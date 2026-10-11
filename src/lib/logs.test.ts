import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// v2.4 upload pipeline. Same mock style as deletion.test.ts: a chainable
// thenable postgrest builder that records every chain, plus storage, auth and
// tus-js-client mocks. The ordering that matters: the row is registered as
// 'uploading', the bytes go up, and only then does the row flip to
// 'uploaded' (which is what notifies the parser).
// ---------------------------------------------------------------------------
interface CannedResult {
  data?: unknown;
  error: { code?: string; message?: string; details?: string | null } | null;
}
interface Chain {
  table: string;
  ops: [string, unknown[]][];
}

const state: {
  results: CannedResult[];
  chains: Chain[];
  uploads: { bucket: string; path: string }[];
  uploadResults: { data: unknown; error: { message: string } | null }[];
  checksum: string;
  uid: string;
} = { results: [], chains: [], uploads: [], uploadResults: [], checksum: '', uid: '' };

const tusState: {
  instances: FakeUpload[];
  outcome: { status: number; body: string } | 'success';
  previous: unknown[];
} = { instances: [], outcome: 'success', previous: [] };

interface FakeUpload {
  file: File;
  options: Record<string, any>;
  resumed: unknown;
  headersSeen: Record<string, string>;
}

function makeBuilder(table: string) {
  const chain: Chain = { table, ops: [] };
  state.chains.push(chain);
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'maybeSingle']) {
    builder[m] = (...args: unknown[]) => {
      chain.ops.push([m, args]);
      return builder;
    };
  }
  builder.then = (onFulfilled: (v: CannedResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(state.results.shift() ?? { data: null, error: null }).then(onFulfilled, onRejected);
  return builder;
}

vi.mock('./supabase', () => ({
  supabaseUrl: 'https://sb.test',
  supabaseKey: 'pub-key',
  supabase: {
    from: (table: string) => makeBuilder(table),
    storage: {
      from: (bucket: string) => ({
        upload: (path: string) => {
          state.uploads.push({ bucket, path });
          return Promise.resolve(state.uploadResults.shift() ?? { data: { path }, error: null });
        },
      }),
    },
    auth: {
      getSession: () =>
        Promise.resolve({ data: { session: { access_token: 'tok-1', user: { id: state.uid } } } }),
    },
  },
}));

vi.mock('./binlog', () => ({ sha256Hex: async () => state.checksum }));

vi.mock('tus-js-client', () => {
  class Upload {
    file: File;
    options: Record<string, any>;
    resumed: unknown = null;
    headersSeen: Record<string, string> = {};
    constructor(file: File, options: Record<string, any>) {
      this.file = file;
      this.options = options;
      tusState.instances.push(this as unknown as FakeUpload);
    }
    findPreviousUploads() {
      return Promise.resolve(tusState.previous);
    }
    resumeFromPreviousUpload(p: unknown) {
      this.resumed = p;
    }
    start() {
      void (async () => {
        await this.options.onBeforeRequest?.({
          setHeader: (k: string, v: string) => {
            this.headersSeen[k] = v;
          },
        });
        const outcome = tusState.outcome;
        if (outcome === 'success') {
          this.options.onProgress?.(this.file.size, this.file.size);
          this.options.onSuccess?.({});
        } else {
          const err = new Error('tus: unexpected response') as Error & { originalResponse: unknown };
          err.originalResponse = { getStatus: () => outcome.status, getBody: () => outcome.body };
          this.options.onError?.(err);
        }
      })();
    }
  }
  return { Upload, DetailedError: Error };
});

import {
  DuplicateLogError,
  TUS_CHUNK_BYTES,
  canResumeInto,
  isStalledUpload,
  isUnfinishedUpload,
  reattachFlightLog,
  uploadFlightLog,
} from './logs';
import type { FlightLog } from './db';

const SUM = 'a'.repeat(64);
const row = (over: Partial<FlightLog> = {}): FlightLog => ({
  id: 'log-1',
  flight_id: 'f1',
  object_path: `f1/${SUM.slice(0, 12)}_x.BIN`,
  sanitized_path: null,
  checksum: SUM,
  size_bytes: 10,
  uploaded_by: 'u1',
  uploaded_at: '2026-10-11T15:00:00Z',
  status: 'uploading',
  error: null,
  ...over,
});
const small = () => new File([new Uint8Array(1024)], 'x.BIN');
const large = () => new File([new Uint8Array(TUS_CHUNK_BYTES + 1)], 'x.BIN');

/** The ops of the n-th postgrest chain, as [method, firstArg]. */
function ops(n: number) {
  return state.chains[n].ops.map(([m, a]) => [m, a[0]]);
}

beforeEach(() => {
  state.results = [];
  state.chains = [];
  state.uploads = [];
  state.uploadResults = [];
  state.checksum = SUM;
  state.uid = 'u1';
  tusState.instances = [];
  tusState.outcome = 'success';
  tusState.previous = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
describe('isUnfinishedUpload', () => {
  it('is true for uploading rows and failed/missing uploads', () => {
    expect(isUnfinishedUpload({ status: 'uploading', error: null })).toBe(true);
    expect(
      isUnfinishedUpload({ status: 'error', error: "upload didn't finish: network error. Re-attach…" }),
    ).toBe(true);
    expect(isUnfinishedUpload({ status: 'error', error: 'storage upload failed: timeout' })).toBe(true);
    // pre-v2.4 rows: the parser's raw HTTPError on a missing object (the Julius case)
    expect(
      isUnfinishedUpload({
        status: 'error',
        error:
          'HTTPError: 400 Client Error: Bad Request for url: https://supabase.arrowair.com/storage/v1/object/flight-logs/24a2/7658_caribou_00000025.BIN',
      }),
    ).toBe(true);
  });

  it('is false for real parse failures and healthy rows', () => {
    expect(isUnfinishedUpload({ status: 'error', error: 'ValueError: bad DataFlash header' })).toBe(false);
    expect(isUnfinishedUpload({ status: 'parsed', error: null })).toBe(false);
    expect(isUnfinishedUpload({ status: 'uploaded', error: null })).toBe(false);
  });
});

describe('isStalledUpload', () => {
  const at = Date.parse('2026-10-11T15:00:00Z');
  it('flags uploading rows untouched for over 30 minutes', () => {
    const l = { status: 'uploading' as const, uploaded_at: '2026-10-11T15:00:00Z' };
    expect(isStalledUpload(l, at + 31 * 60_000)).toBe(true);
    expect(isStalledUpload(l, at + 5 * 60_000)).toBe(false);
  });
  it('uses updated_at when present (a resumed upload is fresh again)', () => {
    const l = {
      status: 'uploading' as const,
      uploaded_at: '2026-10-11T10:00:00Z',
      updated_at: '2026-10-11T14:55:00Z',
    };
    expect(isStalledUpload(l, at)).toBe(false);
  });
  it('ignores other statuses', () => {
    expect(isStalledUpload({ status: 'parsed', uploaded_at: '2020-01-01T00:00:00Z' }, at)).toBe(false);
  });
});

describe('canResumeInto', () => {
  const ex = { flight_id: 'f1', uploaded_by: 'u1', status: 'error' as const, error: null };
  it('allows the uploader on the same flight while unfinished', () => {
    expect(canResumeInto(ex, 'f1', 'u1')).toBe(true);
    expect(canResumeInto({ ...ex, status: 'uploading' }, 'f1', 'u1')).toBe(true);
  });
  it('refuses other flights, other users, finished rows', () => {
    expect(canResumeInto(ex, 'f2', 'u1')).toBe(false);
    expect(canResumeInto(ex, 'f1', 'u2')).toBe(false);
    expect(canResumeInto(ex, 'f1', null)).toBe(false);
    expect(canResumeInto({ ...ex, status: 'parsed' }, 'f1', 'u1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// uploadFlightLog
// ---------------------------------------------------------------------------
describe('uploadFlightLog', () => {
  it('registers as uploading, puts the bytes, then queues as uploaded', async () => {
    state.results = [
      { data: row(), error: null }, // insert
      { data: [row({ status: 'uploaded' })], error: null }, // queue
    ];
    const out = await uploadFlightLog('f1', small());

    expect(state.chains[0].table).toBe('flight_logs');
    const insert = state.chains[0].ops.find(([m]) => m === 'insert')![1][0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      flight_id: 'f1',
      object_path: `f1/${SUM.slice(0, 12)}_x.BIN`,
      checksum: SUM,
      status: 'uploading',
    });
    expect(state.uploads).toEqual([{ bucket: 'flight-logs', path: `f1/${SUM.slice(0, 12)}_x.BIN` }]);
    expect(ops(1)).toEqual([
      ['update', { status: 'uploaded', error: null }],
      ['eq', 'id'],
      ['select', undefined],
    ]);
    expect(out.status).toBe('uploaded');
    expect(tusState.instances).toHaveLength(0);
  });

  it('sends large files through tus with Supabase settings and a fresh token', async () => {
    state.results = [
      { data: row(), error: null },
      { data: [row({ status: 'uploaded' })], error: null },
    ];
    const progress: number[] = [];
    await uploadFlightLog('f1', large(), undefined, (sent, total) => progress.push(sent / total));

    expect(state.uploads).toHaveLength(0);
    const up = tusState.instances[0];
    expect(up.options.endpoint).toBe('https://sb.test/storage/v1/upload/resumable');
    expect(up.options.chunkSize).toBe(6 * 1024 * 1024);
    expect(up.options.metadata).toMatchObject({
      bucketName: 'flight-logs',
      objectName: `f1/${SUM.slice(0, 12)}_x.BIN`,
    });
    expect(up.options.headers).toMatchObject({ apikey: 'pub-key', 'x-upsert': 'false' });
    expect(up.headersSeen.authorization).toBe('Bearer tok-1');
    // the fingerprint is per object path, so a different flight never resumes this upload
    expect(await up.options.fingerprint(up.file)).toContain(`f1/${SUM.slice(0, 12)}_x.BIN`);
    expect(progress.at(-1)).toBe(1);
    expect(ops(1)[0]).toEqual(['update', { status: 'uploaded', error: null }]);
  });

  it('resumes a previous tus upload of the same file', async () => {
    state.results = [
      { data: row(), error: null },
      { data: [row({ status: 'uploaded' })], error: null },
    ];
    tusState.previous = [{ uploadUrl: 'https://sb.test/storage/v1/upload/resumable/abc' }];
    await uploadFlightLog('f1', large());
    expect(tusState.instances[0].resumed).toEqual(tusState.previous[0]);
  });

  it('falls back to a single PUT when the tus endpoint is missing', async () => {
    state.results = [
      { data: row(), error: null },
      { data: [row({ status: 'uploaded' })], error: null },
    ];
    tusState.outcome = { status: 404, body: 'Not Found' };
    await uploadFlightLog('f1', large());
    expect(state.uploads).toHaveLength(1);
    expect(ops(1)[0]).toEqual(['update', { status: 'uploaded', error: null }]);
  });

  it('does not fall back on a policy rejection; marks the row and throws', async () => {
    state.results = [
      { data: row(), error: null },
      { data: [row({ status: 'error' })], error: null }, // mark error
    ];
    tusState.outcome = {
      status: 400,
      body: JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }),
    };
    await expect(uploadFlightLog('f1', large())).rejects.toThrow(
      'upload x.BIN: new row violates row-level security policy',
    );
    expect(state.uploads).toHaveLength(0);
    const mark = state.chains[1].ops[0][1][0] as Record<string, string>;
    expect(mark.status).toBe('error');
    expect(mark.error).toMatch(/^upload didn't finish: new row violates/);
    expect(mark.error).toContain('Re-attach the same .bin');
  });

  it('marks the row when a small PUT fails', async () => {
    state.results = [
      { data: row(), error: null },
      { data: [row({ status: 'error' })], error: null },
    ];
    state.uploadResults = [{ data: null, error: { message: 'Failed to fetch' } }];
    await expect(uploadFlightLog('f1', small())).rejects.toThrow('upload x.BIN: Failed to fetch');
    const mark = state.chains[1].ops[0][1][0] as Record<string, string>;
    expect(mark).toMatchObject({ status: 'error' });
    expect(mark.error).toContain('Failed to fetch');
  });

  it('treats "already exists" as landed and queues the row', async () => {
    state.results = [
      { data: row(), error: null },
      { data: [row({ status: 'uploaded' })], error: null },
    ];
    state.uploadResults = [{ data: null, error: { message: 'The resource already exists' } }];
    const out = await uploadFlightLog('f1', small());
    expect(out.status).toBe('uploaded');
  });

  it('falls back to the old flow when the database lacks the uploading state', async () => {
    state.results = [
      { data: null, error: { code: '22P02', message: 'invalid input value for enum flight_log_status: "uploading"' } },
      { data: row({ status: 'uploaded' }), error: null }, // legacy insert
      { data: [row({ status: 'uploaded' })], error: null }, // race recovery
    ];
    await uploadFlightLog('f1', small());
    const legacyInsert = state.chains[1].ops.find(([m]) => m === 'insert')![1][0] as Record<string, unknown>;
    expect(legacyInsert).not.toHaveProperty('status');
    // recovery only flips a premature 'error' back
    expect(ops(2)).toEqual([
      ['update', { status: 'uploaded', error: null }],
      ['eq', 'id'],
      ['eq', 'status'],
      ['select', undefined],
    ]);
  });

  it("resumes into the uploader's own unfinished row instead of refusing a duplicate", async () => {
    const stuck = row({ status: 'error', error: 'HTTPError: 400 …/storage/v1/object/…' });
    state.results = [
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      { data: stuck, error: null }, // findLogByChecksum
      { data: [row({ status: 'uploading' })], error: null }, // resume -> uploading
      { data: [row({ status: 'uploaded' })], error: null }, // queue
    ];
    const out = await uploadFlightLog('f1', small());
    expect(ops(2)[0]).toEqual(['update', { status: 'uploading', error: null }]);
    expect(state.uploads).toHaveLength(1);
    expect(out.status).toBe('uploaded');
  });

  it('still refuses a duplicate that belongs to another flight', async () => {
    state.results = [
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
      { data: row({ flight_id: 'f9', status: 'parsed' }), error: null },
    ];
    const err = await uploadFlightLog('f1', small()).catch((e) => e);
    expect(err).toBeInstanceOf(DuplicateLogError);
    expect((err as DuplicateLogError).flightId).toBe('f9');
    expect(state.uploads).toHaveLength(0);
  });
});

describe('reattachFlightLog', () => {
  it('refuses a different file', async () => {
    state.checksum = 'b'.repeat(64);
    await expect(reattachFlightLog(row({ status: 'error' }), small())).rejects.toThrow(
      "That isn't the same file",
    );
    expect(state.chains).toHaveLength(0);
  });

  it('re-uploads the same file and queues it', async () => {
    state.results = [
      { data: [row({ status: 'uploading' })], error: null },
      { data: [row({ status: 'uploaded' })], error: null },
    ];
    const out = await reattachFlightLog(row({ status: 'error' }), small());
    expect(ops(0)[0]).toEqual(['update', { status: 'uploading', error: null }]);
    expect(state.uploads).toHaveLength(1);
    expect(out.status).toBe('uploaded');
  });
});
