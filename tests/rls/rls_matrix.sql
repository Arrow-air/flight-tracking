-- =============================================================================
-- RLS test matrix — schema gate (critic-owned; builder must not touch tests/rls/)
-- Proves every RUN-CONTEXT "Schema" RLS invariant against a FRESH
-- `supabase db reset`. Run as postgres via tests/rls/run.sh, or directly:
--   docker exec -i supabase_db_flight-tracking psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < tests/rls/rls_matrix.sql
-- Every test impersonates a real seeded user (session GUCs `role` +
-- `request.jwt.claims`, exactly what PostgREST sets), acts, restores postgres,
-- and records PASS/FAIL. The file raises at the end if ANY test failed, so the
-- psql exit code is the verdict (0 = all pass).
--
-- Invariant map (RUN-CONTEXT numbering):
--   1  manufacturer-only aircraft INSERT
--   2  operator write scoping via aircraft_operators; fleet-visible reads
--   3  gps_private: series + raw storage object denied to non-owner/non-admin;
--      sanitized artifacts fleet-readable
--   4  no silent RLS swallowing: denials error (WITH CHECK 42501); the one
--      unavoidable silent case (UPDATE through USING-filtered rows) reports an
--      accurate 0 rowcount so the API layer can detect it
--   5  audit_log coverage (trigger-fed on core tables) + immutability
-- =============================================================================

drop schema if exists tests_rls cascade;
create schema tests_rls;

create table tests_rls.results (
  n         int generated always as identity primary key,
  invariant text not null,
  name      text not null,
  ok        boolean not null,
  detail    text
);

-- Fixture ids (seed users are fixed by supabase/seed.sql; test rows get fixed
-- uuids so audit assertions are exact)
create table tests_rls.f (k text primary key, id uuid not null);
insert into tests_rls.f values
  ('thomas', '11111111-1111-1111-1111-111111111111'),  -- admin + manufacturer
  ('julius', '22222222-2222-2222-2222-222222222222'),  -- manufacturer only
  ('oper',   '33333333-3333-3333-3333-333333333333'),  -- operator only
  ('ac1',    'aaaaaaaa-0000-4000-8000-000000000001'),  -- aircraft, oper assigned
  ('ac2',    'aaaaaaaa-0000-4000-8000-000000000002'),  -- aircraft, NOT assigned
  ('f1',     'ffffffff-0000-4000-8000-000000000001'),  -- oper flight on ac1, gps_private default
  ('f2',     'ffffffff-0000-4000-8000-000000000002'),  -- thomas flight on ac2, gps_private=false
  ('f3',     'ffffffff-0000-4000-8000-000000000003'),  -- oper flight on ac1, private, pilot=julius
  ('l1',     '0f000000-0000-4000-8000-000000000001'),  -- log on f1 (oper)
  ('l2',     '0f000000-0000-4000-8000-000000000002'),  -- log on f2 (thomas)
  ('l3',     '0f000000-0000-4000-8000-000000000003'),  -- log on f3 (oper)
  ('c1',     'cc000000-0000-4000-8000-000000000001'),  -- component (oper)
  ('tag1',   'dd000000-0000-4000-8000-000000000001');
insert into tests_rls.f select 'quiver', id from public.aircraft_types where name = 'Quiver';

create or replace function tests_rls.fid(p_k text) returns uuid
language sql stable as $$ select id from tests_rls.f where k = p_k $$;

-- PostgREST-style impersonation: session-level so it survives the DO block
-- boundaries; exception rollbacks inside a test cannot un-impersonate because
-- impersonation happens before the inner BEGIN.
create or replace function tests_rls.impersonate(p_uid uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid::text, 'role', 'authenticated')::text, false);
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  perform set_config('role', 'authenticated', false);
end $$;

create or replace function tests_rls.impersonate_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', false);
  perform set_config('request.jwt.claim.sub', '', false);
  perform set_config('role', 'anon', false);
end $$;

create or replace function tests_rls.unimpersonate() returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', false);
  perform set_config('request.jwt.claims', '', false);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;

create or replace function tests_rls.record(p_inv text, p_name text, p_ok boolean, p_detail text)
returns void language sql as
$$ insert into tests_rls.results (invariant, name, ok, detail) values (p_inv, p_name, p_ok, p_detail) $$;

grant usage on schema tests_rls to public;
grant select on tests_rls.f to public;
grant execute on all functions in schema tests_rls to public;

-- =============================================================================
-- INVARIANT 1 — only manufacturers (and admins) INSERT aircraft
-- =============================================================================

-- T01 [1+] Julius (manufacturer) creates aircraft ac1
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  begin
    insert into public.aircraft (id, serial, name, type_id)
    values (tests_rls.fid('ac1'), 'RLS-AC1', 'Gate test 1', tests_rls.fid('quiver'));
    ok := true; d := 'insert accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  ok := ok and exists (select 1 from public.aircraft where id = tests_rls.fid('ac1'));
  perform tests_rls.record('1', 'T01+ manufacturer (Julius) INSERT aircraft allowed', ok, d);
end $$;

-- T02 [1+] Thomas (admin) creates aircraft ac2
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  begin
    insert into public.aircraft (id, serial, name, type_id)
    values (tests_rls.fid('ac2'), 'RLS-AC2', 'Gate test 2', tests_rls.fid('quiver'));
    ok := true; d := 'insert accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('1', 'T02+ admin (Thomas) INSERT aircraft allowed', ok, d);
end $$;

-- T03 [1-] operator INSERT aircraft -> hard error (42501), not silent
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.aircraft (serial, type_id) values ('RLS-DENY-1', tests_rls.fid('quiver'));
    ok := false; d := 'insert SUCCEEDED — invariant 1 broken';
  exception when others then
    ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('1', 'T03- operator INSERT aircraft denied with error', ok, d);
end $$;

-- T04 [1-] anon INSERT aircraft -> hard error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate_anon();
  begin
    insert into public.aircraft (serial, type_id) values ('RLS-DENY-2', tests_rls.fid('quiver'));
    ok := false; d := 'insert SUCCEEDED as anon';
  exception when others then
    ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('1', 'T04- anon INSERT aircraft denied with error', ok, d);
end $$;

-- =============================================================================
-- INVARIANT 2 — operator writes scoped by aircraft_operators; fleet reads
-- =============================================================================

-- T05 [2+] manufacturer assigns operator to ac1
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  begin
    insert into public.aircraft_operators (aircraft_id, user_id)
    values (tests_rls.fid('ac1'), tests_rls.fid('oper'));
    ok := true; d := 'assignment accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T05+ manufacturer assigns operator to ac1', ok, d);
end $$;

-- T06 [2-] operator cannot self-assign to ac2
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.aircraft_operators (aircraft_id, user_id)
    values (tests_rls.fid('ac2'), tests_rls.fid('oper'));
    ok := false; d := 'self-assignment SUCCEEDED';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T06- operator self-assign to unassigned aircraft denied', ok, d);
end $$;

-- T07 [2+] operator creates flight f1 on assigned ac1 (gps_private OMITTED on
-- purpose — T21 checks the private-by-default trigger)
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.flights (id, aircraft_id, title, started_at, ended_at)
    values (tests_rls.fid('f1'), tests_rls.fid('ac1'), 'Op flight on ac1', now() - interval '1 hour', now());
    ok := true; d := 'insert accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T07+ operator INSERT flight on assigned aircraft', ok, d);
end $$;

-- T08 [2-] operator flight on UNassigned ac2 -> error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.flights (aircraft_id, title) values (tests_rls.fid('ac2'), 'should fail');
    ok := false; d := 'insert SUCCEEDED — scoping broken';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T08- operator INSERT flight on unassigned aircraft denied', ok, d);
end $$;

-- T09 [2-] manufacturer (Julius, not assigned, not admin) cannot write flights
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  begin
    insert into public.flights (aircraft_id, title) values (tests_rls.fid('ac1'), 'mfg should fail');
    ok := false; d := 'insert SUCCEEDED — manufacturer got operational write';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T09- unassigned manufacturer INSERT flight denied', ok, d);
end $$;

-- T10 [2+] operator maintenance (airframe_events) on assigned ac1
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.airframe_events (aircraft_id, kind, title)
    values (tests_rls.fid('ac1'), 'maintenance', 'prop swap');
    ok := true; d := 'insert accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T10+ operator maintenance event on assigned aircraft', ok, d);
end $$;

-- T11 [2-] operator maintenance on UNassigned ac2 -> error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.airframe_events (aircraft_id, kind, title)
    values (tests_rls.fid('ac2'), 'maintenance', 'should fail');
    ok := false; d := 'insert SUCCEEDED';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T11- operator maintenance on unassigned aircraft denied', ok, d);
end $$;

-- T12 [2+] operator component + install event on assigned ac1
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.components (id, kind, serial) values (tests_rls.fid('c1'), 'motor', 'RLS-M1');
    insert into public.component_events (aircraft_id, component_id, event)
    values (tests_rls.fid('ac1'), tests_rls.fid('c1'), 'installed');
    ok := true; d := 'component + install event accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T12+ operator component_event on assigned aircraft', ok, d);
end $$;

-- T13 [2-] operator component event on UNassigned ac2 -> error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.component_events (aircraft_id, component_id, event)
    values (tests_rls.fid('ac2'), tests_rls.fid('c1'), 'installed');
    ok := false; d := 'insert SUCCEEDED';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T13- operator component_event on unassigned aircraft denied', ok, d);
end $$;

-- T14 [2+] operator reports issue on assigned ac1
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.issues (aircraft_id, problem) values (tests_rls.fid('ac1'), 'squawk: vibration');
    ok := true; d := 'insert accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T14+ operator issue on assigned aircraft', ok, d);
end $$;

-- T15 [2-] operator issue on UNassigned ac2 -> error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.issues (aircraft_id, problem) values (tests_rls.fid('ac2'), 'should fail');
    ok := false; d := 'insert SUCCEEDED';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T15- operator issue on unassigned aircraft denied', ok, d);
end $$;

-- T16 [2+] operator can UPDATE the aircraft they control (rowcount 1)
do $$
declare ok bool; d text; rc int;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    update public.aircraft set name = 'Gate test 1 (op-renamed)' where id = tests_rls.fid('ac1');
    get diagnostics rc = row_count;
    ok := (rc = 1); d := 'row_count=' || rc;
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T16+ operator UPDATE controlled aircraft affects 1 row', ok, d);
end $$;

-- T17 [2+ read] non-writer authenticated user (Julius) reads operator flight
do $$
declare ok bool; d text; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  select count(*) into c from public.flights where id = tests_rls.fid('f1');
  perform tests_rls.unimpersonate();
  ok := (c = 1); d := 'visible rows=' || c;
  perform tests_rls.record('2', 'T17+ fleet-visible: Julius reads operator flight metadata', ok, d);
end $$;

-- T18 [2+ read] operator sees the whole fleet
do $$
declare ok bool; d text; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  select count(*) into c from public.aircraft;
  perform tests_rls.unimpersonate();
  ok := (c >= 2); d := 'aircraft visible=' || c;
  perform tests_rls.record('2', 'T18+ fleet-visible: operator reads all aircraft', ok, d);
end $$;

-- T19 [2- read] anon gets NO reads in P0
do $$
declare ok bool; d text; c int;
begin
  perform tests_rls.impersonate_anon();
  begin
    select count(*) into c from public.flights;
    ok := false; d := 'anon SELECT succeeded, rows=' || c;
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T19- anon SELECT flights denied', ok, d);
end $$;

-- =============================================================================
-- INVARIANT 3 — gps_private gating (series + raw storage vs sanitized)
-- =============================================================================

-- T20 [2+] admin writes anywhere: Thomas creates PUBLIC flight f2 on ac2
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  begin
    insert into public.flights (id, aircraft_id, title, gps_private)
    values (tests_rls.fid('f2'), tests_rls.fid('ac2'), 'Public flight', false);
    ok := true; d := 'insert accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T20+ admin INSERT flight on any aircraft', ok, d);
end $$;

-- T21 [3+] gps_private omitted on f1 -> defaulted TRUE (private by default)
do $$
declare ok bool; g bool;
begin
  select gps_private into g from public.flights where id = tests_rls.fid('f1');
  ok := (g is true);
  perform tests_rls.record('3', 'T21+ gps_private defaults to TRUE when omitted', ok, 'gps_private=' || coalesce(g::text, 'NULL'));
end $$;

-- T22 [2+] operator uploads log l1 on own flight f1
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.flight_logs (id, flight_id, object_path, checksum)
    values (tests_rls.fid('l1'), tests_rls.fid('f1'), 'rls-test/L1.bin', 'rls-sha-l1');
    ok := true; d := 'insert accepted';
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T22+ operator INSERT flight_log on own flight', ok, d);
end $$;

-- T23 [2-] operator log upload on someone else's flight (f2) -> error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.flight_logs (flight_id, object_path, checksum)
    values (tests_rls.fid('f2'), 'rls-test/deny.bin', 'rls-sha-deny');
    ok := false; d := 'insert SUCCEEDED';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T23- operator INSERT flight_log on unassigned flight denied', ok, d);
end $$;

-- Setup (not a test): Thomas uploads l2 on f2; operator creates private flight
-- f3 (pilot = Julius) + log l3; series rows written as service context
-- (postgres, RLS-bypassing owner — same privilege level the parser's
-- service_role key has); storage objects for raw + sanitized artifacts.
do $$
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  insert into public.flight_logs (id, flight_id, object_path, checksum)
  values (tests_rls.fid('l2'), tests_rls.fid('f2'), 'rls-test/L2.bin', 'rls-sha-l2');
  perform tests_rls.unimpersonate();

  perform tests_rls.impersonate(tests_rls.fid('oper'));
  insert into public.flights (id, aircraft_id, title, pilot_id, gps_private)
  values (tests_rls.fid('f3'), tests_rls.fid('ac1'), 'Private, Julius pilots', tests_rls.fid('julius'), true);
  insert into public.flight_logs (id, flight_id, object_path, checksum)
  values (tests_rls.fid('l3'), tests_rls.fid('f3'), 'rls-test/L3.bin', 'rls-sha-l3');
  perform tests_rls.unimpersonate();

  insert into public.flight_log_series (log_id, channel, t, v) values
    (tests_rls.fid('l1'), 'GPS.Lat', array[0,1]::float8[], array[30.1,30.2]::float8[]),
    (tests_rls.fid('l2'), 'GPS.Lat', array[0,1]::float8[], array[31.1,31.2]::float8[]),
    (tests_rls.fid('l3'), 'GPS.Lat', array[0,1]::float8[], array[32.1,32.2]::float8[]);

  insert into storage.objects (bucket_id, name) values
    ('flight-logs', 'rls-test/L1.bin'),
    ('flight-logs', 'rls-test/L2.bin'),
    ('flight-logs-sanitized', 'rls-test/L1.sanitized.bin');
end $$;

-- T24 [3-] Julius (non-owner, non-admin, non-pilot) series of private l1 -> 0 rows
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  select count(*) into c from public.flight_log_series where log_id = tests_rls.fid('l1');
  perform tests_rls.unimpersonate();
  ok := (c = 0);
  perform tests_rls.record('3', 'T24- non-owner series of gps_private flight hidden', ok, 'rows=' || c);
end $$;

-- T25 [3+] admin sees private series
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  select count(*) into c from public.flight_log_series where log_id = tests_rls.fid('l1');
  perform tests_rls.unimpersonate();
  ok := (c = 1);
  perform tests_rls.record('3', 'T25+ admin sees gps_private series', ok, 'rows=' || c);
end $$;

-- T26 [3+] owner/uploader sees own private series
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  select count(*) into c from public.flight_log_series where log_id = tests_rls.fid('l1');
  perform tests_rls.unimpersonate();
  ok := (c = 1);
  perform tests_rls.record('3', 'T26+ owner sees own gps_private series', ok, 'rows=' || c);
end $$;

-- T27 [3+] non-private flight series fleet-visible (Julius reads l2)
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  select count(*) into c from public.flight_log_series where log_id = tests_rls.fid('l2');
  perform tests_rls.unimpersonate();
  ok := (c = 1);
  perform tests_rls.record('3', 'T27+ non-private series fleet-visible', ok, 'rows=' || c);
end $$;

-- T28 [3+] pilot counts as owner: Julius (pilot of f3) sees l3 series
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  select count(*) into c from public.flight_log_series where log_id = tests_rls.fid('l3');
  perform tests_rls.unimpersonate();
  ok := (c = 1);
  perform tests_rls.record('3', 'T28+ pilot sees private series of their flight', ok, 'rows=' || c);
end $$;

-- T29 [3-] raw .bin storage object of private flight hidden from Julius
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  select count(*) into c from storage.objects
   where bucket_id = 'flight-logs' and name = 'rls-test/L1.bin';
  perform tests_rls.unimpersonate();
  ok := (c = 0);
  perform tests_rls.record('3', 'T29- raw object of gps_private flight hidden from non-owner', ok, 'rows=' || c);
end $$;

-- T30 [3+] sanitized artifact fleet-readable (Julius)
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  select count(*) into c from storage.objects
   where bucket_id = 'flight-logs-sanitized' and name = 'rls-test/L1.sanitized.bin';
  perform tests_rls.unimpersonate();
  ok := (c = 1);
  perform tests_rls.record('3', 'T30+ sanitized artifact fleet-readable', ok, 'rows=' || c);
end $$;

-- T31 [3+] uploader reads own raw object
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  select count(*) into c from storage.objects
   where bucket_id = 'flight-logs' and name = 'rls-test/L1.bin';
  perform tests_rls.unimpersonate();
  ok := (c = 1);
  perform tests_rls.record('3', 'T31+ uploader reads own raw gps_private object', ok, 'rows=' || c);
end $$;

-- T32 [3+] admin reads any raw object
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  select count(*) into c from storage.objects
   where bucket_id = 'flight-logs' and name = 'rls-test/L1.bin';
  perform tests_rls.unimpersonate();
  ok := (c = 1);
  perform tests_rls.record('3', 'T32+ admin reads raw gps_private object', ok, 'rows=' || c);
end $$;

-- T33 [3+] raw object of NON-private flight fleet-readable (Julius reads L2.bin)
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  select count(*) into c from storage.objects
   where bucket_id = 'flight-logs' and name = 'rls-test/L2.bin';
  perform tests_rls.unimpersonate();
  ok := (c = 1);
  perform tests_rls.record('3', 'T33+ raw object of non-private flight fleet-readable', ok, 'rows=' || c);
end $$;

-- T34 [3-] non-admin cannot forge series rows (pipeline integrity)
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    insert into public.flight_log_series (log_id, channel, t, v)
    values (tests_rls.fid('l1'), 'FAKE', array[0]::float8[], array[0]::float8[]);
    ok := false; d := 'insert SUCCEEDED';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('3', 'T34- non-admin INSERT flight_log_series denied', ok, d);
end $$;

-- T35 [3-] non-admin cannot forge summaries (parser-only surface)
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('julius'));
  begin
    insert into public.flight_log_summary (log_id, duration_s) values (tests_rls.fid('l2'), 1);
    ok := false; d := 'insert SUCCEEDED';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('3', 'T35- non-admin INSERT flight_log_summary denied', ok, d);
end $$;

-- =============================================================================
-- INVARIANT 4 — no silent RLS swallowing (DB side of the contract)
-- =============================================================================

-- T36 [4+] permitted UPDATE reports row_count=1 (success measurable)
do $$
declare ok bool; d text; rc int;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    update public.flights set title = 'Op flight on ac1 (edited)' where id = tests_rls.fid('f1');
    get diagnostics rc = row_count;
    ok := (rc = 1); d := 'row_count=' || rc;
  exception when others then ok := false; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('4', 'T36+ permitted UPDATE reports row_count=1', ok, d);
end $$;

-- T37 [4] USING-filtered UPDATE is the ONE silent case: it must report an
-- ACCURATE row_count=0 (API contract: treat 0 rows as failure) and must not
-- actually change the row
do $$
declare ok bool; d text; rc int; t text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    update public.flights set title = 'hacked' where id = tests_rls.fid('f2');
    get diagnostics rc = row_count;
    d := 'row_count=' || rc;
    ok := (rc = 0);
  exception when others then ok := false; d := 'unexpected error ' || sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  select title into t from public.flights where id = tests_rls.fid('f2');
  ok := ok and (t = 'Public flight');
  perform tests_rls.record('4', 'T37  denied UPDATE detectable: row_count=0 and row unchanged', ok, d || '; title=' || t);
end $$;

-- T38 [4+] moving a row OUT of scope errors loudly (WITH CHECK, not silent)
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    update public.flights set aircraft_id = tests_rls.fid('ac2') where id = tests_rls.fid('f1');
    ok := false; d := 'UPDATE out of scope SUCCEEDED';
  exception when others then ok := (sqlstate = '42501'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('4', 'T38+ UPDATE moving row out of scope raises 42501', ok, d);
end $$;

-- =============================================================================
-- INVARIANT 5 — audit_log coverage + immutability
-- =============================================================================

-- T39 [5+] audit trigger present on all 18 core tables
do $$
declare ok bool; missing text;
begin
  select string_agg(t, ', ') into missing
  from unnest(array[
    'user_profiles','sites','aircraft_types','aircraft','aircraft_operators',
    'components','component_events','tags','attachments_catalog','flights',
    'flight_payloads','flight_tags','flight_notes','airframe_events',
    'issues','flight_logs','media','exports']) as t
  where not exists (
    select 1 from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t
      and tg.tgname = 'audit_row' and not tg.tgisinternal);
  ok := (missing is null);
  perform tests_rls.record('5', 'T39+ audit trigger on all 18 core tables', ok,
    coalesce('missing: ' || missing, 'all 18 present'));
end $$;

-- T40 [5+] aircraft INSERT audited with correct actor (Julius / ac1)
do $$
declare ok bool; c int;
begin
  select count(*) into c from public.audit_log
   where table_name = 'aircraft' and action = 'INSERT'
     and row_id = tests_rls.fid('ac1')::text and actor = tests_rls.fid('julius');
  ok := (c = 1);
  perform tests_rls.record('5', 'T40+ aircraft INSERT audit row with actor=Julius', ok, 'rows=' || c);
end $$;

-- T41 [5+] flight INSERT + UPDATE audited with actor=operator (f1)
do $$
declare ok bool; ci int; cu int;
begin
  select count(*) into ci from public.audit_log
   where table_name = 'flights' and action = 'INSERT'
     and row_id = tests_rls.fid('f1')::text and actor = tests_rls.fid('oper');
  select count(*) into cu from public.audit_log
   where table_name = 'flights' and action = 'UPDATE'
     and row_id = tests_rls.fid('f1')::text and actor = tests_rls.fid('oper');
  ok := (ci = 1 and cu >= 1);
  perform tests_rls.record('5', 'T41+ flight INSERT+UPDATE audited with actor', ok,
    'insert rows=' || ci || ', update rows=' || cu);
end $$;

-- T42 [5+] DELETE audited: Thomas creates + deletes a tag, both entries land
do $$
declare ok bool; d text; ci int; cd int;
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  begin
    insert into public.tags (id, name) values (tests_rls.fid('tag1'), 'rls-gate-tag');
    delete from public.tags where id = tests_rls.fid('tag1');
    d := 'insert+delete accepted';
  exception when others then d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  select count(*) into ci from public.audit_log
   where table_name = 'tags' and action = 'INSERT' and row_id = tests_rls.fid('tag1')::text;
  select count(*) into cd from public.audit_log
   where table_name = 'tags' and action = 'DELETE' and row_id = tests_rls.fid('tag1')::text
     and actor = tests_rls.fid('thomas');
  ok := (ci = 1 and cd = 1);
  perform tests_rls.record('5', 'T42+ DELETE audited (tags insert+delete pair)', ok,
    d || '; insert rows=' || ci || ', delete rows=' || cd);
end $$;

-- T43 [5-] authenticated (even admin) UPDATE audit_log -> error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  begin
    update public.audit_log set table_name = 'tampered' where id = (select min(id) from public.audit_log);
    ok := false; d := 'UPDATE SUCCEEDED';
  exception when others then ok := true; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('5', 'T43- admin (authenticated) UPDATE audit_log denied', ok, d);
end $$;

-- T44 [5-] authenticated DELETE audit_log -> error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  begin
    delete from public.audit_log where id = (select min(id) from public.audit_log);
    ok := false; d := 'DELETE SUCCEEDED';
  exception when others then ok := true; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('5', 'T44- admin (authenticated) DELETE audit_log denied', ok, d);
end $$;

-- T45 [5-] even table owner (postgres = service-level power) cannot UPDATE
do $$
declare ok bool; d text;
begin
  begin
    update public.audit_log set table_name = 'tampered' where id = (select min(id) from public.audit_log);
    ok := false; d := 'UPDATE as postgres SUCCEEDED';
  exception when others then ok := (sqlerrm like '%append-only%'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.record('5', 'T45- postgres UPDATE audit_log rejected (append-only)', ok, d);
end $$;

-- T46 [5-] postgres DELETE audit_log rejected
do $$
declare ok bool; d text;
begin
  begin
    delete from public.audit_log where id = (select min(id) from public.audit_log);
    ok := false; d := 'DELETE as postgres SUCCEEDED';
  exception when others then ok := (sqlerrm like '%append-only%'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.record('5', 'T46- postgres DELETE audit_log rejected (append-only)', ok, d);
end $$;

-- T47 [5-] postgres TRUNCATE audit_log rejected
do $$
declare ok bool; d text;
begin
  begin
    truncate public.audit_log;
    ok := false; d := 'TRUNCATE SUCCEEDED';
  exception when others then ok := (sqlerrm like '%append-only%'); d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.record('5', 'T47- postgres TRUNCATE audit_log rejected (append-only)', ok, d);
end $$;

-- T48 [5+] admin can read the trail
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('thomas'));
  select count(*) into c from public.audit_log;
  perform tests_rls.unimpersonate();
  ok := (c > 0);
  perform tests_rls.record('5', 'T48+ admin SELECT audit_log returns entries', ok, 'rows=' || c);
end $$;

-- T49 [5-] non-admin sees no audit trail
do $$
declare ok bool; c int;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  select count(*) into c from public.audit_log;
  perform tests_rls.unimpersonate();
  ok := (c = 0);
  perform tests_rls.record('5', 'T49- operator SELECT audit_log sees 0 rows', ok, 'rows=' || c);
end $$;

-- T50 [guard-] privilege escalation: operator self-promoting roles -> error
do $$
declare ok bool; d text;
begin
  perform tests_rls.impersonate(tests_rls.fid('oper'));
  begin
    update public.user_profiles set roles = '{admin}'::public.user_role[]
     where id = tests_rls.fid('oper');
    ok := false; d := 'self-promotion SUCCEEDED';
  exception when others then ok := true; d := sqlstate || ': ' || sqlerrm;
  end;
  perform tests_rls.unimpersonate();
  perform tests_rls.record('2', 'T50- operator self-promotion to admin denied', ok, d);
end $$;

-- =============================================================================
-- Report
-- =============================================================================
select format('[%s] inv%s %s%s',
              case when ok then 'PASS' else 'FAIL' end,
              invariant, name,
              case when ok then '' else ' :: ' || coalesce(detail, '') end) as result
from tests_rls.results order by n;

select format('TOTAL=%s PASS=%s FAIL=%s',
              count(*),
              count(*) filter (where ok),
              count(*) filter (where not ok)) as summary
from tests_rls.results;

-- Failure detail dump (empty when green)
select n, invariant, name, detail from tests_rls.results where not ok order by n;

-- Non-zero psql exit if anything failed
do $$
begin
  if exists (select 1 from tests_rls.results where not ok) then
    raise exception 'RLS MATRIX: failures present (see rows above)';
  end if;
end $$;
