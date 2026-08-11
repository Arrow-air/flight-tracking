# Parser — round 2 build log

Run: 2026-08-10 ~20:00–20:15 CDT. Branch `overnight/p0`. Prior state: full
round-1 parser in `parser/` (see parser-r1.md) + critic gate results
(`parser/tests/results/gate-r1.json`, 27/30 green, 3 battery-plausibility
fails). Only `parser/` + this log touched. Nothing committed.

## Blocker fixed: battery stats picked up post-landing power-off transient

Critic finding (round 1, 3/18 PT1 fixtures): `summary.py` computed
volt_min/volt_max/sag/per_cell over the ENTIRE log with only a `v>1.0`
guard. Logs that capture the battery being switched off after landing
(voltage 53–57 V → 22–26 V → 0 in the final seconds) reported the shutdown
transient as flight stats (00000086 volt_min=25.4 V pc_min=1.95;
00000088 volt_min=22.5 V pc_min=1.61; PT1-002/00000089 volt_min=26.5 V
pc_min=1.89).

Data check before fixing (all three fixtures): the collapse begins strictly
AFTER the disarm EV — 00000086 disarm 784.2 s / collapse 789.3 s;
00000088 disarm 388.5 / collapse 398.5; 00000089 disarm 842.7 / collapse
852.8. So the armed window alone fixes all three observed cases.

Fix (`arrow_parser/summary.py`, new `_flight_volt_stats`):
1. BAT samples are accumulated (t, volt) during the pass; volt min/max are
   now computed POST-loop windowed to the armed span (first arm .. last
   disarm, from the interval assembly that already existed for
   armed_duration_s).
2. Fallback for logs without arm events (and for power-off-before-disarm):
   a trailing collapse suffix — terminal samples below ~2.5 V/cell (or
   0.6× pack max when cells unknown, capped at 0.7× so legitimate deep sag
   ≥3.0 V/cell is never eaten) that never recover — is trimmed, plus a 1 s
   guard band to catch mid-fall samples.
3. `battery.stats_window` records what applied (`armed` / `full_log` /
   `…+collapse_trimmed`). `volt_start` and the `batt_volt` series keep the
   full trace (the collapse stays visible on charts).

After fix (fresh CLI runs, verify OK on all):
- 00000086: volt_min 48.75 volt_max 53.73 sag 4.98 pc_min 3.75 (window=armed)
- 00000088: volt_min 53.88 volt_max 56.72 sag 2.85 pc_min 3.85 (window=armed)
- 00000089: volt_min 52.43 volt_max 57.70 sag 5.28 pc_min 3.75 (window=armed)
- controls unchanged in effect: test12 vmin 55.27 pc_min 3.69; 00000075
  vmin 53.53 pc_min 3.82.
- Edge cases unit-checked on synthetic data: no-arm-events collapse
  (→ `full_log+collapse_trimmed`, vmin = real sag 49.0 not 22.5), clean log
  (no trim), all-samples-below-threshold garbage (no trim, stats returned),
  empty (None).
- Sanitize verify still exact: BAT/EV/ARM all survive sanitization, so raw
  and sanitized parses window identically.

## Also done: alignment with the LANDED schema (r1 leftover — migrations
were empty in round 1, schema phase has since landed 7 migrations)

- `db.py`: writes `max_speed_mps` (landed column name; r1 wrote
  `max_speed_ms` which silently filtered out). `mark_error` now uses the
  landed `flight_logs.error` column (falls back to `parse_error`, then
  status-only).
- `watcher.py`: LISTEN channel corrected `flight_logs_uploaded` →
  `flight_log_uploaded` (matches `tg_notify_flight_log_uploaded` in
  migration 20260810210200_helpers.sql; env-overridable). Sanitized copy
  now uploads to the `flight-logs-sanitized` bucket (migration
  20260810210500) at the SAME object path as the raw log;
  `flight_logs.sanitized_path` records that path.
- `storage.py`: `SANITIZED_BUCKET` env (default `flight-logs-sanitized`);
  raw bucket default `flight-logs` confirmed against the migration (no
  longer an assumption).
- `README.md` updated (buckets, channel, battery window section, dropped-
  field note).

## Evidence (actual numbers)

- **Live-stack integration (NEW — r1 leftover)** against the RUNNING local
  supabase stack with the real migrations + seed: inserted a flight_logs
  row (seeded Quiver flight ffffffff-…-0002, uploaded_by Thomas), uploaded
  real PT1 00000088.BIN to `flight-logs`, claimed it BY ID (deliberately
  not a queue drain — the 3 schema-phase `rls-test/*` rows with
  status='uploaded' must stay untouched, verified still 'uploaded' after),
  ran `watcher.process_one`: status→`parsed`, sanitized_path set, summary
  row dur=92 s dist=34.6 m max_speed_mps=1.84 (column mapping works),
  battery cells=14 cells_source=**aircraft_type** (join works) per_cell_min
  3.848 stats_window=armed, health 75, 10 series channels, 1115 params;
  sanitized object downloaded back from `flight-logs-sanitized`
  (2,437,346 B, 59,301 msgs, 0 location msgs). All rows/objects cleaned up
  after (delete cascade + storage DELETE 200s). Script: ran from
  /tmp/parser-r2-live-int.py (throwaway).
- **Gate re-run (critic harness `tests/gate_round1.py gate`, 30 logs,
  deep): 30/30 green** — see `tests/results/gate-r1.json` (rewritten by
  this run; the critic's pre-fix copy preserved at
  `tests/results/gate-r1-critic-pre-r2.json`, which shows exactly the 3
  per-cell failures 1.95/1.61/1.89 now fixed).
- **Docker**: image rebuilt with the fixes (`arrow-parser:latest`,
  cf6125671278); CLI smoke-tested inside the container on test12 →
  dur=243.3 s health=60, verify OK, exit 0. Built only, not deployed.

## What remains

- **Full 101-log NAS corpus run** (required once before parser phase
  exit). LAUNCHED at the end of this round as a detached process
  (`nohup .venv/bin/python tests/gate_round1.py corpus`, pid 36282,
  started ~20:12 CDT, ~15–20 min expected): it survives this agent and
  writes progress to `/tmp/corpus-r2.log` and the verdict JSON to
  `parser/tests/results/corpus-r1.json` when done. At handoff it was 7/101
  with 0 failures. NEXT AGENT: check those two files — if
  `corpus-r1.json` shows `n_fail: 0`, the corpus requirement is met; if
  the file is missing, the process died and the run must be restarted.
- Landed `flight_log_summary` has NO columns (nor `summary` jsonb
  overflow) for `armed_duration_s`, `start_time_utc`, `vehicle`,
  `max_alt_source`, `message_counts` — currently dropped on DB write
  (still in CLI JSON). One ALTER by the schema phase and db.py picks them
  up automatically (introspecting writes). `start_time_utc` matters for
  bulk-dump intake (flight stubs from log timestamps).
- Wind estimate not computed (`wind` column left NULL).
- Health thresholds still partly ASSUMPTION (motor spread 15%, RSSI
  dropout rule, deduction weights) — unchanged from r1.
- Cells inference ambiguity (14S near-full vs 15S sagged) remains for logs
  without an aircraft_type join; live path uses `aircraft_types.cells`
  (proven above), so this only affects offline CLI without `--cells`.
