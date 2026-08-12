# ARCH-NOTES-V22 — recon map for the v2.2 feedback run (2026-08-12)

Ground-truth notes from actual code on branch `v22-feedback` (off main @
070340b, the v2.1 merge). Read WITH run/ARCH-NOTES-V21.md — this file only
records what CHANGED since V21 plus targeted recon for P1–P7. Where these
notes conflict with RUN-CONTEXT-V22.md, the code was trusted.

---

## 1. Deltas since ARCH-NOTES-V21 (v21 merged as PR #1, commit 070340b)

Everything ARCH-NOTES-V21 flagged as "missing" infra now EXISTS:

- **vitest installed and green-able**: `npm test` = `vitest run`
  (package.json:11). Test files: src/lib/{admin,binlog,filters,
  flightMetrics,format,oauthCallback,params}.test.ts.
- **parser pytest set up**: parser/pytest.ini, parser/requirements-dev.txt,
  parser/tests/conftest.py + test_v21_schema_parser.py. Fixture-dependent
  tests skip cleanly when fixtures/ (gitignored) is absent; they use
  fixtures/nas-logs/00000021.BIN. Use `parser/.venv` (python 3.14; system
  python3 is 3.9).
- **Local supabase stack is UP and healthy** (the colima corruption V21 §5
  described is gone): `docker ps` shows supabase_db_flight-tracking (postgres
  17, :54322), storage-api, postgrest, realtime, studio (:54323) all
  Up/healthy. ui-smoke prereqs are reachable again.
- **New libs** (extend these, don't duplicate):
  - `src/lib/flightMetrics.ts` — `flightDurationS()` (summary-first duration,
    E1 fix), `flightStartIso()`, `flightWeatherCoords()` (log coarse takeoff
    → site fallback), `embeddedSummary()` (object-or-array PostgREST embed
    handling).
  - `src/lib/filters.ts` — fleet + flight filter predicates w/ URL sync
    helpers; `builtByUser()` at :119-126 (P5's source of truth).
  - `src/lib/params.ts` + `src/pages/FlightParams.vue` — param
    browser/diff (`/flights/:id/params`).
  - `src/lib/admin.ts` + `src/pages/Admin.vue` — `/admin` (users, roles,
    aircraft operator grants), route guarded by isAdmin in router.ts:25-29.
  - `src/lib/oauthCallback.ts` — OAuth failure-callback surfacing.
- **Router now**: `/aircraft/:id` → AircraftDetail.vue (P5 home),
  `/flights/:id/params`, `/admin` added. User menu/nav for P4 lives in
  AppShell.vue / AppNavbar.vue.
- **Migration 20260811120000_v21_summary_takeoff_start_incident.sql** added:
  flight_log_summary.start_time_utc (timestamptz), takeoff_lat/takeoff_lon
  (numeric(5,2), 2-dp privacy coarsening enforced parser-side AND by column
  scale); flights.incident (enum flight_incident) + incident_notes.
- **db.py reworked**: `build_summary_row()` (db.py:113-135) builds a
  candidate row; `_filtered_insert()` (db.py:64) drops keys without real
  columns — so parser can emit keys ahead of schema. `utc_from_unix()`
  converts parser unix seconds → timestamptz. Mapping quirk retained:
  summary key `max_speed_ms` → column `max_speed_mps`.
- **E1 shipped**: Flights.vue prefers summed summary duration_s
  (Flights.vue:272) with a deploy-window fallback query (Flights.vue:77-88
  retries the select without start_time_utc if the column 42703s).
- **AppCard at-rest contrast fixed (C1), hover NOT fixed** — see §7 (P6).
- **BulkUpload now client-scans log head** for start time + coarse coords
  (binlog.ts `extractLogStartTime`); flight stubs get started_at from GPS
  clock.
- Prod reality (RUN-CONTEXT verified facts): summary table now has
  start_time_utc, takeoff_lat/lon; full reparse ran 2026-08-11→12; Hex
  reruns reparse after THIS round merges.

---

## 2. P1 — duration computation + battery armed window (parser)

### Where duration_s is computed
`parser/arrow_parser/summary.py`:
- **:222-227** — t_min_us/t_max_us accumulated from TimeUS of EVERY matched
  message in the loop.
- **:381-382** — `duration_s = (t_max_us - t_min_us) / 1e6` — i.e. TOTAL LOG
  SPAN. This is the bug.
- **:451** — emitted as `"duration_s"` (rounded 2dp).

### The armed-window code ALREADY EXISTS — reuse it
- Arm-state transitions collected in-loop: EV id 10 (ARMED) / 11 (DISARMED)
  at **:297-302**; ARM.ArmState messages at **:349-352** (both feed
  `arm_events: list[(ts, bool)]`, declared :179).
- Intervals assembled post-loop at **:384-407**: sort, collapse consecutive
  same-state events, leading-DISARM ⇒ armed-from-log-start (:395-396),
  trailing-ARM ⇒ armed-to-log-end (:397-398), then sum spans into `armed_s`
  and `armed_intervals`. Multi-arm cycles already summed.
- **`armed_duration_s` is ALREADY EMITTED** (summary.py:452) and already in
  db.py's candidate row (db.py:121) — it is silently dropped today because
  flight_log_summary has NO such column. So the plumbing for "armed time"
  exists end-to-end except the schema + the semantics swap.
- Battery armed-window consumer: `_flight_volt_stats()` at **:82-130** takes
  `armed_intervals`, windows samples to first-arm..last-disarm, labels the
  result `battery.stats_window` = "armed" / "full_log" (+"+collapse_trimmed")
  — :104-112. This is the "record which window applied" pattern RUN-CONTEXT
  wants mirrored for duration (e.g. a `duration_source` = armed|full_log).
- CAVEAT for the fix: when `arm_events` is empty, `armed_s` stays 0.0 —
  the fallback to full log span must be added explicitly (don't ship 0).

### Frontend consumers of duration_s (all keep working post-fix)
- src/lib/flightMetrics.ts `flightDurationS` (sums per-log summary
  duration_s; used by Flights.vue:272 and FlightCard).
- FleetList.vue:70 (`flight_log_summary(duration_s)` select) and :150-153 —
  fleet total-hours stat sums duration_s ⇒ inherits the fix automatically.
- FlightCard.vue:546 per-log duration stat.
- **WATCH OUT — FlightCard.vue:362**: modes timeline uses
  `modes[i+1]?.t_s ?? s.duration_s` as the LAST mode segment's end. Mode
  `t_s` values are log-relative seconds, so after the semantics change
  duration_s (armed time) is no longer a valid timeline endpoint — that
  fallback should switch to the new `log_duration_s` (fetch it) or
  `Math.max(last event t_s, ...)`. Only known consumer where the OLD
  semantics were load-bearing.

### The bug log EXISTS LOCALLY — proof target
Object paths are `{flightId}/{sha256.slice(0,12)}_{filename}`
(src/lib/logs.ts:55), so "387be26687b7_00000027.BIN" means sha256 starting
`387be26687b7`. Verified by checksumming:

- **`/Users/hex/projects/arrow/flight-tracking/fixtures/nas-logs/00000027.BIN`
  has sha256 387be26687b7ed4d10b216a82c995864f88e87be2bba1c3d5bc628a4a9fd9851
  — this IS the exact prod log** from flight bd0ee3e6-…. Parse it locally for
  the before/after proof; no prod download needed.
- backups/v1-storage-flight_logs/ (190 objects, v1 pull) was fully
  checksummed: NO object there matches 387be26687b7 (two unrelated
  *_00000027.bin files exist; neither matches). State "fixtures/, not
  backups/" in RUN-RESULT.
- fixtures/nas-logs/ holds 00000009.BIN…001xx.BIN (101 files, gitignored) —
  the multi-arm / no-arm pytest cases can be sourced from these.

New schema work: migration adding `log_duration_s` (numeric, same check
pattern as duration_s) — db.py `build_summary_row` needs the new key; also
consider finally adding `armed_duration_s` column since the parser already
emits it (decide: keep both or fold into duration_s + log_duration_s).

---

## 3. P2 — first-fix scan + GPS validity info

### Parser first-fix scan — summary.py:230-246
```python
if mtype == "GPS":
    status = getattr(m, "Status", 0)
    inst = getattr(m, "I", getattr(m, "Instance", 0))
    if inst not in (0, None): continue
    if status is not None and status >= 3:          # 3D fix or better
        lat, lng = getattr(m, "Lat", None), getattr(m, "Lng", None)
        if first_ts_unix is None:
            first_ts_unix = getattr(m, "_timestamp", None)
        if lat is not None and lng is not None and (lat or lng):   # ← guard
            if first_fix is None:
                first_fix = (lat, lng)
```
- Validity today = `GPS.Status >= 3` on instance 0, plus `(lat or lng)`
  truthiness — which rejects ONLY the exact (0, 0) pair. A GPS-stripped log
  whose lat/lng were zeroed to NEAR-zero (or that logs Status≥3 with tiny
  residual coords) passes the guard and rounds to (0.00, 0.00) at
  summary.py:462-463. The v21 parser HAD this guard and prod still got 12
  (0,0) rows ⇒ the stripped values are near-zero-but-truthy (or one of the
  pair is 0). Fix must treat near-(0,0) as no-fix (epsilon on BOTH being
  ~0), and lean on the fix-type field rather than message presence.
- `first_ts_unix` (→ start_time_utc) is taken from the FIRST Status≥3
  message even when its coords fail the guard (:237-238) — stripped logs may
  carry a bogus GPS wall clock too if the stripper zeroes GWk/GMS; verify on
  a stripped fixture.
- `distance_m` accumulates from the same fixes (:242-246, 500 m glitch
  guard) and `max_speed`/alt are read whenever Status≥3 — decide whether
  stripped logs should also null distance (coords bogus ⇒ haversine over
  garbage) or keep it (Spd field survives stripping).

### What validity info the GPS message carries
ArduPilot DataFlash `GPS` message fields (available via getattr; parser
reads only Status/Lat/Lng/Spd/Alt today): **Status** (fix type: 0 no-GPS,
1 no-fix, 2 2D, 3 3D, 4 DGPS, 5 RTK-float, 6 RTK-fixed), **NSats**,
**HDop**, GWk/GMS (GPS week/ms — wall clock), Alt, Spd, GCrs, VZ, U.
`GPA` messages (accuracy: HAcc/VAcc/SAcc) exist in logs but are NOT in
`_TYPES` (summary.py:21-24) — add "GPA" there if accuracy gating is wanted.
The sanitizer's own field list (parser/arrow_parser/sanitize.py:39-45) shows
what strippers typically zero: GPS/GPS2/GPSB/GPA*/POS dropped entirely OR
Lat/Lng-named fields zeroed in kept messages — i.e. expect exactly
"Status≥3 with zeroed coords" shapes from external strippers.

### Client-side head scan (context)
src/lib/binlog.ts `decodeGpsMsg` (:160-199) already rejects exact (0,0) and
out-of-range coords, gwk==0, and implausible dates — BulkUpload's stub
coords are safer than the parser's. Same epsilon upgrade applies if touched.

### App-side weather (the error-message half of P2)
- QuickLog.vue `autofillWeather` (:155-193) ALREADY shows a no-coords error
  string; it uses head-scanned `logCoords` (exact-(0,0)-safe) → site coords.
- FlightCard.vue weather (:218-255): coords from
  `flightWeatherCoords(logs, site)` (flightMetrics.ts:102-117) — accepts ANY
  finite takeoff_lat/lon INCLUDING 0.0 ⇒ this is the path that fetched
  equatorial-Atlantic weather for c39f3e92. Button disabled when
  `!weatherCoords` (FlightCard.vue:412) — so once summaries carry null coords
  (post-P2-parser + Hex's nulling) the button disables, but a clear error
  message per RUN-CONTEXT still needs adding, and flightWeatherCoords should
  itself refuse (0,0). `fetchWeatherAt` (src/lib/weather.ts) has NO
  coordinate guard — belt-and-braces guard there too.

---

## 4. P3 — deletion: existing RLS, FK reality, storage reality

### Existing DELETE policies (they DO exist — contra "there may be none")
From supabase/migrations/20260810210300_rls.sql (verbatim):

```sql
-- flights (rls.sql:204-205) — OPERATORS CAN ALREADY DELETE FLIGHTS:
create policy "operators delete flights" on public.flights
  for delete to authenticated using (app.can_write_aircraft_data(aircraft_id));

-- aircraft (rls.sql:92-93) — ADMIN-ONLY, matches P3 ask already:
create policy "admin delete aircraft" on public.aircraft
  for delete to authenticated using (app.is_admin());

-- flight_logs (rls.sql:311-312) — UPLOADER-or-admin, NOT operator:
create policy "delete own logs" on public.flight_logs
  for delete to authenticated using (uploaded_by = auth.uid() or app.is_admin());

-- flight_log_summary (rls.sql:329-330): admin-only delete
-- flight_notes (rls.sql:252-253): author-or-admin delete
-- sites (rls.sql:51-52): own-or-admin; user_profiles/types/components/
--   component_events/tags/attachments/airframe_events/issues: admin-only
-- flight_payloads / flight_tags (rls.sql:223-224, 234-235): can_write_flight
```
`app.can_write_aircraft_data(uuid)` = `is_admin() or is_operator_of(uuid)`
(helpers.sql:62-70) — exactly the canWrite semantics P3 asks for. So the
DB-side permission model for P3 is ~already correct; the real gaps are
(a) the FK chain blocks the delete in practice, (b) UI affordances, and
(c) the flight_logs delete policy being uploader-scoped (an operator who
didn't upload the log can't delete its flight_logs row → can't delete the
flight — see below).

### FK ON DELETE chain (20260810210100_tables.sql)
- flights.aircraft_id → aircraft **ON DELETE RESTRICT** (tables.sql:190) —
  aircraft delete is ALREADY blocked at DB level while flights exist (the
  "safe default" is the current behavior; UI just needs to surface it).
- **flight_logs.flight_id → flights ON DELETE RESTRICT** (tables.sql:308) —
  THE blocker: deleting a flight with logs fails until its flight_logs rows
  are deleted first (client-side under the uploader-scoped policy) or the FK
  becomes CASCADE via migration.
- flight_logs children all CASCADE already: flight_log_summary (:332),
  flight_log_series (:355), param_snapshots (:368) — log-row delete cleans
  them via postgres (FK cascade is not subject to RLS).
- flights children: flight_notes (:239), flight_tags (:229),
  flight_payloads (:219) all CASCADE; airframe_events.flight_id **SET
  NULL** (:265); exports.aircraft_id SET NULL; media has no flight FK.
- aircraft children: aircraft_operators, component_events, airframe_events,
  issues CASCADE from aircraft (:108, :144, :258, :281).

So: adding `ON DELETE CASCADE` to flight_logs.flight_id (migration altering
the constraint) makes flight-delete single-statement and cascades DB-side
through summary/series/params/notes/tags/payloads. Alternative (no
migration): client deletes flight_logs rows first — but then RLS "delete own
logs" blocks non-uploader operators; if operators-can-delete-flights is the
spec, either widen that policy to can_write_flight() or use the CASCADE.

### Storage delete reality (20260810210500_storage.sql)
- Raw bucket `flight-logs` HAS a delete policy — "raw logs delete uploader
  or admin" (storage.sql): allowed when admin OR
  `exists(select 1 from flight_logs fl where fl.object_path = objects.name
  and fl.uploaded_by = auth.uid())`.
  **ORDERING TRAP**: the policy resolves permission THROUGH the
  flight_logs row — once the DB row is deleted (or cascade-deleted), no
  non-admin can ever delete the object. Client flow must remove storage
  objects BEFORE deleting DB rows, and only the uploader (or admin) can do
  it. Also note supabase-js `storage.remove()` does NOT error on
  RLS-filtered misses — check the returned data list length.
- Sanitized bucket `flight-logs-sanitized` has NO authenticated
  INSERT/UPDATE/DELETE policies at all (parser writes via service_role) —
  sanitized objects CANNOT be deleted by any client; they WILL orphan.
  `flight_logs.sanitized_path` holds the object name — an orphan list is
  reconstructable post-hoc only if captured before row delete (or by
  admin/service listing bucket objects with no matching flight_logs row —
  which after cascade requires diffing bucket contents against live rows).
- media bucket: "media delete uploader or admin" (same row-dependent shape).

### Not yet in code
- NO delete UI anywhere (grep deleteRow usage: Sites.vue only). db.ts has
  `deleteRow` helper (throws on 0 rows — RLS denials surface). FlightCard /
  AircraftDetail have no delete buttons; no confirm-dialog component exists
  yet (build per Styleguide patterns).

---

## 5. P5 — manufactured-by field

- The v21 fleet filter "manufactured by me" uses **`aircraft.built_by`
  falling back to `aircraft.created_by`**: `builtByUser()` at
  src/lib/filters.ts:119-126 (`(a.built_by ?? a.created_by) === userId`);
  same fallback for the flights-page builder filter at filters.ts:241.
- Schema: `aircraft.built_by uuid references user_profiles (id)` — nullable,
  no ON DELETE clause (tables.sql:89); `created_by` NOT NULL (:93). Also
  note `built_at date` (:90) exists.
- P5 display+edit therefore = `built_by` (keep the created_by fallback for
  display consistency with the filter). Name lookup: user_profiles SELECT is
  fleet-visible (names, not emails) — join or map id→name client-side like
  Admin.vue does. Aircraft UPDATE RLS is operator-or-admin
  ("operators update aircraft data" / can_write_aircraft_data), so an
  ADMIN-ONLY edit control needs client gating (isAdmin) — acceptable here
  since changing built_by isn't privilege-bearing, but note it in
  RUN-RESULT (operators could technically PATCH built_by via API; a
  column-guard trigger like tg_guard_roles is the strict fix if the critic
  cares).
- Home: src/pages/AircraftDetail.vue (route /aircraft/:id).

## 6. P6 — AppCard hover contrast (exact rules)

src/components/ui/AppCard.vue — v21 fixed AT-REST only (background →
`--docs-bg` #ffffff, dither `opacity(0.06)` at :91, body copy #3d5270 at
:162). The HOVER state kept the original high-contrast-killing styling:

```css
/* AppCard.vue:94-96 — THE culprit: dither jumps 0.06 → FULL opacity */
.card--link:hover::before {
  filter: saturate(1) opacity(1);
}
/* AppCard.vue:98-103 — bg tint + lift (fine to keep as affordance) */
.card--link:hover {
  background: var(--card-hover-color);   /* #ECF0FA */
  border-color: var(--card-hover-border); /* #6D8ED9 */
  transform: translateY(-4px);
  box-shadow: var(--shadow-lift);
}
```
The `::before` is the bayer-dither SVG (card-bayer-gradient.svg, 130px tall,
anchored bottom, :83-90) — at `opacity(1) saturate(1)` it's a saturated blue
pixel pattern rising under the body text/meta. Body text does darken on
hover (`.card--link:hover .card__body { color: var(--docs-text) }` :173-175)
but sits on the full-strength dither ⇒ unreadable. Fix shape: cap hover
dither far lower (e.g. 0.12–0.2) or keep saturate(1) with low opacity;
keep translateY/border/bg shift as the hover affordance. Tokens at
src/styles/tokens.css:116-120. Meta row uses --docs-text-muted (#6b7280)
at :187 — check its hover contrast too.

## 7. P7 — how single upload sets flight titles

- QuickLog (single): free-text Title input (QuickLog.vue:334,
  `form.title`) → `title: form.value.title.trim() || null` in the flights
  INSERT (QuickLog.vue:226). Null/blank = no title; display fallbacks
  elsewhere render aircraft/date instead.
- BulkUpload: title is HARDCODED per file —
  `title: 'Bulk dump · ${item.file.name}'` (BulkUpload.vue:162) inside the
  per-file flight-stub INSERT (:158-167). P7 = add an optional shared Title
  input to the defaults panel (pattern: `defaults` ref at BulkUpload.vue:47
  area holds aircraft_id/pilot_id/site_id/gps_private) and use
  `sharedTitle.trim() || 'Bulk dump · ' + item.file.name` (blank ⇒ current
  default, per RUN-CONTEXT).
- flights.title is plain nullable text (tables.sql:195); no uniqueness or
  trigger involved.

---

## 8. Notes for this run

- P4 (profile page): no existing profile page; auth store has
  session+profile (`src/lib/auth.ts`), user menu lives in AppNavbar/AppShell.
  Email IS available client-side from `auth.session.user.email` (not from
  user_profiles). Route + sidebar/nav entry pattern: see Admin.vue wiring.
- Migrations: next timestamps must sort after 20260811120000; keep the
  YYYYMMDDHHMMSS_name.sql convention.
- Parser Dockerfile COPY paths are repo-root-relative (HARD RULE 5) — the
  Dockerfile wasn't touched by v21; keep it that way unless adding files.
- ui-smoke (run/ui-smoke.mjs) uploads fixtures/nas-logs/00000074/39/21.BIN
  and pre-cleans via `docker exec supabase_db_flight-tracking psql` — stack
  is up, so it should be runnable this round (it also references a PT1 log
  under /Users/hex/projects/project-quiver/ — verify presence before run).
