# Parser — round 1 build log

Run: 2026-08-10 ~19:30–19:50 CDT. Branch `overnight/p0`. Prior state: only
`parser/.venv` from preflight (pymavlink 2.4.49) — no prior parser rounds,
built from scratch. Only `parser/` (+ this log) touched.

## What was built (all under `parser/`)

- `run.py` — CLI: `parser/.venv/bin/python parser/run.py <file.bin>`
  (`--out`, `--cells`, `--no-verify`, `--summary-only`, `--quiet`). Writes
  `<name>.summary.json` / `.series.json` / `.params.json` /
  `.sanitized.bin`; exit 0 ok / 1 parse fail / 2 verify fail.
- `watcher.py` — queue worker: claims `flight_logs.status='uploaded'` via
  `FOR UPDATE SKIP LOCKED` (multi-worker safe), storage download → parse →
  sanitize → verify → upload sanitized copy → write summary/series/params →
  `status='parsed'` + `sanitized_path`; failures → `status='error'` (+
  `parse_error` column if the schema adds one) — never silent. Polls
  (POLL_INTERVAL_S=5) and LISTENs on `flight_logs_uploaded` for instant
  wake; `ONESHOT=1` drains and exits.
- `arrow_parser/summary.py` — one-pass pymavlink extraction: duration
  (TimeUS span), armed duration (EV 10/11 + ARM.ArmState, with
  leading-disarm ⇒ armed-from-log-start handling — real logs start at
  arm), GPS distance (haversine, 500 m glitch guard), max alt (baro,
  GPS fallback), max speed, battery (volt start/min/max, sag, mAh, Wh,
  per-cell via `--cells`/aircraft_type or inference), modes timeline,
  events, ERR list (subsystem names), PARM dict, 10 downsampled series
  channels (≤600 pts: baro_alt, gnd_speed, volt, curr, vibe x/y/z, ekf
  vel/pos/mag var, rssi), vehicle detect, start_time_utc from GPS clock.
- `arrow_parser/health.py` — 0–100 score + A–F grade. Thresholds per
  RUN-CONTEXT: vibe >30 m/s², clip >0, EKF variance >0.5, compass (EKF SM)
  >0.5. ASSUMPTION (labelled in-file): motor-spread warn >15% of throttle
  range, RSSI dropout >5 events below 20% of peak, deduction weights.
- `arrow_parser/sanitize.py` — raw-byte DataFlash walker (FMT
  self-description, resync on corruption). Drops GPS/GPS2/GPSB, GPA/GPA2/
  GPAB, POS, ORGN, HOME, TERR, RALY, GRAW/GRXH/GRXS wholesale; zeroes
  Lat/Lng-named fields in ALL kept messages (catches AHR2, CMD, MISE, SIM
  etc. without a per-type list). Output is a valid .bin.
- `arrow_parser/pipeline.py` — parse → sanitize → verify. Verify = full
  pymavlink re-parse of sanitized copy: 0 surviving location messages,
  0 nonzero Lat/Lng fields, duration/armed/volt_min/sag/mAh within 1% of
  raw (RUN-CONTEXT contract). Watcher refuses `parsed` unless verify passes.
- `arrow_parser/db.py` — psycopg3. **Schema-introspecting writes** (schema
  phase runs in parallel; `supabase/migrations/` still empty this round):
  only existing columns written, unknown summary fields fold into a
  `summary` jsonb column, json vs array adapted per `udt_name`,
  `ON CONFLICT (log_id)` upsert = idempotent, 0-rows-affected raises
  (v1 pain point #4).
- `arrow_parser/storage.py` — Supabase storage HTTP client (service-role).
  Bucket `flight-logs` is ASSUMPTION (env `STORAGE_BUCKET`); sanitized
  object = `<path>.sanitized.bin` sibling (ASSUMPTION, path recorded in
  `sanitized_path` either way).
- `Dockerfile` (python:3.12-slim, non-root, CMD watcher) + `README.md` +
  `requirements.txt` (pymavlink 2.4.49, psycopg[binary] 3.2.13, requests
  2.32.5) + `.gitignore` (.venv/, out/).

## Evidence (actual numbers)

- **Gate run (30 logs): all 18 PT1 + test12 + SITL + 10 sampled NAS —
  30/30 OK, every log passed sanitize verification** (exit 0). Examples:
  test12 dur=243.3 s armed=228.3 s dist=427.5 m health=60;
  PT1 00000089 dur=244.6 s health=55; NAS 00000029 dur=1783.0 s;
  SITL 00000001 dur=5695.5 s armed=61.8 s. NAS sample list:
  00000009/19/29/39/49/59/69/79/89/99.BIN. Throughput ~0.3–11 s/log,
  27 s for the 5695 s SITL log.
- test12 sanitize stats: dropped ORGN 4, POS 2434, GPS 2292, GPA 2292;
  zeroed AHR2 2434, CMD 1002, MISE 55; resync_bytes 0. Verify comparisons
  raw=sanitized exactly (duration 243.3=243.3, mAh 4314.5=4314.5).
- **DB integration test** (throwaway `postgres:16-alpine` container,
  spec-shaped scratch schema, removed after): claim flips to `parsing`,
  SKIP LOCKED works, summary row (duration 243.3, battery jsonb cells=15,
  health jsonb), 10 series rows ≤600 pts as float8[], 1216 params,
  idempotent re-write (still 1 summary row / 10 series rows), error path
  sets `status='error'` + `parse_error`. Watcher `process_one` with stub
  storage: PT1 log → `parsed`, sanitized object 6,485,287 B (raw
  6,680,576 B), duration 244.6 s written.
- **Docker**: `arrow-parser:latest` built (4364b99e100c); CLI smoke-tested
  INSIDE the container on test12 → same numbers, verify OK. Not deployed.

## Bugs found on real data this round (fixed)

1. PM.NLon (perf loop counter) matched the lat/lng field regex → was being
   zeroed. Regex now only matches bare `Lon`/`Long` without prefix letter.
2. Armed duration was 0 on all real logs — logging starts AT arm, so the
   only arm event visible is the trailing disarm. Fixed with post-loop
   interval assembly (leading disarm ⇒ armed from log start).
3. PT1 BAT.Curr contains NaN samples → invalid JSON on DB write. Added
   finite-value guards at all extraction points (curr_max now 122.1 A on
   PT1-89 instead of NaN).
4. Docker COPY inherited host 0600 perms → non-root user couldn't read
   /app. `chmod -R a+rX /app` added.

## What remains (for later rounds / other phases)

- **Full 101-log NAS corpus run** — required before parser phase exit
  (RUN-CONTEXT); only 10 sampled this round. ~10–15 min sequential.
- **Live-stack integration**: watcher tested against a scratch DB + stub
  storage, not yet against the real migrations + supabase storage (schema
  phase hadn't landed migrations this round — `supabase/migrations/` was
  empty). Once schema lands: verify column names line up (db.py
  introspects, so mismatches degrade to jsonb overflow, not failures),
  bucket name, and add `pg_notify('flight_logs_uploaded')` trigger for
  instant wake (watcher already LISTENs; polling works without it).
- Wind estimate (`wind` jsonb in schema sketch) not computed — column
  left NULL.
- Health thresholds marked ASSUMPTION (motor spread 15%, RSSI dropout
  rules, deduction weights) should be checked against Hex's flight-card
  memory if a later round can read it.
- Cells inference is ambiguous around full 14S vs sagged 15S (PT1 infers
  15 from 58.97 V); authoritative value must come from
  `aircraft_types.cells` via the flight join (watcher already queries it).
