# ARCH-NOTES-V21 — recon map for the v2.1 feedback run (2026-08-11)

Ground-truth architecture notes for later agents. Written from actual code on
branch `v21-feedback` (off main @ 2780869). Where these notes conflict with
RUN-CONTEXT-V21.md, the CODE was trusted; discrepancies are listed in §6.

Stack: Vue 3 + vite + vue-router (SPA, no state library — module-singleton
reactive stores), supabase-js v2 against self-hosted Supabase, Python parser
(pymavlink + psycopg) as a separate queue worker.

---

## 1. Frontend structure, mapped to work items A–G

Entry: `src/main.ts` → `src/App.vue` (bare `<router-view/>`) → `src/router.ts`.

Router (`src/router.ts`):
- `/` FleetList, `/login` (public), `/aircraft/new`, `/aircraft/:id`,
  `/sites`, `/flights`, `/flights/new` (QuickLog), `/flights/:id` (FlightCard),
  `/upload` (BulkUpload), `/logs` (LogStatus), `/styleguide` (public),
  catch-all → `/`.
- Global guard at router.ts:32-41: awaits `initAuth()`, redirects to `/login`
  when no session. NOTE: guard only checks session, NOT roles — a new admin
  route needs its own role check (plus RLS; client gating alone = red-team FAIL).

Shared libs:
- `src/lib/supabase.ts` — client (env: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY).
- `src/lib/db.ts` — data-access discipline: `insertRow`/`updateRow`/`deleteRow`
  throw on 0 rows (RLS denial surfaces as error); `selectRows` throws on error.
  All row TS interfaces live here (Profile, Aircraft, Flight, FlightLog,
  FlightLogSummary, …). Extend these for any new columns.
- `src/lib/auth.ts` — reactive `auth` store {session, profile, operatorOf[], ready};
  computed `isAdmin`, `isManufacturer`, `roles`; `canWriteAircraft()`,
  `canViewRawGps()`; `signInWithGitHub()` EXISTS (auth.ts:133-139), gated by
  `githubEnabled` = `VITE_GITHUB_AUTH_ENABLED === 'true'` (auth.ts:15-16).
  `refreshProfile()` exists for after admin edits.
- `src/lib/logs.ts` — upload pipeline: sha256 → INSERT flight_logs row →
  storage PUT to bucket `flight-logs`; `DuplicateLogError` thrown on unique
  checksum violation (logs.ts:21-54); watcher-race recovery at :81-90.
- `src/lib/binlog.ts` — `sha256Hex(file)` + `extractLogStartTime(file)`
  (GPS-clock scan of the log head, fallback file mtime).
- `src/lib/weather.ts` — Open-Meteo keyless fetch: `fetchWeatherAt(lat, lon, when)`
  (forecast API <6 days old, else archive), `weatherLine()` for notes text.
- `src/lib/format.ts` — `fmtDuration` (s → MM:SS / H:MM:SS), `fmtHours`,
  `fmtDateTime`, `fmtBytes`, `toDatetimeLocal`/`fromDatetimeLocal`.

UI kit: `src/components/ui/` — AppNavbar, AppSidebar, AppTable (slot per cell:
`#cell-<key>`), AppCard, AppBadge, AppInput (as=select/textarea/checkbox),
AppButton, AppBreadcrumbs. Chrome: `src/components/AppShell.vue` (navbar +
sidebar + breadcrumbs). Sidebar sections are computed at AppShell.vue:26-51 —
add the admin nav entry there (already role-conditional for "Manufacturing").
Design tokens: `src/styles/tokens.css`; component gallery `/styleguide`
(`src/pages/Styleguide.vue`) — match its patterns for new pages.

Per work item:
- **A (login)** — `src/pages/Login.vue`. GitHub button already implemented at
  Login.vue:128-141 (flag-gated); the "New accounts start as operator…" text to
  REMOVE (A2) is Login.vue:151-154. Wordmark to replace (A3) is the
  `login__wordmark` span "ARROW" at Login.vue:85-89; also the navbar brand in
  `src/components/ui/AppNavbar.vue`. No assets in `src/assets/` yet; `public/`
  exists. OAuth callback: supabase-js default `detectSessionInUrl` handles the
  redirect landing on `/` (redirectTo = window.location.origin, auth.ts:136);
  `onAuthStateChange` in initAuth reloads the profile. Profile provisioning for
  OAuth users already handled server-side (see §4).
- **B (admin page)** — does not exist. Build `src/pages/Admin.vue` + route +
  sidebar entry gated on `isAdmin`. Server side already supports it: RLS
  "update own profile or admin" on user_profiles (rls.sql:27-30) + guard_roles
  trigger lets admins change `roles[]`; aircraft_operators INSERT/DELETE
  allowed for manufacturer/admin (rls.sql:103-108, `granted_by = auth.uid()`
  required on insert). Listing users: `user_profiles` SELECT is fleet-visible
  (rls.sql:21-22); emails are NOT in user_profiles (auth.users is not readable
  from the client) — display name/id only, or add a column/view via migration.
- **C (fleet page)** — `src/pages/FleetList.vue`. Tiles are `AppCard`
  (`src/components/ui/AppCard.vue`): `--card-bg` #f1f3f8 + bayer-dither SVG
  background-image at AppCard.vue:83-86 — that dither is the C1 readability
  culprit. Stats math (flight count + hours, summary-first) at
  FleetList.vue:64-98 — the same map already computes per-aircraft seconds;
  a "total hours across Quiver airframes" (C3) can be derived there (filter
  `aircraft_types.name === 'Quiver'`). Filters (C2): status field exists
  (`aircraft.status` active/maintenance/retired), type via `aircraft_types`,
  "operated by me" via `auth.operatorOf`, "manufactured by me" via
  `aircraft.built_by`/`created_by` vs `userId`.
- **D (sites/weather)** — `src/pages/Sites.vue` (plain CRUD table+form);
  weather consumed only in `src/pages/QuickLog.vue` (autofillWeather at
  QuickLog.vue:118-147, uses `selectedSite.lat/lon` + started_at; result is
  appended to flight NOTES — there is no weather column). Parser-side takeoff
  coords for D1: `parser/arrow_parser/summary.py` tracks GPS fixes at
  :234-242 (`last_fix = (lat, lng)`) — first valid fix is available there;
  round to 2 dp BEFORE it leaves the parser. New summary key + new
  flight_log_summary column via migration; db.py picks up columns
  automatically (§2/§4 of parser README, see §5 note on db.py introspection).
  PRIVACY: flight_log_summary is fleet-visible under RLS ("summaries
  fleet-visible", rls.sql) — a coarse 2-dp coordinate column there is readable
  by ALL authenticated users regardless of gps_private. 2 dp ≈ 1.1 km is the
  accepted coarseness per RUN-CONTEXT; do not store more precision.
- **E (flights table)** — `src/pages/Flights.vue`. Root cause of E1 in §3.
  Filters (E2): the page loads a flat 200-row select (Flights.vue:32-41);
  add client-side filter state over the same query (aircraft type needs
  `aircraft(type_id, aircraft_types(name))` added to the select). Incident
  flag: NO column on flights today; `airframe_events.kind='incident'` exists
  but is per-aircraft, optionally linked to a flight via
  airframe_events.flight_id. RUN-CONTEXT prescribes a new `incident` enum
  column on flights via migration — nothing in the code conflicts with that.
  Flight detail page for editing = `src/pages/FlightCard.vue` (833 lines:
  meta edit form, per-log summary cards, modes timeline, health checks,
  notes; log summary render at :409-445).
- **F (uploads)** — `src/pages/QuickLog.vue` + `src/pages/BulkUpload.vue`,
  both call `uploadFlightLog` from `src/lib/logs.ts`.
  F1: dedupe EXISTS end-to-end (sha256 client-side, `checksum text not null
  unique` in schema, DuplicateLogError caught per-file in BulkUpload.vue:134-136
  → 'duplicate' state, QuickLog.vue:212-216). What's missing vs the ask:
  a PRE-upload checksum query (current code discovers the dupe at INSERT
  time — functionally equivalent, but no pre-warn). Unique index already
  exists; no race migration needed.
  F2: aircraft dropdown ALREADY operator-filtered — `writableAircraft` at
  QuickLog.vue:64-68 and BulkUpload.vue:47-49. Sites dropdowns are unfiltered
  in the UI, but RLS (redteam fix, §2) already limits visible sites to
  own+public+admin. "Sites where user is operator" has no schema backing —
  sites have no operator edge; interpret as own+public or add nothing.
  F3: "Ended" field = QuickLog.vue:291 (`form.ended_at`); flights.started_at
  and ended_at are BOTH already nullable in schema (constraint only orders
  them). BulkUpload never sets ended_at. `start_time_utc`: parser computes it
  (summary.py:455, unix seconds) and db.py already passes it
  (db.py:117) — it is dropped only because flight_log_summary has no column;
  a migration adding `start_time_utc` (numeric or timestamptz — note db.py
  adapt() sends the raw unix number; check type adaptation in db.py:79-101)
  makes it land automatically.
- **G (param viewer)** — NO frontend code exists for params (grep
  `param_snapshots` in src/ → zero hits). Table exists (§2), parser writes it
  (watcher pipeline → db.py `_filtered_insert` into param_snapshots), RLS =
  fleet-visible SELECT ("params fleet-visible"), admin-only writes. Params are
  stored as one jsonb blob per log — a diff of two flights is two single-row
  fetches. Natural home: new page(s) + a link from FlightCard's log section.
  No virtualization lib in package.json — add one or paginate manually.

## 2. Actual schema (supabase/migrations/, applied in filename order)

Files: `20260810210000_types.sql` (enums), `210100_tables.sql` (22 tables +
grants), `210200_helpers.sql` (app.* role helpers + triggers), `210300_rls.sql`,
`210400_audit.sql`, `210500_storage.sql` (buckets `flight-logs`,
`flight-logs-sanitized`), `210600_seed_aircraft_types.sql` (Quiver/Caribou/
Spearhead/Kestrel with fixed UUIDs), `232000_redteam_fixes.sql`.
New migrations: follow `YYYYMMDDHHMMSS_name.sql` naming.

Roles — enum + array on profile (NOT a join table):

```sql
create type public.user_role as enum ('admin', 'manufacturer', 'operator');

create table public.user_profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  name                text,
  roles               public.user_role[] not null default '{operator}',
  gps_default_private boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
```

Aircraft access — per-aircraft operator edge:

```sql
create table public.aircraft_operators (
  aircraft_id uuid not null references public.aircraft (id) on delete cascade,
  user_id     uuid not null references public.user_profiles (id) on delete cascade,
  granted_by  uuid references public.user_profiles (id) default auth.uid(),
  granted_at  timestamptz not null default now(),
  primary key (aircraft_id, user_id)
);
```

Flights (started_at/ended_at both nullable; gps_private filled by trigger):

```sql
create table public.flights (
  id          uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft (id) on delete restrict,
  pilot_id    uuid references public.user_profiles (id),
  site_id     uuid references public.sites (id) on delete set null,
  started_at  timestamptz,
  ended_at    timestamptz,
  title       text,
  notes       text,
  created_by  uuid not null references public.user_profiles (id) default auth.uid(),
  session_id  uuid,
  gps_private boolean not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint flights_time_order check (
    started_at is null or ended_at is null or ended_at >= started_at
  )
);
```

flight_logs (checksum already UNIQUE — F1's anchor):

```sql
create table public.flight_logs (
  id             uuid primary key default gen_random_uuid(),
  flight_id      uuid not null references public.flights (id) on delete restrict,
  object_path    text not null unique,
  sanitized_path text,
  checksum       text not null unique,
  size_bytes     bigint check (size_bytes is null or size_bytes >= 0),
  uploaded_by    uuid not null references public.user_profiles (id) default auth.uid(),
  uploaded_at    timestamptz not null default now(),
  status         public.flight_log_status not null default 'uploaded',
  error          text,
  updated_at     timestamptz not null default now()
);
```

flight_log_summary (NO start_time_utc / armed_duration_s / vehicle /
coordinate columns today — D1 and F3 columns go here via new migration):

```sql
create table public.flight_log_summary (
  log_id        uuid primary key references public.flight_logs (id) on delete cascade,
  duration_s    numeric check (duration_s is null or duration_s >= 0),
  distance_m    numeric check (distance_m is null or distance_m >= 0),
  max_alt_m     numeric,
  max_speed_mps numeric,
  battery       jsonb,
  health        jsonb,
  modes         jsonb,
  events        jsonb,
  errors        jsonb,
  wind          jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

param_snapshots (one jsonb blob per log; fleet-visible SELECT):

```sql
create table public.param_snapshots (
  log_id     uuid primary key references public.flight_logs (id) on delete cascade,
  params     jsonb not null,
  created_at timestamptz not null default now()
);
```

RLS essentials (20260810210300_rls.sql + 232000_redteam_fixes.sql):
- Helpers in schema `app` (SECURITY DEFINER): `app.is_admin()`,
  `app.is_manufacturer()`, `app.is_operator_of(uuid)`,
  `app.can_write_aircraft_data(uuid)`, `app.can_write_flight(uuid)`,
  `app.can_view_raw_gps(uuid)`.
- user_profiles: SELECT all authed; UPDATE own-or-admin; role changes guarded
  by `tg_guard_roles` trigger (helpers.sql:146-166) — non-admins cannot set
  roles ≠ '{operator}' on insert nor change roles on update.
- aircraft_operators: SELECT all authed; INSERT/DELETE manufacturer-or-admin.
- flights/flight_logs/flight_log_summary/param_snapshots: SELECT all authed
  (fleet-visible); writes via can_write_aircraft_data/can_write_flight;
  summary/params/series writes are admin-or-service_role only.
- flight_log_series SELECT is gps-gated (`app.can_view_raw_gps`).
- sites SELECT (redteam fix): `visibility='public' or created_by=auth.uid()
  or app.is_admin()` — NOT fleet-visible anymore.
- Grants: `authenticated` has table-level DML grants; RLS is the control.
  Default privileges cover future tables created by postgres — new migration
  tables still need `enable row level security` + policies.

Local seed (`supabase/seed.sql`, applied by `supabase db reset` only): Thomas
admin+manufacturer thomas@arrowair.com / Julius manufacturer julius@example.com
/ Op Test operator operator@example.com, all password123, + 2 coord-less sites.

## 3. Bug E1 root cause (durations not showing on /flights)

`src/pages/Flights.vue:85-88`:

```ts
duration:
  f.started_at && f.ended_at
    ? fmtDuration((new Date(f.ended_at).getTime() - new Date(f.started_at).getTime()) / 1000)
    : '—',
```

Duration is computed ONLY from `started_at`/`ended_at`. The select at
Flights.vue:36 fetches `flight_logs(id,status)` but never joins
`flight_log_summary`, so the parser's `duration_s` is never read on this page.
Flights created by BulkUpload get `started_at` only — no `ended_at` is ever
written (BulkUpload.vue:118-126) — so every bulk-uploaded flight (the vast
majority; prod has 190 parsed logs) renders '—' even though
flight_log_summary.duration_s is populated.

Fix pattern already exists in the codebase: FleetList.vue:49-51 selects
`flight_logs.select('flight_id, flight_log_summary(duration_s)')` and
FleetList.vue:64-92 prefers summary duration, falling back to ended-started.
For /flights, extend the embedded select to
`flight_logs(id,status,flight_log_summary(duration_s))` and prefer the
summed/first summary duration_s. (Beware: embedded one-to-one comes back as
object OR array depending on PostgREST version — both FleetList.vue:68-70 and
FlightCard.vue:76-78 defensively handle both; copy that.)

## 4. Profile/role provisioning on signup (A1)

Server-side trigger, already OAuth-aware — `supabase/migrations/
20260810210200_helpers.sql:116-140`:

```sql
create or replace function public.handle_new_user() ... security definer ...
begin
  insert into public.user_profiles (id, name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'name',       -- email signup (options.data.name)
      new.raw_user_meta_data ->> 'full_name',  -- GitHub OAuth
      new.raw_user_meta_data ->> 'user_name',  -- GitHub login
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
```

So EVERY new auth.users row (email or GitHub) gets a user_profiles row with
`roles` defaulting to `'{operator}'` and zero aircraft_operators rows — i.e.
GitHub users already land in the "operator, no assignments" state A1 requires.
No new trigger/migration needed for provisioning (verify on local stack when
docker is fixed). The role-escalation guard (`tg_guard_roles`) allows this
insert because auth.uid() is NULL in the trigger context. Client-side fallback:
none — if the trigger were missing, auth.ts loadProfile would just get NULL
profile ("NO ROLE" in sidebar).

## 5. Test setup + local dev reality

- **vitest: NOT INSTALLED.** package.json has no test script, no vitest
  devDependency, and there are zero `*.test.*` files in the repo. The
  RUN-CONTEXT bar "npx vitest run green" requires ADDING vitest (+ config +
  first tests) in this run. Good first targets: format.ts, the E1 duration
  mapping, param-diff logic, checksum/dup logic.
- **pytest: NOT SET UP.** `parser/tests/` contains gate scripts
  (`gate_round1.py`, `gate_round2.py`, `report_table.py` — standalone
  fixture-based harnesses), no `test_*.py`, no pytest in
  parser/requirements.txt, no config. "parser pytest green (if parser
  touched)" ⇒ D1 parser work must add pytest + tests.
  Parser venv exists: `parser/.venv` (python 3.14 site-packages; system
  python3 is 3.9.6 — use the venv).
- **Build:** `npm run build` (vite build; `npm run typecheck` = vue-tsc also
  available). node v24.18.0 active.
- **ui-smoke:** `run/ui-smoke.mjs` (Playwright, chromium). Prereqs: dev server
  on :5199, LOCAL supabase stack seeded, parser watcher running, and fixture
  logs (`fixtures/nas-logs/*.BIN` exist; it also references a PT1 log at
  /Users/hex/projects/project-quiver/flight-test/PT1/... — verify before run).
  It shells `docker exec supabase_db_flight-tracking psql ...` to pre-clean.
- **Supabase CLI local dev: PRESENT BUT CURRENTLY BROKEN ON THIS MACHINE.**
  CLI 2.112.0 at /opt/homebrew/bin/supabase; docker = colima context. The P0
  run's containers exist (supabase_db_flight-tracking etc., kong on :54321)
  but the colima docker daemon is in a corrupted state: `docker ps` claims the
  db container is "Up 17 hours (healthy)" while exec/start/restart fail with
  `open /var/lib/docker/containers/39ba3322.../hosts: input/output error`,
  and `supabase status` reports the db container exited. Time-boxed attempts
  (docker start/restart) failed. Likely fix: `colima restart` (restarts ALL
  local containers, including non-project container `v1source`) then
  `supabase start` in the repo — a later agent should do this early, since
  RLS tests, ui-smoke, and D1 watcher verification all depend on it. Until
  then: build + unit tests + code review carry the weight (RUN-CONTEXT
  anticipates this).
- RLS matrix harness: `tests/rls/rls_matrix.sql` + `tests/rls/run.sh`
  (needs the local db).

## 6. Discrepancies vs RUN-CONTEXT-V21 (code wins; noted per rule)

1. **A1 is ~80% built already.** GitHub OAuth button + `signInWithGitHub()`
   exist behind `VITE_GITHUB_AUTH_ENABLED` (auth.ts:15-16,133-139;
   Login.vue:128-141), and `.env.example` already documents ALL the
   GOTRUE_EXTERNAL_GITHUB_* server env vars plus the real OAuth client id and
   callback URL. Profile provisioning for OAuth users already works (§4).
   Remaining A1 work: README docs note (README.md doesn't cover it — only
   .env.example does), decide flag default for prod build, and verify the
   callback/session path.
2. **F1 duplicate detection largely exists** (sha256 client hash, unique
   checksum column, DuplicateLogError, per-file 'duplicate' state in bulk).
   Missing vs the letter of the ask: pre-upload checksum QUERY (warn before
   creating the flight stub — today the flight stub row is created even when
   the log turns out to be a dup) and no "warn/skip" choice UI. The unique
   index already covers the server-side race; no migration needed.
3. **F2 aircraft dropdowns are already operator-filtered** (QuickLog.vue:64-68,
   BulkUpload.vue:47-49). Only the SITES half of F2 is genuinely open, and
   "sites where user is operator" has no schema meaning — sites have
   created_by + visibility only (post-redteam RLS already narrows visible
   sites to own+public+admin).
4. **"vitest green" / "parser pytest green" bars reference test suites that do
   not exist.** No vitest, no pytest anywhere in the repo (§5). "Unit tests
   where the repo has precedent" — there is NO precedent; infra must be added.
5. **F3 "parser computes start_time_utc, add column, db.py picks it up"** —
   confirmed accurate: summary.py:455 emits it (unix seconds float), db.py:117
   already includes it in summary_row; `_filtered_insert` drops it for lack of
   a column. Caveat: check db.py's adapt() type handling — the value is a
   unix number, so the new column should be numeric, or db.py/parser must
   convert if timestamptz is chosen.
6. **E2 "if no incident field exists"** — none on flights, but
   `airframe_events.kind='incident'` already models incidents at the aircraft
   level with an optional flight_id link. Adding the prescribed
   `incident` enum column on flights is additive, but the builder should
   decide whether to reconcile/cross-populate with airframe_events.
7. **Verified-facts section says prod summary drops `max_alt_source`,
   `message_counts`, `vehicle`, `armed_duration_s`, `start_time_utc`** —
   matches parser/README.md and db.py exactly. Also note db.py maps
   summary key `max_speed_ms` → column `max_speed_mps` (db.py:115-116);
   keep that in mind when adding columns (name them to match what db.py
   sends, or add mappings).
8. **RUN-CONTEXT says "Local supabase dev: `supabase start` if CLI
   available"** — CLI is available but the docker daemon is currently broken
   (§5); plan around a colima restart.
9. Minor: `flight_log_summary.wind` column exists but summary.py never emits
   a `wind` key (QuickLog comment says "parser-side wind lands in
   flight_log_summary.wind later" — not implemented; irrelevant to A–G but
   don't be surprised by NULLs).
10. Login note text (A2 target) is at Login.vue:151-154 — it also states the
    role model that page B's UI will make visible; removing it (per A2) loses
    the only user-facing explanation of the "no role" state. QuickLog/
    BulkUpload keep their own "not assigned" warnings, so removal is safe.
