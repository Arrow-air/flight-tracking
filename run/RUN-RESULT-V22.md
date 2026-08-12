# RUN-RESULT-V22 — v2.2 feedback round 2

Per-phase results. Each phase appends its own section; the packager merges
the work-item status table into the PR body.

---

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
