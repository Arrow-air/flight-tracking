# RUN-RESULT-V22 — Flight Tracking v2.2 feedback round 2 (2026-08-12)

Branch `v22-feedback` off main @ 070340b (the v2.1 merge). All work items
P1–P7 shipped. Prod untouched; migrations are files only, Hex applies
post-merge. DRAFT PR raised — do not merge without Thomas's review.

**REPARSE REQUIRED AFTER MERGE** (see Decisions §"Reparse"): existing prod
summaries still carry total-log durations and no log_duration_s /
duration_source until Hex reruns the full reparse (already planned per
RUN-CONTEXT).

---

## Final verification (re-run by packager, 2026-08-12 ~10:15)

| Gate | Result |
| --- | --- |
| `npm run build` (vite) | green, 1.0 s |
| `npm run typecheck` (vue-tsc) | green |
| `npx vitest run` | **130/130** tests, 9 files |
| parser pytest (`parser/.venv`) | **35/35** |
| ui-smoke (`run/ui-smoke.mjs`) | **16/16 PASS** (dev :5199 + local stack + watcher; refreshed shots committed) |
| Local end-to-end (watcher parse) | new columns land: `duration_source` armed/full_log, `log_duration_s` ≠ `duration_s` on armed logs (103.9 vs 692.8), null takeoff coords on no-GPS log |
| Local migrations | both v22 migrations applied via `supabase migration up`; `flight_logs.flight_id` FK confirmed CASCADE (`pg_constraint.confdeltype='c'`) |

## Critic evidence — P1 before/after (THE priority)

Proof target: flight bd0ee3e6-7ff7-4242-bd80-f5cbaacd57ed's log
`387be26687b7_00000027.BIN`. The exact prod log exists locally as
**`fixtures/nas-logs/00000027.BIN`** (sha256 `387be26687b7ed4d…` verified —
NOT in backups/v1-storage-flight_logs/, whose 190 objects were all
checksummed with no match). No prod download occurred.

Parsed with the fixed parser (re-run independently by the packager):

| Field | Before (prod, v21 parser) | After (v22 parser) |
| --- | --- | --- |
| `duration_s` | **3745.21** (total log span — the bug) | **573.70** (sum of armed spans) |
| `log_duration_s` | — (column didn't exist) | **3745.21** (total span preserved) |
| `duration_source` | — | `armed` |
| `takeoff_lat/lon` | 30.04, -103.49 | 30.04, -103.49 (unchanged) |

Thomas's evidence said AUTO_ARMED t=2163.5 → DISARMED t=2733.5 ≈ 570 s;
armed-span sum 573.7 s is consistent (includes all arm cycles). Fallback
when no arm events: full log span with `duration_source='full_log'`,
mirroring `battery.stats_window`.

---

## Per-phase results

### Phase 1 — Parser fixes (P1 + P2 parser half; 2 rounds, critic r1 fix)

Commits 0c60219, fc46d8a.

- **P1**: `duration_s` now sums armed spans via
  `_assemble_armed_intervals()` — the arm/disarm detection extracted from
  the previously-inline battery stats-window path, so both consumers share
  ONE code path (no duplication, per RUN-CONTEXT). Multi-arm cycles summed;
  leading-DISARM ⇒ armed-from-log-start; trailing-ARM ⇒ armed-to-log-end.
  No-arm-events logs fall back to full log span; `duration_source`
  ('armed'|'full_log') records which applied. Total span kept as new
  `log_duration_s`. Migration `20260812130000_v22_duration_semantics.sql`
  adds `log_duration_s` + `duration_source` (db.py build_summary_row +
  column introspection pick them up). `armed_duration_s` still emitted
  parser-side but intentionally NOT given a column (redundant with the new
  `duration_s` semantics — see Decisions).
- **P2 (parser half)**: `_plausible_fix()` — a Status≥3 GPS message whose
  coords would round to the 2-dp null island (0.00, 0.00), or are out of
  range, is NOT a fix. GPS-stripped uploads (the Erick case) now emit null
  takeoff coords and null distance_m instead of (0,0).
- **Critic r1 catch (fc46d8a)**: FlightCard's modes timeline used
  `duration_s` as the last segment's endpoint — valid under old semantics,
  NEGATIVE under new (bd0ee3e6: from 2163.5 → to 573.7). Extracted
  `modeTimeline()` to flightMetrics.ts; last segment now ends at the latest
  absolute t_s across modes+events, stays open when unknown. Per-log
  Duration stat gained an armed-vs-full_log tooltip.
- Frontend duration consumers verified: Flights.vue, FleetList.vue
  total-hours stat, FlightCard all read `duration_s` via
  flightMetrics/selects — they inherit correct semantics automatically
  (fleet total hours = armed hours post-reparse).
- Tests: 21 new pytest cases (armed-span unit incl. multi-arm/leading/
  trailing, no-arm fallback, fix-validity matrix, synthesized stripped-GPS
  log → null coords, bd0ee3e6 integration ~570 s, db-row/migration
  agreement); 4 new vitest timeline cases.

### Phase 2 — Deletions (P3; 1 round)

Commit 1e844bf. Full detail in the builder section below ("P3 — deletion
permissions"). Highlights: existing RLS was already correct (operators
delete flights via can_write_aircraft_data; aircraft delete admin-only —
contra RUN-CONTEXT's "there may be none"); the real blocker was
`flight_logs.flight_id` ON DELETE RESTRICT → now CASCADE via migration
`20260812150000_v22_deletions.sql`; storage delete policies widened to
flight-writer-or-admin (sanitized bucket previously had NO client delete
path at all); ConfirmDialog component (type-the-serial for aircraft);
aircraft-with-flights delete BLOCKED as the safe default. RLS + Storage-API
behavior verified live against the local stack as real seed users.

### Phase 3 — App misc (P4, P5, P6, P7, P2 app half; 1 round)

Commit 4199cc7. Full detail in the builder section below. Highlights:
`/profile` page (name, email from session, roles, copyable uuid) linked
from the navbar user block; AircraftDetail Manufacturer row (built_by ??
created_by, name not uuid) with admin-only edit; AppCard hover dither
capped `opacity(1)` → `opacity(0.14)` keeping lift/border affordance;
BulkUpload optional shared Title (blank = existing per-file default);
weather guard — `usableWeatherCoords()` null-island epsilon screen on BOTH
coord sources, `fetchWeatherAt` throws before any network call on unusable
coords, FlightCard/QuickLog show the prescribed clear error and never
fetch for (0,0).

### Phase 4 — Package (this document)

All gates re-run green (table above); ui-smoke executed 16/16 with a live
watcher parse proving the new columns land end-to-end; P1 before/after
independently reproduced; screenshots refreshed; harness committed
(run-workflow-v22.js, run/watchdog-v22.sh) per v21 precedent; draft PR
raised.

---

## Work-item status P1–P7

| Item | Status | Where | Proof |
| --- | --- | --- | --- |
| P1 duration = armed flight time | **DONE** | summary.py `_assemble_armed_intervals`, migration 20260812130000, flightMetrics.ts | bd0ee3e6 log: 3745.21 → 573.70 s; `log_duration_s` 3745.21 kept; 35 pytest green |
| P2 coords guard + weather error | **DONE** | summary.py `_plausible_fix`; flightMetrics `usableWeatherCoords`; weather.ts throw; FlightCard/QuickLog errors | stripped-log pytest → null coords; vitest proves no fetch for (0,0); local no-GPS log parsed → null coords |
| P3 deletion permissions | **DONE** | migration 20260812150000, deletion.ts, ConfirmDialog, FlightCard/AircraftDetail | live RLS matrix + Storage API checks as seed users; FK cascade verified |
| P4 profile page w/ user id | **DONE** | src/pages/Profile.vue, `/profile`, AppShell link | ui-smoke suite green; copy button + fallback |
| P5 aircraft manufacturer | **DONE** | AircraftDetail.vue (built_by, name displayed, admin-only edit) | same source field as v21 "manufactured by me" filter |
| P6 fleet tile hover contrast | **DONE** | AppCard.vue hover `::before` 1 → 0.14; meta row darkens | at-rest v21 fix untouched; affordance (lift/border/bg) kept |
| P7 bulk upload shared title | **DONE** | BulkUpload.vue defaults panel | trim-or-fallback matches QuickLog semantics; blank = old behavior |

## Risk register

1. **Stale prod durations until reparse** (HIGH visibility, planned
   mitigation): until Hex reruns the full reparse, prod `duration_s` rows
   keep total-log values and `log_duration_s`/`duration_source` are NULL.
   Frontend handles NULLs (tooltip omits source; timeline no longer uses
   duration_s). Mitigation: Hex's already-planned post-merge reparse.
2. **Migration ordering on prod**: 20260812130000 (duration columns) and
   20260812150000 (deletions/FK/storage) must be applied before the reparse
   and before anyone uses delete UI. Applied clean on local stack.
3. **FK CASCADE widens delete blast radius** (accepted): an authorized
   flights DELETE now removes flight_logs rows the deleter didn't upload,
   plus summaries/series/params via existing cascades. That IS the P3 spec;
   summaries were already admin-write-only so no privilege is gained.
4. **Storage orphans are eventual-consistency by design** (see Decisions):
   client crash between storage remove and row delete leaves a re-deletable
   flight; RLS miss leaves an orphaned object for the admin sweep. No
   data-loss path found.
5. **built_by editable by operators via raw API** (LOW): aircraft UPDATE RLS
   is operator-or-admin; the admin-only restriction on the Manufacturer
   field is client-side. Not privilege-bearing. Strict fix = column-guard
   trigger (like tg_guard_roles) if Thomas wants it.
6. **Storage-API removed-list over-reports "unconfirmed"** for non-owner
   operators deleting gps_private raw objects (RETURNING filtered by SELECT
   policy). Deliberate: over-report rather than under-report; admin sweep
   reconciles.
7. **P6 hover dither 0.14 is a judgment call** — one-line tunable in
   AppCard.vue if Thomas still finds hover text hard to read.
8. **Weather button now errors on click instead of disabling** — deliberate
   per RUN-CONTEXT ("must show a clear error"); noted in case UX
   expectations differ.

## Decisions for Thomas

1. **Storage-orphan approach (P3) — CHOSEN: delete-objects-first, orphan
   knowingly, admin sweep reconciles.** Storage delete policies resolve
   permission THROUGH the flight_logs row, so objects must be removed
   BEFORE the row (enforced + unit-tested in deletion.ts). Anything not
   confirmed removed is surfaced in the UI ("N object(s) could not be
   confirmed removed") and orphans harmlessly. Reconciliation mechanism for
   Hex (service-role): list bucket objects with no matching live
   flight_logs row (`object_path` for raw, `sanitized_path` for sanitized)
   and delete via the Storage API — direct SQL DML on storage.objects is
   blocked by a guard trigger (discovered in testing). Alternative rejected:
   server-side delete function (edge function / RPC with service role) —
   more moving parts than this round warranted; say the word if you want
   atomicity instead of a sweep.
2. **REPARSE REQUIREMENT: after this merges and migrations apply, the full
   reparse must run** (Hex already plans this) — it (a) fixes all
   duration_s values to armed time + populates log_duration_s/
   duration_source, and (b) regenerates the 12 nulled (0,0) coord rows
   correctly under the new validity guard. No reparse tooling was built per
   RUN-CONTEXT.
3. **Aircraft-with-flights delete: BLOCKED (safe default).** DB keeps ON
   DELETE RESTRICT, UI pre-checks the live count and tells the admin to
   delete/reassign flights first. Alternative (explicit cascade of flights)
   deliberately not offered.
4. **`armed_duration_s` column NOT added** — duration_s now IS armed time;
   a third duration column would be redundant. Parser still emits the key
   (dropped by introspection) if you ever want it.
5. **Flight delete is one-click-confirm** (dialog, but no type-to-confirm) —
   type-to-confirm reserved for the aircraft cascade per RUN-CONTEXT. Easy
   to add if flights should get it too.
6. **built_by column-guard trigger?** (risk #5) — operators can technically
   PATCH built_by via raw API today; client UI hides it. Add a guard
   trigger migration if that must be DB-enforced.

---

## Builder phase reports (verbatim)

## P3 — deletion permissions (builder round 1)

### What shipped

- **Migration `supabase/migrations/20260812150000_v22_deletions.sql`**
  - Verified existing RLS first (RUN-CONTEXT said "there may be none" — there
    ARE): `flights` DELETE was already operator-or-admin
    (`app.can_write_aircraft_data`, exactly the canWrite semantics asked for)
    and `aircraft` DELETE was already admin-only. Both left untouched.
  - `flight_logs.flight_id` FK: RESTRICT → **CASCADE**. This was the real
    blocker: without it a flight delete required deleting flight_logs rows
    first, and the uploader-scoped "delete own logs" policy would block
    operators who didn't upload the log. Flight delete is now one statement;
    summaries/series/param_snapshots (cascade from flight_logs) and
    notes/tags/payloads (cascade from flights) clean up DB-side.
    `airframe_events.flight_id` stays SET NULL — aircraft history survives.
  - Storage: raw-bucket DELETE policy widened from uploader-or-admin to
    uploader-or-**flight-writer**-or-admin; sanitized bucket (which had NO
    authenticated delete policy — objects would ALWAYS orphan) got the same
    flight-writer-or-admin delete policy. Read policies untouched
    (gps-privacy INVARIANT 3 unaffected).
- **`src/lib/deletion.ts`** — `deleteFlight()` (storage objects first, then
  the row; see ordering trap below), `deleteAircraft()` +
  `countAircraftFlights()` (safe-default block). 15 unit tests in
  `src/lib/deletion.test.ts` including the storage-before-row ordering.
- **UI** — new `src/components/ui/ConfirmDialog.vue` (danger styling,
  optional type-to-confirm). FlightCard: "Delete flight" (canWrite-gated) +
  confirm dialog listing what cascades; success notice hands over to /flights
  via a one-shot `?notice=` param. AircraftDetail: admin-only "Danger zone"
  with "Delete aircraft" — blocked with a clear message while flights exist
  (live count, not the page's 50-row list); otherwise **type-the-serial**
  confirm (aircraft delete cascades operator grants, component events,
  airframe events, issues).

### Aircraft-with-flights: SAFE DEFAULT chosen = BLOCK

`flights.aircraft_id → aircraft` stays ON DELETE RESTRICT (DB blocks it even
via raw API), `deleteAircraft()` pre-checks the count, and the UI tells the
admin to delete or reassign flights first. Flight history is never cascaded
away by an aircraft delete.

### Storage-orphan approach (decision for Thomas)

Chosen approach: **client deletes storage objects BEFORE the DB rows; leftovers
orphan knowingly; a service-role sweep reconciles.**

- Ordering trap: both storage delete policies resolve permission THROUGH the
  `flight_logs` row (`object_path`/`sanitized_path` match). Once the row is
  gone (FK cascade included), no client can ever delete the object — hence
  objects first, row second (enforced + unit-tested in deletion.ts).
- Anything not removed (network error, RLS miss) is reported: console list +
  UI notice ("N object(s) could not be confirmed removed").
- **Known over-report (verified on local stack):** the Storage API's
  removed-list is RETURNING-filtered by SELECT policies, so a NON-owner
  operator deleting a `gps_private` flight's raw object succeeds but can't
  see the confirmation (raw read stays owner/admin-only). deletion.ts
  deliberately over-reports that case as "unconfirmed".
- **Admin sweep mechanism** (for Hex, post-merge, service-role): list each
  bucket and delete objects with no matching live `flight_logs` row —
  raw: `object_path`, sanitized: `sanitized_path`. One-shot SQL shape
  (service context): `select name from storage.objects o where bucket_id =
  'flight-logs' and not exists (select 1 from public.flight_logs fl where
  fl.object_path = o.name)` (mirror for sanitized), then delete via the
  Storage API (direct SQL DML on storage.objects is blocked by a guard
  trigger — discovered while testing).

### Evidence

- `npm run build`, `npm run typecheck`, `npx vitest run` (119 tests, 8 files),
  parser pytest (35) — all green.
- Migration applied to the LOCAL stack (`supabase migration up`; prod
  untouched — files only, Hex applies post-merge).
- psql RLS matrix-style spot-checks (impersonated seed users, rolled back):
  operator delete of unassigned flight denied (0 rows); operator aircraft
  delete denied; operator delete of assigned flight (log uploaded by someone
  else) succeeds and cascades logs+summary; admin delete of aircraft WITH
  flights blocked by FK restrict; admin flight-then-aircraft delete succeeds.
- Storage API end-to-end as real seed users (supabase-js against local kong):
  operator (non-uploader) removes raw + sanitized objects, deletes the
  flight, FK cascade clean, zero objects left in either bucket; operator
  aircraft delete returns 0 rows. Plus the gps_private=true/false pair
  proving the RETURNING-filter behavior above.
- ui-smoke NOT run this phase (needs dev server + parser watcher; no P3
  coverage in it anyway) — left for the packager/critic gate.

### Risks / notes for the critic

- Flight delete UI is one-click-confirm (no type-to-confirm) by design —
  RUN-CONTEXT reserves type-to-confirm for the aircraft cascade. Say the word
  if flights should get it too.
- The FK CASCADE means an authorized flights DELETE via raw API also removes
  log rows the deleter didn't upload — intended (that's what "operator can
  delete a flight" means), and summaries were already admin-write-only so no
  privilege gained.
- Orphan handling accepts eventual consistency: worst case (client crashes
  between storage remove and row delete) leaves DB rows pointing at deleted
  objects — the flight simply still exists with missing artifacts, and
  re-deleting finishes the job. No data-loss path found.

---

## P4 / P5 / P6 / P7 / P2-app-side — app misc (builder round 1)

### What shipped

- **P4 — profile page** (`src/pages/Profile.vue`, route `/profile`): name,
  email (from the GoTrue session — auth.users/user_profiles carry no
  client-readable email), role badges, and the user's uuid in a selectable
  `<code>` block with a Copy button (clipboard API; graceful "copy manually"
  fallback when the API is unavailable). Linked from the existing navbar user
  block in `AppShell.vue` (name/role chip is now a router-link,
  `data-test="profile-link"`). No new queries — reads the auth store.
- **P5 — manufacturer on the aircraft page** (`AircraftDetail.vue`): Identity
  card gains a "Manufacturer" row showing the profile NAME for
  `built_by ?? created_by` — the exact source field of the v21
  "manufactured by me" filter (`filters.ts builtByUser`) — with a muted
  "(record creator)" suffix when `built_by` is unset. Admin-only edit: a
  Manufacturer select (all profiles + unset) rendered only for admins in the
  registry edit form, and `built_by` is included in the UPDATE payload only
  when `isAdmin` — a non-admin registry save can never touch it. NOTE
  (known, from ARCH-NOTES §5): aircraft UPDATE RLS is operator-or-admin, so
  an operator could PATCH built_by via raw API; not privilege-bearing, a
  column-guard trigger is the strict fix if the critic wants it.
- **P6 — fleet tile HOVER contrast** (`ui/AppCard.vue`): the hover rule
  jumped the bayer dither from the v21 at-rest 0.06 to `opacity(1)` —
  saturated blue pixels under body/meta text. Now
  `saturate(1) opacity(0.14)` on hover (color still returns as affordance;
  translateY lift + border/bg shift kept), and the 10px meta row darkens on
  hover (`--docs-text-muted` → `--docs-text-secondary`). The v21 at-rest fix
  (0.06 dither, #3d5270 body) is untouched.
- **P7 — bulk upload shared title** (`BulkUpload.vue`): optional "Title
  (applied to every flight)" input in the batch-defaults row;
  `title: defaults.title.trim() || 'Bulk dump · <filename>'` — same
  trim-or-fallback semantics as QuickLog's single-upload title; blank keeps
  the existing per-file default exactly.
- **P2 (app side) — weather null-island guard + hard error**:
  - `flightMetrics.ts`: new `usableWeatherCoords(lat, lon)` — finite, in
    range, and NOT within 0.005° of (0,0) on both axes (anything that
    ROUNDS to the 2-dp null island; mirrors the parser's `_plausible_fix`
    epsilon from the r1 parser commit). Single-zero-axis pairs stay valid.
    `flightWeatherCoords` now screens BOTH log takeoff coords and site
    coords through it.
  - `weather.ts fetchWeatherAt`: belt-and-braces — THROWS
    "refusing weather lookup for unusable coordinates" before any network
    call; a missed caller guard surfaces loudly instead of fetching
    equatorial-Atlantic data (the c39f3e92 failure).
  - `FlightCard.vue`: fetch-weather button no longer silently disabled when
    coords are missing — clicking with no usable coords shows the hard
    error "No coordinates available for weather — set coordinates on this
    flight's site (Sites page) or upload a log with GPS. Nothing was
    fetched." (separate clear error for missing start time).
  - `QuickLog.vue autofillWeather`: both coordinate sources go through
    `usableWeatherCoords`; the existing no-coords error message kept and
    clarified ("Weather was not fetched.").

### Verification

- `npm run build`, `npm run typecheck` green.
- `npx vitest run`: **130 tests, 10 files, all green** (11 new: null-island
  rejection in `flightWeatherCoords` incl. the c39f3e92 string-"0.00" shape,
  `usableWeatherCoords` epsilon/range/zero-axis matrix, and
  `weather.test.ts` proving `fetchWeatherAt` throws WITHOUT calling fetch
  for (0,0)/near-zero/NaN/out-of-range and does reach fetch for real
  coords).
- Parser untouched this phase (P2 parser half landed in r1); pytest not
  rerun here.
- ui-smoke selectors checked (`start-bulk`, `.dropzone__pick`) — untouched;
  full smoke left to the packager gate as before.

### Risks / notes for the critic

- P5 client-side-only gating of `built_by` (see NOTE above) — decision for
  Thomas: add a column-guard trigger migration if operators must be blocked
  at the DB layer.
- P6 hover dither at 0.14 is a judgment call ("keep some hover affordance");
  trivially tunable in one place (`AppCard.vue` hover `::before`).
- FlightCard's weather button being always-enabled (error-on-click) is
  deliberate per RUN-CONTEXT ("must show a clear error … instead of
  fetching"); the tooltip still explains what's needed.
