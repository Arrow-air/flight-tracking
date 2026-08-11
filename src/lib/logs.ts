/**
 * Log upload pipeline (client side of the storage contract in
 * supabase/migrations/20260810210500_storage.sql):
 *   1. sha256 the file (dedupe on flight_logs.checksum UNIQUE)
 *   2. INSERT the flight_logs row FIRST (object_path, checksum, size)
 *   3. PUT the object at that exact path in the 'flight-logs' bucket
 *      (the bucket INSERT policy requires the metadata row to exist)
 * Failures surface loudly; a failed storage PUT marks the row status='error'.
 */
import { supabase } from './supabase';
import { sha256Hex } from './binlog';
import { insertRow, updateRow, type FlightLog } from './db';

export const RAW_BUCKET = 'flight-logs';
export const SANITIZED_BUCKET = 'flight-logs-sanitized';

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}

export class DuplicateLogError extends Error {
  constructor(public checksum: string) {
    super(
      `This log was already uploaded (checksum ${checksum.slice(0, 12)}…). Duplicate skipped.`,
    );
    this.name = 'DuplicateLogError';
  }
}

export async function uploadFlightLog(
  flightId: string,
  file: File,
): Promise<FlightLog> {
  const checksum = await sha256Hex(file);
  const objectPath = `${flightId}/${checksum.slice(0, 12)}_${safeName(file.name)}`;

  let row: FlightLog;
  try {
    row = await insertRow<FlightLog>(
      'flight_logs',
      {
        flight_id: flightId,
        object_path: objectPath,
        checksum,
        size_bytes: file.size,
      },
      `register log ${file.name}`,
    );
  } catch (e) {
    if (e instanceof Error && /duplicate/i.test(e.message)) {
      throw new DuplicateLogError(checksum);
    }
    throw e;
  }

  const { error: putError } = await supabase.storage
    .from(RAW_BUCKET)
    .upload(objectPath, file, {
      contentType: 'application/octet-stream',
      upsert: false,
    });

  if (putError) {
    // Surface the failure on the row itself — never a silent half-upload.
    try {
      await updateRow('flight_logs', row.id, {
        status: 'error',
        error: `storage upload failed: ${putError.message}`,
      });
    } catch {
      /* row-level error note is best-effort */
    }
    throw new Error(`upload ${file.name}: storage PUT failed — ${putError.message}`);
  }

  // Race recovery: the watcher wakes on the row INSERT (pg_notify) and can
  // try to download BEFORE the PUT above finished, marking the row 'error'.
  // Now that the object exists, flip any premature error back to 'uploaded'
  // — the status change re-notifies the watcher. Parser writes are upserts,
  // so a double parse is harmless.
  const { data: recovered } = await supabase
    .from('flight_logs')
    .update({ status: 'uploaded', error: null })
    .eq('id', row.id)
    .eq('status', 'error')
    .select();
  if (recovered?.length) {
    return recovered[0] as FlightLog;
  }
  return row;
}

/** Re-queue a failed log for parsing (writers only; RLS enforces). */
export async function requeueLog(logId: string): Promise<void> {
  await updateRow('flight_logs', logId, { status: 'uploaded', error: null }, 'retry parse');
}

/** Signed URL for a raw log (storage RLS decides; error → null). */
export async function rawLogUrl(objectPath: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(RAW_BUCKET)
    .createSignedUrl(objectPath, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/** Signed URL for the sanitized (GPS-stripped) copy. */
export async function sanitizedLogUrl(
  sanitizedPath: string,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(SANITIZED_BUCKET)
    .createSignedUrl(sanitizedPath, 3600);
  if (error) return null;
  return data?.signedUrl ?? null;
}
