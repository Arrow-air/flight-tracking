/**
 * Data-access layer with the v1-pain-point-#1 discipline: every write either
 * returns the affected row(s) or THROWS a human-readable error. RLS denials
 * surface as errors (42501) or as 0-rows-returned — both become exceptions
 * here, so no caller can silently "succeed" without a row.
 */
import { supabase } from './supabase';

// ---------------------------------------------------------------------------
// Row types (mirror supabase/migrations — the fields the UI touches)
// ---------------------------------------------------------------------------
export type Role = 'admin' | 'manufacturer' | 'operator';

export interface Profile {
  id: string;
  name: string | null;
  roles: Role[];
  gps_default_private: boolean;
}

export interface AircraftType {
  id: string;
  name: string;
  class: 'multirotor' | 'fixed_wing';
  cells: number | null;
}

export interface Aircraft {
  id: string;
  serial: string;
  name: string | null;
  type_id: string;
  status: 'active' | 'maintenance' | 'retired';
  notes: string | null;
  photo_path: string | null;
  design_rev: string | null;
  built_by: string | null;
  built_at: string | null;
  created_by: string;
  created_at: string;
  aircraft_types?: AircraftType;
}

export interface Site {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  elevation_m: number | null;
  notes: string | null;
  visibility: 'public' | 'private';
  created_by: string | null;
}

export interface Flight {
  id: string;
  aircraft_id: string;
  pilot_id: string | null;
  site_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
  notes: string | null;
  created_by: string;
  session_id: string | null;
  gps_private: boolean;
  created_at: string;
}

export type FlightLogStatus = 'uploaded' | 'parsing' | 'parsed' | 'error';

export interface FlightLog {
  id: string;
  flight_id: string;
  object_path: string;
  sanitized_path: string | null;
  checksum: string;
  size_bytes: number | null;
  uploaded_by: string;
  uploaded_at: string;
  status: FlightLogStatus;
  error: string | null;
}

export interface HealthCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | string;
  value: number | null;
  threshold: number | null;
  detail: string;
}

export interface FlightLogSummary {
  log_id: string;
  duration_s: number | null;
  distance_m: number | null;
  max_alt_m: number | null;
  max_speed_mps: number | null;
  battery: {
    volt_start?: number | null;
    volt_min?: number | null;
    volt_max?: number | null;
    sag_v?: number | null;
    curr_max_a?: number | null;
    mah_used?: number | null;
    energy_wh?: number | null;
    cells?: number | null;
    cells_source?: string;
    per_cell_min?: number | null;
    per_cell_sag?: number | null;
  } | null;
  health: { score?: number; grade?: string; checks?: HealthCheck[] } | null;
  modes: { t_s: number; mode: string; mode_num?: number }[] | null;
  events: { t_s: number; id?: number; event: string }[] | null;
  errors: unknown[] | null;
  wind: Record<string, unknown> | null;
}

export interface ComponentRow {
  id: string;
  kind: string;
  part_no: string | null;
  serial: string | null;
  batch_no: string | null;
  vendor: string | null;
  notes: string | null;
}

export interface ComponentEvent {
  id: string;
  aircraft_id: string;
  component_id: string;
  event: 'installed' | 'removed';
  position: string | null;
  occurred_at: string;
  performed_by: string | null;
  reason: string | null;
  notes: string | null;
  components?: ComponentRow;
}

export interface AirframeEvent {
  id: string;
  aircraft_id: string;
  kind: 'maintenance' | 'incident' | 'field_action';
  author: string | null;
  occurred_at: string;
  title: string;
  body: string | null;
  hours_at: number | null;
  flight_id: string | null;
}

export interface FlightNote {
  id: string;
  flight_id: string;
  author: string | null;
  type: 'pilot' | 'admin' | 'engineer' | 'witness' | 'other';
  body: string;
  created_at: string;
}

export interface Tag {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Error translation + strict write helpers
// ---------------------------------------------------------------------------
interface PgError {
  code?: string;
  message?: string;
  details?: string | null;
  hint?: string | null;
}

export function friendlyDbError(context: string, e: PgError): Error {
  const code = e.code ?? '';
  if (code === '42501') {
    return new Error(
      `${context}: permission denied — your role is not allowed to do this. (${e.message ?? 'RLS policy rejected the write'})`,
    );
  }
  if (code === '23505') {
    return new Error(
      `${context}: duplicate — a record with this unique value already exists. (${e.details ?? e.message ?? ''})`,
    );
  }
  if (code === 'PGRST116') {
    return new Error(
      `${context}: the write affected no rows — blocked by permissions or the record does not exist.`,
    );
  }
  return new Error(`${context}: ${e.message ?? 'unknown database error'}`);
}

/** INSERT one row; returns the created row or throws (never silent). */
export async function insertRow<T = Record<string, unknown>>(
  table: string,
  values: Record<string, unknown>,
  context?: string,
): Promise<T> {
  const { data, error } = await supabase
    .from(table)
    .insert(values)
    .select()
    .maybeSingle();
  const ctx = context ?? `insert into ${table}`;
  if (error) throw friendlyDbError(ctx, error);
  if (!data) {
    throw new Error(
      `${ctx}: no row returned — the write was blocked (permission denied) or dropped. Nothing was saved.`,
    );
  }
  return data as T;
}

/** UPDATE by id; throws if 0 rows were affected (RLS or missing record). */
export async function updateRow<T = Record<string, unknown>>(
  table: string,
  id: string,
  values: Record<string, unknown>,
  context?: string,
): Promise<T> {
  const { data, error } = await supabase
    .from(table)
    .update(values)
    .eq('id', id)
    .select();
  const ctx = context ?? `update ${table}`;
  if (error) throw friendlyDbError(ctx, error);
  if (!data || data.length === 0) {
    throw new Error(
      `${ctx}: 0 rows updated — you may not have permission for this record. Nothing was saved.`,
    );
  }
  return data[0] as T;
}

/** DELETE by id; throws if 0 rows were affected. */
export async function deleteRow(
  table: string,
  id: string,
  context?: string,
): Promise<void> {
  const { data, error } = await supabase
    .from(table)
    .delete()
    .eq('id', id)
    .select();
  const ctx = context ?? `delete from ${table}`;
  if (error) throw friendlyDbError(ctx, error);
  if (!data || data.length === 0) {
    throw new Error(
      `${ctx}: 0 rows deleted — you may not have permission for this record.`,
    );
  }
}

/** SELECT that throws on error (reads may legitimately return []). */
export async function selectRows<T>(
  builder: PromiseLike<{ data: unknown; error: PgError | null }>,
  context: string,
): Promise<T> {
  const { data, error } = await builder;
  if (error) throw friendlyDbError(context, error);
  return (data ?? []) as T;
}
