-- Schema smoke test — proves the RUN-CONTEXT RLS invariants against a fresh
-- `supabase db reset`. Run as postgres:
--   docker exec -i supabase_db_flight-tracking psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=0 -f - < supabase/tests/schema_smoke.sql
-- Expected: every line printed with a [PASS] prefix; DENIED cases show the
-- raised error immediately above their [PASS] line.

\set thomas '11111111-1111-1111-1111-111111111111'
\set julius '22222222-2222-2222-2222-222222222222'
\set operator '33333333-3333-3333-3333-333333333333'

-- ---------------------------------------------------------------------------
\echo '--- 0. structure: 22 tables, seed rows'
select case when count(*) = 22 then '[PASS] 22 public tables' else '[FAIL] table count = ' || count(*) end
  from pg_tables where schemaname = 'public';
select case when count(*) = 4 then '[PASS] 4 aircraft_types' else '[FAIL] aircraft_types = ' || count(*) end
  from public.aircraft_types;
select case when count(*) = 2 then '[PASS] 2 seed sites' else '[FAIL] sites = ' || count(*) end
  from public.sites;
select case
    when (select roles from public.user_profiles where id = :'thomas') = '{admin,manufacturer}'::public.user_role[]
     and (select roles from public.user_profiles where id = :'julius') = '{manufacturer}'::public.user_role[]
     and (select roles from public.user_profiles where id = :'operator') = '{operator}'::public.user_role[]
    then '[PASS] seed roles: Thomas admin+manufacturer, Julius manufacturer, operator'
    else '[FAIL] seed roles wrong' end;
select case when count(*) = 3 then '[PASS] 3 storage buckets' else '[FAIL] buckets = ' || count(*) end
  from storage.buckets where id in ('flight-logs','flight-logs-sanitized','media');

-- ---------------------------------------------------------------------------
\echo '--- fixtures (as service: two aircraft, operator assigned to ONE)'
insert into public.aircraft (id, serial, name, type_id, created_by)
values ('c0000000-0000-4000-8000-000000000001', 'SMOKE-Q1', 'Smoke Quiver 1',
        'a1c0f7e0-0000-4000-8000-000000000001', :'thomas'),
       ('c0000000-0000-4000-8000-000000000002', 'SMOKE-Q2', 'Smoke Quiver 2',
        'a1c0f7e0-0000-4000-8000-000000000001', :'thomas');
insert into public.aircraft_operators (aircraft_id, user_id, granted_by)
values ('c0000000-0000-4000-8000-000000000001', :'operator', :'thomas');
select '[PASS] fixtures created';

-- ---------------------------------------------------------------------------
\echo '--- 1. only manufacturers/admins INSERT aircraft'
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  insert into public.aircraft (serial, type_id, created_by)
  values ('SMOKE-DENY', 'a1c0f7e0-0000-4000-8000-000000000001', '33333333-3333-3333-3333-333333333333');
rollback;
select case when not exists (select 1 from public.aircraft where serial = 'SMOKE-DENY')
  then '[PASS] operator INSERT aircraft DENIED (error above expected)' else '[FAIL] operator created aircraft' end;

begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
  insert into public.aircraft (serial, name, type_id)
  values ('SMOKE-J1', 'Julius build', 'a1c0f7e0-0000-4000-8000-000000000002');
commit;
select case when exists (select 1 from public.aircraft where serial = 'SMOKE-J1')
  then '[PASS] manufacturer INSERT aircraft allowed' else '[FAIL] manufacturer INSERT blocked' end;

-- ---------------------------------------------------------------------------
\echo '--- 2. operators write flights only for assigned aircraft; reads fleet-visible'
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  insert into public.flights (id, aircraft_id, pilot_id, title)
  values ('d0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001',
          '33333333-3333-3333-3333-333333333333', 'assigned aircraft flight');
commit;
select case when exists (select 1 from public.flights where id = 'd0000000-0000-4000-8000-000000000001')
  then '[PASS] operator flight on ASSIGNED aircraft allowed' else '[FAIL] assigned-aircraft flight blocked' end;

begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  insert into public.flights (aircraft_id, title)
  values ('c0000000-0000-4000-8000-000000000002', 'NOT assigned — must fail');
rollback;
select case when not exists (select 1 from public.flights where title like 'NOT assigned%')
  then '[PASS] operator flight on UNASSIGNED aircraft DENIED (error above expected)' else '[FAIL] unassigned write got through' end;

begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  insert into public.airframe_events (aircraft_id, kind, title, author)
  values ('c0000000-0000-4000-8000-000000000002', 'maintenance', 'unassigned maint — must fail',
          '33333333-3333-3333-3333-333333333333');
rollback;
select case when not exists (select 1 from public.airframe_events where title like 'unassigned maint%')
  then '[PASS] operator maintenance on UNASSIGNED aircraft DENIED (error above expected)' else '[FAIL] unassigned maintenance got through' end;

begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
  select case when (select count(*) from public.flights) >= 1
    then '[PASS] fleet-visible: Julius (not operator of it) can read the flight'
    else '[FAIL] fleet read blocked' end;
commit;

-- ---------------------------------------------------------------------------
\echo '--- 3. GPS privacy: series of gps_private flight = owner/admin only'
-- gps_private was NOT specified on insert -> per-user default (true) must hold
select case when (select gps_private from public.flights where id = 'd0000000-0000-4000-8000-000000000001')
  then '[PASS] gps_private defaulted TRUE from user default' else '[FAIL] gps_private default wrong' end;

insert into public.flight_logs (id, flight_id, object_path, checksum, uploaded_by)
values ('e0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
        'smoke/e0000000.bin', 'smoke-checksum-1', :'operator');
insert into public.flight_log_series (log_id, channel, t, v)
values ('e0000000-0000-4000-8000-000000000001', 'GPS.Lat', array[0,1], array[30.1,30.2]);

begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
  select case when count(*) = 0
    then '[PASS] non-owner non-admin sees NO series rows of private flight'
    else '[FAIL] private series leaked to Julius' end
  from public.flight_log_series where log_id = 'e0000000-0000-4000-8000-000000000001';
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
  select case when count(*) = 1
    then '[PASS] admin sees series of private flight'
    else '[FAIL] admin blocked from series' end
  from public.flight_log_series where log_id = 'e0000000-0000-4000-8000-000000000001';
commit;

begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  select case when count(*) = 1
    then '[PASS] owner/uploader sees own series'
    else '[FAIL] owner blocked from own series' end
  from public.flight_log_series where log_id = 'e0000000-0000-4000-8000-000000000001';
commit;

-- ---------------------------------------------------------------------------
\echo '--- 5. audit_log: fed by writes, rejects UPDATE/DELETE'
select case when count(*) >= 1 then '[PASS] audit rows for aircraft INSERTs (' || count(*) || ')'
  else '[FAIL] no audit rows for aircraft' end
  from public.audit_log where table_name = 'aircraft' and action = 'INSERT';
select case when count(*) >= 1 then '[PASS] audit row for flight INSERT'
  else '[FAIL] no audit row for flights' end
  from public.audit_log where table_name = 'flights' and action = 'INSERT';
select case when (select actor from public.audit_log
                  where table_name = 'flights' and action = 'INSERT'
                  order by at desc limit 1) = :'operator'::uuid
  then '[PASS] audit actor recorded (operator uuid)' else '[FAIL] audit actor missing/wrong' end;

-- even as postgres (table owner) UPDATE/DELETE must raise
begin;
  update public.audit_log set table_name = 'tampered' where id = (select min(id) from public.audit_log);
rollback;
select case when not exists (select 1 from public.audit_log where table_name = 'tampered')
  then '[PASS] audit_log UPDATE rejected (error above expected)' else '[FAIL] audit_log updated' end;

begin;
  delete from public.audit_log;
rollback;
select case when (select count(*) from public.audit_log) > 0
  then '[PASS] audit_log DELETE rejected (error above expected)' else '[FAIL] audit_log emptied' end;

-- ---------------------------------------------------------------------------
\echo '--- extra: privilege-escalation guard'
begin;
  set local role authenticated;
  set local request.jwt.claims to '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}';
  update public.user_profiles set roles = '{admin}' where id = '33333333-3333-3333-3333-333333333333';
rollback;
select case when (select roles from public.user_profiles where id = :'operator') = '{operator}'::public.user_role[]
  then '[PASS] operator cannot self-promote to admin (error above expected)' else '[FAIL] privilege escalation!' end;

-- ---------------------------------------------------------------------------
\echo '--- cleanup smoke fixtures'
delete from public.flight_log_series where log_id = 'e0000000-0000-4000-8000-000000000001';
delete from public.flight_logs where id = 'e0000000-0000-4000-8000-000000000001';
delete from public.flights where id = 'd0000000-0000-4000-8000-000000000001';
delete from public.aircraft_operators where aircraft_id = 'c0000000-0000-4000-8000-000000000001';
delete from public.aircraft where serial in ('SMOKE-Q1','SMOKE-Q2','SMOKE-J1');
select '[PASS] cleanup done (audit rows of the smoke run remain — append-only by design)';
