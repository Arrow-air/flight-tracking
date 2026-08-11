-- Flight Tracking v2 — role helpers + behavior triggers
-- Helper functions live in schema `app` (NOT exposed via PostgREST). They are
-- SECURITY DEFINER (owner: postgres, who owns the tables) so RLS policies can
-- consult user_profiles / aircraft_operators without recursing into RLS.

create schema if not exists app;

grant usage on schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Role checks
-- ---------------------------------------------------------------------------
create or replace function app.current_roles()
returns public.user_role[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select roles from public.user_profiles where id = auth.uid()),
    '{}'::public.user_role[]
  );
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 'admin'::public.user_role = any (app.current_roles());
$$;

create or replace function app.is_manufacturer()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 'manufacturer'::public.user_role = any (app.current_roles());
$$;

-- Control edge: is the current user an assigned operator of this aircraft?
create or replace function app.is_operator_of(p_aircraft uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.aircraft_operators ao
    where ao.aircraft_id = p_aircraft and ao.user_id = auth.uid()
  );
$$;

-- Write access to per-aircraft operational data (flights, maintenance, logs):
-- admins everywhere; operators ONLY where assigned (RLS invariant 2).
create or replace function app.can_write_aircraft_data(p_aircraft uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.is_admin() or app.is_operator_of(p_aircraft);
$$;

create or replace function app.can_write_flight(p_flight uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.is_admin() or exists (
    select 1 from public.flights f
    where f.id = p_flight and app.is_operator_of(f.aircraft_id)
  );
$$;

-- GPS privacy rule (RLS invariant 3): raw location data of a gps_private
-- flight is visible ONLY to admins and the flight's owners (creator, pilot,
-- log uploader — "Uploader's GPS stays visible to them"). Everyone else gets
-- sanitized artifacts.
create or replace function app.can_view_raw_gps(p_flight uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.is_admin() or exists (
    select 1 from public.flights f
    where f.id = p_flight
      and (
        not f.gps_private
        or f.created_by = auth.uid()
        or f.pilot_id = auth.uid()
        or exists (
          select 1 from public.flight_logs fl
          where fl.flight_id = f.id and fl.uploaded_by = auth.uid()
        )
      )
  );
$$;

grant execute on all functions in schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Auto-create a profile for every new auth user (GoTrue email or GitHub OAuth)
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.user_profiles (id, name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'user_name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Privilege-escalation guard: only admins may set/change roles.
-- (auth.uid() IS NULL = service/migration/seed context — allowed.)
-- ---------------------------------------------------------------------------
create or replace function public.tg_guard_roles()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is not null and not app.is_admin() then
    if tg_op = 'INSERT' and new.roles is distinct from '{operator}'::public.user_role[] then
      raise exception 'only admins can assign roles';
    elsif tg_op = 'UPDATE' and new.roles is distinct from old.roles then
      raise exception 'only admins can change roles';
    end if;
  end if;
  return new;
end;
$$;

create trigger guard_roles
  before insert or update on public.user_profiles
  for each row execute function public.tg_guard_roles();

-- ---------------------------------------------------------------------------
-- gps_private per-user default: NULL on INSERT -> creator's
-- gps_default_private; falls back to TRUE (private by default — Thomas).
-- ---------------------------------------------------------------------------
create or replace function public.tg_flight_gps_default()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.gps_private is null then
    select up.gps_default_private into new.gps_private
    from public.user_profiles up
    where up.id = coalesce(new.created_by, auth.uid());
    new.gps_private := coalesce(new.gps_private, true);
  end if;
  return new;
end;
$$;

create trigger flight_gps_default
  before insert on public.flights
  for each row execute function public.tg_flight_gps_default();

-- ---------------------------------------------------------------------------
-- Parser queue hook: NOTIFY when a log enters status 'uploaded'
-- (parser may LISTEN 'flight_log_uploaded' or poll flight_logs.status).
-- ---------------------------------------------------------------------------
create or replace function public.tg_notify_flight_log_uploaded()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'uploaded' and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform pg_notify('flight_log_uploaded', new.id::text);
  end if;
  return new;
end;
$$;

create trigger notify_flight_log_uploaded
  after insert or update of status on public.flight_logs
  for each row execute function public.tg_notify_flight_log_uploaded();
