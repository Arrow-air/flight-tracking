import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse, HttpStack } from 'tus-js-client';

// ---------------------------------------------------------------------------
// The real tus-js-client upload logic (create, resume, retry, URL storage,
// onAfterResponse) driven through an in-memory HTTP stack that plays a tus
// server at https://sb.test, plus a Blob reader (what the browser build uses)
// and an in-memory URL storage standing in for localStorage. Unlike
// logs.test.ts, nothing about tus itself is mocked: these check what the
// library does with the upload URL a server answers with, when it retries,
// and what it remembers for a resume. Requests to any other address fail the
// way a browser's do for http://…:8000 from an https page: a network error.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const store = {
    rows: new Map<string, Record<string, unknown>>(),
    async findAllUploads() {
      return [...store.rows.entries()].map(([urlStorageKey, v]) => ({ ...v, urlStorageKey }));
    },
    async findUploadsByFingerprint(fp: string) {
      return [...store.rows.entries()]
        .filter(([k]) => k.startsWith(`tus::${fp}::`))
        .map(([urlStorageKey, v]) => ({ ...v, urlStorageKey }));
    },
    async removeUpload(key: string) {
      store.rows.delete(key);
    },
    async addUpload(fp: string, upload: Record<string, unknown>) {
      const key = `tus::${fp}::${store.rows.size + 1}`;
      store.rows.set(key, upload);
      return key;
    },
  };
  return {
    base: 'https://sb.test',
    store,
    /** Where the server says the rest of an upload goes. */
    location: (id: string) => `https://sb.test/storage/v1/upload/resumable/${id}`,
    /** Every request tus sent, reachable or not: "METHOD url". */
    attempts: [] as string[],
    uploads: new Map<string, { offset: number; length: number }>(),
    nextId: 0,
    puts: [] as string[],
    dbResults: [] as { data: unknown; error: null }[],
  };
});

vi.mock('./supabase', () => {
  const builder = () => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'insert', 'update', 'eq', 'maybeSingle']) b[m] = () => b;
    b.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(h.dbResults.shift() ?? { data: null, error: null }).then(ok);
    return b;
  };
  return {
    supabaseUrl: h.base,
    supabaseKey: 'pub-key',
    supabase: {
      from: () => builder(),
      storage: {
        from: () => ({
          upload: async (path: string) => {
            h.puts.push(path);
            return { data: { path }, error: null };
          },
        }),
      },
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'tok-1', user: { id: 'u1' } } } }),
      },
    },
  };
});

vi.mock('./binlog', () => ({ sha256Hex: async () => 'b'.repeat(64) }));

/** A tus server in memory (the subset storage-api answers with). */
function serve(method: string, url: string, headers: Record<string, string>, body: Blob | null): HttpResponse {
  const tus = { 'tus-resumable': '1.0.0' } as Record<string, string>;
  const reply = (status: number, extra: Record<string, string> = {}): HttpResponse => {
    const all: Record<string, string> = { ...tus };
    for (const [k, v] of Object.entries(extra)) all[k.toLowerCase()] = v;
    return {
      getStatus: () => status,
      getHeader: (k: string) => all[k.toLowerCase()],
      getBody: () => '',
      getUnderlyingObject: () => null,
    };
  };
  const path = new URL(url).pathname;
  if (method === 'POST' && path === '/storage/v1/upload/resumable') {
    const id = `up${++h.nextId}`;
    const up = { offset: body?.size ?? 0, length: Number(headers['upload-length']) };
    h.uploads.set(id, up);
    return reply(201, { Location: h.location(id), 'Upload-Offset': String(up.offset) });
  }
  const up = h.uploads.get(path.split('/').pop() ?? '');
  if (!up) return reply(404);
  if (method === 'PATCH') {
    up.offset += body?.size ?? 0;
    return reply(204, { 'Upload-Offset': String(up.offset) });
  }
  if (method === 'HEAD') {
    return reply(200, { 'Upload-Offset': String(up.offset), 'Upload-Length': String(up.length) });
  }
  return reply(405);
}

const memoryHttpStack: HttpStack = {
  getName: () => 'memory',
  createRequest(method: string, url: string): HttpRequest {
    const headers: Record<string, string> = {};
    return {
      getMethod: () => method,
      getURL: () => url,
      setHeader: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
      },
      getHeader: (k: string) => headers[k.toLowerCase()],
      setProgressHandler: () => undefined,
      abort: async () => undefined,
      getUnderlyingObject: () => null,
      send: async (body: Blob | null) => {
        h.attempts.push(`${method} ${url}`);
        if (!url.startsWith(`${h.base}/`)) throw new Error('net::ERR_CONNECTION_REFUSED');
        return serve(method, url, headers, body);
      },
    };
  },
};

vi.mock('tus-js-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('tus-js-client')>();
  class Upload extends real.Upload {
    constructor(file: Blob, options: Record<string, unknown>) {
      super(file, {
        ...options,
        httpStack: memoryHttpStack,
        urlStorage: h.store,
        fileReader: {
          // what the browser build's FileSource does
          openFile: async (input: Blob) => ({
            size: input.size,
            slice: async (start: number, end: number) => ({ value: input.slice(start, end), done: end >= input.size }),
            close: () => undefined,
          }),
        },
      } as never);
    }
  }
  return { ...real, Upload };
});

import { TUS_CHUNK_BYTES, uploadFlightLog } from './logs';

const SIZE = TUS_CHUNK_BYTES + 10;
const PATH = `f1/${'b'.repeat(12)}_x.BIN`;
const FINGERPRINT = ['arrow-log', 'https://sb.test', PATH, SIZE, 1].join('|');
/** What a proxied self-hosted Supabase handed out before Nov 23, 2026. */
const DEAD = 'http://sb.test:8000/upload/resumable';

const row = (status: string) => ({
  id: 'log-1',
  flight_id: 'f1',
  object_path: PATH,
  checksum: 'b'.repeat(64),
  size_bytes: SIZE,
  uploaded_by: 'u1',
  uploaded_at: '2026-11-23T14:00:00Z',
  status,
  error: null,
});
const bin = () => new File([new Uint8Array(SIZE)], 'x.BIN', { lastModified: 1 });
const savedUpload = (uploadUrl: string) => ({
  size: SIZE,
  metadata: {},
  creationTime: '2026-11-21T01:26:14Z',
  uploadUrl,
  parallelUploadUrls: null,
});

beforeEach(() => {
  h.attempts = [];
  h.puts = [];
  h.uploads.clear();
  h.store.rows.clear();
  h.location = (id) => `${h.base}/storage/v1/upload/resumable/${id}`;
  h.dbResults = [
    { data: row('uploading'), error: null }, // insert
    { data: [row('uploaded')], error: null }, // queue for parsing
  ];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('resumable uploads through the real tus client', () => {
  it('uploads in chunks to the URL the server gives back', async () => {
    const out = await uploadFlightLog('f1', bin());
    const id = `up${h.nextId}`;
    expect(out.status).toBe('uploaded');
    expect(h.attempts).toEqual([
      'POST https://sb.test/storage/v1/upload/resumable',
      `PATCH https://sb.test/storage/v1/upload/resumable/${id}`,
    ]);
    expect(h.uploads.get(id)).toEqual({ offset: SIZE, length: SIZE });
    expect(h.puts).toEqual([]);
    expect(h.store.rows.size).toBe(0); // forgotten on success
  });

  it('uses a single request at once, and remembers nothing, when the server hands out an unreachable URL', async () => {
    h.location = (id) => `${DEAD}/${id}`;
    const out = await uploadFlightLog('f1', bin());
    expect(out.status).toBe('uploaded');
    expect(h.attempts).toEqual(['POST https://sb.test/storage/v1/upload/resumable']); // no chunk, no retry
    expect(h.puts).toEqual([PATH]);
    expect(h.store.rows.size).toBe(0);
  });

  it('forgets a saved unreachable upload URL instead of retrying it, then uploads fresh', async () => {
    await h.store.addUpload(FINGERPRINT, savedUpload(`${DEAD}/old`));
    const out = await uploadFlightLog('f1', bin());
    expect(out.status).toBe('uploaded');
    expect(h.attempts.some((a) => a.includes(DEAD))).toBe(false); // no HEAD on the dead URL
    expect(h.attempts[0]).toBe('POST https://sb.test/storage/v1/upload/resumable');
    expect(h.puts).toEqual([]);
    expect(h.store.rows.size).toBe(0);
  });

  it('still resumes a saved upload on its own endpoint from where it stopped', async () => {
    h.uploads.set('up-old', { offset: TUS_CHUNK_BYTES, length: SIZE });
    await h.store.addUpload(FINGERPRINT, savedUpload(h.location('up-old')));
    const out = await uploadFlightLog('f1', bin());
    expect(out.status).toBe('uploaded');
    expect(h.attempts).toEqual([
      'HEAD https://sb.test/storage/v1/upload/resumable/up-old',
      'PATCH https://sb.test/storage/v1/upload/resumable/up-old',
    ]);
    expect(h.uploads.get('up-old')).toEqual({ offset: SIZE, length: SIZE });
  });
});
