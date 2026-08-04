-- One-way sync: jobs -> clients.stage, "least-finished job wins".
--
-- Rules (agreed 04 Aug 2026):
--   * Jobs with status 'Cancelled / NMF' are excluded from the aggregation.
--   * Any counted job not yet Delivered/Invoiced/Completed  -> stage 'Active'.
--     Unknown or legacy statuses (e.g. old free-text values) count as open,
--     so the least-finished interpretation always wins.
--   * All counted jobs Completed                             -> stage 'Complete'.
--   * All counted jobs Delivered/Invoiced/Completed (mixed)  -> stage 'Delivered'.
--   * A client with no counted jobs keeps a manually managed stage
--     (Potential / Quoted / Parked / Lost are never touched by this sync).
--   * Manual kanban stage changes stand until the next job write recomputes;
--     the sync never fights the user in real time.
--   * System-driven transitions bypass the manual Quoted->Active deposit gate
--     in updateLead by design: creating a real job implies the deposit is in.
--
-- The stage write is audited as a normal lead_stage_changed activity_events
-- row (metadata.via = 'job_sync') so it shows on the lead timeline exactly
-- like a manual change.

create or replace function public.recompute_client_stage(p_client_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $$
declare
  v_client public.clients%rowtype;
  v_total int;
  v_completed int;
  v_settled int;
  v_new text;
begin
  if p_client_id is null then
    return;
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    return;  -- client mid-deletion: nothing to sync
  end if;

  select count(*),
         count(*) filter (where status = 'Completed'),
         count(*) filter (where status in ('Delivered', 'Invoiced', 'Completed'))
    into v_total, v_completed, v_settled
    from public.jobs
   where client_id = p_client_id
     and status is distinct from 'Cancelled / NMF';

  if v_total = 0 then
    return;  -- no counted jobs: stage stays manually managed
  end if;

  v_new := case
    when v_settled < v_total then 'Active'
    when v_completed = v_total then 'Complete'
    else 'Delivered'
  end;

  if v_new is distinct from v_client.stage then
    update public.clients set stage = v_new where id = p_client_id;

    insert into public.activity_events
      (event_type, actor_user_id, actor_email, actor_name, subject_label, metadata)
    values
      ('lead_stage_changed', null, null, 'System — job sync',
       coalesce(v_client.full_name, p_client_id::text),
       jsonb_build_object(
         'leadId', p_client_id::text,
         'field', 'Stage',
         'from', v_client.stage,
         'to', v_new,
         'via', 'job_sync'));
  end if;
end;
$$;

create or replace function public.trg_jobs_sync_client_stage()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_client_stage(old.client_id);
    return old;
  end if;

  perform public.recompute_client_stage(new.client_id);

  -- A job re-linked to a different client must also recompute the old one.
  if tg_op = 'UPDATE' and old.client_id is distinct from new.client_id then
    perform public.recompute_client_stage(old.client_id);
  end if;

  return new;
end;
$$;

drop trigger if exists jobs_sync_client_stage on public.jobs;
create trigger jobs_sync_client_stage
  after insert or delete or update of status, client_id on public.jobs
  for each row execute function public.trg_jobs_sync_client_stage();

notify pgrst, 'reload schema';
