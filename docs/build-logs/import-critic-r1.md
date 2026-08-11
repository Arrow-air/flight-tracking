# Import — round 1 critic (gate) log

Date: 2026-08-11 (overnight run). Verdict: **PASS** (details + numbers below).
Method: independent re-run from scratch per the gate spec — `supabase db reset`,
then `node scripts/import/01-import.mjs` twice (fresh run + idempotency run),
plus my own queries and an independent checksum spot-check (not the importer's
self-check).

## Environment incident found and remediated mid-gate (not an importer defect)

First fresh-run attempt crashed at ~75/192 staged files: the **host disk was
full** (738 MB free on `/System/Volumes/Data`), so the colima VM's sparse disk
images could not grow → virtio I/O errors → **ext4 journal abort** on the
docker data disk (`vdb1`, dmesg: `Aborting journal on device vdb1-8`) → the
supabase db container crashed mid-staging. Note the storage volume held **7.0 G
of orphaned objects** (a full pre-reset generation of raw + sanitized copies —
`supabase db reset` wipes `storage.objects` rows but not the backing files, and
supabase-storage versions files, so every reset+restage doubles disk).

Remediation performed:
1. `npm cache clean --force` on the host (freed 4.3 G so the VM could write).
2. `colima stop && colima start` (ext4 journal recovery on mount).
3. Wiped `/var/lib/docker/volumes/supabase_storage_flight-tracking/_data/*`
   (the 7.0 G of orphans; storage container stopped first), `fstrim -av`
   (8.4 GiB returned to the host), restarted containers + `v1source`.
4. Fresh `supabase db reset`, then the gate runs below. Host free space after:
   ~13 Gi. **Still tight — see issues.**

Both parser watchers died in the incident; I restarted one
(`parser/.venv/bin/python parser/watcher.py`, log
`/tmp/parser-watcher-restart.log`) so the staged backlog gets chewed overnight.

## Gate evidence (all numbers observed, commands noted)

v1source (restored real backup, port 55432) verified before the run:
13 aircraft / 193 flight_legs / 197 flight_leg_logs / 18 maintenance /
94 flight_notes / 17 user_profiles / 199 storage.objects — matches RUN-CONTEXT.

Run 1 (fresh DB, `/tmp/import-run1.log`, exit 0):
- before: all zeros; after/inserted: **aircraft 11, operators 11, flights 191,
  flight_notes 94, airframe_events 16, flight_logs 192, users 5, sites 9**.
- Cross-checked against v1 by my own SQL: legs on kept (Quiver%) aircraft
  = 191, maintenance on kept = 16, notes on kept legs = 94, leg logs on kept
  legs = 195 with **192 distinct checksums** (3 dupes skipped + reported).
- Attribution (query over aircraft × user_profiles): built_by/created_by =
  Thomas for 10 aircraft, **Julius for QVR-GER01-0001** ("Julius Devkit");
  QVR-PT-US02B "(Destroyed)" → status `retired`.
- Operator assignments = v1 ownership 1:1 for all 11 kept aircraft (Kellan →
  q_0004, ZeynepB → QVR-PT-GE02A, Erick → QVR-US01-0003, Julius → his devkit,
  Thomas → the 7 he owned).
- Pilot distribution matches v1 exactly (Thomas 172, Erick 12, ZeynepB 3,
  Kellan/Julius/z/Brandon 1 each).
- Skips: JIS M-40 ("Jis M40", serial NA, QuadCopter) and Stork VTOL
  (SPH-STRK-TR01A) both have explicit entries in `out/skip-report.{md,json}`;
  `select count(*) from aircraft where name ilike '%jis%' or ...` = **0** in v2.
- Storage staging: 192/192 uploaded, importer verified sha256 of all 192
  source files vs v1 checksums (`verified_checksums: 192`, `failed: []`).
- **Independent** spot-check (my own script, not the importer's): 12 random
  `flight_logs` rows downloaded from v2 storage via the API → sha256 + size
  vs DB checksum: **12/12 match**. Plus 3 random source backup files re-hashed
  vs v1 `checksum_sha256`: 3/3 match.
- storage.objects in bucket `flight-logs`: **192** exactly; dup object_paths 0;
  orphan flights 0; sites 11 total (9 imported + 2 seed); all 191 flights
  `gps_private = true`.

Run 2 (idempotency, `/tmp/import-run2.log`, exit 0):
- `inserted this run: {aircraft:0, operators:0, flights:0, flight_notes:0,
  airframe_events:0, flight_logs:0, users:0, sites:0}`; staging
  `uploaded=0 existing=192 failed=0`; spot-check 12/12; storage.objects still
  192; `count(*) = count(distinct checksum) = 192`. **Zero duplicates.**

## Issues carried forward

- **major (environment, not import):** host disk is at ~94 % (~13 Gi free).
  Parser sanitized copies will consume several more GB inside the VM. If the
  host fills again the VM ext4 will abort its journal again (tonight's failure
  mode). Recommend the packager/next phases keep an eye on `df` and avoid
  further reset+restage cycles (each one strands a ~7 G orphan generation in
  the storage volume until manually wiped).
- **minor:** devkit-filter breadth ASSUMPTION (`/^Quiver/` keeps PT3 + v3, not
  only `Quiver Devkit` type) — labeled in mapping.md, defensible per V2-PLAN
  Q5, one-line change if Thomas wants the strict reading.
- **minor:** v2 seed has julius@example.com; Julius's real address is
  julius@arrowair.com (flagged by builder; seed fix outside import scope).
