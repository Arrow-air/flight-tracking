# Import — round 1 (builder log)

Date: 2026-08-11 (overnight run). First round of this launch; no prior import
work existed (no import-r* logs, no `scripts/import/`). Built from scratch.

## Delivered (all inside `scripts/import/`)

- `00-restore-v1source.sh` — restores the real v1 backup dumps into a local
  Docker container `v1source` (supabase/postgres:17.6.1.158, port 55432).
  Never touches the live project. Idempotent (marker counts; `--force`
  rebuilds). Handles the image's old auth baseline (adds hosted-project
  columns), creates minimal storage tables for the data-only dump, installs
  `moddatetime` + `pg_trgm` needed by v1 DDL.
- `mapping.md` — full v1 → v2 schema mapping doc, incl. the scope-filter
  ASSUMPTION (below), user mapping, attribution, idempotency rules.
- `01-import.mjs` — the importer (Node, psql + @supabase/supabase-js).
  `--dry-run` and `--skip-storage` flags.
- `README.md` — usage.
- `out/import-report.json`, `out/skip-report.{json,md}` — run evidence.

## Restore evidence (v1source)

Counts after restore match RUN-CONTEXT exactly: **13 aircraft, 193
flight_legs, 197 flight_leg_logs, 18 maintenance, 94 flight_notes,
17 user_profiles, 17 auth.users, 199 storage.objects**. Public dump restored
with 0 errors after extension installs.

## Scope filter — the round's one judgment call (ASSUMPTION, labeled)

v1 `aircraft_type` values: Quiver Devkit (4), Quiver PT3 (6), Quiver v3 (1),
Stork VTOL (1), QuadCopter (1 = "Jis M40"). "Quiver-devkit data only" is read
as the whole **Quiver family** (`KEEP_TYPE_RE = /^Quiver/` in 01-import.mjs):
V2-PLAN Q5 phrases the cut as "anything not from a Quiver devkit", the strict
reading would drop Thomas's own 161-leg PT3 history, and RUN-CONTEXT expects
a parser "backlog" of staged logs. The strict alternative (4 devkit-type
aircraft only) is a one-line filter change. **Flag for critic/Thomas review.**
Skipped either way: Stork VTOL (Spearhead program) and **JIS M-40** ("Jis
M40", serial `NA`, type QuadCopter) — both have explicit skip-report entries;
JIS M-40's cites Thomas's 2026-08-09 exclusion verbatim.

## Import evidence (real numbers, from out/import-report.json)

- Kept: **11/13 aircraft, 191 flights, 192 flight_logs (3 duplicate-checksum
  rows skipped+reported), 94 flight_notes, 16 airframe_events (maintenance),
  9 sites, 5 users created + 2 mapped to seed users**.
- User mapping: v1 Thomas `e80dadf8…` → seed `1111…` (email match), v1 Julius
  `146712de…` → seed `2222…` (name match; NOTE: Julius's real email is
  julius@arrowair.com — the v2 seed placeholder julius@example.com could be
  corrected by the packager, outside import scope). Kellan/ZeynepB/Erick/
  Brandon/"z" created with v1 UUIDs, roles `{operator}`, unusable random
  passwords, profiles via the `handle_new_user` trigger.
- Manufacturer attribution: `built_by`/`created_by` = Thomas for 10 aircraft,
  **Julius for `QVR-GER01-0001` ("Julius Devkit")** — verified by query.
- Operator assignments from v1 ownership: 11 rows (Erick → Houston Devkit,
  Kellan → q_0004, ZeynepB → QVR-PT-GE02A, etc.) — verified by query.
- `QVR-PT-US02B` "(Destroyed)" imported with `status='retired'`.
- Storage staging: **192/192 files uploaded** to bucket `flight-logs` at the
  v2 path convention (`<flight_id>/<sha256[0:12]>_<name>`), sha256 of EVERY
  source file verified against the v1 checksum (192/192), rows
  `status='uploaded'`. Download-back spot-check: **12/12 sha256 match**
  (gate requires ≥10).
- Idempotency: second full run → `inserted_this_run` all zeros, storage
  `existing=192, uploaded=0`, spot-check 12/12. Third run same.
- Skip report: 2 aircraft (Stork VTOL: 2 legs/2 logs/1 maint; Jis M40:
  0 legs/1 maint), 3 dup-checksum log rows, 7 unstaged storage objects
  (2 skipped-aircraft, 3 dup, 2 unreferenced by any v1 row), 10 unreferenced
  v1 users (test/spam accounts).

## Incident found & fixed: watcher race

The live parser watcher (running during this run) woke on the flight_logs
INSERTs (committed before staging) and marked all 192 rows `status='error'`
(HTTP 400 downloading not-yet-uploaded objects) — exactly the race documented
in `src/lib/logs.ts`. Added step 5b to the importer: after staging, flip
plan rows with `status='error' and error like '%storage/v1/object/%'` back to
`'uploaded'` (re-notifies the watcher; genuine parse errors don't match the
pattern). Verified: 192 recovered, and the backlog then parsed for real —
observed `uploaded=186, parsing=2, parsed=4, error=0` minutes later. The
parser chewing the rest overnight is expected and NOT gated (per RUN-CONTEXT).

## Mapping decisions worth review (all in mapping.md)

- `flights.started_at` = v1 leg `created_at` (v1 stored no flight times;
  parser summaries carry true times). ASSUMPTION.
- `aircraft.built_at` = v1 record creation date. ASSUMPTION.
- All flights `gps_private = true` (private by default; v1 had no flag).
- v1 `location` free-text → 9 `sites` rows (private, deterministic UUIDs,
  no coords — quick-log weather autofill needs coords added later).
- v1 maintenance types (build/upgrade/repair/…) all → `airframe_events`
  kind `maintenance`, original type preserved in body provenance line.
- v1/v2 `flight_note_type` enums are identical — direct copy.
- `tags`/`flight_leg_tags` empty in v1; `aircraft_hardware` 0 rows.

## What remains / notes for the critic

- Critic should verify with: `node scripts/import/01-import.mjs` (re-run,
  expect zeros), `out/import-report.json`, `out/skip-report.md` (JIS M-40
  entry present), and spot queries in this log.
- The devkit-filter breadth ASSUMPTION (above) is the main thing a human
  should confirm.
- Parser backlog completion is a parser-phase concern; import gate only
  needed staging + checksum spot-check (done, 12/12).
- v1source container left running (port 55432) for verification; safe to
  `docker rm -f v1source` after the run — `00-restore-v1source.sh` rebuilds it.
