# Arrow flight-log parser

Python + pymavlink service that turns uploaded ArduPilot DataFlash `.bin`
logs into flight-card data and a GPS-stripped sanitized copy.

## Pieces

- `run.py` — offline CLI: `parser/.venv/bin/python parser/run.py <file.bin>`
  (options: `--out DIR`, `--cells N`, `--no-verify`, `--quiet`).
  Writes `<name>.summary.json`, `.series.json`, `.params.json`,
  `.sanitized.bin` to `--out` (default `parser/out/<name>/`).
  Exit 0 = ok, 1 = parse failure, 2 = sanitize-verification failure.
- `watcher.py` — queue worker: claims `flight_logs.status='uploaded'` rows
  (`FOR UPDATE SKIP LOCKED`, multi-worker safe), downloads from Supabase
  storage, writes `flight_log_summary` / `flight_log_series` /
  `param_snapshots`, uploads the sanitized copy to the
  `flight-logs-sanitized` bucket (same object path as the raw log), flips
  status to `parsed`/`error`. Polls (default 5 s) and LISTENs on
  `flight_log_uploaded` (the trigger in migration
  `20260810210200_helpers.sql`) for instant wake. `ONESHOT=1` drains the
  queue and exits (used in tests).
- `arrow_parser/` — library: `summary.py` (one-pass extraction),
  `health.py` (scoring), `sanitize.py` (raw-byte location stripper),
  `pipeline.py` (parse→sanitize→verify), `db.py`, `storage.py`.

## Sanitization contract

Dropped wholesale: GPS/GPS2/GPSB, GPA/GPA2/GPAB, POS, ORGN, HOME, TERR,
RALY, GRAW/GRXH/GRXS. All other messages keep their bytes except fields
named like Lat/Lng/Lon (AHR2, CMD, MISE, SIM, ...), which are zeroed in
place. The verifier re-parses the sanitized file with pymavlink and
requires: zero surviving location messages/fields AND duration + battery
summary within 1% of the raw parse (RUN-CONTEXT requirement) — the
watcher refuses to mark a log `parsed` if this fails.

## Battery stats window

Some real logs capture the battery being switched off after landing
(voltage collapse 53–57 V → 22–26 V → 0 in the final seconds). Flight
battery stats (`volt_min` / `volt_max` / `sag_v` / `per_cell_*`) are
therefore computed over the armed span (first arm .. last disarm) and any
trailing collapse-to-zero suffix is trimmed (fallback for logs without arm
events). `battery.stats_window` records which window applied
(`armed` / `full_log`, `+collapse_trimmed` when a suffix was cut).
`volt_start` remains the first sample of the whole log; the `batt_volt`
series keeps the full trace including the collapse.

## Health score

100-point scale, deductions per failed check: vibration (>30 m/s²,
RUN-CONTEXT), accel clipping (>0), EKF variance (>0.5, RUN-CONTEXT),
compass innovation (EKF SM >0.5), motor-output spread (>15% of throttle
range — ASSUMPTION), RC RSSI dropouts (>5 events below 20% of peak —
ASSUMPTION). Deduction weights in `health.py` are ASSUMPTION; see file
header.

## Env (watcher)

| var | default |
| --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| `SUPABASE_URL` | `http://127.0.0.1:54321` |
| `SUPABASE_SERVICE_ROLE_KEY` | (required) |
| `STORAGE_BUCKET` | `flight-logs` (raw, per storage migration) |
| `SANITIZED_BUCKET` | `flight-logs-sanitized` (per storage migration) |
| `POLL_INTERVAL_S` | `5` |

DB writes introspect table columns; unknown summary fields fold into a
`summary` jsonb column when present. NOTE for schema/UI phases: the landed
`flight_log_summary` has no columns (nor a `summary` overflow jsonb) for
`armed_duration_s`, `start_time_utc`, `vehicle`, `max_alt_source`,
`message_counts` — those are currently dropped on DB write (they remain in
the CLI JSON). Adding the columns or a `summary jsonb` column makes db.py
pick them up automatically.

## Docker

`docker build -t arrow-parser parser/` — deployed on Openship next to the
self-hosted Supabase (build only in this run; no deploy).
