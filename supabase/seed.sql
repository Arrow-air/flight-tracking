-- Flight Tracking v2 — LOCAL DEV seed (applied by `supabase db reset`)
-- Production gets real GoTrue signups; this file exists so the local stack has
-- the launch role model to develop and gate against (RUN-CONTEXT "Seed"):
--   Thomas  — admin + manufacturer   thomas@arrowair.com  (real address)
--   Julius  — manufacturer           julius@example.com   (ASSUMPTION: real
--             email unknown to this run; placeholder domain on purpose)
--   Op Test — operator               operator@example.com (test user)
-- All local passwords: password123
-- Plus 2 seed sites. Site names are real references (Javelina ops, PT1 flight
-- test); coordinates are NOT known to this run -> NULL (quick-log weather
-- auto-fill needs coords entered before it can fire for these sites).

-- ---------------------------------------------------------------------------
-- Auth users (GoTrue-compatible rows; the on_auth_user_created trigger builds
-- the matching public.user_profiles rows)
-- ---------------------------------------------------------------------------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-1111-1111-111111111111',
    'authenticated', 'authenticated', 'thomas@arrowair.com',
    extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"name":"Thomas"}',
    now(), now(), '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-2222-2222-222222222222',
    'authenticated', 'authenticated', 'julius@example.com',
    extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"name":"Julius"}',
    now(), now(), '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '33333333-3333-3333-3333-333333333333',
    'authenticated', 'authenticated', 'operator@example.com',
    extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}', '{"name":"Operator Test"}',
    now(), now(), '', '', '', ''
  )
on conflict (id) do nothing;

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
)
values
  (
    gen_random_uuid(), '11111111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    '{"sub":"11111111-1111-1111-1111-111111111111","email":"thomas@arrowair.com","email_verified":true}',
    'email', now(), now(), now()
  ),
  (
    gen_random_uuid(), '22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222222',
    '{"sub":"22222222-2222-2222-2222-222222222222","email":"julius@example.com","email_verified":true}',
    'email', now(), now(), now()
  ),
  (
    gen_random_uuid(), '33333333-3333-3333-3333-333333333333',
    '33333333-3333-3333-3333-333333333333',
    '{"sub":"33333333-3333-3333-3333-333333333333","email":"operator@example.com","email_verified":true}',
    'email', now(), now(), now()
  )
on conflict (provider_id, provider) do nothing;

-- ---------------------------------------------------------------------------
-- Roles (seed runs as postgres: auth.uid() IS NULL, so the guard_roles
-- trigger allows this)
-- ---------------------------------------------------------------------------
update public.user_profiles
  set roles = '{admin,manufacturer}'::public.user_role[]
  where id = '11111111-1111-1111-1111-111111111111';

update public.user_profiles
  set roles = '{manufacturer}'::public.user_role[]
  where id = '22222222-2222-2222-2222-222222222222';

update public.user_profiles
  set roles = '{operator}'::public.user_role[]
  where id = '33333333-3333-3333-3333-333333333333';

-- ---------------------------------------------------------------------------
-- 2 seed sites
-- ---------------------------------------------------------------------------
insert into public.sites (id, name, lat, lon, elevation_m, notes, visibility, created_by)
values
  (
    'b0000000-0000-4000-8000-000000000001', 'Javelina (TX ops)',
    null, null, null,
    'Texas ag-ops site (Javelina flights). Coordinates not on record yet — fill in before quick-log weather auto-fill can run.',
    'private', '11111111-1111-1111-1111-111111111111'
  ),
  (
    'b0000000-0000-4000-8000-000000000002', 'PT1 Flight Test Area',
    null, null, null,
    'Quiver PT1 flight-test location. Coordinates not on record yet.',
    'private', '11111111-1111-1111-1111-111111111111'
  )
on conflict (id) do nothing;
