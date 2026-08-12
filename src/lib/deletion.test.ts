import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// supabase mock (same shape as admin.test.ts): chainable thenable builder for
// postgrest calls + a storage mock. Tests queue canned results in order and
// assert on the recorded operation sequence — deleteFlight's storage-before-
// row-delete ordering is load-bearing (the storage delete policies resolve
// through the flight_logs row; see src/lib/deletion.ts).
// ---------------------------------------------------------------------------
interface CannedResult {
  data?: unknown;
  count?: number | null;
  error: { code?: string; message?: string; details?: string | null } | null;
}

const state: {
  results: CannedResult[];
  storageResults: { data: { name: string }[] | null; error: { message: string } | null }[];
  seq: string[];
  removeArgs: Record<string, string[][]>;
} = { results: [], storageResults: [], seq: [], removeArgs: {} };

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'maybeSingle']) {
    builder[m] = () => builder;
  }
  builder.then = (
    onFulfilled: (v: CannedResult) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) =>
    Promise.resolve(state.results.shift() ?? { data: null, error: null }).then(
      onFulfilled,
      onRejected,
    );
  return builder;
}

vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => {
      state.seq.push(`from:${table}`);
      return makeBuilder();
    },
    storage: {
      from: (bucket: string) => ({
        remove: (paths: string[]) => {
          state.seq.push(`remove:${bucket}`);
          (state.removeArgs[bucket] ??= []).push(paths);
          return Promise.resolve(
            state.storageResults.shift() ?? {
              data: paths.map((p) => ({ name: p })),
              error: null,
            },
          );
        },
      }),
    },
  },
}));

import {
  countAircraftFlights,
  deleteAircraft,
  deleteFlight,
  logObjectPaths,
  orphanedPaths,
} from './deletion';

beforeEach(() => {
  state.results = [];
  state.storageResults = [];
  state.seq = [];
  state.removeArgs = {};
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
describe('logObjectPaths', () => {
  it('groups raw and sanitized paths, skipping null sanitized copies', () => {
    expect(
      logObjectPaths([
        { object_path: 'f1/aaa_x.BIN', sanitized_path: 'f1/aaa_x.sanitized.BIN' },
        { object_path: 'f1/bbb_y.BIN', sanitized_path: null },
      ]),
    ).toEqual({
      raw: ['f1/aaa_x.BIN', 'f1/bbb_y.BIN'],
      sanitized: ['f1/aaa_x.sanitized.BIN'],
    });
  });

  it('is empty for no logs', () => {
    expect(logObjectPaths([])).toEqual({ raw: [], sanitized: [] });
  });
});

describe('orphanedPaths', () => {
  it('returns requested paths missing from the remove() result (silent RLS miss)', () => {
    expect(orphanedPaths(['a', 'b', 'c'], [{ name: 'a' }, { name: 'c' }])).toEqual(['b']);
  });

  it('returns [] when everything was removed', () => {
    expect(orphanedPaths(['a'], [{ name: 'a' }])).toEqual([]);
  });

  it('treats a null result as all-orphaned', () => {
    expect(orphanedPaths(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// deleteFlight
// ---------------------------------------------------------------------------
describe('deleteFlight', () => {
  const twoLogs = [
    { object_path: 'f1/aaa_x.BIN', sanitized_path: 'f1/aaa_x.san.BIN' },
    { object_path: 'f1/bbb_y.BIN', sanitized_path: null },
  ];

  it('removes storage objects BEFORE deleting the flight row', async () => {
    state.results = [
      { data: twoLogs, error: null }, // flight_logs select
      { data: [{ id: 'f1' }], error: null }, // flights delete
    ];
    const res = await deleteFlight('f1');
    expect(res).toEqual({ logCount: 2, orphans: [] });
    expect(state.seq).toEqual([
      'from:flight_logs',
      'remove:flight-logs',
      'remove:flight-logs-sanitized',
      'from:flights',
    ]);
    expect(state.removeArgs['flight-logs'][0]).toEqual(['f1/aaa_x.BIN', 'f1/bbb_y.BIN']);
    expect(state.removeArgs['flight-logs-sanitized'][0]).toEqual(['f1/aaa_x.san.BIN']);
  });

  it('skips storage calls entirely for a flight with no logs', async () => {
    state.results = [
      { data: [], error: null },
      { data: [{ id: 'f1' }], error: null },
    ];
    const res = await deleteFlight('f1');
    expect(res).toEqual({ logCount: 0, orphans: [] });
    expect(state.seq).toEqual(['from:flight_logs', 'from:flights']);
  });

  it('reports objects the storage RLS silently refused as orphans', async () => {
    state.results = [
      { data: twoLogs, error: null },
      { data: [{ id: 'f1' }], error: null },
    ];
    state.storageResults = [
      { data: [{ name: 'f1/aaa_x.BIN' }], error: null }, // raw: bbb refused
      { data: [], error: null }, // sanitized: refused
    ];
    const res = await deleteFlight('f1');
    expect(res.orphans).toEqual(['f1/bbb_y.BIN', 'f1/aaa_x.san.BIN']);
  });

  it('still deletes the DB rows when storage remove errors (all orphaned)', async () => {
    state.results = [
      { data: [twoLogs[0]], error: null },
      { data: [{ id: 'f1' }], error: null },
    ];
    state.storageResults = [
      { data: null, error: { message: 'network down' } },
      { data: null, error: { message: 'network down' } },
    ];
    const res = await deleteFlight('f1');
    expect(res.orphans).toEqual(['f1/aaa_x.BIN', 'f1/aaa_x.san.BIN']);
    expect(state.seq.at(-1)).toBe('from:flights');
  });

  it('throws loudly when RLS blocks the flight delete (0 rows)', async () => {
    state.results = [
      { data: [], error: null }, // no logs
      { data: [], error: null }, // delete affected 0 rows
    ];
    await expect(deleteFlight('f1')).rejects.toThrow(/0 rows deleted/);
  });
});

// ---------------------------------------------------------------------------
// deleteAircraft — safe default: never deletes while flights exist
// ---------------------------------------------------------------------------
describe('deleteAircraft', () => {
  it('refuses when the aircraft still has flights, without touching the row', async () => {
    state.results = [{ count: 3, error: null }];
    await expect(deleteAircraft('ac1')).rejects.toThrow(/3 flights.*Delete or reassign/s);
    expect(state.seq).toEqual(['from:flights']); // count only — no aircraft delete
  });

  it('deletes when the aircraft has no flights', async () => {
    state.results = [
      { count: 0, error: null },
      { data: [{ id: 'ac1' }], error: null },
    ];
    await expect(deleteAircraft('ac1')).resolves.toBeUndefined();
    expect(state.seq).toEqual(['from:flights', 'from:aircraft']);
  });

  it('surfaces an RLS denial on the aircraft delete (operator via API)', async () => {
    state.results = [
      { count: 0, error: null },
      { data: null, error: { code: '42501', message: 'permission denied' } },
    ];
    await expect(deleteAircraft('ac1')).rejects.toThrow(/permission denied/);
  });
});

describe('countAircraftFlights', () => {
  it('returns the exact count', async () => {
    state.results = [{ count: 12, error: null }];
    await expect(countAircraftFlights('ac1')).resolves.toBe(12);
  });

  it('throws a friendly error on failure', async () => {
    state.results = [{ count: null, error: { message: 'boom' } }];
    await expect(countAircraftFlights('ac1')).rejects.toThrow(/count flights: boom/);
  });
});
