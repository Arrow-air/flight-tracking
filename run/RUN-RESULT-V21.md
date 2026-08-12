# RUN-RESULT-V21 — Flight Tracking v2.1 feedback round 1 (2026-08-11)

Branch: `v21-feedback` off main @ 2780869. 10 commits. Draft PR to main —
DO NOT merge before reading "Decisions Thomas must make" below.

Evidence discipline: everything in this file is backed by commits on the
branch, files in the repo, or commands re-run by the packager on 2026-08-11
(~18:00). Per-round critic verdicts (numeric 0-10 scores) were returned as
structured JSON to the run orchestrator and were not persisted to disk; this
file records the round counts, the issues critics raised that forced fixes
(preserved verbatim in commit messages), and the packager's independent
re-verification. That gap is labeled where it applies.

## Final verification (re-run by packager, 2026-08-11 ~18:00)

| Gate | Result |
|---|---|
| `npm run build` (vite + vue-tsc) | exit 0, built in 1.05s |
| `npx vitest run` | 100/100 passed, 7 files, 331ms |
| `parser: python -m pytest` (parser/.venv) | 12/12 passed, 0.56s |
| `run/ui-smoke.mjs` (local supabase + dev server + parser watcher) | 16/16 PASS incl. real .BIN upload → parse-wait → flight card render, RLS denial visibility, GPS-privacy checks |

## Per-phase results

### Phase 0 — Recon (1 agent)
`run/ARCH-NOTES-V21.md` (417 lines, commit 1aad2e4): frontend map per work
item, actual schema quoted from migrations, E1 root cause, OAuth provisioning
path, test-infra reality, discrepancies vs RUN-CONTEXT (notably: GitHub
sign-in UI and F1/F2 substantially pre-existed — see work-item table).

### Phase 1 — Schema+Parser (1 round; critics: correctness, privacy)
Commit 5381493. Migration `20260811120000_v21_summary_takeoff_start_incident.sql`:
`flight_log_summary.start_time_utc timestamptz`, `takeoff_lat/lon numeric(5,2)`
with DB-level range checks (2-dp coarseness as defense in depth),
`flights.incident` enum (none/crash/hard_landing/systems/other) +
`incident_notes`. Parser emits takeoff coords rounded to 2 dp INSIDE the
parser; `pipeline.py verify_sanitized` asserts the sanitized artifact yields
NO takeoff coords. New pytest suite (12 tests) covers rounding vs an
independent first-fix scan, no-precise-coord leak walk over
summary/series/params outputs, unix→UTC conversion, db.py introspection
pre/post migration, and migration↔db.py column-name agreement.
Passed round 1 (no critic-fix commit exists).

### Phase 2 — QuickFixes (2 rounds; critics: functional, ux-consistency)
Commits 831cffb (r1), 5d5bfbe (r2). Round-1 critics found two real defects,
both fixed in r2 (issue text preserved in the 5d5bfbe commit message):
1. QuickLog `onFilePicked` async race — re-picking a file while the previous
   pick's sha256/dup-lookup awaited could permanently invert dedupe (upload
   new file under old checksum). Fixed with `logFile.value === f` guards
   after every await.
2. Deploy-ordering window — /flights selected the not-yet-applied
   `start_time_utc` column; would 42703 and render zero rows if frontend
   deploys before the migration. Now catches missing-column and retries
   with `duration_s` only. (Risk register #1.)

### Phase 3 — Features (3 sequential build loops)
- github-auth, 1 round (52fc2d1; critic: auth-review). OAuth
  failure-callback surfacing (`src/lib/oauthCallback.ts`, 5 tests), README
  GoTrue env docs + manual test plan for Hex. Provisioning for first GitHub
  login verified against the existing server-side path — no migration needed.
- admin-page, 1 round (591869f; critics: security, functional). `/admin` +
  `src/lib/admin.ts` (26 tests). RLS is the real gate (existing
  rls.sql policies + guard_roles trigger authorize exactly these ops; no new
  policies needed); route `meta.adminOnly` is client convenience. 0-rows-throws
  discipline means RLS denial can never look like success. Self-demotion
  lockout guarded client-side.
- filters-stats, 1 round (1387f90; critics: data-correctness, functional).
  Fleet + flights filters AND-composed and URL-synced (shareable), Quiver
  hours stat, incident editing on FlightCard, weather auto-fill preferring
  coarse log coords (site fallback, source labelled in the note).

### Phase 4 — ParamViewer (1 round; critics: functional, scale-ux)
Commit 09f1ff2. `src/lib/params.ts` pure logic + 25 tests (diff kinds,
null-vs-absent semantics, filter counts, hostile-localStorage round-trip);
`src/pages/FlightParams.vue` paginated 250/page (1000+ param safe), substring
search, two-flight diff, COMPASS_/STAT_ default hides + user prefix hides
persisted in localStorage, hidden COUNTS always visible. Entry: "Params →"
on each parsed log card in FlightCard; route `/flights/:id/params`.

### Phase 5 — Gate
No `[v21 gate-fix]` commit exists → gate passed without a fix round.
Independently re-verified by packager (table above).

### Phase 6 — RedTeam (security + product, verdicts held by orchestrator)
No `[v21 redteam-fix]` commit exists → no blocker-severity remediation was
required on app code. Observable red-team/gate artifact: the ui-smoke run
tripped over the P0 red-team RLS fix (private sites invisible to non-owners
emptied the operator's site dropdown in the smoke scenario — captured as
ERR-operator.png, since removed). Disposition: test-harness fix, not an app
bug — smoke's created site is now public (run/ui-smoke.mjs, commit 3c86c3f);
re-run 16/16 PASS. LABELED GAP: the red-team verdict JSON (findings that
were non-blocker, if any) was not persisted; nothing beyond the above is on
disk.

### Phase 7 — Package (this document)
Harness committed, tree clean, branch pushed, draft PR opened.

## Work-item status A1–G3

| Item | Status | Where / evidence |
|---|---|---|
| A1 GitHub sign-in | done (server config pending — Hex) | Button pre-existed flag-gated (`VITE_GITHUB_AUTH_ENABLED`), Login.vue; v21 adds OAuth error-callback surfacing (src/lib/oauthCallback.ts) + README GoTrue env docs + manual test plan. Provisioning verified, no migration. E2E needs the provider secret — cannot be tested locally. |
| A2 remove "new accounts…" text | done | Removed from Login.vue (831cffb). QuickLog/BulkUpload keep their own contextual "not assigned" warnings. |
| A3 real wordmark | done | Brand lockups downloaded to src/assets/brand/ (darkblue + white); login "ARROW" text replaced with darkblue lockup. Navbar already rendered the real SVG. |
| B1 admin page | done | /admin: list users, role checkboxes (self-demotion blocked), per-user aircraft grant/revoke. RLS-gated (existing policies) + client route guard. 26 tests. Emails not shown — auth.users is not client-readable by design (see decisions). |
| C1 tile readability | done | AppCard: plain --docs-bg, dither 0.15→0.06 at rest, body copy #6a7c95→#3d5270. |
| C2 fleet filters | done | Type / status(active·maintenance·retired) / manufactured-by-me / operated-by-me, AND-composed, URL-synced. |
| C3 Quiver total hours | done — HOME: fleet page header stat | "Quiver fleet total" in FleetList header; whole-fleet summary-first math, ignores active filters. |
| D1 log-coords weather | done | Parser emits 2-dp takeoff coords (precise never leaves parser; sanitize-verify test); migration columns; QuickLog reads coarse first-fix client-side pre-parse; FlightCard "Fetch weather → notes" prefers summary coords, site fallback, source labelled. |
| E1 durations bug | done | /flights embeds flight_log_summary(duration_s,…); src/lib/flightMetrics.ts sums parser duration_s, wall-clock fallback. Verified in smoke (flight card duration renders). |
| E2 flight filters + incident | done | Type / aircraft / site / manufacturer / incident(any·none·exact) / pilot / has-log / local-date range; URL-synced; incident enum via migration, edited on FlightCard (canWrite-gated). |
| F1 duplicate detection | done | sha256 pre-upload lookup + warn/skip in QuickLog and BulkUpload (incl. within-batch dupes); existing `checksum unique` index already covers the server-side race — partial index evaluated and rejected (documented in-migration). |
| F2 operator-scoped dropdowns | done (sites: interpreted) | Aircraft dropdowns already operator-scoped (writableAircraft). Sites have NO operator edge in schema — RLS scopes to own+public+admin; documented in-code. See decisions. |
| F3 remove ended, started optional | done | "Ended" input deleted (QuickLog + FlightCard edit); "Started" optional with hint; log-derived start_time_utc preferred everywhere via flightStartIso(). |
| G1 param browser | done | /flights/:id/params — paginated 250/page, substring search, per-row copy-name, log picker. |
| G2 param diff | done | Diff against any of the 500 most recent flights w/ parsed logs: changed/added/removed (old→new), null-aware, show-unchanged toggle. |
| G3 noise filters | done | COMPASS_*/STAT_* hidden by default, toggleable; user prefix hides persisted in localStorage; hidden counts always displayed. |

## Risk register

1. **Deploy-ordering window: /flights vs migration 20260811120000** —
   `src/pages/Flights.vue` selects `flight_log_summary.start_time_utc`,
   which exists only in unapplied migration
   `supabase/migrations/20260811120000_v21_summary_takeoff_start_incident.sql`.
   The frontend auto-deploys on merge to main; the migration is applied
   by Hex AFTER merge. **Action: apply the migration before or
   immediately at merge.** Mitigation shipped in r2: Flights.vue now
   catches the missing-column error and retries with `duration_s` only,
   so /flights still renders (durations correct, start column falls back
   to hand-entered `started_at`) during the window. FlightCard uses
   `flight_log_summary(*)` and is unaffected. The parser also only
   starts persisting `start_time_utc`/takeoff coords once the column
   exists (db.py drops unknown keys), so summaries written during the
   window lack log-derived start times until reparsed.
2. **Existing 190 prod summaries lack the new fields** — start_time_utc /
   takeoff coords only appear for logs parsed after the migration. A
   backfill reparse of existing logs is Hex's call (decision #4). Until
   then, /flights start times fall back to hand-entered started_at and
   FlightCard weather-fetch falls back to site coords for old flights.
3. **OAuth e2e untested** — GitHub sign-in cannot be end-to-end tested
   without the GoTrue client secret (server-side, Hex-managed). Unit tests
   cover the callback-error path; README carries the manual test plan.
   Feature stays dark until `VITE_GITHUB_AUTH_ENABLED=true` is set in the
   frontend deploy env, so there is no user-facing risk before Hex's config.
4. **Coarse takeoff coords are fleet-visible** — flight_log_summary is
   fleet-visible under RLS regardless of gps_private; the new
   takeoff_lat/lon (2 dp ≈ 1.1 km) are therefore readable by all
   authenticated users. This is the coarseness RUN-CONTEXT accepted, and
   the DB numeric(5,2) type + parser-side rounding + sanitize-verify test
   enforce it in depth — but it is a deliberate privacy trade-off worth
   restating.
5. **Critic/red-team verdict JSON not persisted** — round scores and any
   non-blocker red-team notes lived in the orchestrator only. Compensating
   controls: fix-forcing issues are quoted in commit messages, and the
   packager independently re-ran every gate (all green, incl. 16/16 smoke).

## Decisions Thomas must make

1. **Merge choreography**: apply migration 20260811120000 to prod before or
   immediately at merge (risk #1). Then (optionally) reparse existing logs
   to backfill start_time_utc/takeoff coords (risk #2).
2. **GitHub OAuth go-live**: Hex configures GoTrue
   (GOTRUE_EXTERNAL_GITHUB_ENABLED/CLIENT_ID/SECRET/REDIRECT_URI, documented
   in README) and sets `VITE_GITHUB_AUTH_ENABLED=true`; then run the README
   manual test plan once against prod.
3. **C3 stat home**: implemented as a fleet-page header stat ("Quiver fleet
   total"). Confirm, or say where you'd rather see it (dashboard candidate).
4. **F2 sites scoping**: schema has no operator↔site edge, so "sites where
   I'm an operator" is undefined; dropdown shows own+public (RLS-scoped).
   Accept, or ask for a site_operators table in a follow-up.
5. **Admin page identity display**: shows name + user id, NOT emails —
   auth.users is not client-readable (by design). If you want emails in the
   admin list, that's a small migration (mirrored column or security-definer
   view) in a follow-up.
6. **Incident history backfill**: new `flights.incident` starts empty;
   existing `airframe_events(kind='incident')` rows were not migrated into
   it (different granularity). Backfill only if you want old incidents
   filterable on /flights.
