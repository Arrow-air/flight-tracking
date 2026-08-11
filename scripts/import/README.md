# scripts/import — v1 → v2 legacy import

Imports the REAL v1 backup (`backups/`, taken 2026-08-09) into the local v2
stack. Never touches the live hosted v1 project — the restore target is a
dedicated local Docker container (`v1source`).

Docs: **`mapping.md`** — full v1 schema → v2 schema mapping, the devkit-only
scope filter (with the labeled ASSUMPTION about PT3s), user mapping, and
idempotency rules.

## Prerequisites
- colima/Docker running; local v2 stack up (`supabase start`) with migrations
  + seed applied (needs the seeded Thomas/Julius users and the `Quiver`
  aircraft type).
- `backups/v1-public-20260809.dump`, `backups/v1-auth-storage-data-20260809.dump`,
  `backups/v1-storage-flight_logs/` (199 objects, ~4.6 GB).
- Host `psql`/`pg_restore` ≥ 18 at `/opt/homebrew/opt/libpq/bin` (the dumps
  were written by pg_dump 18.4).

## Run
```sh
# 1. restore the v1 backup into the v1source container (idempotent; --force rebuilds)
scripts/import/00-restore-v1source.sh

# 2. import into v2 + stage log files (idempotent; re-run ⇒ 0 new rows)
node scripts/import/01-import.mjs             # full import
node scripts/import/01-import.mjs --dry-run   # plan + reports only, no writes
node scripts/import/01-import.mjs --skip-storage  # DB rows only, no file staging
```

Targets default to the local stack (v1source on 55432, v2 DB on 54322, v2 API
on 54321 with the standard local demo service-role key); override with
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.

## Output (`out/`, regenerated every run)
- `import-report.json` — v1 totals, kept counts, before/after v2 row counts,
  `inserted_this_run` (idempotency evidence), storage staging + checksum
  verification results, ≥10-object download spot-check.
- `skip-report.json` / `skip-report.md` — every skipped aircraft (incl. the
  explicitly excluded **JIS M-40**), duplicate-checksum log rows, unstaged
  storage objects, unimported users.

## What it does (short version)
1. Reads v1 rows from `v1source` (verifies backup counts: 13/193/197).
2. Keeps Quiver-family aircraft only (11 of 13); skips Stork VTOL + Jis M40
   with skip-report entries.
3. Creates/maps users (Thomas→seed admin, Julius→seed manufacturer, 5 others
   created with v1 UUIDs), sites from leg locations, aircraft (manufacturer
   attribution: Thomas, Julius for `QVR-GER01-0001`), operator assignments
   from v1 ownership, flights (flattened legs, `gps_private=true`), notes,
   maintenance → `airframe_events`, `flight_logs` rows (`status='uploaded'`).
4. Stages the actual `.bin` files from `backups/v1-storage-flight_logs/` into
   the v2 `flight-logs` bucket (sha256-verified against the v1 checksum for
   every file), recovers watcher-race rows, then downloads a ≥10 sample back
   and re-hashes it.

All inserts preserve v1 UUIDs and use `on conflict do nothing`, so the import
is safely re-runnable; the parser queue picks up the staged backlog on its own.
