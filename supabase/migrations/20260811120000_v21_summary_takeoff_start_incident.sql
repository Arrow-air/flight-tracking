-- v2.1 feedback run — schema slice for parser outputs + incident tracking.
-- Work items (run/RUN-CONTEXT-V21.md): D1 (coarse takeoff coords),
-- F3 (start_time_utc), E2 (incident field on flights), F1 (checksum note).
-- Additive only; existing RLS policies on both tables cover the new columns
-- (no new tables, so no new `enable row level security` needed).

-- ---------------------------------------------------------------------------
-- D1 + F3: flight_log_summary columns for parser-emitted fields.
--
-- start_time_utc: the parser emits unix seconds (GPS wall clock of the first
-- good fix, summary.py); db.py converts it to a tz-aware datetime before
-- insert (build_summary_row) so this column can be timestamptz like
-- flights.started_at. db.py's column introspection picks the column up
-- automatically once this migration is applied.
--
-- takeoff_lat / takeoff_lon: COARSE takeoff coordinate for weather auto-fill.
-- PRIVACY: flight_log_summary is fleet-visible under RLS ("summaries
-- fleet-visible"), so these values are readable by ALL authenticated users
-- regardless of flights.gps_private. The parser therefore rounds to
-- 2 decimal places (~1.1 km) BEFORE the value leaves the parser
-- (summary.py), and numeric(5,2) makes the database itself unable to store
-- more precision (postgres rounds excess scale on insert) as defense in
-- depth. This amends the 20260810210100_tables.sql comment "summaries carry
-- NO coordinates": they now carry an intentionally-coarse one, nothing more.
alter table public.flight_log_summary
  add column start_time_utc timestamptz,
  add column takeoff_lat numeric(5, 2)
    check (takeoff_lat is null or takeoff_lat between -90 and 90),
  add column takeoff_lon numeric(5, 2)
    check (takeoff_lon is null or takeoff_lon between -180 and 180);

comment on column public.flight_log_summary.start_time_utc is
  'Flight start wall clock derived from the log''s GPS time (parser-emitted).';
comment on column public.flight_log_summary.takeoff_lat is
  'Coarse takeoff latitude, rounded to 2 dp (~1.1 km) in the parser. '
  'Fleet-visible: never store more precision here.';
comment on column public.flight_log_summary.takeoff_lon is
  'Coarse takeoff longitude, rounded to 2 dp (~1.1 km) in the parser. '
  'Fleet-visible: never store more precision here.';

-- ---------------------------------------------------------------------------
-- E2: per-flight incident flag, editable from the flight detail page under
-- the existing "flights update" RLS policy (app.can_write_flight). This is
-- additive next to airframe_events (kind='incident'), which remains the
-- per-AIRCRAFT maintenance/event stream (optionally linked to a flight);
-- this column is the cheap per-FLIGHT filterable flag the flights table
-- filters need. Default 'none' keeps every existing insert path working.
create type public.flight_incident as enum
  ('none', 'crash', 'hard_landing', 'systems', 'other');

alter table public.flights
  add column incident public.flight_incident not null default 'none',
  add column incident_notes text;

comment on column public.flights.incident is
  'Per-flight incident classification for fleet-data filtering (E2). '
  'Aircraft-level incident history stays in airframe_events.';
comment on column public.flights.incident_notes is
  'Optional free-text detail for incident != none.';

-- ---------------------------------------------------------------------------
-- F1 (decision, no DDL): flight_logs.checksum is already `text not null
-- unique` (20260810210100_tables.sql:311), which fully covers the
-- server-side upload race — a concurrent second INSERT with the same
-- checksum fails and the client surfaces DuplicateLogError
-- (src/lib/logs.ts). A PARTIAL unique index (e.g. excluding status='error'
-- rows) was considered and REJECTED: it would let duplicate rows accumulate
-- for failed logs, break the client's checksum pre-check query (which
-- expects at most one match), and error-status logs are retried in place
-- rather than re-inserted. Keeping the full unique constraint as-is.
