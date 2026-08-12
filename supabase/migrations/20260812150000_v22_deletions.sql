-- v2.2 feedback run — P3: deletion permissions (run/RUN-CONTEXT-V22.md P3).
--
-- PERMISSION MODEL (verified before writing this — most of it already existed
-- in 20260810210300_rls.sql and is intentionally left untouched):
--   * flights DELETE: "operators delete flights" —
--     app.can_write_aircraft_data(aircraft_id) = admin or assigned operator.
--     Exactly the canWrite semantics P3 asks for. NO CHANGE.
--   * aircraft DELETE: "admin delete aircraft" — app.is_admin() only.
--     Operators cannot delete aircraft. NO CHANGE.
--   * aircraft delete SAFE DEFAULT: flights.aircraft_id → aircraft is
--     ON DELETE RESTRICT (20260810210100_tables.sql) — the DB blocks deleting
--     an aircraft while flights exist. We KEEP that (no cascade): the admin is
--     told to delete/reassign the flights first. NO CHANGE.
--
-- What this migration actually changes:
--   1. flight_logs.flight_id FK: RESTRICT → CASCADE, so an authorized flight
--      DELETE cleans its children in one statement.
--   2. Storage DELETE policies so the client can remove log objects (raw +
--      sanitized) BEFORE deleting the DB rows. See ORDERING TRAP below.

-- ---------------------------------------------------------------------------
-- 1. flight-delete child cleanup.
-- Already CASCADE from flights: flight_notes, flight_tags, flight_payloads.
-- Already CASCADE from flight_logs: flight_log_summary, flight_log_series,
-- param_snapshots (FK cascades run as the system — not subject to RLS, so an
-- operator's flight delete cleans summaries even though summary DELETE policy
-- is admin-only). airframe_events.flight_id is ON DELETE SET NULL — aircraft
-- history intentionally survives a flight delete.
-- The one RESTRICT in the chain was flight_logs.flight_id; without this
-- change, a flight delete required deleting flight_logs rows first, and the
-- "delete own logs" policy (uploader-or-admin) would block operators who
-- didn't upload the log — contradicting operators-can-delete-flights.
-- ---------------------------------------------------------------------------
alter table public.flight_logs
  drop constraint flight_logs_flight_id_fkey,
  add constraint flight_logs_flight_id_fkey
    foreign key (flight_id) references public.flights (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 2. Storage object deletion.
--
-- ORDERING TRAP (why the client must delete storage objects FIRST): both
-- policies below resolve permission THROUGH the public.flight_logs row that
-- references the object. Once that row is gone (including via the FK cascade
-- above), no authenticated user can ever delete the object — only the
-- service_role can. The client flow is therefore:
--     list flight_logs rows → storage.remove(raw + sanitized paths)
--     → delete flights row (cascade cleans the DB side).
-- supabase-js storage.remove() does NOT error on RLS-filtered misses — the
-- client must compare the returned list against what it asked for; anything
-- not in it is a POSSIBLE orphan (see src/lib/deletion.ts for the report and
-- RUN-RESULT-V22 for the admin sweep mechanism: service-role listing of each
-- bucket diffed against live flight_logs.object_path/sanitized_path).
-- Note the returned list is also RETURNING-filtered by SELECT policies: a
-- non-owner operator deleting a gps_private flight's raw object succeeds but
-- can't see the result (raw read stays owner/admin-only) — deletion.ts
-- knowingly over-reports that case.
--
-- 2a. Raw bucket: previously uploader-or-admin only. Widened to anyone who
-- can write (and therefore delete) the flight, so an assigned operator
-- deleting a teammate's flight can clean up its objects too. This does not
-- weaken INVARIANT 3 (raw-read privacy): SELECT policies are untouched, and
-- deleting requires the same operator assignment that flight deletion does.
drop policy "raw logs delete uploader or admin" on storage.objects;

create policy "raw logs delete flight-writer or admin" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'flight-logs'
    and (
      app.is_admin()
      or exists (
        select 1 from public.flight_logs fl
        where fl.object_path = storage.objects.name
          and (
            fl.uploaded_by = auth.uid()
            or app.can_write_flight(fl.flight_id)
          )
      )
    )
  );

-- 2b. Sanitized bucket: had NO authenticated delete policy at all (parser
-- writes via service_role), so sanitized copies would ALWAYS orphan. Same
-- shape as 2a, matched on flight_logs.sanitized_path. Fleet-readability
-- (SELECT) is untouched.
create policy "sanitized logs delete flight-writer or admin" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'flight-logs-sanitized'
    and (
      app.is_admin()
      or exists (
        select 1 from public.flight_logs fl
        where fl.sanitized_path = storage.objects.name
          and (
            fl.uploaded_by = auth.uid()
            or app.can_write_flight(fl.flight_id)
          )
      )
    )
  );
