# RUN-CONTEXT-V21 — Flight Tracking v2.1 Feedback Run (2026-08-11)

Ground truth for every agent in this run. READ THIS FULLY before any work.
Never invent facts. If something here conflicts with the code, TRUST THE CODE
and note the discrepancy in your output. Label all assumptions.

## Mission

Implement Thomas's 2026-08-11 feedback list (below, verbatim intent preserved)
on the flight-tracking app, fully tested and reviewed. This is a production app
with active users (flights.arrowair.com).

## HARD RULES (quoted directives, dated 2026-08-11)

1. ALL work on branch `v21-feedback` off current main (2780869). NEVER commit
   or push to `main`. Pushing the feature branch to origin is allowed and safe
   (auto-deploy only watches main).
2. NEVER touch production: no requests that mutate https://supabase.arrowair.com
   (except read-only GETs if genuinely needed — prefer not at all), nothing to
   ship.arrowair.com, no SSH to any server. Test locally only.
3. Never print secrets or contents of ~/.openclaw/workspace/.secrets/ or repo
   .env files into logs/commits.
4. Schema changes = new migration files under supabase/migrations/ following the
   existing naming pattern. They will be applied to prod by Hex AFTER merge —
   do not attempt to apply them anywhere but a local dev database.
5. Thomas (2026-08-11): "I'd feel better knowing that everything was completely
   tested and reviewed." Tests are not optional. Every feature lands with unit
   tests where the repo has precedent, `npm run build` green, vitest green,
   parser pytest green (if parser touched).
6. Repo Dockerfile convention: Openship builds with REPO ROOT as context and
   `-f parser/Dockerfile` — parser Dockerfile COPY paths are repo-root-relative.
   Do not "fix" this back.

## Work items (from Thomas, 2026-08-11)

### A. Login page
- A1: Add GitHub sign-in option. Frontend: supabase-js
  `signInWithOAuth({ provider: 'github' })` button alongside the existing email
  login. The GoTrue server config (client id/secret) is handled by Hex outside
  this run — implement the UI + a docs note in README for the server env vars
  (GOTRUE_EXTERNAL_GITHUB_ENABLED/CLIENT_ID/SECRET/REDIRECT_URI). Handle the
  OAuth callback route/session properly in the SPA. New GitHub-auth'd users with
  no profile row must land in the same "operator, no assignments" state as email
  signups (check how profiles are provisioned; add trigger/migration if needed).
- A2: REMOVE the text "New accounts start as operator with no aircraft
  assignments — an admin grants roles and aircraft access."
- A3: Replace the "Arrow" text with the actual wordmark. Assets (SVG):
  https://arrowair.com/img/brand/SVGs/arrow-lockup-white.svg (also -black, -blue,
  -darkblue variants; logomark-* variants; wordmark_gray.svg at
  /img/brand/wordmark_gray.svg). Download the appropriate variant(s) into
  public/ or src/assets/ and pick per theme/background. Brand colors:
  https://arrowair.com/docs/contributing/arrow-brand

### B. Admin page
- B1: New admin-only page: manage users and their roles, and aircraft
  assignments (the login page text implies roles + per-aircraft access already
  exist in schema — verify actual model in supabase/ and build on it).
  Must be gated by RLS AND client routing (client gating alone = red-team FAIL).
  Admin can: list users, change roles, grant/revoke aircraft access. Keep it
  simple and consistent with existing app styling.

### C. Fleet/Aircraft page
- C1: Tile styling: text hard to read — remove or lighten the tile backgrounds.
- C2: Filters: by aircraft type; by "manufactured by me" / "operated by me";
  by active/retired.
- C3: "Total flight hours across all Quiver airframes" stat — doesn't have to
  live on this page; pick a sensible home (fleet header stat or dashboard) and
  note the choice.

### D. Sites
- D1: Weather auto-fill should use actual flight-log coordinates when
  available. Parser summary should carry a COARSE takeoff coordinate
  (round to 2 decimal places ≈ 1.1 km — privacy: precise coords must NOT enter
  the DB; sanitized logs are the public artifact) via a new migration column;
  weather lookup prefers log coords, falls back to site coords. Parser change +
  migration + app change.

### E. Flights / All Flights page
- E1: BUG: durations not showing in the table. Parser writes `duration_s` in
  flight_log_summary; find where the table reads it and fix the mapping.
- E2: Filters for engineers studying fleet data: aircraft type, specific
  aircraft, site, manufacturer, crash/incident flag, plus anything else cheap
  (date range, pilot/operator, has-log). If no incident field exists, add one
  via migration (e.g. `incident` enum: none/crash/hard_landing/systems/other +
  optional notes) editable from the flight detail page.

### F. Log uploads
- F1: Duplicate detection on upload (esp. bulk). `flight_logs.checksum` column
  EXISTS (verified in prod schema 2026-08-11) — compute client-side hash
  (sha256) pre-upload, query for existing checksum, warn/skip duplicates.
  Also handle server-side race (unique index via migration if sensible).
- F2: Aircraft dropdown: only aircraft where the current user is an operator.
  Same for sites.
- F3: Delete the "ended" field. "Started" becomes optional — pull from the log
  itself when possible. Parser computes `start_time_utc` but the v2 schema has
  NO column for it (parser/README.md documents this) — add migration column,
  db.py picks it up automatically per its introspection design; verify.

### G. Param viewer/diff (BIG feature)
- G1: View + search all parameters from each flight log (`param_snapshots`
  table exists — verify shape). Per-flight param browser with substring search.
- G2: Diff params between any two flights: changed/added/removed values.
- G3: Noise filters: hide compass-calibration params (COMPASS_*) and STAT_*
  (always-changing) by default, toggleable; allow user-defined prefix hides.
  Design for 1000+ params (virtualized list or pagination).

## Verified facts (Hex, 2026-08-11)

- Prod flight_logs columns: id, flight_id, object_path, sanitized_path,
  checksum, size_bytes, uploaded_by, uploaded_at, status, error, updated_at.
- Parser summary fields dropped on DB write today (no columns):
  armed_duration_s, start_time_utc, vehicle, max_alt_source, message_counts.
- 190/192 prod logs parsed; 2 are text-format dumps mislabeled .bin (permanent
  errors, not your problem).
- Local repo: /Users/hex/projects/arrow/flight-tracking (main @ 2780869).
- Existing run harness from P0 run: run/ui-smoke.mjs (UI smoke test), fixtures/.
- Local supabase dev: repo supabase/ dir; `supabase start` if CLI available,
  otherwise unit/build tests + code review carry the weight. DO NOT test
  against prod.

## Testing bar (gate for shipping)

- `npm run build` exits 0.
- `npx vitest run` green.
- Parser: `cd parser && python -m pytest` green (venv: parser/.venv if present,
  else create).
- run/ui-smoke.mjs passes if runnable locally.
- Critics' verdicts must contain actual numbers/evidence (file:line, test
  counts), not vibes.

## Deliverables

- Branch `v21-feedback` pushed to origin with clean, logically-grouped commits.
- Draft PR to main via `gh pr create --draft` titled
  "v2.1: feedback round 1 — auth, admin, filters, param viewer" with a body
  summarizing every work item's status (done/partial/skipped + why).
- run/RUN-RESULT-V21.md: per-phase summary, critic scores, risk register,
  anything Thomas must decide.
- Do NOT merge the PR. Do NOT deploy.
