/**
 * Admin store/api layer (B1) — users, roles, aircraft access grants.
 *
 * Server-side gating (verified in supabase/migrations, no new migration
 * needed):
 *  - user_profiles: "update own profile or admin" (rls.sql) + guard_roles
 *    trigger (helpers.sql) — only admins can change `roles[]`.
 *  - aircraft_operators: INSERT/DELETE restricted to manufacturer-or-admin;
 *    INSERT requires granted_by = auth.uid() (we rely on the column DEFAULT
 *    auth.uid(), which satisfies the WITH CHECK).
 *  - Emails live in auth.users which is NOT client-readable; the UI shows
 *    profile name + id only (documented limitation, not a bug).
 *
 * All writes go through the db.ts discipline: 0 rows affected = thrown error,
 * so an RLS denial can never look like success.
 */
import {
  friendlyDbError,
  insertRow,
  selectRows,
  updateRow,
  type Profile,
  type Role,
} from './db';
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Canonical role order for display + storage. */
export const ALL_ROLES: Role[] = ['admin', 'manufacturer', 'operator'];

export interface OperatorGrant {
  aircraft_id: string;
  user_id: string;
  granted_by: string | null;
  granted_at: string;
}

/** The slice of aircraft the admin page needs for the grant dropdown. */
export interface AircraftOption {
  id: string;
  serial: string;
  name: string | null;
  status: 'active' | 'maintenance' | 'retired';
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Dedupe + drop unknown values + impose canonical order. */
export function sortRoles(roles: readonly string[]): Role[] {
  return ALL_ROLES.filter((r) => roles.includes(r));
}

/** Add/remove one role, returning a new canonical array. */
export function toggleRole(roles: readonly Role[], role: Role): Role[] {
  const next = roles.includes(role)
    ? roles.filter((r) => r !== role)
    : [...roles, role];
  return sortRoles(next);
}

/**
 * True when saving `nextRoles` on `targetId` would strip the CURRENT admin's
 * own admin role — a lockout the server happily allows (an admin may edit
 * their own profile), so the client must refuse it.
 */
export function removesOwnAdmin(
  selfId: string | null,
  targetId: string,
  nextRoles: readonly Role[],
): boolean {
  return selfId != null && targetId === selfId && !nextRoles.includes('admin');
}

/** Grants belonging to one user. */
export function grantsForUser(
  grants: readonly OperatorGrant[],
  userId: string,
): OperatorGrant[] {
  return grants.filter((g) => g.user_id === userId);
}

/** Aircraft the user does NOT already have access to (for the grant select). */
export function grantableAircraft(
  aircraft: readonly AircraftOption[],
  grants: readonly OperatorGrant[],
  userId: string,
): AircraftOption[] {
  const held = new Set(
    grants.filter((g) => g.user_id === userId).map((g) => g.aircraft_id),
  );
  return aircraft.filter((a) => !held.has(a.id));
}

/** "name (serial)" or just serial when unnamed. */
export function aircraftLabel(a: Pick<AircraftOption, 'serial' | 'name'>): string {
  return a.name ? `${a.name} (${a.serial})` : a.serial;
}

// ---------------------------------------------------------------------------
// API (supabase-backed; RLS is the real gate)
// ---------------------------------------------------------------------------

export function listUsers(): Promise<Profile[]> {
  return selectRows<Profile[]>(
    supabase.from('user_profiles').select('*').order('name'),
    'load users',
  );
}

export function listAircraftOptions(): Promise<AircraftOption[]> {
  return selectRows<AircraftOption[]>(
    supabase.from('aircraft').select('id, serial, name, status').order('serial'),
    'load aircraft',
  );
}

export function listGrants(): Promise<OperatorGrant[]> {
  return selectRows<OperatorGrant[]>(
    supabase.from('aircraft_operators').select('*'),
    'load aircraft access grants',
  );
}

/** Replace a user's roles (canonicalized). Server guard_roles trigger and
 *  RLS enforce admin-only; 0 rows updated throws. */
export function setUserRoles(userId: string, roles: readonly Role[]): Promise<Profile> {
  return updateRow<Profile>(
    'user_profiles',
    userId,
    { roles: sortRoles(roles) },
    'change user roles',
  );
}

/** Grant a user operator access to an aircraft. granted_by is filled by the
 *  column default (auth.uid()), which is what the RLS WITH CHECK requires. */
export function grantAircraft(
  aircraftId: string,
  userId: string,
): Promise<OperatorGrant> {
  return insertRow<OperatorGrant>(
    'aircraft_operators',
    { aircraft_id: aircraftId, user_id: userId },
    'grant aircraft access',
  );
}

/**
 * Revoke a grant. aircraft_operators has a composite PK, so db.ts deleteRow
 * (id-based) does not apply — same discipline, both keys filtered, 0 rows
 * deleted throws (RLS denial or already revoked).
 */
export async function revokeAircraft(
  aircraftId: string,
  userId: string,
): Promise<void> {
  const ctx = 'revoke aircraft access';
  const { data, error } = await supabase
    .from('aircraft_operators')
    .delete()
    .eq('aircraft_id', aircraftId)
    .eq('user_id', userId)
    .select();
  if (error) throw friendlyDbError(ctx, error);
  if (!data || data.length === 0) {
    throw new Error(
      `${ctx}: 0 rows deleted — you may not have permission, or the grant was already revoked.`,
    );
  }
}
