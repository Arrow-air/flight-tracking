# Schema — round 1 build log

Run: 2026-08-10 (overnight P0), branch `overnight/p0`. Prior state: NO earlier
schema rounds — `supabase/migrations/` contained only the placeholder
`README.md`. Built from scratch per RUN-CONTEXT "Schema" + V2-PLAN "Data model
sketch (v2)". No commits made (rules). Only `supabase/` touched (plus this log).

## Files written

- `supabase/migrations/20260810210000_types.sql` — 15 enum types.
- `supabase/migrations/20260810210100_tables.sql` — all **22 tables**
  (user_profiles, sites, aircraft_types, aircraft, aircraft_operators,
  components, component_events, tags, attachments_catalog, flights,
  flight_payloads, flight_tags, flight_notes, airframe_events, issues,
  flight_logs, flight_log_summary, flight_log_series, param_snapshots, media,
  exports, audit_log) + indexes + `updated_at` triggers + **explicit grants**
  (see gotcha below).
- `supabase/migrations/20260810210200_helpers.sql` — `app` schema (not
  PostgREST-exposed) with SECURITY DEFINER role helpers (`is_admin`,
  `is_manufacturer`, `is_operator_of`, `can_write_aircraft_data`,
  `can_write_flight`, `can_view_raw_gps`); auth.users→user_profiles
  auto-profile trigger; roles privilege-escalation guard; `gps_private`
  per-user-default trigger; `pg_notify('flight_log_uploaded', id)` trigger for
  the parser queue (LISTEN or poll both work).
- `supabase/migrations/20260810210300_rls.sql` — RLS enabled + policies on all
  21 non-audit tables (audit_log RLS lives in the audit migration).
- `supabase/migrations/20260810210400_audit.sql` — generic `tg_audit()`
  SECURITY DEFINER trigger attached to 18 core tables; audit_log immutability
  (raise-exception trigger on UPDATE/DELETE/TRUNCATE — fires even for
  postgres/service_role — plus revokes plus admin-only SELECT policy).
- `supabase/migrations/20260810210500_storage.sql` — buckets `flight-logs`
  (raw, GPS-gated), `flight-logs-sanitized` (fleet-readable, parser-written
  only), `media`; storage.objects policies; realtime publication for
  flight_logs + flight_log_summary.
- `supabase/migrations/20260810210600_seed_aircraft_types.sql` — Quiver /
  Caribou / Spearhead / Kestrel with fixed UUIDs (reference data → migration,
  not seed.sql).
- `supabase/seed.sql` — local-dev auth users + roles (Thomas
  admin+manufacturer `thomas@arrowair.com`, Julius manufacturer, operator test
  user; password `password123`) + 2 seed sites.
- `supabase/tests/schema_smoke.sql` — invariant proof script (see evidence).

## Evidence (actual numbers)

`supabase db reset` applies all 7 migrations + seed cleanly (exit 0, CLI
2.112.0, postgres 17). Smoke test
(`docker exec -i supabase_db_flight-tracking psql -U postgres -d postgres -v ON_ERROR_STOP=0 -f - < supabase/tests/schema_smoke.sql`):
**21/21 [PASS], 0 [FAIL]** on a fresh reset, covering every RUN-CONTEXT RLS
invariant:

1. Operator INSERT aircraft → `42501 new row violates row-level security`
   (real error, not silent); manufacturer (Julius) INSERT → allowed. ✔
2. Operator flight on assigned aircraft → allowed; on unassigned aircraft →
   RLS error; unassigned maintenance (airframe_events) → RLS error; Julius
   (non-operator) can still READ the flight (fleet-visible). ✔
3. gps_private defaulted TRUE from user default when omitted; flight_log_series
   of the private flight: Julius (non-owner) sees **0 rows**, admin sees 1,
   uploader sees 1. ✔
4. All denials above surface as errors on INSERT/UPDATE (WITH CHECK →
   `42501`), not silent no-ops. NOTE for UI phase: SELECT-filtered rows and
   UPDATE ... WHERE on invisible rows still return 0 rows silently — the API
   layer MUST use `.select()` on writes and treat 0 rows as an error (RLS
   invariant 4 is a client contract; documented in the RLS migration header).
5. audit_log: 3 aircraft INSERT rows + flight INSERT row captured with actor
   uuid recorded; UPDATE and DELETE on audit_log rejected **even as postgres**
   ("audit_log is append-only"). ✔
   Extra: operator self-promotion to admin rejected ("only admins can change
   roles").

Live API checks: GoTrue password login 200 for `thomas@arrowair.com` and
`operator@example.com`; PostgREST as Thomas returns the 4 seeded
aircraft_types (Quiver cells=14, Caribou 18, Spearhead/Kestrel null); anon
gets `42501 permission denied` (P0 has zero anon access — public pages are
P1/M6).

## Gotcha found (matters for later phases)

The local stack does **not** auto-grant table privileges to
`authenticated`/`service_role` on migration-created tables — first smoke run
failed with `permission denied for table aircraft` before RLS was even
consulted. Fixed with explicit `GRANT`s + `ALTER DEFAULT PRIVILEGES` at the end
of `20260810210100_tables.sql`. Any later migration creating tables as a
different role than `postgres` must add its own grants.

## Decisions + labeled assumptions

- **roles is `user_role[]`** (not the sketch's scalar) — the seed requires
  Thomas = admin+manufacturer; a scalar can't express it. Helpers hide this.
- ASSUMPTION: issue severity values `low|medium|high|critical`, status
  `open|in_progress|resolved|closed` (plan only fixes "squawk = low").
- ASSUMPTION: remote-ID column names `remote_id_serial`, `faa_registration`
  (v1 has no remote-ID columns to copy; plan says schema-only, no UI).
- ASSUMPTION: Kestrel class multirotor, cells NULL; Spearhead cells NULL —
  not stated in any source available to this run. Quiver cells=14 is FACT
  (website docs: "Tattu 14S 30 Ah"); Caribou 18 is FACT (RUN-CONTEXT).
- ASSUMPTION: Julius seed email `julius@example.com` (real address unknown;
  placeholder domain on purpose, local-dev only).
- Seed sites have NULL lat/lon — no confirmed coordinates in run sources;
  UI weather auto-fill needs coords entered first. Names: "Javelina (TX ops)",
  "PT1 Flight Test Area".
- `flight_note_type` enum copied from v1 (`pilot|admin|engineer|witness|other`)
  to ease the M5 import.
- Series privacy is conservative: ALL series channels of a gps_private flight
  are owner/admin-only (position channels can't leak); the fleet-visible
  flight card reads flight_log_summary instead (no coordinates there).
- Audit triggers on 18 core tables; deliberately NOT on flight_log_summary /
  flight_log_series / param_snapshots (bulk machine-written parser output).
- Manufacturers may write component_events/components (build workflow: "an
  airframe is born in a manufacturing workflow") but NOT flights/logs/issues
  unless also operator/admin.
- Storage upload contract: create `flight_logs` row first (checksum,
  object_path), then PUT to `flight-logs/<object_path>` — the bucket INSERT
  policy enforces the ordering. Parser writes sanitized copies via
  service_role into `flight-logs-sanitized` (no authenticated write policy).
- Extra columns beyond sketch: `flight_logs.error` (parser error message
  surface), `flight_log_summary.events/errors` jsonb — parser needs a home
  for arm/disarm events + error list per P0 item 6.

## State / what remains

- Local stack LEFT RUNNING (supabase start; parser/UI/import phases need it).
  Keys = standard local demo keys (see preflight log).
- No `supabase/config.toml` exists; CLI 2.112 runs on defaults — fine locally.
  Whoever wires GitHub OAuth flags (`GOTRUE_EXTERNAL_GITHUB_*` placeholders)
  will likely need to introduce config.toml — do NOT put the secret in it.
- For the schema gate: rerun `supabase db reset` + the smoke file; expect
  21/21 PASS. Idempotency of seeds verified via ON CONFLICT DO NOTHING paths.
- Remaining for later phases (not schema round 2 unless the gate says so):
  parser writes summary/series/params + sanitized copies as service_role;
  import must reuse the fixed aircraft_type UUIDs in
  `20260810210600_seed_aircraft_types.sql`.
