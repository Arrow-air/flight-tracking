-- Flight Tracking v2 — RLS
-- Invariants (RUN-CONTEXT):
--   1. Only manufacturers (and admins) can INSERT aircraft.
--   2. Operators write flights/maintenance ONLY for aircraft assigned via
--      aircraft_operators; reads are fleet-visible for authenticated users.
--   3. GPS privacy: non-owner/non-admin access to a gps_private flight's raw
--      series/track coordinates is DENIED (raw .bin denial is in the storage
--      migration); sanitized artifacts are what they get.
--   5. audit_log rejects UPDATE/DELETE (audit migration).
-- Invariant 4 (no silent RLS swallowing) is an API-layer contract: the client
-- must always request representation (`.select()` / Prefer: return=representation)
-- and treat 0 rows affected as an error. Nothing here can do that for it, but
-- policies below prefer WITH CHECK errors over silent row-filtering.
-- Anonymous users get NO access in P0 (public read-only pages are P1/M6).

-- ---------------------------------------------------------------------------
-- user_profiles
-- ---------------------------------------------------------------------------
alter table public.user_profiles enable row level security;

create policy "profiles fleet-visible" on public.user_profiles
  for select to authenticated using (true);

create policy "insert own profile" on public.user_profiles
  for insert to authenticated with check (id = auth.uid());

create policy "update own profile or admin" on public.user_profiles
  for update to authenticated
  using (id = auth.uid() or app.is_admin())
  with check (id = auth.uid() or app.is_admin());

create policy "admin delete profiles" on public.user_profiles
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- sites — fleet-visible; any authenticated user can create; author/admin manage
-- ---------------------------------------------------------------------------
alter table public.sites enable row level security;

create policy "sites fleet-visible" on public.sites
  for select to authenticated using (true);

create policy "create sites" on public.sites
  for insert to authenticated with check (created_by = auth.uid());

create policy "update own sites or admin" on public.sites
  for update to authenticated
  using (created_by = auth.uid() or app.is_admin())
  with check (created_by = auth.uid() or app.is_admin());

create policy "delete own sites or admin" on public.sites
  for delete to authenticated using (created_by = auth.uid() or app.is_admin());

-- ---------------------------------------------------------------------------
-- aircraft_types — reference data; manufacturers/admins manage
-- ---------------------------------------------------------------------------
alter table public.aircraft_types enable row level security;

create policy "types fleet-visible" on public.aircraft_types
  for select to authenticated using (true);

create policy "manufacturers manage types" on public.aircraft_types
  for insert to authenticated with check (app.is_manufacturer() or app.is_admin());

create policy "manufacturers update types" on public.aircraft_types
  for update to authenticated
  using (app.is_manufacturer() or app.is_admin())
  with check (app.is_manufacturer() or app.is_admin());

create policy "admin delete types" on public.aircraft_types
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- aircraft — INVARIANT 1: only manufacturers (and admins) INSERT.
-- Operators of an aircraft may UPDATE it ("write access to aircraft they
-- control"); DELETE is admin-only (system of record).
-- ---------------------------------------------------------------------------
alter table public.aircraft enable row level security;

create policy "aircraft fleet-visible" on public.aircraft
  for select to authenticated using (true);

create policy "manufacturers create aircraft" on public.aircraft
  for insert to authenticated
  with check ((app.is_manufacturer() or app.is_admin()) and created_by = auth.uid());

create policy "operators manufacturers update aircraft" on public.aircraft
  for update to authenticated
  using (app.is_admin() or app.is_manufacturer() or app.is_operator_of(id))
  with check (app.is_admin() or app.is_manufacturer() or app.is_operator_of(id));

create policy "admin delete aircraft" on public.aircraft
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- aircraft_operators — manufacturers assign at ship time; admins too
-- ---------------------------------------------------------------------------
alter table public.aircraft_operators enable row level security;

create policy "assignments fleet-visible" on public.aircraft_operators
  for select to authenticated using (true);

create policy "manufacturers assign operators" on public.aircraft_operators
  for insert to authenticated
  with check ((app.is_manufacturer() or app.is_admin()) and granted_by = auth.uid());

create policy "manufacturers revoke operators" on public.aircraft_operators
  for delete to authenticated using (app.is_manufacturer() or app.is_admin());

-- ---------------------------------------------------------------------------
-- components — fleet-visible registry; any authenticated user can register a
-- component (operators log maintenance parts; manufacturers log build parts);
-- author/admin update
-- ---------------------------------------------------------------------------
alter table public.components enable row level security;

create policy "components fleet-visible" on public.components
  for select to authenticated using (true);

create policy "create components" on public.components
  for insert to authenticated with check (created_by = auth.uid());

create policy "update own components or admin" on public.components
  for update to authenticated
  using (created_by = auth.uid() or app.is_admin())
  with check (created_by = auth.uid() or app.is_admin());

create policy "admin delete components" on public.components
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- component_events — INVARIANT 2 (maintenance writes). Manufacturers also
-- write install events (aircraft born in a manufacturing workflow: build info
-- = install events by the builder).
-- ---------------------------------------------------------------------------
alter table public.component_events enable row level security;

create policy "component events fleet-visible" on public.component_events
  for select to authenticated using (true);

create policy "write component events" on public.component_events
  for insert to authenticated
  with check (
    (app.can_write_aircraft_data(aircraft_id) or app.is_manufacturer())
    and performed_by = auth.uid()
  );

create policy "update component events" on public.component_events
  for update to authenticated
  using (app.can_write_aircraft_data(aircraft_id) or app.is_manufacturer())
  with check (app.can_write_aircraft_data(aircraft_id) or app.is_manufacturer());

create policy "admin delete component events" on public.component_events
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- tags / attachments_catalog — communal reference data
-- ---------------------------------------------------------------------------
alter table public.tags enable row level security;

create policy "tags fleet-visible" on public.tags
  for select to authenticated using (true);

create policy "create tags" on public.tags
  for insert to authenticated with check (created_by = auth.uid());

create policy "admin delete tags" on public.tags
  for delete to authenticated using (app.is_admin());

alter table public.attachments_catalog enable row level security;

create policy "attachments fleet-visible" on public.attachments_catalog
  for select to authenticated using (true);

create policy "create attachments" on public.attachments_catalog
  for insert to authenticated with check (created_by = auth.uid());

create policy "update attachments" on public.attachments_catalog
  for update to authenticated
  using (created_by = auth.uid() or app.is_admin())
  with check (created_by = auth.uid() or app.is_admin());

create policy "admin delete attachments" on public.attachments_catalog
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- flights — INVARIANT 2: operators write ONLY for assigned aircraft; reads
-- fleet-visible (metadata; coordinates live in series/storage, gated below)
-- ---------------------------------------------------------------------------
alter table public.flights enable row level security;

create policy "flights fleet-visible" on public.flights
  for select to authenticated using (true);

create policy "operators create flights" on public.flights
  for insert to authenticated
  with check (app.can_write_aircraft_data(aircraft_id) and created_by = auth.uid());

create policy "operators update flights" on public.flights
  for update to authenticated
  using (app.can_write_aircraft_data(aircraft_id))
  with check (app.can_write_aircraft_data(aircraft_id));

create policy "operators delete flights" on public.flights
  for delete to authenticated using (app.can_write_aircraft_data(aircraft_id));

-- ---------------------------------------------------------------------------
-- flight_payloads / flight_tags / flight_notes — follow the flight's write rule
-- ---------------------------------------------------------------------------
alter table public.flight_payloads enable row level security;

create policy "payloads fleet-visible" on public.flight_payloads
  for select to authenticated using (true);

create policy "write payloads" on public.flight_payloads
  for insert to authenticated with check (app.can_write_flight(flight_id));

create policy "update payloads" on public.flight_payloads
  for update to authenticated
  using (app.can_write_flight(flight_id))
  with check (app.can_write_flight(flight_id));

create policy "delete payloads" on public.flight_payloads
  for delete to authenticated using (app.can_write_flight(flight_id));

alter table public.flight_tags enable row level security;

create policy "flight tags fleet-visible" on public.flight_tags
  for select to authenticated using (true);

create policy "write flight tags" on public.flight_tags
  for insert to authenticated with check (app.can_write_flight(flight_id));

create policy "delete flight tags" on public.flight_tags
  for delete to authenticated using (app.can_write_flight(flight_id));

alter table public.flight_notes enable row level security;

create policy "notes fleet-visible" on public.flight_notes
  for select to authenticated using (true);
  -- v1's own-rows-only SELECT on notes was explicitly wrong for a fleet tool

create policy "write notes" on public.flight_notes
  for insert to authenticated
  with check (app.can_write_flight(flight_id) and author = auth.uid());

create policy "update own notes" on public.flight_notes
  for update to authenticated
  using (author = auth.uid() or app.is_admin())
  with check (author = auth.uid() or app.is_admin());

create policy "delete own notes" on public.flight_notes
  for delete to authenticated using (author = auth.uid() or app.is_admin());

-- ---------------------------------------------------------------------------
-- airframe_events / issues — maintenance writes, INVARIANT 2
-- ---------------------------------------------------------------------------
alter table public.airframe_events enable row level security;

create policy "airframe events fleet-visible" on public.airframe_events
  for select to authenticated using (true);

create policy "write airframe events" on public.airframe_events
  for insert to authenticated
  with check (app.can_write_aircraft_data(aircraft_id) and author = auth.uid());

create policy "update airframe events" on public.airframe_events
  for update to authenticated
  using (app.can_write_aircraft_data(aircraft_id))
  with check (app.can_write_aircraft_data(aircraft_id));

create policy "admin delete airframe events" on public.airframe_events
  for delete to authenticated using (app.is_admin());

alter table public.issues enable row level security;

create policy "issues fleet-visible" on public.issues
  for select to authenticated using (true);

create policy "report issues" on public.issues
  for insert to authenticated
  with check (app.can_write_aircraft_data(aircraft_id) and reporter = auth.uid());

create policy "update issues" on public.issues
  for update to authenticated
  using (app.can_write_aircraft_data(aircraft_id) or reporter = auth.uid())
  with check (app.can_write_aircraft_data(aircraft_id) or reporter = auth.uid());

create policy "admin delete issues" on public.issues
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- flight_logs — metadata fleet-visible (paths are opaque; the raw OBJECT is
-- gated in storage policies). Writes follow the flight's aircraft assignment.
-- Parser (service_role) bypasses RLS to flip status / set sanitized_path.
-- ---------------------------------------------------------------------------
alter table public.flight_logs enable row level security;

create policy "logs fleet-visible" on public.flight_logs
  for select to authenticated using (true);

create policy "upload logs" on public.flight_logs
  for insert to authenticated
  with check (app.can_write_flight(flight_id) and uploaded_by = auth.uid());

create policy "update logs" on public.flight_logs
  for update to authenticated
  using (app.can_write_flight(flight_id))
  with check (app.can_write_flight(flight_id));

create policy "delete own logs" on public.flight_logs
  for delete to authenticated using (uploaded_by = auth.uid() or app.is_admin());

-- ---------------------------------------------------------------------------
-- flight_log_summary — no coordinates; fleet-visible. Written by the parser
-- (service_role, bypasses RLS) — no authenticated write policies except admin.
-- ---------------------------------------------------------------------------
alter table public.flight_log_summary enable row level security;

create policy "summaries fleet-visible" on public.flight_log_summary
  for select to authenticated using (true);

create policy "admin write summaries" on public.flight_log_summary
  for insert to authenticated with check (app.is_admin());

create policy "admin update summaries" on public.flight_log_summary
  for update to authenticated using (app.is_admin()) with check (app.is_admin());

create policy "admin delete summaries" on public.flight_log_summary
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- flight_log_series — INVARIANT 3. Series can contain position channels, so
-- the whole series of a gps_private flight is owner/admin-only. (Conservative:
-- non-location channels of private flights are also hidden; the flight card
-- uses the summary, which is fleet-visible.)
-- ---------------------------------------------------------------------------
alter table public.flight_log_series enable row level security;

create policy "series gps-gated" on public.flight_log_series
  for select to authenticated
  using (
    app.can_view_raw_gps((select fl.flight_id from public.flight_logs fl where fl.id = log_id))
  );

create policy "admin write series" on public.flight_log_series
  for insert to authenticated with check (app.is_admin());

create policy "admin delete series" on public.flight_log_series
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- param_snapshots — params carry no GPS; fleet-visible for cross-user diff
-- ---------------------------------------------------------------------------
alter table public.param_snapshots enable row level security;

create policy "params fleet-visible" on public.param_snapshots
  for select to authenticated using (true);

create policy "admin write params" on public.param_snapshots
  for insert to authenticated with check (app.is_admin());

create policy "admin delete params" on public.param_snapshots
  for delete to authenticated using (app.is_admin());

-- ---------------------------------------------------------------------------
-- media / exports
-- ---------------------------------------------------------------------------
alter table public.media enable row level security;

create policy "media fleet-visible" on public.media
  for select to authenticated using (true);

create policy "attach media" on public.media
  for insert to authenticated with check (uploaded_by = auth.uid());

create policy "delete own media" on public.media
  for delete to authenticated using (uploaded_by = auth.uid() or app.is_admin());

alter table public.exports enable row level security;

create policy "see own or shared exports" on public.exports
  for select to authenticated
  using (generated_by = auth.uid() or visibility = 'shared' or app.is_admin());

create policy "create exports" on public.exports
  for insert to authenticated with check (generated_by = auth.uid());

create policy "update own exports" on public.exports
  for update to authenticated
  using (generated_by = auth.uid() or app.is_admin())
  with check (generated_by = auth.uid() or app.is_admin());

create policy "delete own exports" on public.exports
  for delete to authenticated using (generated_by = auth.uid() or app.is_admin());
