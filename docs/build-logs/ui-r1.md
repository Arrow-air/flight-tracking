# UI — round 1 build log

Run: 2026-08-10 evening, branch `overnight/p0`. First UI round of this launch:
`docs/build-logs/` had design/schema/parser PASSED but no `ui-r*.md`, and
`src/pages/` contained only the scaffold `Home.vue` + `Styleguide.vue` — so the
P0 UI was built from scratch on top of the (untouched) design system.

## What was built

### Wiring / env
- `.env.local` (gitignored) — local stack values from `supabase status`
  (`http://127.0.0.1:54321` + `sb_publishable_…` key) + `VITE_GITHUB_AUTH_ENABLED=false`.
- `.env.example` — documents the GitHub OAuth wiring with placeholders only:
  `VITE_GITHUB_AUTH_ENABLED` (frontend flag) + the four
  `GOTRUE_EXTERNAL_GITHUB_*` server vars (client ID `Ov23liqSDMPkyBhht5hG` is
  public; the SECRET is explicitly marked do-not-commit). Per RUN-CONTEXT the
  callback targets prod, so no end-to-end GitHub login was attempted — the
  button renders only when the flag is true (asserted wiring by flipping the
  flag locally, left `false`).
- `src/vite-env.d.ts` — typed the new env var.

### `src/lib/` (data layer)
- `db.ts` — row types for the schema tables the UI touches + **strict write
  helpers** (`insertRow`/`updateRow`/`deleteRow`/`selectRows`): every write
  either returns the affected row(s) or throws a translated error; **0 rows
  affected throws** (v1 pain point #1 / RLS invariant 4 — no silent RLS
  swallowing). 42501 → "permission denied — your role…", 23505 → "duplicate…".
- `auth.ts` — reactive auth store: session, `user_profiles` row (roles[]),
  and the operator control edge (`aircraft_operators` rows for the user).
  Helpers `isAdmin`/`isManufacturer`/`canWriteAircraft`/`canWriteComponents`/
  `canViewRawGps` mirror the `app.*` SQL helpers so the UI hides exactly what
  RLS denies. Email sign-in/up/reset + `signInWithGitHub` behind the flag.
- `binlog.ts` — client-side DataFlash helpers: SHA-256 checksum, and
  **best-effort log start-time extraction** (walks FMT self-describing formats
  in the first 8 MB, decodes the first GPS msg with GWk>0 → GPS week/ms →
  UTC, 18 s leap correction). Falls back to file mtime, labelled `mtime` so
  the UI says which source it used.
- `weather.ts` — Open-Meteo (keyless): forecast API w/ `past_days` for recent
  dates, archive API for older, nearest-hour pick (≤2 h tolerance), returns
  temp/RH/precip/wind/gusts/direction + `weatherLine()` one-liner.
- `logs.ts` — upload pipeline per the storage-migration contract: checksum →
  `flight_logs` row FIRST → storage PUT at that exact path in `flight-logs`.
  Duplicate checksum → `DuplicateLogError`; failed PUT marks the row
  `status='error'` with the reason (no silent half-uploads). Signed-URL
  helpers for raw + sanitized buckets (storage RLS decides; denial → null).

### `src/components/`
- `AppShell.vue` — the authenticated chrome: AppNavbar (user name + roles +
  sign out), role-aware AppSidebar (Manufacturing section only for
  manufacturer/admin), breadcrumbs, content column.
- `AlertBanner.vue` — admonition-style error/success/warning strip; every
  write failure in the app surfaces through it.
- **`src/components/ui/` internals untouched** (no prop additions needed).

### Pages (all under the shell, all on the design system)
- `Login.vue` (`/login`, public) — sign in / create account / reset password;
  GitHub button behind the flag with the octocat mark.
- `FleetList.vue` (`/`) — aircraft card grid w/ type, status badge, derived
  stats (flight count + hours; parsed `flight_log_summary.duration_s` wins
  over `ended-started`). "New aircraft" hidden from non-manufacturers.
- `AircraftNew.vue` (`/aircraft/new`) — registry form; non-manufacturers get
  a warning banner and, if they submit anyway, the real RLS error.
- `AircraftDetail.vue` (`/aircraft/:id`) — registry cards (identity /
  operators / notes) + inline edit; operator assign/revoke (manufacturer/
  admin); **component history** (install/remove events w/ inline new-component
  creation, position, reason) as a table; **airframe events** stream
  (maintenance/incident/field_action); flights table for the airframe.
- `Sites.vue` (`/sites`) — CRUD table + inline form; "no coords" warning badge
  (coords gate the weather auto-fill); edit/delete only for creator/admin
  (mirrors RLS).
- `Flights.vue` (`/flights`) — all flights w/ aircraft/pilot/site joins,
  per-flight log-status rollup badge, GPS badge; rows open the flight card.
- `QuickLog.vue` (`/flights/new`) — one-screen entry: aircraft (**operators
  only see aircraft they're assigned**, admins all), pilot, site, times,
  title, notes, tags (comma-separated → tags upsert + flight_tags),
  gps_private checkbox defaulted from profile, optional `.bin` attach
  (timestamp auto-read from the log → start time), **Open-Meteo auto-fill**
  (auto-fires when site w/ coords + start time exist; result appended to
  notes on save).
- `BulkUpload.vue` (`/upload`) — drop N `.BIN`s, batch defaults
  (aircraft/pilot/site/gps), one shared `session_id` per batch; per file:
  GPS-time extraction → flight stub (`Bulk dump · <file>`) → log row →
  storage PUT; live per-file state machine
  (queued/timing/creating/uploading/done/duplicate/failed) in a table with
  links to the created flights.
- `LogStatus.vue` (`/logs`) — every log with size/uploader/status/detail,
  status counts, **realtime subscription on `flight_logs` + 10 s poll
  fallback**; rows link to the flight.
- `FlightCard.vue` (`/flights/:id`) — flight header (aircraft/pilot/site/
  times/tags/GPS badge), inline edit for writers, per-log section: status
  badge, **parsed summary** (duration/distance/max alt/max speed/health
  score+grade), battery card (start/min/sag/per-cell/mAh/peak A, cells w/
  "est." when inferred), modes timeline (t → mode → dwell), events list,
  error count, collapsible health-check table (ok/warn/fail per check);
  **downloads: Raw .bin only when `canViewRawGps`** (admin/owner/non-private),
  Sanitized .bin whenever `sanitized_path` exists; attach-another-log for
  writers; notes list + add note. Polls 5 s while logs are uploaded/parsing.
- `router.ts` — all routes + auth guard (awaits `initAuth()`; non-public →
  `/login?redirect=…`; logged-in `/login` → `/`). Scaffold `Home.vue`
  deleted (its unscoped dark `body` style was the placeholder the design
  round flagged).

## Verification (builder smoke — NOT the critic gate)

`npm run typecheck` ✅ and `npm run build` ✅ (948 ms, see terminal).

Functional smoke `run/ui-smoke.mjs` (playwright, dev server :5199, local
stack seeded, parser watcher running from `parser/` with
`DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`,
`SUPABASE_URL=http://127.0.0.1:54321`, service-role key from
`supabase status`): screenshots in `docs/build-logs/ui-r1-shots/`.

Final run (all 16 steps green, exit 0, 11 s wall):

```
PASS [1s]  thomas login + fleet renders
PASS [1s]  manufacturer created aircraft — SMOKE-MSO0ZFCZ
PASS [1s]  operator assigned to aircraft
PASS [1s]  component install event logged
PASS [1s]  airframe maintenance event logged
PASS [2s]  site with coordinates created — Smoke Field mso0zfcz
PASS [2s]  new-aircraft button hidden from operator
PASS [2s]  operator aircraft INSERT denied with visible error —
           "permission denied — your role is not allowed to do this"
PASS [2s]  log timestamp extracted — from the log's GPS clock (2025-03-05 14:49:59)
PASS [4s]  weather auto-filled — Open-Meteo archive, 2025-03-05T21:00Z:
           24.8 °C, RH 18%, wind 10.1 km/h from 44° gusting 28 km/h
PASS [5s]  operator quick-logged flight with real PT1 .BIN upload (4.4 MB)
PASS [10s] flight card parsed: duration 02:52, battery start 57.85 V,
           modes STABILIZE/ALT_HOLD/POSHOLD, health 65 (C)
PASS [11s] bulk-drop: 3 NAS logs → 3 flight stubs created
PASS [11s] bulk stubs appear in flights list
PASS [11s] non-owner (julius) sees NO raw download for gps_private flight
PASS [11s] non-owner gets sanitized artifact button
```

DB cross-check: `flight_log_summary` row for the PT1 log has
duration_s=172.2, distance_m=156.3, max_speed_mps=5.95, health score 65,
3 modes; `flight_logs.sanitized_path` set; watcher log confirms
parse+sanitize+verify. Checksum dedupe confirmed working (a re-upload of
the same PT1 file across smoke runs was rejected as duplicate — the smoke
now pre-cleans its own rows).

Notes from smoke debugging:
- 3 stale `rls-test/L*.bin` rows (schema-gate fixtures with no storage
  objects) were claimed by the watcher and correctly flipped to
  `status='error'` with the HTTP reason — visible-failure behavior working.
- **Real race found & fixed**: the helpers migration NOTIFYs on the
  `flight_logs` row INSERT, but the storage contract requires row-first,
  PUT-second — so the watcher woke and tried to download the object *before
  the browser finished uploading it*, 400'd, and errored the row. Fix in
  `src/lib/logs.ts`: after a successful PUT, conditionally flip
  `status='error' → 'uploaded'` (the status change re-NOTIFYs; parser writes
  are ON CONFLICT upserts, so double-parse is safe), plus a "Retry parse"
  button on the flight card for writers. Verified: re-queued PT1 log went
  `error → uploaded → parsed` with `sanitized_path` set, duration 172.2 s,
  health 65. A schema-side hardening (e.g. deferring NOTIFY or an
  'uploading' state) could remove the window entirely — left for a critic
  to route to the schema owner if wanted.

## Assumptions (labelled)

- **Weather storage**: `flights` has no weather column; quick-log appends the
  Open-Meteo one-liner to `flights.notes`. Parser-side wind belongs to
  `flight_log_summary.wind` later. If a critic wants structured weather, it
  needs a schema addition (out of my lane this round).
- **Bulk-dump `ended_at`** is left NULL on stubs (parser summary carries
  duration); "editable later" = flight-card inline edit.
- **Client-side GPS-time extraction** is best-effort (first 8 MB scan); files
  without early GPS lock fall back to mtime, labelled in the UI and refined
  by the parser at parse time.
- Role changes / user administration UI is NOT in P0 scope (seed users carry
  roles; `guard_roles` trigger blocks self-promotion).

## What remains / known gaps

- Aircraft photo upload (schema `photo_path`) — not wired; media bucket
  helpers exist but no UI. P0 spec lists "photo" under registry fields via
  V2-PLAN item 3; treated as nice-to-have this round.
- Flight deletion UI (RLS allows for writers) — intentionally omitted
  (system of record); no critic requirement.
- `flight_log_series` / param views are P1 (plots/params) — not built.
- GitHub OAuth end-to-end is untestable locally by design (prod callback);
  only flag/button wiring is claimable.

## Environment left running for the critic

- Vite dev server on **:5199** (`npm run dev -- --port 5199`, log
  `/tmp/ft-dev.log`).
- Parser watcher (2 workers) from `parser/` with
  `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`,
  `SUPABASE_URL=http://127.0.0.1:54321`,
  `SUPABASE_SERVICE_ROLE_KEY=<from supabase status>`; log
  `/tmp/ft-watcher.log`. (Session-scoped processes — if gone, restart with
  those commands.)
- Local DB currently contains smoke leftovers (SMOKE-* aircraft, Smoke
  Field sites, bulk stubs, 3 stale `rls-test/L*.bin` error rows from the
  schema gate). `supabase db reset` gives a clean slate; the smoke script
  (`run/ui-smoke.mjs`) pre-cleans its own rows on each run.
