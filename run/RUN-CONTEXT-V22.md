# RUN-CONTEXT-V22 — Flight Tracking v2.2 Feedback Round 2 (2026-08-12)

Ground truth for every agent. READ FULLY. Never invent facts; label assumptions.
If this conflicts with code, trust the code and note the discrepancy.

## HARD RULES (same as V21, still binding)

1. ALL work on branch `v22-feedback` off current main. NEVER commit/push main.
   Branch pushes to origin are safe (auto-deploy watches main only).
2. NEVER touch production (supabase.arrowair.com mutations, ship.arrowair.com,
   SSH). Local testing only. Migrations = files only; Hex applies post-merge.
3. Never print secrets. 4. Tests are not optional: npm build, vitest, parser
   pytest green; ui-smoke if runnable. 5. Parser Dockerfile COPY paths stay
   repo-root-relative (Openship build context).
6. Read run/RUN-CONTEXT-V21.md and run/ARCH-NOTES-V21.md for the v2.1
   groundwork (schema, file map, provisioning). V21 shipped; main now includes
   it all.

## Work items (Thomas, 2026-08-12)

### P1 — Parser duration fix (THE priority; investigate → fix → prove)
- BUG (verified by Hex on prod): `flight_log_summary.duration_s` is TOTAL LOG
  duration, not flight duration. Evidence: flight
  bd0ee3e6-7ff7-4242-bd80-f5cbaacd57ed log 387be26687b7_00000027.BIN has
  duration_s=3745.21 but events show AUTO_ARMED t=2163.5 → DISARMED t=2733.5
  (~570 s actual flight). Thomas: "They should be flight duration, not total
  log duration."
- FIX in parser/arrow_parser/summary.py: duration_s = ARMED flight time (sum
  of all armed spans, same arm/disarm detection the battery stats window
  already uses; reuse that code path, don't duplicate). Keep total log span as
  a NEW field `log_duration_s` (+ migration column) so nothing is lost.
  Fallback when no arm events: full log span (current behavior) — and record
  which applied (like battery.stats_window does).
- Fixtures exist under fixtures/ — add pytest cases: armed-span computation
  from events, multi-arm-cycle logs (sum spans), no-arm-events fallback.
- Frontend: anywhere showing duration keeps using duration_s (semantics now
  correct). Total-hours stat (fleet header) inherits the fix automatically —
  verify its code path.

### P2 — Parser coords guard + weather error
- BUG (verified): GPS-stripped uploads (Erick strips GPS before upload)
  yielded takeoff coords (0.00, 0.00) — null island — and FlightCard weather
  fetch got equatorial-Atlantic data for flight
  c39f3e92-c599-41f4-8ddd-ba3957c48b40. Hex nulled 12 such rows in prod
  2026-08-12 as interim mitigation.
- Parser: a first "fix" at/near (0,0) or with no valid GPS lock quality is NOT
  a fix — emit null coords (check how first-fix scan judges validity; use the
  log's fix-type/status field, not just presence of a GPS message).
- App: weather auto-fill with NO usable coords (no takeoff coords AND no site
  coords) must show a clear error ("no coordinates available — set site
  coordinates or upload a log with GPS") instead of fetching anything. Never
  fetch for (0,0).

### P3 — Deletion permissions
- Operators can DELETE a flight (for aircraft they operate — same canWrite
  semantics as flight editing). Admins can delete aircraft. Operators must NOT
  be able to delete aircraft.
- RLS delete policies via migration (verify what exists first — there may be
  none). UI: delete affordances with confirm dialogs (type-to-confirm for
  aircraft, which cascades). Handle children: flight delete should clean
  flight_logs rows/summaries/notes (FK cascade state — check schema; add ON
  DELETE CASCADE via migration if missing). STORAGE objects (raw + sanitized
  .bin) cannot be deleted by client RLS alone — investigate storage RLS delete
  policies for the uploader/admin; if not cleanly possible, delete DB rows and
  leave objects orphaned, documenting the orphan list mechanism (a Hex/admin
  sweep can collect them later). State chosen approach in RUN-RESULT.
- Aircraft delete: block or explicitly cascade flights — pick SAFE default
  (block delete while flights exist, tell admin to reassign/delete flights
  first). Note the choice.

### P4 — Profile page with own user id
- Users can view their own user id (uuid) — put it on a small profile page
  (name, roles, user id with copy button; email if the session has it from
  auth). Link from the existing user menu/nav.

### P5 — Aircraft manufacturer
- Aircraft page shows who manufactured the aircraft; admins can change it.
  Check schema: aircraft likely has manufacturer or manufactured_by (the v21
  fleet filter "manufactured-by-me" exists — reuse its source field). Display
  the user/entity name, not a bare uuid; admin-only edit control.

### P6 — Fleet tile hover styling
- Thomas: tiles are STILL hard to read "but only when I'm hovering over the
  tile." v21 fixed the at-rest state (AppCard dither 0.15→0.06, darker body
  copy) — the HOVER state kept high-contrast-killing styling. Find the hover
  rule and fix text contrast on hover; keep some hover affordance.

### P7 — Bulk upload shared title
- Bulk upload: optional title field applied to all flights created in that
  batch (existing per-flight title semantics — check how single upload sets
  titles). Blank = current default behavior.

## Verified facts (Hex, 2026-08-12)

- Prod flight_log_summary columns now: log_id, duration_s, distance_m,
  max_alt_m, max_speed_mps, battery, health, modes, events, errors, wind,
  created_at, updated_at, start_time_utc, takeoff_lat, takeoff_lon.
- events jsonb includes ARMED/AUTO_ARMED/DISARMED entries with t_s.
- battery.stats_window already distinguishes armed vs full_log windows.
- Full reparse of all logs ran overnight 2026-08-11→12 (v21 parser) — Hex
  reruns reparse again after THIS round merges; do not build reparse tooling.
- 12 prod summaries had (0,0) coords, nulled 2026-08-12 (regenerated correctly
  on next reparse once P2 lands).

## Testing bar + deliverables (same as V21)

- Gates: npm run build, npx vitest run, parser pytest, ui-smoke if runnable.
- Branch `v22-feedback` pushed; DRAFT PR "v2.2: feedback round 2 — durations,
  deletes, profile, weather guard" with work-item status table; DO NOT merge.
- run/RUN-RESULT-V22.md: per-phase summary, critic evidence, risk register,
  decisions for Thomas. P1 must include before/after duration numbers for
  bd0ee3e6's log fixture-style proof (parse the real .BIN only if it exists
  locally in backups/v1-storage-flight_logs/ — check; NEVER download from prod).
