-- Flight Tracking v2 — audit trail (RLS invariant 5; study §3.5 step 1)
-- Generic trigger feeds audit_log on INSERT/UPDATE/DELETE of the core tables.
-- audit_log itself is append-only: no UPDATE/DELETE, ever.

create or replace function public.tg_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row_id text;
  v_diff jsonb;
begin
  if tg_op = 'INSERT' then
    v_row_id := to_jsonb(new) ->> 'id';
    v_diff := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    v_row_id := coalesce(to_jsonb(new) ->> 'id', to_jsonb(old) ->> 'id');
    v_diff := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
  else
    v_row_id := to_jsonb(old) ->> 'id';
    v_diff := to_jsonb(old);
  end if;

  insert into public.audit_log (table_name, row_id, action, actor, diff)
  values (tg_table_name, v_row_id, tg_op::public.audit_action, auth.uid(), v_diff);

  return coalesce(new, old);
end;
$$;

-- Attach to the core tables. Deliberately NOT audited: flight_log_summary,
-- flight_log_series, param_snapshots (bulk derived parser output, rewritten on
-- re-parse — auditing them would bloat the log with machine writes) and
-- audit_log itself.
do $$
declare
  t text;
begin
  foreach t in array array[
    'user_profiles', 'sites', 'aircraft_types', 'aircraft', 'aircraft_operators',
    'components', 'component_events', 'tags', 'attachments_catalog', 'flights',
    'flight_payloads', 'flight_tags', 'flight_notes', 'airframe_events',
    'issues', 'flight_logs', 'media', 'exports'
  ]
  loop
    execute format(
      'create trigger audit_row after insert or update or delete on public.%I
         for each row execute function public.tg_audit()',
      t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Immutability: audit_log rejects UPDATE/DELETE for every role (trigger fires
-- even for table owner / service_role), plus privilege revokes + RLS.
-- ---------------------------------------------------------------------------
create or replace function public.tg_audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only: % rejected', tg_op;
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function public.tg_audit_log_immutable();

-- Truncate would bypass row triggers; block it too.
create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.tg_audit_log_immutable();

revoke update, delete, truncate on public.audit_log from anon, authenticated, service_role;

alter table public.audit_log enable row level security;

-- Admins can read the trail; nobody INSERTs directly (the SECURITY DEFINER
-- trigger function runs as table owner and bypasses RLS). No UPDATE/DELETE
-- policies exist, so RLS denies them independently of the guard trigger.
create policy "admin read audit log" on public.audit_log
  for select to authenticated using (app.is_admin());
