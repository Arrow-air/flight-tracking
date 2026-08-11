-- Flight Tracking v2 — storage buckets + object policies + realtime
--
-- Buckets:
--   flight-logs            raw .bin uploads (GPS-bearing) — access gated
--   flight-logs-sanitized  parser-written GPS-stripped copies — fleet-readable
--   media                  photos / reports / docs
--
-- Upload contract (P0 UI + import + parser): create the public.flight_logs row
-- FIRST (checksum, object_path), then PUT the object at that exact path. The
-- raw-bucket INSERT policy enforces this ordering.

insert into storage.buckets (id, name, public)
values
  ('flight-logs', 'flight-logs', false),
  ('flight-logs-sanitized', 'flight-logs-sanitized', false),
  ('media', 'media', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- flight-logs (raw): INVARIANT 3 — the raw object of a gps_private flight is
-- readable ONLY by admins and the flight's owners (creator / pilot / uploader).
-- ---------------------------------------------------------------------------
create policy "raw logs owner or admin read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'flight-logs'
    and (
      app.is_admin()
      or exists (
        select 1
        from public.flight_logs fl
        join public.flights f on f.id = fl.flight_id
        where fl.object_path = storage.objects.name
          and (
            not f.gps_private
            or f.created_by = auth.uid()
            or f.pilot_id = auth.uid()
            or fl.uploaded_by = auth.uid()
          )
      )
    )
  );

create policy "raw logs upload after metadata row" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'flight-logs'
    and (
      app.is_admin()
      or exists (
        select 1 from public.flight_logs fl
        where fl.object_path = storage.objects.name
          and fl.uploaded_by = auth.uid()
      )
    )
  );

create policy "raw logs delete uploader or admin" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'flight-logs'
    and (
      app.is_admin()
      or exists (
        select 1 from public.flight_logs fl
        where fl.object_path = storage.objects.name
          and fl.uploaded_by = auth.uid()
      )
    )
  );

-- ---------------------------------------------------------------------------
-- flight-logs-sanitized: what non-owners get. Written only by the parser via
-- service_role (bypasses RLS) — no authenticated INSERT/UPDATE/DELETE policies.
-- ---------------------------------------------------------------------------
create policy "sanitized logs fleet-readable" on storage.objects
  for select to authenticated
  using (bucket_id = 'flight-logs-sanitized');

-- ---------------------------------------------------------------------------
-- media
-- ---------------------------------------------------------------------------
create policy "media fleet-readable" on storage.objects
  for select to authenticated
  using (bucket_id = 'media');

create policy "media upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'media');

create policy "media delete uploader or admin" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'media'
    and (
      app.is_admin()
      or exists (
        select 1 from public.media m
        where m.object_path = storage.objects.name
          and m.uploaded_by = auth.uid()
      )
    )
  );

-- ---------------------------------------------------------------------------
-- Realtime: UI subscribes to log status flips (uploaded -> parsing -> parsed)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.flight_logs;
    alter publication supabase_realtime add table public.flight_log_summary;
  end if;
end;
$$;
