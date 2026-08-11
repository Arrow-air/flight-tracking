import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// supabase mock: a chainable, thenable query builder so the db.ts helpers
// (insert/update/select().maybeSingle() etc.) run unmodified against canned
// results. Each test sets `nextResult` before calling the api function.
// ---------------------------------------------------------------------------
interface CannedResult {
  data: unknown;
  error: { code?: string; message?: string; details?: string | null } | null;
}

const state: { nextResult: CannedResult; calls: Record<string, unknown[][]> } = {
  nextResult: { data: null, error: null },
  calls: {},
};

function makeBuilder() {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'maybeSingle']) {
    builder[m] = (...args: unknown[]) => {
      (state.calls[m] ??= []).push(args);
      return builder;
    };
  }
  // thenable: awaiting the builder resolves the canned result
  builder.then = (
    onFulfilled: (v: CannedResult) => unknown,
    onRejected?: (e: unknown) => unknown,
  ) => Promise.resolve(state.nextResult).then(onFulfilled, onRejected);
  return builder;
}

vi.mock('./supabase', () => ({
  supabase: {
    from: (table: string) => {
      (state.calls.from ??= []).push([table]);
      return makeBuilder();
    },
  },
}));

import {
  aircraftLabel,
  grantableAircraft,
  grantAircraft,
  grantsForUser,
  listAircraftOptions,
  listGrants,
  listUsers,
  removesOwnAdmin,
  revokeAircraft,
  setUserRoles,
  sortRoles,
  toggleRole,
  type AircraftOption,
  type OperatorGrant,
} from './admin';
import type { Role } from './db';

beforeEach(() => {
  state.nextResult = { data: null, error: null };
  state.calls = {};
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('sortRoles', () => {
  it('imposes canonical order and dedupes', () => {
    expect(sortRoles(['operator', 'admin', 'operator'])).toEqual(['admin', 'operator']);
  });

  it('drops unknown values (defensive against bad enum data)', () => {
    expect(sortRoles(['operator', 'superuser'])).toEqual(['operator']);
  });

  it('handles empty input', () => {
    expect(sortRoles([])).toEqual([]);
  });
});

describe('toggleRole', () => {
  it('adds a missing role in canonical position', () => {
    expect(toggleRole(['operator'], 'admin')).toEqual(['admin', 'operator']);
  });

  it('removes a held role', () => {
    expect(toggleRole(['admin', 'operator'], 'admin')).toEqual(['operator']);
  });

  it('can empty the role list (server default was {operator})', () => {
    expect(toggleRole(['operator'], 'operator')).toEqual([]);
  });
});

describe('removesOwnAdmin (lockout guard)', () => {
  const self = 'user-1';
  it('true when the current admin strips their own admin role', () => {
    expect(removesOwnAdmin(self, self, ['operator'])).toBe(true);
    expect(removesOwnAdmin(self, self, [])).toBe(true);
  });

  it('false when admin is kept, or the target is someone else', () => {
    expect(removesOwnAdmin(self, self, ['admin'])).toBe(false);
    expect(removesOwnAdmin(self, 'user-2', ['operator'])).toBe(false);
  });

  it('false when there is no session user (nothing to lock out)', () => {
    expect(removesOwnAdmin(null, self, [])).toBe(false);
  });
});

const AIRCRAFT: AircraftOption[] = [
  { id: 'a1', serial: 'QV-001', name: 'Quiver 1', status: 'active' },
  { id: 'a2', serial: 'QV-002', name: null, status: 'retired' },
];

const GRANTS: OperatorGrant[] = [
  { aircraft_id: 'a1', user_id: 'u1', granted_by: 'adm', granted_at: '2026-08-11T00:00:00Z' },
  { aircraft_id: 'a2', user_id: 'u2', granted_by: 'adm', granted_at: '2026-08-11T00:00:00Z' },
];

describe('grantsForUser / grantableAircraft', () => {
  it('filters grants down to one user', () => {
    expect(grantsForUser(GRANTS, 'u1')).toEqual([GRANTS[0]]);
    expect(grantsForUser(GRANTS, 'nobody')).toEqual([]);
  });

  it('offers only aircraft the user does not already hold', () => {
    expect(grantableAircraft(AIRCRAFT, GRANTS, 'u1').map((a) => a.id)).toEqual(['a2']);
    expect(grantableAircraft(AIRCRAFT, GRANTS, 'u3').map((a) => a.id)).toEqual(['a1', 'a2']);
  });
});

describe('aircraftLabel', () => {
  it('uses "name (serial)" when named, serial otherwise', () => {
    expect(aircraftLabel(AIRCRAFT[0])).toBe('Quiver 1 (QV-001)');
    expect(aircraftLabel(AIRCRAFT[1])).toBe('QV-002');
  });
});

// ---------------------------------------------------------------------------
// API layer against the mocked client
// ---------------------------------------------------------------------------

describe('listUsers / listAircraftOptions / listGrants', () => {
  it('listUsers queries user_profiles and returns rows', async () => {
    const rows = [{ id: 'u1', name: 'Thomas', roles: ['admin'] }];
    state.nextResult = { data: rows, error: null };
    await expect(listUsers()).resolves.toEqual(rows);
    expect(state.calls.from).toEqual([['user_profiles']]);
    expect(state.calls.order).toEqual([['name']]);
  });

  it('listAircraftOptions queries aircraft ordered by serial', async () => {
    state.nextResult = { data: AIRCRAFT, error: null };
    await expect(listAircraftOptions()).resolves.toEqual(AIRCRAFT);
    expect(state.calls.from).toEqual([['aircraft']]);
    expect(state.calls.order).toEqual([['serial']]);
  });

  it('listGrants queries aircraft_operators; null data becomes []', async () => {
    state.nextResult = { data: null, error: null };
    await expect(listGrants()).resolves.toEqual([]);
    expect(state.calls.from).toEqual([['aircraft_operators']]);
  });

  it('select errors are thrown with context', async () => {
    state.nextResult = { data: null, error: { message: 'boom' } };
    await expect(listUsers()).rejects.toThrow(/load users: boom/);
  });
});

describe('setUserRoles', () => {
  it('canonicalizes roles before writing and returns the updated row', async () => {
    const updated = { id: 'u1', roles: ['admin', 'operator'] };
    state.nextResult = { data: [updated], error: null };
    await expect(
      setUserRoles('u1', ['operator', 'admin', 'operator'] as Role[]),
    ).resolves.toEqual(updated);
    expect(state.calls.update).toEqual([[{ roles: ['admin', 'operator'] }]]);
    expect(state.calls.eq).toEqual([[ 'id', 'u1' ]]);
  });

  it('throws when 0 rows updated (RLS denial must not look like success)', async () => {
    state.nextResult = { data: [], error: null };
    await expect(setUserRoles('u1', ['admin'])).rejects.toThrow(/0 rows updated/);
  });

  it('translates the guard_roles / RLS permission error (42501)', async () => {
    state.nextResult = {
      data: null,
      error: { code: '42501', message: 'only admins can change roles' },
    };
    await expect(setUserRoles('u1', ['admin'])).rejects.toThrow(/permission denied/);
  });
});

describe('grantAircraft', () => {
  it('inserts the edge WITHOUT granted_by (column default auth.uid() must satisfy RLS)', async () => {
    const row = GRANTS[0];
    state.nextResult = { data: row, error: null };
    await expect(grantAircraft('a1', 'u1')).resolves.toEqual(row);
    expect(state.calls.from).toEqual([['aircraft_operators']]);
    expect(state.calls.insert).toEqual([[{ aircraft_id: 'a1', user_id: 'u1' }]]);
  });

  it('duplicate grant (23505) reads as a duplicate, not a crash', async () => {
    state.nextResult = {
      data: null,
      error: { code: '23505', message: 'duplicate key', details: 'already exists' },
    };
    await expect(grantAircraft('a1', 'u1')).rejects.toThrow(/duplicate/);
  });

  it('no row returned (silent RLS drop) throws', async () => {
    state.nextResult = { data: null, error: null };
    await expect(grantAircraft('a1', 'u1')).rejects.toThrow(/no row returned/);
  });
});

describe('revokeAircraft', () => {
  it('deletes by BOTH composite-key columns', async () => {
    state.nextResult = { data: [GRANTS[0]], error: null };
    await expect(revokeAircraft('a1', 'u1')).resolves.toBeUndefined();
    expect(state.calls.delete).toHaveLength(1);
    expect(state.calls.eq).toEqual([
      ['aircraft_id', 'a1'],
      ['user_id', 'u1'],
    ]);
  });

  it('throws when 0 rows deleted (RLS denial or already revoked)', async () => {
    state.nextResult = { data: [], error: null };
    await expect(revokeAircraft('a1', 'u1')).rejects.toThrow(/0 rows deleted/);
  });

  it('translates delete errors', async () => {
    state.nextResult = { data: null, error: { code: '42501', message: 'denied' } };
    await expect(revokeAircraft('a1', 'u1')).rejects.toThrow(/permission denied/);
  });
});
