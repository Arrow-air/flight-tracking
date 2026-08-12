/**
 * Composable (AND) filters for the fleet (C2) and flights (E2) pages,
 * kept pure so they unit-test without Vue or Supabase. Every filter state
 * round-trips through URL query params (parse* / *ToQuery) so engineers
 * can share filtered views by copying the address bar.
 *
 * Conventions:
 *  - '' (empty string) always means "no filter" and is omitted from the URL;
 *  - boolean filters serialize as '1' and parse '1'/'true';
 *  - unknown/malformed params degrade to "no filter", never throw.
 */
import type { FlightIncident } from './db';
import { flightStartIso, type LogWithSummary } from './flightMetrics';

// ---------------------------------------------------------------------------
// Query-param primitives (vue-router LocationQuery values are
// string | null | (string | null)[])
// ---------------------------------------------------------------------------
type QueryValue = unknown;

/** First scalar of a query param, '' when absent/null. */
export function firstParam(v: QueryValue): string {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v : '';
}

/** Boolean query param: '1' or 'true'. */
export function flagParam(v: QueryValue): boolean {
  const s = firstParam(v).toLowerCase();
  return s === '1' || s === 'true';
}

/** 'YYYY-MM-DD' (from <input type="date">) or ''. */
function dateParam(v: QueryValue): string {
  const s = firstParam(v);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** Local-timezone calendar date of an ISO timestamp, as 'YYYY-MM-DD'. */
export function localDateStr(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Drop ''-valued entries so the URL only carries active filters. */
function compactQuery(q: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(q)) {
    if (v !== '') out[k] = v;
  }
  return out;
}

/** Structural equality for serialized filter queries (loop guard for
 *  route.query <-> state watchers). */
export function sameQuery(
  a: Record<string, string>,
  b: Record<string, QueryValue>,
): boolean {
  const bKeys = Object.keys(b);
  if (Object.keys(a).length !== bKeys.length) return false;
  return bKeys.every((k) => a[k] === firstParam(b[k]));
}

// ---------------------------------------------------------------------------
// C2 — fleet filters
// ---------------------------------------------------------------------------
export interface FleetFilterState {
  /** aircraft_types.id, '' = all */
  type: string;
  /** aircraft.status ('active' | 'maintenance' | 'retired'), '' = all */
  status: string;
  /** manufactured by me (built_by, else created_by, equals current user) */
  mfg: boolean;
  /** operated by me (current user in aircraft_operators) */
  op: boolean;
}

export function parseFleetFilters(q: Record<string, QueryValue>): FleetFilterState {
  return {
    type: firstParam(q.type),
    status: firstParam(q.status),
    mfg: flagParam(q.mfg),
    op: flagParam(q.op),
  };
}

export function fleetFiltersToQuery(f: FleetFilterState): Record<string, string> {
  return compactQuery({
    type: f.type,
    status: f.status,
    mfg: f.mfg ? '1' : '',
    op: f.op ? '1' : '',
  });
}

export function hasFleetFilters(f: FleetFilterState): boolean {
  return Object.keys(fleetFiltersToQuery(f)).length > 0;
}

/** The fields filterAircraft needs (structural subset of db.Aircraft). */
export interface AircraftFilterable {
  id: string;
  type_id: string;
  status: string;
  built_by: string | null;
  created_by: string;
}

export interface FleetFilterCtx {
  userId: string | null;
  /** aircraft ids the user operates (auth.operatorOf) */
  operatorOf: string[];
}

/** "Manufactured by me": built_by when set, else the record's creator
 *  (aircraft rows are born via the manufacturer workflow). */
export function builtByUser(
  a: Pick<AircraftFilterable, 'built_by' | 'created_by'>,
  userId: string | null,
): boolean {
  if (!userId) return false;
  return (a.built_by ?? a.created_by) === userId;
}

/** All active fleet filters must pass (AND). */
export function filterAircraft<T extends AircraftFilterable>(
  list: T[],
  f: FleetFilterState,
  ctx: FleetFilterCtx,
): T[] {
  return list.filter((a) => {
    if (f.type && a.type_id !== f.type) return false;
    if (f.status && a.status !== f.status) return false;
    if (f.mfg && !builtByUser(a, ctx.userId)) return false;
    if (f.op && !ctx.operatorOf.includes(a.id)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// E2 — flights filters
// ---------------------------------------------------------------------------
export interface FlightFilterState {
  /** aircraft_types.id via the flight's aircraft, '' = all */
  type: string;
  /** specific aircraft id, '' = all */
  aircraft: string;
  /** site id, '' = all */
  site: string;
  /** manufacturer (user id; matches builtByUser of the flight's aircraft) */
  builder: string;
  /** '' = all, 'any' = incident != none, else exact FlightIncident value */
  incident: string;
  /** pilot user id, '' = all */
  pilot: string;
  /** '' = all, 'with' = has >=1 log, 'without' = no logs */
  log: string;
  /** inclusive local-date range on the flight's best start time */
  from: string;
  to: string;
}

const INCIDENT_VALUES: readonly string[] = [
  'any',
  'none',
  'crash',
  'hard_landing',
  'systems',
  'other',
];

export function parseFlightFilters(q: Record<string, QueryValue>): FlightFilterState {
  const incident = firstParam(q.incident);
  const log = firstParam(q.log);
  return {
    type: firstParam(q.type),
    aircraft: firstParam(q.aircraft),
    site: firstParam(q.site),
    builder: firstParam(q.builder),
    incident: INCIDENT_VALUES.includes(incident) ? incident : '',
    pilot: firstParam(q.pilot),
    log: log === 'with' || log === 'without' ? log : '',
    from: dateParam(q.from),
    to: dateParam(q.to),
  };
}

export function flightFiltersToQuery(f: FlightFilterState): Record<string, string> {
  return compactQuery({
    type: f.type,
    aircraft: f.aircraft,
    site: f.site,
    builder: f.builder,
    incident: f.incident,
    pilot: f.pilot,
    log: f.log,
    from: f.from,
    to: f.to,
  });
}

export function hasFlightFilters(f: FlightFilterState): boolean {
  return Object.keys(flightFiltersToQuery(f)).length > 0;
}

/** The fields filterFlights needs (structural subset of a flights row). */
export interface FlightFilterable {
  aircraft_id: string;
  site_id: string | null;
  pilot_id: string | null;
  incident: FlightIncident;
  started_at: string | null;
  flight_logs?: LogWithSummary[];
}

/** Aircraft facts the flight filter joins against (by aircraft_id). */
export interface AircraftFacts {
  type_id: string;
  built_by: string | null;
  created_by: string;
}

export interface FlightFilterCtx {
  aircraftById: Map<string, AircraftFacts>;
}

/** All active flight filters must pass (AND). */
export function filterFlights<T extends FlightFilterable>(
  list: T[],
  f: FlightFilterState,
  ctx: FlightFilterCtx,
): T[] {
  return list.filter((fl) => {
    const ac = ctx.aircraftById.get(fl.aircraft_id);
    if (f.aircraft && fl.aircraft_id !== f.aircraft) return false;
    if (f.type && ac?.type_id !== f.type) return false;
    if (f.builder && !(ac && (ac.built_by ?? ac.created_by) === f.builder)) {
      return false;
    }
    if (f.site && fl.site_id !== f.site) return false;
    if (f.pilot && fl.pilot_id !== f.pilot) return false;
    if (f.incident === 'any') {
      if (fl.incident === 'none') return false;
    } else if (f.incident && fl.incident !== f.incident) {
      return false;
    }
    const logCount = fl.flight_logs?.length ?? 0;
    if (f.log === 'with' && logCount === 0) return false;
    if (f.log === 'without' && logCount > 0) return false;
    if (f.from || f.to) {
      // Best start time (parser's start_time_utc wins), compared as a
      // LOCAL calendar date so "from 2026-08-11" means the user's day.
      const day = localDateStr(flightStartIso(fl.flight_logs, fl.started_at));
      if (!day) return false; // undated flights can't match a date range
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
    }
    return true;
  });
}
