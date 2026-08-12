/**
 * P3 (v2.2): flight + aircraft deletion (run/RUN-CONTEXT-V22.md P3).
 *
 * Permission model (mirrors RLS; see migration 20260812150000_v22_deletions):
 *   - flights DELETE: admin or assigned operator (can_write_aircraft_data) —
 *     the same canWrite semantics as flight editing.
 *   - aircraft DELETE: admin only. SAFE DEFAULT: the flights.aircraft_id FK
 *     is ON DELETE RESTRICT, so the DB refuses to delete an aircraft that
 *     still has flights — we check first and tell the admin to delete or
 *     reassign the flights instead of cascading them away.
 *
 * STORAGE ORDERING TRAP: the storage delete policies resolve permission
 * through the flight_logs row that references each object. Once the row is
 * gone (the flights delete cascades through flight_logs), NO client can ever
 * remove the object — only a service-role sweep can. So deleteFlight removes
 * storage objects FIRST, then deletes the flight row. Objects that could not
 * be removed (network error, already gone) are reported as possible ORPHANS:
 * supabase-js storage.remove() does not error on misses, so we diff the
 * returned list against what we asked for. Orphans are logged to the console
 * (path list) and surfaced in the UI notice; the admin sweep (RUN-RESULT-V22
 * P3) reconciles buckets against live flight_logs rows.
 *
 * KNOWN OVER-REPORT (verified against the local stack): the removed-list is
 * RETURNING-filtered by the SELECT policies, so when a NON-owner operator
 * deletes a gps_private flight, its raw objects ARE deleted but come back
 * absent from the result (raw read is owner/admin-only) and get flagged here
 * as orphans. The deleter can't confirm either way (listing is filtered by
 * the same policy), so we deliberately over-report — the admin sweep finding
 * nothing is the good outcome.
 */
import { supabase } from './supabase';
import { deleteRow, friendlyDbError, selectRows } from './db';
import { RAW_BUCKET, SANITIZED_BUCKET } from './logs';

export interface LogPaths {
  object_path: string;
  sanitized_path: string | null;
}

export interface FlightDeleteResult {
  /** Log rows the flight had (cascade-deleted with it). */
  logCount: number;
  /**
   * Storage objects whose removal could not be CONFIRMED — see module docs:
   * genuinely orphaned, or removed-but-RETURNING-filtered (gps_private raw
   * objects deleted by a non-owner). The admin sweep reconciles.
   */
  orphans: string[];
}

/** Bucket-grouped object paths for a set of log rows (pure; unit-tested). */
export function logObjectPaths(logs: LogPaths[]): { raw: string[]; sanitized: string[] } {
  return {
    raw: logs.map((l) => l.object_path).filter((p): p is string => !!p),
    sanitized: logs
      .map((l) => l.sanitized_path)
      .filter((p): p is string => !!p),
  };
}

/**
 * Paths that did NOT come back from storage.remove() — i.e. orphans.
 * remove() reports successes in `data` (name per object); RLS-filtered
 * misses are silent, so requested minus removed is the orphan set (pure).
 */
export function orphanedPaths(
  requested: string[],
  removed: { name?: string | null }[] | null,
): string[] {
  const ok = new Set((removed ?? []).map((r) => r.name).filter(Boolean));
  return requested.filter((p) => !ok.has(p));
}

/** Best-effort bulk remove from one bucket; returns the orphaned paths. */
async function removeObjects(bucket: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { data, error } = await supabase.storage.from(bucket).remove(paths);
  if (error) {
    // Storage failure must NOT block the DB delete — report all as orphans.
    console.warn(`delete: storage remove failed for ${bucket}:`, error.message);
    return paths;
  }
  return orphanedPaths(paths, data);
}

/**
 * Delete a flight: storage objects first (see ordering trap above), then the
 * flights row — the FK cascade cleans flight_logs, summaries, series, param
 * snapshots, notes, tags and payloads DB-side. Throws if the row delete is
 * blocked (RLS) — storage objects removed before a blocked row delete can
 * only happen to users who could delete them anyway (same permission source).
 */
export async function deleteFlight(flightId: string): Promise<FlightDeleteResult> {
  const logs = await selectRows<LogPaths[]>(
    supabase
      .from('flight_logs')
      .select('object_path, sanitized_path')
      .eq('flight_id', flightId),
    'list logs for delete',
  );

  const paths = logObjectPaths(logs);
  const orphans = [
    ...(await removeObjects(RAW_BUCKET, paths.raw)),
    ...(await removeObjects(SANITIZED_BUCKET, paths.sanitized)),
  ];
  if (orphans.length) {
    // The admin sweep's breadcrumb: these object paths no longer have a
    // flight_logs row once the delete below lands.
    console.warn('delete flight: orphaned storage objects:', orphans);
  }

  await deleteRow('flights', flightId, 'delete flight');
  return { logCount: logs.length, orphans };
}

/** How many flights an aircraft has (drives the safe-default block). */
export async function countAircraftFlights(aircraftId: string): Promise<number> {
  const { count, error } = await supabase
    .from('flights')
    .select('id', { count: 'exact', head: true })
    .eq('aircraft_id', aircraftId);
  if (error) throw friendlyDbError('count flights', error);
  return count ?? 0;
}

/**
 * Delete an aircraft (admin-only per RLS). SAFE DEFAULT: refuses while the
 * aircraft still has flights — matching the ON DELETE RESTRICT FK — instead
 * of cascading flight history away. aircraft_operators, component_events,
 * airframe_events and issues DO cascade with the aircraft.
 */
export async function deleteAircraft(aircraftId: string): Promise<void> {
  const flights = await countAircraftFlights(aircraftId);
  if (flights > 0) {
    throw new Error(
      `delete aircraft: blocked — this aircraft still has ${flights} flight${
        flights === 1 ? '' : 's'
      }. Delete or reassign its flights first (flight history is never cascaded away).`,
    );
  }
  await deleteRow('aircraft', aircraftId, 'delete aircraft');
}
