-- Flight Tracking v2 — the 22 core tables
-- Order differs from the RUN-CONTEXT list only to satisfy FK dependencies.
-- Every record carries created_by/timestamps where it makes sense (v1 pain point #2:
-- the "JIS M-40" attribution hole).

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. user_profiles
-- roles is an ARRAY because the launch seed requires Thomas = admin+manufacturer
-- (RUN-CONTEXT "Seed"); a single role column cannot express that.
-- ---------------------------------------------------------------------------
create table public.user_profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  name                text,
  roles               public.user_role[] not null default '{operator}',
  gps_default_private boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create trigger set_updated_at before update on public.user_profiles
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. sites (first-class locations; lat/lon nullable — seed sites have no
-- confirmed coordinates; quick-log weather auto-fill requires coords at use time)
-- ---------------------------------------------------------------------------
create table public.sites (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  lat         double precision,
  lon         double precision,
  elevation_m double precision,
  notes       text,
  visibility  public.site_visibility not null default 'private',
  created_by  uuid references public.user_profiles (id) default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint sites_lat_range check (lat is null or (lat >= -90 and lat <= 90)),
  constraint sites_lon_range check (lon is null or (lon >= -180 and lon <= 180))
);

create trigger set_updated_at before update on public.sites
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. aircraft_types — drives battery math (cells) and parser thresholds
-- ---------------------------------------------------------------------------
create table public.aircraft_types (
  id             uuid primary key default gen_random_uuid(),
  name           text not null unique,
  class          public.aircraft_class not null,
  cells          integer check (cells is null or cells > 0),
  parser_profile jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger set_updated_at before update on public.aircraft_types
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. aircraft — born via manufacturer workflow (RLS: only manufacturers/admins
-- INSERT). Total hours/cycles are derived from flights, not stored.
-- Remote-ID columns kept per V2-PLAN ("in schema, no UI until Part 107 forces
-- it"); ASSUMPTION on the two column names — v1 has no remote-ID columns to copy.
-- ---------------------------------------------------------------------------
create table public.aircraft (
  id               uuid primary key default gen_random_uuid(),
  serial           text not null unique,
  name             text,
  type_id          uuid not null references public.aircraft_types (id) on delete restrict,
  status           public.aircraft_status not null default 'active',
  notes            text,
  photo_path       text,
  design_rev       text,
  built_by         uuid references public.user_profiles (id),
  built_at         date,
  remote_id_serial text,
  faa_registration text,
  created_by       uuid not null references public.user_profiles (id) default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index aircraft_type_id_idx on public.aircraft (type_id);

create trigger set_updated_at before update on public.aircraft
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. aircraft_operators — THE control edge. "operators have write access to
-- aircraft they control"; manufacturer assigns at ship time.
-- ---------------------------------------------------------------------------
create table public.aircraft_operators (
  aircraft_id uuid not null references public.aircraft (id) on delete cascade,
  user_id     uuid not null references public.user_profiles (id) on delete cascade,
  granted_by  uuid references public.user_profiles (id) default auth.uid(),
  granted_at  timestamptz not null default now(),
  primary key (aircraft_id, user_id)
);

create index aircraft_operators_user_id_idx on public.aircraft_operators (user_id);

-- ---------------------------------------------------------------------------
-- 6. components — study §5 minimums; hours-while-installed derived from
-- component_events x flights at query time.
-- ---------------------------------------------------------------------------
create table public.components (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  part_no    text,
  serial     text,
  batch_no   text,
  vendor     text,
  design_rev text,
  mfg_date   date,
  notes      text,
  created_by uuid references public.user_profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.components
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. component_events — install/remove event stream ("front-left motor for 37.2h")
-- ---------------------------------------------------------------------------
create table public.component_events (
  id           uuid primary key default gen_random_uuid(),
  aircraft_id  uuid not null references public.aircraft (id) on delete cascade,
  component_id uuid not null references public.components (id) on delete restrict,
  event        public.component_event_kind not null,
  position     text,
  occurred_at  timestamptz not null default now(),
  performed_by uuid references public.user_profiles (id) default auth.uid(),
  reason       text,
  notes        text,
  created_at   timestamptz not null default now()
);

create index component_events_aircraft_id_idx on public.component_events (aircraft_id, occurred_at);
create index component_events_component_id_idx on public.component_events (component_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 8. tags + 9. attachments_catalog (referenced by flight tables below)
-- ---------------------------------------------------------------------------
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_by uuid references public.user_profiles (id) default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.attachments_catalog (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  kind       text,
  mass_g     numeric check (mass_g is null or mass_g >= 0),
  notes      text,
  created_by uuid references public.user_profiles (id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.attachments_catalog
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 10. flights — flattened (leg == flight, DECIDED 2026-08-09). gps_private has
-- NO column default on purpose: a BEFORE INSERT trigger (helpers migration)
-- fills NULL from user_profiles.gps_default_private (per-user default,
-- per-flight override).
-- ---------------------------------------------------------------------------
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

create index flights_aircraft_id_idx on public.flights (aircraft_id, started_at desc);
create index flights_pilot_id_idx on public.flights (pilot_id);
create index flights_site_id_idx on public.flights (site_id);
create index flights_session_id_idx on public.flights (session_id) where session_id is not null;

create trigger set_updated_at before update on public.flights
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 11. flight_payloads (mass-aware analysis, P1 UI; schema from M0)
-- ---------------------------------------------------------------------------
create table public.flight_payloads (
  flight_id     uuid not null references public.flights (id) on delete cascade,
  attachment_id uuid not null references public.attachments_catalog (id) on delete restrict,
  qty           integer not null default 1 check (qty > 0),
  primary key (flight_id, attachment_id)
);

-- ---------------------------------------------------------------------------
-- 12. flight_tags
-- ---------------------------------------------------------------------------
create table public.flight_tags (
  flight_id uuid not null references public.flights (id) on delete cascade,
  tag_id    uuid not null references public.tags (id) on delete cascade,
  primary key (flight_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- 13. flight_notes
-- ---------------------------------------------------------------------------
create table public.flight_notes (
  id         uuid primary key default gen_random_uuid(),
  flight_id  uuid not null references public.flights (id) on delete cascade,
  author     uuid references public.user_profiles (id) default auth.uid(),
  type       public.flight_note_type not null default 'pilot',
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index flight_notes_flight_id_idx on public.flight_notes (flight_id);

create trigger set_updated_at before update on public.flight_notes
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 14. airframe_events — unified maintenance/incident/field_action stream;
-- v1 maintenance_logs land here at import.
-- ---------------------------------------------------------------------------
create table public.airframe_events (
  id          uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft (id) on delete cascade,
  kind        public.airframe_event_kind not null,
  author      uuid references public.user_profiles (id) default auth.uid(),
  occurred_at timestamptz not null default now(),
  title       text not null,
  body        text,
  hours_at    numeric check (hours_at is null or hours_at >= 0),
  flight_id   uuid references public.flights (id) on delete set null,
  signoff_by  uuid references public.user_profiles (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index airframe_events_aircraft_id_idx on public.airframe_events (aircraft_id, occurred_at desc);

create trigger set_updated_at before update on public.airframe_events
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 15. issues — May 7 issue/failure log; "squawk" = severity 'low'
-- ---------------------------------------------------------------------------
create table public.issues (
  id          uuid primary key default gen_random_uuid(),
  aircraft_id uuid not null references public.aircraft (id) on delete cascade,
  reporter    uuid references public.user_profiles (id) default auth.uid(),
  opened_at   timestamptz not null default now(),
  severity    public.issue_severity not null default 'low',
  status      public.issue_status not null default 'open',
  problem     text not null,
  fix         text,
  fixable     public.fixable not null default 'unknown',
  resolved_by uuid references public.user_profiles (id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index issues_aircraft_id_idx on public.issues (aircraft_id, opened_at desc);
create index issues_status_idx on public.issues (status);

create trigger set_updated_at before update on public.issues
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 16. flight_logs — checksum UNIQUE is the dedupe + import-idempotency anchor;
-- uploaded_by/checksum/timestamps are the $ARROW-rewards attribution base.
-- sanitized_path = GPS-stripped copy written by the parser.
-- ---------------------------------------------------------------------------
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

create index flight_logs_flight_id_idx on public.flight_logs (flight_id);
create index flight_logs_status_idx on public.flight_logs (status);

create trigger set_updated_at before update on public.flight_logs
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 17. flight_log_summary — parser output, one row per log. battery/health/
-- modes/wind stay jsonb (parser owns the shape). Summaries carry NO
-- coordinates, so they survive sanitization and are fleet-visible.
-- ---------------------------------------------------------------------------
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

create trigger set_updated_at before update on public.flight_log_summary
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 18. flight_log_series — downsampled channels; may include position channels,
-- so SELECT is gated by the GPS-privacy rule (RLS migration).
-- ---------------------------------------------------------------------------
create table public.flight_log_series (
  log_id     uuid not null references public.flight_logs (id) on delete cascade,
  channel    text not null,
  t          double precision[] not null,
  v          double precision[] not null,
  primary key (log_id, channel),
  constraint series_lengths_match check (array_length(t, 1) = array_length(v, 1))
);

-- ---------------------------------------------------------------------------
-- 19. param_snapshots — params carry no GPS; cross-user comparison is
-- privacy-clean by design (V2-PLAN P1 item 10).
-- ---------------------------------------------------------------------------
create table public.param_snapshots (
  log_id     uuid primary key references public.flight_logs (id) on delete cascade,
  params     jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 20. media — polymorphic evidence attachments (crash records: photos +
-- pilot report on issues/airframe_events)
-- ---------------------------------------------------------------------------
create table public.media (
  id          uuid primary key default gen_random_uuid(),
  owner_table text not null check (owner_table in (
    'aircraft', 'components', 'component_events', 'flights', 'issues',
    'airframe_events', 'sites', 'user_profiles'
  )),
  owner_id    uuid not null,
  object_path text not null,
  kind        public.media_kind not null default 'photo',
  uploaded_by uuid references public.user_profiles (id) default auth.uid(),
  created_at  timestamptz not null default now()
);

create index media_owner_idx on public.media (owner_table, owner_id);

-- ---------------------------------------------------------------------------
-- 21. exports — study's Export entity; airframe history report lands here,
-- hash-stamped (trust step 2 schema, built in v2, UI in P1)
-- ---------------------------------------------------------------------------
create table public.exports (
  id             uuid primary key default gen_random_uuid(),
  report_type    text not null,
  aircraft_id    uuid references public.aircraft (id) on delete set null,
  generated_by   uuid references public.user_profiles (id) default auth.uid(),
  generated_at   timestamptz not null default now(),
  content_hash   text,
  object_path    text,
  visibility     public.export_visibility not null default 'private',
  included_range jsonb
);

create index exports_aircraft_id_idx on public.exports (aircraft_id);

-- ---------------------------------------------------------------------------
-- 22. audit_log — append-only, trigger-fed (study §3.5 step 1). Immutability
-- enforced in the audit migration (RLS + guard trigger + revokes).
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id         bigint generated always as identity primary key,
  table_name text not null,
  row_id     text,
  action     public.audit_action not null,
  actor      uuid,
  at         timestamptz not null default now(),
  diff       jsonb
);

create index audit_log_table_row_idx on public.audit_log (table_name, row_id);
create index audit_log_at_idx on public.audit_log (at desc);

-- ---------------------------------------------------------------------------
-- Grants. The local stack does NOT auto-grant privileges on migration-created
-- tables (verified: authenticated got "permission denied" before this block),
-- so grant explicitly. RLS (next migrations) is the actual access control;
-- anon gets NO table grants in P0 (public read-only pages are P1/M6).
-- audit_log immutability revokes happen in the audit migration, after this.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

-- Future tables created by postgres (later migrations) inherit the same grants.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges for role postgres in schema public
  grant all on tables to service_role;
alter default privileges for role postgres in schema public
  grant usage, select on sequences to authenticated, service_role;
