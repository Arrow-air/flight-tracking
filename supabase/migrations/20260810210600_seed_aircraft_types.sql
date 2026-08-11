-- Flight Tracking v2 — reference seed: aircraft_types
-- Lives in a migration (not seed.sql) because types are production reference
-- data, not local-dev fixtures. Fixed UUIDs keep the import + parser phases
-- deterministic; ON CONFLICT keeps re-runs idempotent.
--
-- Facts vs assumptions:
--   Quiver    cells=14  — website docs project-quiver/index.md: "Tattu 14S 30 Ah
--                         smart battery"; class multirotor (quad).
--   Caribou   cells=18  — RUN-CONTEXT: "Caribou (18S hex)"; class multirotor.
--   Spearhead fixed-wing — RUN-CONTEXT; cells UNKNOWN -> NULL (parser must
--                         handle NULL cells: skip per-cell math or infer).
--   Kestrel   class + cells not stated anywhere available to this run.
--             ASSUMPTION: multirotor; cells NULL.

insert into public.aircraft_types (id, name, class, cells, parser_profile)
values
  ('a1c0f7e0-0000-4000-8000-000000000001', 'Quiver',    'multirotor', 14,   '{}'::jsonb),
  ('a1c0f7e0-0000-4000-8000-000000000002', 'Caribou',   'multirotor', 18,   '{}'::jsonb),
  ('a1c0f7e0-0000-4000-8000-000000000003', 'Spearhead', 'fixed_wing', null, '{}'::jsonb),
  ('a1c0f7e0-0000-4000-8000-000000000004', 'Kestrel',   'multirotor', null, '{}'::jsonb)
on conflict (name) do nothing;
