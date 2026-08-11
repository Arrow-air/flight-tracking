#!/usr/bin/env node
/**
 * 01-import.mjs — v1 → v2 data import (see mapping.md for the full mapping).
 *
 *   source : local Docker container `v1source` (restored REAL v1 backup —
 *            run 00-restore-v1source.sh first; NEVER the live project)
 *   target : local v2 Supabase stack (DB 127.0.0.1:54322, API 127.0.0.1:54321)
 *   files  : backups/v1-storage-flight_logs/ → v2 bucket `flight-logs`,
 *            flight_logs.status = 'uploaded' (parser queue takes it from there)
 *
 * Scope: Quiver-devkit data only (KEEP_TYPE_RE below; ASSUMPTION documented in
 * mapping.md — the whole Quiver family is kept, Stork VTOL + "Jis M40" are
 * skipped, each with an explicit skip-report entry).
 *
 * Idempotent: v1 UUIDs preserved + `on conflict do nothing` + storage
 * "already exists" treated as success. Re-run ⇒ 0 new rows.
 *
 * Usage: node scripts/import/01-import.mjs [--dry-run] [--skip-storage]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const BACKUP_STORAGE = join(REPO, 'backups', 'v1-storage-flight_logs');
const OUT_DIR = join(HERE, 'out');

const PSQL = '/opt/homebrew/opt/libpq/bin/psql';
const V1 = { host: '127.0.0.1', port: '55432', user: 'postgres', db: 'postgres', password: 'postgres' };
const V2 = { host: '127.0.0.1', port: '54322', user: 'postgres', db: 'postgres', password: 'postgres' };

const V2_API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
// Local-stack demo key (public knowledge, matches `supabase status`); override for any other target.
const V2_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const RAW_BUCKET = 'flight-logs';

// Scope filter (see mapping.md "Scope filter" — ASSUMPTION labeled there).
const KEEP_TYPE_RE = /^Quiver/;
// Explicit named exclusion (Thomas, 2026-08-09). Matched by v1 aircraft id so
// the skip-report entry exists even if the type rule would already skip it.
const EXPLICIT_SKIPS = {
  '367d45f7-d81a-4aad-bf1e-0d635adc71a1':
    'JIS M-40 ("Jis M40", serial "NA") — explicitly excluded by Thomas (2026-08-09): ' +
    'not devkit-attributable; the mystery record dies with v1.',
};

// v2 seed identities (supabase/seed.sql)
const V2_THOMAS = '11111111-1111-1111-1111-111111111111';
const V2_JULIUS = '22222222-2222-2222-2222-222222222222';
// v1 → v2 user overrides (Thomas matched by email, Julius by name; mapping.md "Users")
const USER_OVERRIDES = {
  'e80dadf8-766f-4bea-b8e2-a344f4256a24': V2_THOMAS, // thomas@arrowair.com
  '146712de-cee2-4872-86bf-bb64ac8bd972': V2_JULIUS, // julius@arrowair.com
};
// Julius built his own devkit — attribution goes to him for this serial only.
const JULIUS_BUILT_SERIALS = new Set(['QVR-GER01-0001']);

const V2_TYPE_NAME = 'Quiver'; // all kept airframes are Quiver-family

const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_STORAGE = process.argv.includes('--skip-storage');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function psql(conn, sql, opts = {}) {
  return execFileSync(
    PSQL,
    ['-v', 'ON_ERROR_STOP=1', '-h', conn.host, '-p', conn.port, '-U', conn.user,
     '-d', conn.db, '-X', '-q', '-At', ...(opts.args ?? [])],
    {
      input: sql,
      env: { ...process.env, PGPASSWORD: conn.password },
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    },
  ).trim();
}

function queryJson(conn, selectSql) {
  const out = psql(conn, `select coalesce(json_agg(t), '[]'::json) from (${selectSql}) t;`);
  return JSON.parse(out);
}

const q = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return `'${String(v).replace(/'/g, "''")}'`;
};

function safeName(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_'); // mirrors src/lib/logs.ts
}

// Deterministic UUID (v5-style, sha1 of a namespace tag + name)
function detUuid(name) {
  const h = createHash('sha1').update(`arrow-v1-import:${name}`).digest('hex');
  return [
    h.slice(0, 8), h.slice(8, 12),
    '5' + h.slice(13, 16),
    ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join('-');
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Load v1 (restored backup)
// ---------------------------------------------------------------------------
console.log('== loading v1 data from v1source ==');
const v1Aircraft = queryJson(V1, `
  select a.id, a.serial_number, a.name, a.aircraft_type, a.notes, a.owner_id,
         a.created_at, up.full_name as owner_name
  from public.aircraft a
  left join public.user_profiles up on up.id = a.owner_id
  order by a.created_at`);
const v1Legs = queryJson(V1, `
  select id, aircraft_id, pilot_id, location, altitude_m, temp_c, title,
         description, created_at
  from public.flight_legs order by created_at`);
const v1Logs = queryJson(V1, `
  select id, flight_leg_id, uploaded_by_id, size_bytes, bucket, object_path,
         checksum_sha256, filename, notes, created_at
  from public.flight_leg_logs order by created_at, id`);
const v1Notes = queryJson(V1, `
  select id, flight_leg_id, author_id, note_type, notes, created_at
  from public.flight_notes order by created_at`);
const v1Maint = queryJson(V1, `
  select id, aircraft_id, author_id, log_type::text as log_type, title, notes,
         log_date, created_at
  from public.aircraft_maintenance_log order by created_at`);
const v1Users = queryJson(V1, `
  select up.id, up.full_name, u.email, u.created_at
  from public.user_profiles up join auth.users u on u.id = up.id`);
const v1StorageObjects = queryJson(V1, `select name from storage.objects`);

console.log(`v1: ${v1Aircraft.length} aircraft, ${v1Legs.length} legs, ` +
  `${v1Logs.length} leg logs, ${v1Notes.length} notes, ${v1Maint.length} maintenance, ` +
  `${v1Users.length} users, ${v1StorageObjects.length} storage objects`);
if (v1Aircraft.length !== 13 || v1Legs.length !== 193 || v1Logs.length !== 197) {
  throw new Error('v1source contents do not match the expected backup counts — re-run 00-restore-v1source.sh --force');
}

// ---------------------------------------------------------------------------
// 2. Build the plan (keep / skip)
// ---------------------------------------------------------------------------
const skipReport = { generated_at: new Date().toISOString(), aircraft: [], flight_logs: [], users: [], storage_objects: [], notes: [] };

const keptAircraft = [];
for (const a of v1Aircraft) {
  const explicit = EXPLICIT_SKIPS[a.id];
  const typeOk = KEEP_TYPE_RE.test(a.aircraft_type ?? '');
  if (explicit || !typeOk) {
    const legs = v1Legs.filter((l) => l.aircraft_id === a.id);
    const legIds = new Set(legs.map((l) => l.id));
    skipReport.aircraft.push({
      v1_id: a.id,
      serial: a.serial_number,
      name: a.name,
      aircraft_type: a.aircraft_type,
      owner: a.owner_name,
      reason: explicit ?? `aircraft_type "${a.aircraft_type}" is not Quiver-devkit data (filter: ${KEEP_TYPE_RE})`,
      skipped_flight_legs: legs.length,
      skipped_leg_logs: v1Logs.filter((l) => legIds.has(l.flight_leg_id)).length,
      skipped_flight_notes: v1Notes.filter((n) => legIds.has(n.flight_leg_id)).length,
      skipped_maintenance: v1Maint.filter((m) => m.aircraft_id === a.id).length,
    });
  } else {
    keptAircraft.push(a);
  }
}
const keptAircraftIds = new Set(keptAircraft.map((a) => a.id));
const keptLegs = v1Legs.filter((l) => keptAircraftIds.has(l.aircraft_id));
const keptLegIds = new Set(keptLegs.map((l) => l.id));
const keptNotes = v1Notes.filter((n) => keptLegIds.has(n.flight_leg_id));
const keptMaint = v1Maint.filter((m) => keptAircraftIds.has(m.aircraft_id));

// Leg logs: kept legs only, dedupe on checksum (v2 UNIQUE) — earliest wins.
const seenChecksum = new Map();
const keptLogs = [];
for (const l of v1Logs.filter((l) => keptLegIds.has(l.flight_leg_id))) {
  const prev = seenChecksum.get(l.checksum_sha256);
  if (prev) {
    skipReport.flight_logs.push({
      v1_id: l.id, flight_leg_id: l.flight_leg_id, filename: l.filename,
      checksum: l.checksum_sha256,
      reason: `duplicate checksum — same physical file already imported as v1 log ${prev.id} (leg ${prev.flight_leg_id}); v2 flight_logs.checksum is UNIQUE`,
    });
    continue;
  }
  seenChecksum.set(l.checksum_sha256, l);
  keptLogs.push(l);
}

// Storage objects that will not be staged
const stagedV1Paths = new Set(keptLogs.map((l) => l.object_path));
for (const o of v1StorageObjects) {
  if (!stagedV1Paths.has(o.name)) {
    const ref = v1Logs.find((l) => l.object_path === o.name);
    skipReport.storage_objects.push({
      v1_path: o.name,
      reason: ref
        ? 'referenced by a skipped/duplicate flight_leg_logs row'
        : 'not referenced by any v1 flight_leg_logs row',
    });
  }
}

// Users: only those referenced by kept data
const referencedUsers = new Set();
for (const a of keptAircraft) if (a.owner_id) referencedUsers.add(a.owner_id);
for (const l of keptLegs) if (l.pilot_id) referencedUsers.add(l.pilot_id);
for (const l of keptLogs) if (l.uploaded_by_id) referencedUsers.add(l.uploaded_by_id);
for (const n of keptNotes) if (n.author_id) referencedUsers.add(n.author_id);
for (const m of keptMaint) if (m.author_id) referencedUsers.add(m.author_id);

const userMap = new Map(); // v1 id -> v2 id
const usersToCreate = [];
for (const u of v1Users) {
  if (!referencedUsers.has(u.id)) {
    skipReport.users.push({ v1_id: u.id, full_name: u.full_name, email: u.email, reason: 'not referenced by any kept (Quiver-devkit) data' });
    continue;
  }
  const override = USER_OVERRIDES[u.id];
  userMap.set(u.id, override ?? u.id);
  if (!override) usersToCreate.push(u);
}
const mapUser = (id) => (id ? (userMap.get(id) ?? null) : null);

// Sites from distinct kept-leg locations
const siteNames = [...new Set(keptLegs.map((l) => (l.location ?? '').trim()).filter(Boolean))];

console.log(`plan: keep ${keptAircraft.length}/13 aircraft, ${keptLegs.length} flights, ` +
  `${keptLogs.length} logs (${skipReport.flight_logs.length} dup-checksum skips), ` +
  `${keptNotes.length} notes, ${keptMaint.length} maintenance, ` +
  `${usersToCreate.length} new users + ${Object.keys(USER_OVERRIDES).length} mapped to seed users, ` +
  `${siteNames.length} sites`);
console.log(`skips: ${skipReport.aircraft.map((a) => `${a.name} [${a.reason.split(' — ')[0]}]`).join('; ')}`);

// ---------------------------------------------------------------------------
// 3. Generate v2 SQL (single transaction, all `on conflict do nothing`)
// ---------------------------------------------------------------------------
const sql = [];
sql.push('begin;');

// 3a. users (auth.users insert fires handle_new_user → user_profiles)
for (const u of usersToCreate) {
  sql.push(`
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
) values (
  '00000000-0000-0000-0000-000000000000', ${q(u.id)}, 'authenticated', 'authenticated',
  ${q(u.email)}, extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}',
  jsonb_build_object('name', ${q(u.full_name)}, 'imported_from_v1', true),
  ${q(u.created_at)}, now(), '', '', '', ''
) on conflict (id) do nothing;
insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values (gen_random_uuid(), ${q(u.id)}, ${q(u.id)},
  jsonb_build_object('sub', ${q(u.id)}, 'email', ${q(u.email)}, 'email_verified', true),
  'email', now(), ${q(u.created_at)}, now())
on conflict (provider_id, provider) do nothing;`);
}

// 3b. sites (deterministic id; reuse an existing site of the same name)
for (const name of siteNames) {
  sql.push(`
insert into public.sites (id, name, visibility, created_by, notes)
select ${q(detUuid(`site:${name}`))}, ${q(name)}, 'private', ${q(V2_THOMAS)},
       'Imported from v1 flight_legs.location'
where not exists (select 1 from public.sites where name = ${q(name)});`);
}

// 3c. aircraft
sql.push(`
-- aircraft type lookup guard
do $$ begin
  if not exists (select 1 from public.aircraft_types where name = ${q(V2_TYPE_NAME)}) then
    raise exception 'aircraft_types row "${V2_TYPE_NAME}" missing — run migrations first';
  end if;
end $$;`);
for (const a of keptAircraft) {
  const attributedTo = JULIUS_BUILT_SERIALS.has(a.serial_number) ? V2_JULIUS : V2_THOMAS;
  const status = /destroyed/i.test(a.name ?? '') ? 'retired' : 'active';
  const notes = [a.notes, `Imported from v1 (${a.aircraft_type}, v1 id ${a.id}).`]
    .filter(Boolean).join('\n\n');
  sql.push(`
insert into public.aircraft (id, serial, name, type_id, status, notes, design_rev,
                             built_by, built_at, created_by, created_at)
values (${q(a.id)}, ${q(a.serial_number)}, ${q(a.name)},
        (select id from public.aircraft_types where name = ${q(V2_TYPE_NAME)}),
        ${q(status)}, ${q(notes)}, ${q(a.aircraft_type)},
        ${q(attributedTo)}, ${q(a.created_at)}::date, ${q(attributedTo)}, ${q(a.created_at)})
on conflict (id) do nothing;`);
  // operator assignment from v1 ownership
  const op = mapUser(a.owner_id);
  if (op) {
    sql.push(`
insert into public.aircraft_operators (aircraft_id, user_id, granted_by, granted_at)
values (${q(a.id)}, ${q(op)}, ${q(attributedTo)}, ${q(a.created_at)})
on conflict do nothing;`);
  }
}

// 3d. flights (flattened legs)
for (const l of keptLegs) {
  const pilot = mapUser(l.pilot_id);
  const loc = (l.location ?? '').trim();
  const noteLines = [l.description?.trim() || null];
  if (l.altitude_m != null) noteLines.push(`Altitude: ${l.altitude_m} m`);
  if (l.temp_c != null) noteLines.push(`Temp: ${l.temp_c} °C`);
  const notes = noteLines.filter(Boolean).join('\n') || null;
  sql.push(`
insert into public.flights (id, aircraft_id, pilot_id, site_id, started_at,
                            title, notes, created_by, gps_private, created_at)
values (${q(l.id)}, ${q(l.aircraft_id)}, ${q(pilot)},
        ${loc ? `(select id from public.sites where name = ${q(loc)} limit 1)` : 'null'},
        ${q(l.created_at)}, ${q(l.title)}, ${q(notes)}, ${q(pilot ?? V2_THOMAS)},
        true, ${q(l.created_at)})
on conflict (id) do nothing;`);
}

// 3e. flight notes (v1/v2 note_type enums are identical)
for (const n of keptNotes) {
  if (!n.notes || !n.notes.trim()) {
    skipReport.notes.push({ v1_id: n.id, flight_leg_id: n.flight_leg_id, reason: 'empty body (v2 body is NOT NULL)' });
    continue;
  }
  sql.push(`
insert into public.flight_notes (id, flight_id, author, type, body, created_at)
values (${q(n.id)}, ${q(n.flight_leg_id)}, ${q(mapUser(n.author_id))},
        ${q(n.note_type)}::public.flight_note_type, ${q(n.notes)}, ${q(n.created_at)})
on conflict (id) do nothing;`);
}

// 3f. maintenance → airframe_events
for (const m of keptMaint) {
  const title = m.title?.trim() || `${m.log_type} (v1 maintenance log)`;
  const body = [m.notes?.trim() || null, `[v1 maintenance type: ${m.log_type}]`]
    .filter(Boolean).join('\n\n');
  sql.push(`
insert into public.airframe_events (id, aircraft_id, kind, author, occurred_at,
                                    title, body, created_at)
values (${q(m.id)}, ${q(m.aircraft_id)}, 'maintenance', ${q(mapUser(m.author_id))},
        coalesce(${q(m.log_date)}::timestamptz, ${q(m.created_at)}::timestamptz),
        ${q(title)}, ${q(body)}, ${q(m.created_at)})
on conflict (id) do nothing;`);
}

// 3g. flight_logs rows (status='uploaded'; object PUT follows in step 5,
// matching the v2 storage contract: metadata row first, then the object)
const stagingPlan = []; // { v2Path, srcPath, checksum, size, logId }
for (const l of keptLogs) {
  const v2Path = `${l.flight_leg_id}/${l.checksum_sha256.slice(0, 12)}_${safeName(l.filename)}`;
  stagingPlan.push({
    v2Path,
    srcPath: join(BACKUP_STORAGE, l.object_path),
    checksum: l.checksum_sha256,
    size: l.size_bytes,
    logId: l.id,
  });
  sql.push(`
insert into public.flight_logs (id, flight_id, object_path, checksum, size_bytes,
                                uploaded_by, uploaded_at, status)
values (${q(l.id)}, ${q(l.flight_leg_id)}, ${q(v2Path)}, ${q(l.checksum_sha256)},
        ${q(l.size_bytes)}, ${q(mapUser(l.uploaded_by_id) ?? V2_THOMAS)},
        ${q(l.created_at)}, 'uploaded')
on conflict (id) do nothing;`);
}

sql.push('commit;');

// ---------------------------------------------------------------------------
// 4. Execute against v2 (with before/after counts for idempotency evidence)
// ---------------------------------------------------------------------------
const countSql = `
select json_build_object(
  'aircraft',       (select count(*) from public.aircraft       where id in (${[...keptAircraftIds].map(q).join(',') || 'null'})),
  'operators',      (select count(*) from public.aircraft_operators where aircraft_id in (${[...keptAircraftIds].map(q).join(',') || 'null'})),
  'flights',        (select count(*) from public.flights         where id in (select id from public.flights where aircraft_id in (${[...keptAircraftIds].map(q).join(',')}))),
  'flight_notes',   (select count(*) from public.flight_notes    where id in (${keptNotes.map((n) => q(n.id)).join(',') || 'null'})),
  'airframe_events',(select count(*) from public.airframe_events where id in (${keptMaint.map((m) => q(m.id)).join(',') || 'null'})),
  'flight_logs',    (select count(*) from public.flight_logs     where id in (${keptLogs.map((l) => q(l.id)).join(',') || 'null'})),
  'users',          (select count(*) from public.user_profiles   where id in (${usersToCreate.map((u) => q(u.id)).join(',') || 'null'})),
  'sites',          (select count(*) from public.sites           where name in (${siteNames.map(q).join(',') || 'null'}))
);`;

const before = JSON.parse(psql(V2, countSql));
console.log('== v2 rows already present (before):', JSON.stringify(before));

if (DRY_RUN) {
  console.log('--dry-run: not executing SQL / storage staging');
} else {
  console.log(`== executing ${sql.length} statements against v2 ==`);
  psql(V2, sql.join('\n'));
}
const after = DRY_RUN ? before : JSON.parse(psql(V2, countSql));
console.log('== v2 rows present (after):', JSON.stringify(after));
const inserted = Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - before[k]]));

// ---------------------------------------------------------------------------
// 5. Stage log files into v2 storage (verify sha256 of every source file)
// ---------------------------------------------------------------------------
const staging = { uploaded: 0, already_present: 0, verified_checksums: 0, failed: [] };
if (!DRY_RUN && !SKIP_STORAGE) {
  console.log(`== staging ${stagingPlan.length} log files into bucket ${RAW_BUCKET} ==`);
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(V2_API_URL, V2_SERVICE_KEY, { auth: { persistSession: false } });

  for (const [i, item] of stagingPlan.entries()) {
    if (!existsSync(item.srcPath)) {
      staging.failed.push({ path: item.v2Path, reason: `backup file missing: ${item.srcPath}` });
      continue;
    }
    const st = statSync(item.srcPath);
    if (Number(st.size) !== Number(item.size)) {
      staging.failed.push({ path: item.v2Path, reason: `size mismatch: file ${st.size} != v1 row ${item.size}` });
      continue;
    }
    const actual = sha256File(item.srcPath);
    if (actual !== item.checksum) {
      staging.failed.push({ path: item.v2Path, reason: `checksum mismatch: file ${actual} != v1 row ${item.checksum}` });
      continue;
    }
    staging.verified_checksums++;

    const { error } = await supabase.storage.from(RAW_BUCKET).upload(
      item.v2Path, readFileSync(item.srcPath),
      { contentType: 'application/octet-stream', upsert: false },
    );
    if (!error) staging.uploaded++;
    else if (/already exists/i.test(error.message) || error.statusCode === '409') staging.already_present++;
    else staging.failed.push({ path: item.v2Path, reason: `upload failed: ${error.message}` });

    if ((i + 1) % 25 === 0 || i === stagingPlan.length - 1) {
      console.log(`  ${i + 1}/${stagingPlan.length} (uploaded=${staging.uploaded} existing=${staging.already_present} failed=${staging.failed.length})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5b. Race recovery (same as src/lib/logs.ts): the parser watcher wakes on the
// row INSERT (committed before staging) and can mark rows 'error' after a 400
// on the not-yet-uploaded object. Now that objects exist, flip those premature
// download errors back to 'uploaded' — the status change re-notifies the
// watcher. Only download-failure errors are matched, so genuine parse errors
// on later re-runs are left alone.
// ---------------------------------------------------------------------------
let raceRecovered = 0;
if (!DRY_RUN && !SKIP_STORAGE) {
  const planIds = stagingPlan.map((p) => q(p.logId)).join(',') || 'null';
  raceRecovered = Number(psql(V2, `
    with fixed as (
      update public.flight_logs
         set status = 'uploaded', error = null
       where id in (${planIds})
         and status = 'error'
         and error like '%storage/v1/object/%'
       returning 1
    ) select count(*) from fixed;`));
  if (raceRecovered) console.log(`race recovery: ${raceRecovered} premature parser errors flipped back to 'uploaded'`);
}

// ---------------------------------------------------------------------------
// 6. Spot-check ≥10 staged objects: download back from v2 storage, re-hash
// ---------------------------------------------------------------------------
const spotCheck = { sampled: 0, passed: 0, failures: [] };
if (!DRY_RUN && !SKIP_STORAGE) {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(V2_API_URL, V2_SERVICE_KEY, { auth: { persistSession: false } });
  const sample = [...stagingPlan].sort(() => Math.random() - 0.5).slice(0, 12);
  console.log(`== spot-checking ${sample.length} staged objects (download + sha256) ==`);
  for (const item of sample) {
    const { data, error } = await supabase.storage.from(RAW_BUCKET).download(item.v2Path);
    spotCheck.sampled++;
    if (error) {
      spotCheck.failures.push({ path: item.v2Path, reason: `download failed: ${error.message}` });
      continue;
    }
    const buf = Buffer.from(await data.arrayBuffer());
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual === item.checksum) spotCheck.passed++;
    else spotCheck.failures.push({ path: item.v2Path, reason: `staged checksum ${actual} != expected ${item.checksum}` });
  }
  console.log(`spot-check: ${spotCheck.passed}/${spotCheck.sampled} passed`);
}

// ---------------------------------------------------------------------------
// 7. Reports
// ---------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const report = {
  generated_at: new Date().toISOString(),
  dry_run: DRY_RUN,
  skip_storage: SKIP_STORAGE,
  source: 'v1source (local Docker restore of backups/v1-public-20260809.dump + auth/storage data dump)',
  v1_totals: {
    aircraft: v1Aircraft.length, flight_legs: v1Legs.length, flight_leg_logs: v1Logs.length,
    flight_notes: v1Notes.length, maintenance: v1Maint.length, users: v1Users.length,
    storage_objects: v1StorageObjects.length,
  },
  kept: {
    aircraft: keptAircraft.length, flights: keptLegs.length, flight_logs: keptLogs.length,
    flight_notes: keptNotes.length - skipReport.notes.length, airframe_events: keptMaint.length,
    users_created: usersToCreate.length, users_mapped_to_seed: Object.keys(USER_OVERRIDES).length,
    sites: siteNames.length,
  },
  v2_rows_before: before,
  v2_rows_after: after,
  inserted_this_run: inserted,
  storage_staging: staging,
  race_recovered_rows: raceRecovered,
  spot_check: spotCheck,
  notes: [
    '"z" (asdf@asdf.com) is a v1 test account but authored kept data; imported to preserve attribution.',
    'Julius real v1 email is julius@arrowair.com; v2 seed uses placeholder julius@example.com (seed fix is outside import scope).',
    'flights.started_at approximated by v1 leg created_at (v1 stored no flight times); parser summaries carry true times.',
  ],
};
writeFileSync(join(OUT_DIR, 'import-report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(OUT_DIR, 'skip-report.json'), JSON.stringify(skipReport, null, 2));

const md = [];
md.push('# v1 → v2 import — skip report', '',
  `Generated ${skipReport.generated_at}. Everything the devkit-only filter (and`,
  'dedupe/consistency rules) excluded, with reasons. See ../mapping.md.', '',
  '## Skipped aircraft');
for (const a of skipReport.aircraft) {
  md.push(`- **${a.name}** (serial \`${a.serial}\`, type "${a.aircraft_type}", owner ${a.owner ?? '—'})`,
    `  - reason: ${a.reason}`,
    `  - dropped with it: ${a.skipped_flight_legs} legs, ${a.skipped_leg_logs} leg logs, ${a.skipped_flight_notes} notes, ${a.skipped_maintenance} maintenance entries`);
}
md.push('', '## Skipped flight-log rows (duplicate checksum)');
for (const l of skipReport.flight_logs) md.push(`- v1 log \`${l.v1_id}\` (${l.filename}): ${l.reason}`);
md.push('', '## Storage objects not staged');
for (const o of skipReport.storage_objects) md.push(`- \`${o.v1_path}\`: ${o.reason}`);
md.push('', '## v1 users not imported');
for (const u of skipReport.users) md.push(`- ${u.full_name} <${u.email}>: ${u.reason}`);
if (skipReport.notes.length) {
  md.push('', '## Skipped flight notes');
  for (const n of skipReport.notes) md.push(`- v1 note \`${n.v1_id}\`: ${n.reason}`);
}
writeFileSync(join(OUT_DIR, 'skip-report.md'), md.join('\n') + '\n');

console.log('== done ==');
console.log(`inserted this run: ${JSON.stringify(inserted)}`);
console.log(`skip report: ${skipReport.aircraft.length} aircraft, ${skipReport.flight_logs.length} dup logs, ` +
  `${skipReport.storage_objects.length} unstaged objects, ${skipReport.users.length} users`);
console.log(`reports written to ${OUT_DIR}/`);
if (staging.failed.length || spotCheck.failures.length) {
  console.error('FAILURES:', JSON.stringify({ staging: staging.failed, spotCheck: spotCheck.failures }, null, 2));
  process.exit(1);
}
