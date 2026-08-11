-- Red-team remediation: RISK-REGISTER F1 (blocker), F2, F3 (major).
-- Applied 2026-08-10 evening, after the P0 run's red-team pass — the run
-- pipeline had no remediation round (see RUN-RESULT.md), so these landed as
-- a follow-up migration. Attack commands from docs/RISK-REGISTER.md re-run
-- against these policies; RLS matrix extended in tests/rls/.

-- ---------------------------------------------------------------------------
-- F1 (BLOCKER): sites SELECT was `using (true)` — private site coordinates
-- were readable by any authenticated user, and because flights are
-- fleet-visible with a site_id, the takeoff location of a gps_private flight
-- resolved through its site row. Site rows now follow sites.visibility.
-- UI consequence (accepted): a non-owner viewing a flight at someone's
-- private site sees no site row (name renders as unknown); site pickers list
-- your own sites + public ones.
-- ---------------------------------------------------------------------------
drop policy "sites fleet-visible" on public.sites;

create policy "sites visible by visibility" on public.sites
  for select to authenticated
  using (
    visibility = 'public'
    or created_by = auth.uid()
    or app.is_admin()
  );

-- ---------------------------------------------------------------------------
-- F3 (MAJOR): public.media INSERT only checked uploaded_by = auth.uid() —
-- media rows could be attached to records the uploader cannot write (forged
-- "evidence" on someone else's aircraft/flight/issue). Attachment now
-- requires write access to the owning record, mirroring each owner table's
-- own write policy.
-- ---------------------------------------------------------------------------
create or replace function app.can_attach_media(p_table text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select app.is_admin() or case p_table
    when 'aircraft'         then app.can_write_aircraft_data(p_id)
    when 'flights'          then app.can_write_flight(p_id)
    when 'components'       then exists (select 1 from public.components c
                                         where c.id = p_id
                                           and c.created_by = auth.uid())
    when 'component_events' then exists (select 1 from public.component_events e
                                         where e.id = p_id
                                           and app.can_write_aircraft_data(e.aircraft_id))
    when 'airframe_events'  then exists (select 1 from public.airframe_events e
                                         where e.id = p_id
                                           and app.can_write_aircraft_data(e.aircraft_id))
    when 'issues'           then exists (select 1 from public.issues i
                                         where i.id = p_id
                                           and app.can_write_aircraft_data(i.aircraft_id))
    when 'sites'            then exists (select 1 from public.sites s
                                         where s.id = p_id
                                           and s.created_by = auth.uid())
    when 'user_profiles'    then p_id = auth.uid()
    else false
  end;
$$;

drop policy "attach media" on public.media;

create policy "attach media to writable records" on public.media
  for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and app.can_attach_media(owner_table, owner_id)
  );

-- ---------------------------------------------------------------------------
-- F2 (MAJOR): the media bucket INSERT policy checked only
-- bucket_id = 'media' — any authenticated user could PUT objects at any
-- path, including a victim's. Row-first contract now, same as flight-logs:
-- the public.media row (gated by the F3 policy above) must exist and be
-- yours before the object PUT at that exact path.
-- ---------------------------------------------------------------------------
drop policy "media upload" on storage.objects;

create policy "media upload row-first" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media'
    and exists (
      select 1 from public.media m
      where m.object_path = storage.objects.name
        and m.uploaded_by = auth.uid()
    )
  );
