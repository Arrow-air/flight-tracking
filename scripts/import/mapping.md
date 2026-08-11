# v1 → v2 import mapping

Source of truth: the 2026-08-09 backup of the real v1 hosted project, restored
into the local Docker container `v1source` by `00-restore-v1source.sh`
(NEVER the live project). Target: the local v2 stack (`supabase start`,
DB on 127.0.0.1:54322, API on 127.0.0.1:54321).

Real v1 contents (verified after restore, matches RUN-CONTEXT):
13 aircraft, 193 flight_legs, 197 flight_leg_logs, 18 maintenance entries,
94 flight_notes, 17 user_profiles, 17 auth.users, 199 storage objects, tags empty.

## Scope filter — "Quiver-devkit data only"

v1 `aircraft.aircraft_type` values found in the real data:

| aircraft_type   | count | verdict |
|-----------------|-------|---------|
| `Quiver Devkit` | 4     | KEEP    |
| `Quiver PT3`    | 6     | KEEP    |
| `Quiver v3`     | 1     | KEEP    |
| `Stork VTOL`    | 1     | SKIP — Spearhead-program testbed, not Quiver-devkit data |
| `QuadCopter`    | 1     | SKIP — this is "Jis M40" (serial `NA`), explicitly excluded by Thomas (2026-08-09): not devkit-attributable; "the mystery record dies with v1" |

**ASSUMPTION (labeled per RUN-CONTEXT):** "Quiver-devkit data only" is read as
*data from the Quiver devkit program* — every `Quiver*`-type airframe (devkit
units AND the PT3 prototypes and the v3 unit), because (a) V2-PLAN Q5 phrases
the cut as "anything **not from a Quiver devkit** is skipped" with JIS M-40 as
the example, (b) skipping the PT3s would drop Thomas's own 161-leg flight
history, and (c) RUN-CONTEXT expects the parser queue to "chew the backlog" of
staged logs (~195 files), which only happens under this reading. The strict
alternative (only `aircraft_type = 'Quiver Devkit'`, 4 aircraft / 26 legs) is a
one-line change: `KEEP_TYPE_RE` in `01-import.mjs`.

Resulting kept set: **11 aircraft, 191 legs, 195 leg logs, 94 notes,
16 maintenance entries**. Everything skipped gets an explicit entry in
`out/skip-report.{json,md}` — including JIS M-40 ("Jis M40" in the data).

## Users

v1 `user_profiles` (17) are imported **only if referenced** by kept data
(as owner, pilot, log uploader, note author, or maintenance author) — 7 users.
The other 10 (test/spam accounts, no kept references) are skipped + reported.

| v1 user (email) | v2 id | how |
|---|---|---|
| Thomas Garrison `e80dadf8-…` (thomas@arrowair.com) | seed `11111111-…` | matched by email to the seeded admin+manufacturer |
| Julius `146712de-…` (julius@arrowair.com) | seed `22222222-…` | matched by name to the seeded manufacturer (seed email `julius@example.com` is a placeholder; real address is julius@arrowair.com — flagged for the packager, seed fix is outside import scope) |
| Kellan Cerveny, ZeynepB, Erick, Brandon, "z" | v1 UUID kept | new `auth.users` row (random unusable bcrypt password, email confirmed) → `handle_new_user` trigger creates the `user_profiles` row; roles stay default `{operator}` |

"z" (asdf@asdf.com) is clearly a test account but authored kept data, so it is
imported to preserve attribution; noted in the import report.

## Table mapping

### aircraft → aircraft
| v2 | from v1 | notes |
|---|---|---|
| id | `aircraft.id` | UUID preserved (idempotency anchor) |
| serial | `serial_number` | UNIQUE in both |
| name | `name` | |
| type_id | — | all kept airframes → v2 `aircraft_types` row `Quiver` (looked up by name at runtime) |
| status | — | `retired` if v1 name contains "Destroyed" (QVR-PT-US02B), else `active` |
| notes | `notes` | plus a provenance line (`Imported from v1 …`) |
| design_rev | `aircraft_type` | preserves the v1 sub-type (Quiver PT3 / Devkit / v3) |
| built_by, created_by | — | **manufacturer attribution**: Thomas (`1111…`) for every airframe except serial `QVR-GER01-0001` ("Julius Devkit") → Julius (`2222…`) — per Thomas 2026-08-09: he manufactured every devkit except the one Julius built himself |
| built_at | `created_at::date` | ASSUMPTION: v1 record creation ≈ build date (no build date in v1) |
| created_at | `created_at` | preserved |

### aircraft.owner_id → aircraft_operators
One row per kept aircraft with a non-null v1 `owner_id`:
`(aircraft_id, user_id = mapped owner, granted_by = the attributed
manufacturer, granted_at = v1 aircraft.created_at)`. This is the "operator
assignments from v1 ownership" requirement (Erick → Houston Devkit, etc.).
Note Thomas/Julius also get operator edges for their own airframes — harmless
(admin/manufacturer already read everything; the edge records real ownership).

### flight_legs → flights (flatten: 1 leg = 1 flight, decided 2026-08-09)
| v2 | from v1 | notes |
|---|---|---|
| id | `flight_legs.id` | preserved |
| aircraft_id | `aircraft_id` | |
| pilot_id, created_by | `pilot_id` | mapped user |
| site_id | `location` (text) | distinct non-empty location strings become `sites` rows (private, created_by Thomas, deterministic UUID from name, reused if a site of that name already exists); flight links by name |
| started_at | `created_at` | ASSUMPTION: v1 has NO flight times; row creation time is the best available approximation. The parser's log summary supplies true times later. `ended_at` = NULL |
| title | `title` | |
| notes | `description` | plus `Altitude: Nm` / `Temp: N°C` lines when v1 `altitude_m`/`temp_c` set |
| session_id | — | NULL |
| gps_private | — | `true` (Thomas: private by default; v1 had no privacy flag) |
| created_at | `created_at` | preserved |

### flight_notes → flight_notes
`id`, `flight_id = flight_leg_id`, `author = author_id` (mapped),
`type = note_type` (v1 and v2 enums are identical: pilot/admin/engineer/
witness/other), `body = notes`. v2 `body` is NOT NULL: null/empty v1 notes
are skipped + reported. `created_at` preserved.

### aircraft_maintenance_log → airframe_events
| v2 | from v1 | notes |
|---|---|---|
| id | `id` | preserved |
| aircraft_id | `aircraft_id` | kept aircraft only (2 of 18 rows are on skipped aircraft → skip-report) |
| kind | — | always `maintenance` (v2 enum: maintenance/incident/field_action; none of the v1 types — build/maintenance/upgrade/repair/trouble-shooting/ground-run/other — are incidents or field actions) |
| author | `author_id` | mapped |
| occurred_at | `log_date` (fallback `created_at`) | |
| title | `title`, fallback the v1 `log_type` | |
| body | `notes` | plus `[v1 maintenance type: X]` provenance line so the finer-grained v1 enum survives |

### flight_leg_logs → flight_logs + storage staging
| v2 | from v1 | notes |
|---|---|---|
| id | `id` | preserved |
| flight_id | `flight_leg_id` | (0 orphans in the real data) |
| object_path | — | rebuilt to the v2 upload convention (`src/lib/logs.ts`): `<flight_id>/<checksum[0:12]>_<safeName(filename)>` in bucket **flight-logs** |
| checksum | `checksum_sha256` | all 197 rows have one; verified against the actual backup file bytes at staging time |
| size_bytes | `size_bytes` | verified against the file on disk |
| uploaded_by | `uploaded_by_id` | mapped |
| uploaded_at | `created_at` | |
| status | — | `'uploaded'` — the v2 parser queue picks the backlog up from here |
| sanitized_path | — | NULL (parser writes it) |

**Duplicate checksums:** v2 `checksum` is UNIQUE; the real v1 data has 3
checksums that appear twice (same physical file attached to two legs). The
earliest row (by `created_at`, then id) wins; the loser is skipped + reported.

**Staging:** file bytes come from `backups/v1-storage-flight_logs/<v1
object_path>` (all 197 v1 rows join a backed-up storage object; 199 − 195 kept
= 4 objects stay unstaged → skip-report). Upload via the storage API
(service role) with `upsert:false`; "already exists" = idempotent no-op.
DB row is inserted before the storage PUT, per the v2 storage contract.
After staging, ≥10 randomly sampled objects are downloaded back from v2
storage and re-hashed against `flight_logs.checksum` (gate requirement).

## Not imported (and why)
- `tags` / `flight_leg_tags` — empty in the real v1 data.
- `aircraft_hardware` — empty in the real v1 data (0 rows).
- v1 RLS policies, views, triggers — v2 has its own.
- `storage.objects` rows themselves — v2 storage-api creates its own metadata
  on upload.

## Idempotency
Every insert preserves v1 UUIDs and uses `on conflict do nothing`; sites use
name-deterministic UUIDs; storage uploads treat "already exists" as success.
Re-running the import against an already-imported v2 produces 0 new rows
(verified by the run report's `inserted` counters).
