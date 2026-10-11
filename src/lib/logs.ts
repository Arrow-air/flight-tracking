/**
 * Log upload pipeline (client side of the storage contract in
 * supabase/migrations/20260810210500_storage.sql):
 *   1. sha256 the file (dedupe on flight_logs.checksum UNIQUE)
 *   2. INSERT the flight_logs row FIRST as status='uploading'
 *      (the bucket INSERT policy requires the metadata row to exist)
 *   3. PUT the object at that exact path in the 'flight-logs' bucket —
 *      resumable (tus, 6 MB chunks) above RESUMABLE_MIN_BYTES
 *   4. flip the row to 'uploaded', which notifies the parser
 *
 * v2.4: the row used to start at 'uploaded', so the parser raced the PUT and
 * marked big uploads 'error' with storage's "Object not found" (HTTP 400). A
 * 100 MB log over a field connection always lost that race, and a dropped
 * single-request upload left an errored row with no bytes behind it, which
 * the checksum dedupe then blocked from being re-attached. Now a row that
 * never got its bytes stays 'uploading' (or 'error' with the upload failure),
 * and re-attaching the same file resumes into it.
 *
 * Failures surface loudly; a failed PUT marks the row status='error'.
 */
import * as tus from 'tus-js-client';
import { supabase, supabaseUrl, supabaseKey } from './supabase';
import { sha256Hex } from './binlog';
import { insertRow, updateRow, type FlightLog } from './db';

export const RAW_BUCKET = 'flight-logs';
export const SANITIZED_BUCKET = 'flight-logs-sanitized';

/** Files above this go up resumably (Supabase's recommendation is >6 MB). */
export const RESUMABLE_MIN_BYTES = 6 * 1024 * 1024;
/** Supabase's tus endpoint requires exactly 6 MB chunks. */
export const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
/** An 'uploading' row untouched this long is treated as interrupted. */
export const STALLED_UPLOAD_MS = 30 * 60 * 1000;

/** (bytesSent, bytesTotal) */
export type ProgressFn = (sent: number, total: number) => void;

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function resumableEnabled(): boolean {
  return import.meta.env.VITE_RESUMABLE_UPLOADS !== '0';
}

export class DuplicateLogError extends Error {
  constructor(
    public checksum: string,
    /** The flight the existing copy belongs to, when known. */
    public flightId?: string,
  ) {
    super(
      `This log was already uploaded (checksum ${checksum.slice(0, 12)}…). Duplicate skipped.` +
        (flightId
          ? ' If that upload did not finish, open its flight and use "Re-attach .bin" there.'
          : ''),
    );
    this.name = 'DuplicateLogError';
  }
}

export type ExistingLog = Pick<
  FlightLog,
  'id' | 'flight_id' | 'uploaded_at' | 'uploaded_by' | 'status' | 'object_path' | 'checksum'
>;

/**
 * Pre-upload dedupe check (F1): look up an existing flight_logs row by
 * checksum so the UI can warn/skip BEFORE creating a flight stub or
 * moving bytes. Best-effort — errors return null; the UNIQUE index on
 * flight_logs.checksum still guards the race at INSERT time.
 */
export async function findLogByChecksum(checksum: string): Promise<ExistingLog | null> {
  const { data, error } = await supabase
    .from('flight_logs')
    .select('id, flight_id, uploaded_at, uploaded_by, status, object_path, checksum')
    .eq('checksum', checksum)
    .maybeSingle();
  if (error) return null;
  return (data as ExistingLog | null) ?? null;
}

/** True for a row whose bytes may never have landed (pure; unit-tested). */
export function isUnfinishedUpload(
  log: Pick<FlightLog, 'status' | 'error'>,
): boolean {
  if (log.status === 'uploading') return true;
  if (log.status !== 'error') return false;
  const e = log.error ?? '';
  return (
    /upload (did ?n[o']t finish|failed)/i.test(e) ||
    /ObjectMissingError|not_found|Object not found/i.test(e) ||
    // pre-v2.4 rows: the parser's raw HTTPError on a missing object
    /HTTPError: 400 .*\/storage\/v1\/object\//.test(e)
  );
}

/** 'uploading' and not touched for STALLED_UPLOAD_MS (pure; unit-tested). */
export function isStalledUpload(
  log: Pick<FlightLog, 'status' | 'uploaded_at'> & { updated_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (log.status !== 'uploading') return false;
  const t = Date.parse(log.updated_at ?? log.uploaded_at);
  return Number.isFinite(t) && now - t > STALLED_UPLOAD_MS;
}

/** May this user resume an unfinished upload into `existing`? (pure) */
export function canResumeInto(
  existing: Pick<FlightLog, 'flight_id' | 'uploaded_by' | 'status' | 'error'>,
  flightId: string,
  uid: string | null,
): boolean {
  return (
    !!uid &&
    existing.flight_id === flightId &&
    existing.uploaded_by === uid &&
    (existing.status === 'uploading' || existing.status === 'error')
  );
}

// --- errors -----------------------------------------------------------------

class UploadError extends Error {
  constructor(
    message: string,
    /** storage said the object is already there (409 / "already exists") */
    public alreadyExists = false,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** The resumable endpoint isn't usable here; fall back to a single PUT. */
class ResumableUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumableUnavailableError';
  }
}

/** Storage answers errors as JSON {statusCode, error, message} (often HTTP 400). */
function storageMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { message?: string; error?: string; statusCode?: string };
    return j.message || j.error || body;
  } catch {
    return body;
  }
}

const ALREADY_EXISTS = /already exists|Duplicate/i;

function isMissingEnumValue(e: unknown): boolean {
  return e instanceof Error && /invalid input value for enum/i.test(e.message);
}

function isDuplicateRow(e: unknown): boolean {
  return e instanceof Error && /duplicate/i.test(e.message);
}

// --- storage PUT ------------------------------------------------------------

async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

/**
 * Resumable upload via Supabase's tus endpoint. The upload URL is kept in
 * localStorage under a fingerprint of (object path, file), so re-attaching
 * the same file to the same log continues from the last acknowledged chunk.
 */
function tusUpload(objectPath: string, file: File, onProgress?: ProgressFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      chunkSize: TUS_CHUNK_BYTES,
      retryDelays: [0, 3000, 5000, 10000, 20000, 30000, 60000, 60000],
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      headers: { apikey: supabaseKey, 'x-upsert': 'false' },
      metadata: {
        bucketName: RAW_BUCKET,
        objectName: objectPath,
        contentType: 'application/octet-stream',
        cacheControl: '3600',
      },
      fingerprint: async (f: File) =>
        ['arrow-log', supabaseUrl, objectPath, f.size, f.lastModified].join('|'),
      // Long uploads outlive the 1 h access token; fetch a fresh one per request.
      onBeforeRequest: async (req) => {
        const token = await accessToken();
        if (token) req.setHeader('authorization', `Bearer ${token}`);
      },
      onShouldRetry: (err) => {
        const status = err.originalResponse?.getStatus() ?? 0;
        const body = err.originalResponse?.getBody() ?? '';
        if (ALREADY_EXISTS.test(body)) return false;
        // auth / policy / size rejections won't fix themselves
        if (status >= 400 && status < 500 && ![409, 423, 429].includes(status)) return false;
        return true; // network drops and 5xx
      },
      onProgress: (sent, total) => onProgress?.(sent, total),
      onError: (err) => reject(classifyTusError(err)),
      onSuccess: () => resolve(),
    });
    upload.findPreviousUploads().then(
      (previous) => {
        if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      },
      () => upload.start(),
    );
  });
}

function classifyTusError(err: Error): Error {
  const res = (err as tus.DetailedError).originalResponse ?? null;
  const status = res?.getStatus() ?? 0;
  const body = res?.getBody() ?? '';
  if (ALREADY_EXISTS.test(body)) return new UploadError(storageMessage(body), true);
  if (status === 404 || status === 405 || /missing Location header/i.test(err.message)) {
    return new ResumableUnavailableError(err.message);
  }
  if (res) return new UploadError(storageMessage(body) || `HTTP ${status}`);
  return new UploadError(err.message || 'network error');
}

/** Single-request PUT (small files, or when the tus endpoint is unusable). */
async function simpleUpload(objectPath: string, file: File, onProgress?: ProgressFn) {
  const { error } = await supabase.storage.from(RAW_BUCKET).upload(objectPath, file, {
    contentType: 'application/octet-stream',
    upsert: false,
  });
  if (error) throw new UploadError(error.message, ALREADY_EXISTS.test(error.message));
  onProgress?.(file.size, file.size);
}

async function putObject(objectPath: string, file: File, onProgress?: ProgressFn) {
  if (resumableEnabled() && file.size > RESUMABLE_MIN_BYTES) {
    try {
      await tusUpload(objectPath, file, onProgress);
      return;
    } catch (e) {
      if (!(e instanceof ResumableUnavailableError)) throw e;
      console.warn('resumable upload unavailable, falling back to a single PUT:', e.message);
    }
  }
  await simpleUpload(objectPath, file, onProgress);
}

// --- pipeline ---------------------------------------------------------------

/**
 * PUT the bytes for `row`, then queue it for parsing. `staged` = the row is
 * in 'uploading' (v2.4); false only on a database without that enum value,
 * where the old race-recovery applies.
 */
async function putAndQueue(
  row: FlightLog,
  file: File,
  staged: boolean,
  onProgress?: ProgressFn,
): Promise<FlightLog> {
  try {
    await putObject(row.object_path, file, onProgress);
  } catch (e) {
    const alreadyThere = e instanceof UploadError && e.alreadyExists;
    if (!alreadyThere) {
      const msg = e instanceof Error ? e.message : String(e);
      // Surface the failure on the row itself — never a silent half-upload.
      try {
        await updateRow('flight_logs', row.id, {
          status: 'error',
          error: `upload didn't finish: ${msg}. Re-attach the same .bin to resume.`,
        });
      } catch {
        /* row-level error note is best-effort */
      }
      throw new Error(`upload ${file.name}: ${msg}`);
    }
    // The object is already in storage (an earlier attempt landed): just queue it.
  }

  if (staged) {
    return updateRow<FlightLog>(
      'flight_logs',
      row.id,
      { status: 'uploaded', error: null },
      'queue log for parsing',
    );
  }

  // Legacy race recovery (pre-v2.4 schema): the watcher wakes on the row
  // INSERT and can try to download BEFORE the PUT above finished, marking
  // the row 'error'. Now that the object exists, flip any premature error
  // back to 'uploaded' — the status change re-notifies the watcher.
  const { data: recovered } = await supabase
    .from('flight_logs')
    .update({ status: 'uploaded', error: null })
    .eq('id', row.id)
    .eq('status', 'error')
    .select();
  if (recovered?.length) return recovered[0] as FlightLog;
  return row;
}

/** Put an existing row back into 'uploading' and finish its upload. */
async function resumeInto(row: FlightLog, file: File, onProgress?: ProgressFn) {
  try {
    row = await updateRow<FlightLog>(
      'flight_logs',
      row.id,
      { status: 'uploading', error: null },
      'resume upload',
    );
  } catch (e) {
    // Pre-v2.4 schema: no 'uploading' state, the row just keeps its status.
    if (!isMissingEnumValue(e)) throw e;
  }
  // Either way the resumed row ends queued as 'uploaded' once the bytes land.
  return putAndQueue(row, file, true, onProgress);
}

export async function uploadFlightLog(
  flightId: string,
  file: File,
  /** Skip re-hashing when the caller already computed the sha256 (F1 pre-check). */
  precomputedChecksum?: string,
  onProgress?: ProgressFn,
): Promise<FlightLog> {
  const checksum = precomputedChecksum ?? (await sha256Hex(file));
  const objectPath = `${flightId}/${checksum.slice(0, 12)}_${safeName(file.name)}`;
  const values = {
    flight_id: flightId,
    object_path: objectPath,
    checksum,
    size_bytes: file.size,
  };
  const context = `register log ${file.name}`;

  let row: FlightLog;
  let staged = true;
  try {
    try {
      row = await insertRow<FlightLog>('flight_logs', { ...values, status: 'uploading' }, context);
    } catch (e) {
      if (!isMissingEnumValue(e)) throw e;
      // Database predates migration 20261011120000: old flow.
      staged = false;
      row = await insertRow<FlightLog>('flight_logs', values, context);
    }
  } catch (e) {
    if (!isDuplicateRow(e)) throw e;
    // Same bytes already registered. If it's this user's unfinished upload on
    // this flight, finish it instead of refusing.
    const existing = await findLogByChecksum(checksum);
    const uid = await currentUserId();
    if (existing && canResumeInto({ ...existing, error: null }, flightId, uid)) {
      return resumeInto({ ...(existing as FlightLog), size_bytes: file.size }, file, onProgress);
    }
    throw new DuplicateLogError(checksum, existing?.flight_id);
  }

  return putAndQueue(row, file, staged, onProgress);
}

/**
 * Re-attach the original .bin to a log whose upload never finished (or
 * whose raw object went missing). Refuses a different file: the row's
 * checksum is the identity the parser and dedupe rely on.
 */
export async function reattachFlightLog(
  log: FlightLog,
  file: File,
  onProgress?: ProgressFn,
): Promise<FlightLog> {
  const checksum = await sha256Hex(file);
  if (checksum !== log.checksum) {
    throw new Error(
      `That isn't the same file: ${file.name} has checksum ${checksum.slice(0, 12)}…, ` +
        `this log expects ${log.checksum.slice(0, 12)}…. Pick the original .bin, or delete ` +
        'this log and attach the new file.',
    );
  }
  return resumeInto(log, file, onProgress);
}

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
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
