-- Cases P6 (part one): a case has its own stage.
--
-- Until now brain_conversations.stage was a copy. clients_sync_stage_to_conversations
-- stamped the client's stage onto EVERY non-archived case of that client on any
-- stage change, so two cases could never disagree and the badge on a case meant
-- nothing case-specific. Any difference visible today is an accident of timing:
-- open_case() creates a case as 'Potential' and the trigger has not fired since.
--
-- This migration makes the case stage real:
--
--   * recompute_case_stage(case_id) computes a case's stage from ITS OWN jobs,
--     mirroring recompute_client_stage's rules so the two cannot disagree about
--     what "Active" means.
--   * the jobs trigger recomputes the job's case as well as its client, and now
--     also fires when a job is filed or moved (case_id joins the UPDATE OF list).
--   * clients_sync_stage_to_conversations is DROPPED. It is the direct enforcer
--     of one-stage-per-client and nothing else can be true while it exists.
--   * a case stage set by a person is no longer overwritten, so the pipeline can
--     offer a per-case control.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- clients.stage is NOT yet derived from the cases, and the deposit gate is NOT
-- yet moved to the case. Both were in the plan for this phase and both are held
-- back on evidence: of 38 clients that have jobs, only 2 have filed any of them,
-- and 3 of 21 live cases have jobs. Deriving the client headline from cases
-- today would compute 36 of those 38 clients' stage from cases containing no
-- jobs, taking the /leads board, the Morning digest and the cadence logic with
-- it. clients.stage therefore keeps its current behaviour exactly -- computed by
-- recompute_client_stage from ALL of a client's jobs, filed or not -- and the
-- switch happens in a later migration once triage has emptied.
--
-- The consequence, stated rather than discovered: for a while a client and its
-- cases can show different stages. That is the point. The client headline is
-- "where is this customer overall", the case stage is "where is this piece of
-- work", and they genuinely differ when a customer has one case delivered and
-- another just quoted.

-- ---------------------------------------------------------------------------
-- 1. A case's stage, from its own jobs.
--
-- Same rules as recompute_client_stage, scoped to one case:
--   no counted jobs            -> leave alone, the stage is managed by hand
--   every job still not started-> leave alone; entry to Active belongs to the
--                                 deposit gate, not to a trigger. Without this,
--                                 minting a quote would promote an unpaid case.
--   some work started          -> Active
--   all delivered/invoiced/completed, not all completed -> Delivered
--   all completed              -> Complete
create or replace function public.recompute_case_stage(p_case_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_case       public.brain_conversations%rowtype;
  v_total      int;
  v_completed  int;
  v_settled    int;
  v_notstarted int;
  v_new        text;
begin
  if p_case_id is null then
    return;
  end if;

  -- Lock first, so two job writes against the same case serialise instead of
  -- each aggregating a stale snapshot. Same reasoning as the client version.
  select * into v_case from public.brain_conversations where id = p_case_id for update;
  if not found then
    return;  -- case deleted or purged mid-write
  end if;

  -- An archived case is closed to writes. It is reachable: file a job under a
  -- case, archive the case, then change that job's status, and without this
  -- guard the trigger would move an archived case's stage and write history
  -- against it. Everything else that touches a case already refuses when
  -- archived_at is set -- assign_job_to_case, set_case_stage -- so this is the
  -- same rule applied to the one path that is not a person's action.
  if v_case.archived_at is not null then
    return;
  end if;

  select count(*),
         count(*) filter (where status = 'Completed'),
         count(*) filter (where status in ('Delivered', 'Invoiced', 'Completed')),
         count(*) filter (where status in ('Pending', 'To Assign'))
    into v_total, v_completed, v_settled, v_notstarted
    from public.jobs
   where case_id = p_case_id
     and status is distinct from 'Cancelled / NMF';

  if v_total = 0 then
    return;  -- nothing filed here yet: stage stays as a person left it
  end if;

  if v_notstarted = v_total then
    return;  -- quoted, not started
  end if;

  v_new := case
    when v_settled < v_total then 'Active'
    when v_completed = v_total then 'Complete'
    else 'Delivered'
  end;

  if v_new is distinct from v_case.stage then
    update public.brain_conversations set stage = v_new where id = p_case_id;

    insert into public.activity_events
      (event_type, actor_name, subject_label, metadata)
    values
      ('case_stage_changed', 'System - job sync',
       coalesce(v_case.case_serial_id, p_case_id::text),
       jsonb_build_object(
         'leadId',       v_case.client_id::text,
         'caseId',       p_case_id::text,
         'caseSerialId', v_case.case_serial_id,
         'field',        'Stage',
         'from',         v_case.stage,
         'to',           v_new,
         'via',          'job_sync'));
  end if;
end;
$function$;

comment on function public.recompute_case_stage(uuid) is
  'Recomputes one case''s stage from the jobs filed under it, by the same rules '
  'recompute_client_stage applies to a client. Leaves the stage alone when the '
  'case has no jobs or none have started, so a person''s setting survives.';

revoke all on function public.recompute_case_stage(uuid) from public, anon, authenticated;
grant execute on function public.recompute_case_stage(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 1b. Setting a case's stage by hand, and its audit row, in ONE transaction.
--
-- Same argument as assign_job_to_case, and the same shape. The first version of
-- this lived in the server function as read -> update -> log through three
-- PostgREST calls, which has two defects that no ordering fixes:
--
--   * logActivityEvent is best-effort and swallows its error, so a failed audit
--     insert leaves the stage changed with nothing in the history. "Every stage
--     change is auditable" then holds by luck.
--   * nothing locks the case between the read and the update. A job write can
--     run recompute_case_stage in that window, and the manual update then
--     overwrites a job-derived stage while logging a 'from' value that was
--     already stale -- a plausible-looking wrong audit row, which is worse than
--     an error.
--
-- Taking the same row lock recompute_case_stage takes serialises the two
-- against each other. A later job change may still move the stage again; that
-- is intended, and it is logged as via=job_sync so the two are told apart.
create or replace function public.set_case_stage(
  p_case_id        uuid,
  p_stage          text,
  p_actor_user_id  uuid default null,
  p_actor_email    text default null
)
returns table (
  out_case_id        uuid,
  out_case_serial_id text,
  out_from_stage     text,
  out_to_stage       text,
  out_unchanged      boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_case public.brain_conversations%rowtype;
begin
  select * into v_case from public.brain_conversations where id = p_case_id for update;
  if not found then
    raise exception 'Case % not found', p_case_id;
  end if;
  if v_case.archived_at is not null then
    raise exception 'That case is archived';
  end if;

  -- Already there: nothing to do and nothing to log, reported so the caller can
  -- say so rather than claiming a change.
  if v_case.stage is not distinct from p_stage then
    return query select v_case.id, v_case.case_serial_id, v_case.stage, v_case.stage, true;
    return;
  end if;

  update public.brain_conversations set stage = p_stage where id = p_case_id;

  insert into public.activity_events
    (event_type, actor_user_id, actor_email, subject_label, metadata)
  values
    ('case_stage_changed',
     p_actor_user_id,
     nullif(btrim(lower(coalesce(p_actor_email, ''))), ''),
     coalesce(v_case.case_serial_id, v_case.id::text),
     jsonb_build_object(
       'leadId',       v_case.client_id::text,
       'caseId',       v_case.id::text,
       'caseSerialId', v_case.case_serial_id,
       'field',        'Stage',
       'from',         v_case.stage,
       'to',           p_stage,
       'via',          'manual'));

  return query select v_case.id, v_case.case_serial_id, v_case.stage, p_stage, false;
end;
$function$;

comment on function public.set_case_stage(uuid, text, uuid, text) is
  'Sets a case''s stage by hand and writes the case_stage_changed audit row in '
  'the same transaction, taking the same row lock recompute_case_stage takes so '
  'a manual change and a job-derived one cannot interleave. The stage vocabulary '
  'is validated by the caller (CLIENT_STAGES in src/lib/leads-shared.ts); this '
  'function is reachable only by service_role.';

revoke all on function public.set_case_stage(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_case_stage(uuid, text, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. The jobs trigger recomputes the case as well as the client.
--
-- recompute_client_stage is untouched and still runs, because clients.stage
-- keeps its current meaning for now (see the header).
create or replace function public.trg_jobs_sync_client_stage()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if tg_op = 'DELETE' then
    perform public.recompute_client_stage(old.client_id);
    perform public.recompute_case_stage(old.case_id);
    return old;
  end if;

  -- A job re-linked to a different client must recompute both clients.
  -- recompute_client_stage locks the client row, so when two rows are
  -- involved always lock in ascending id order to avoid deadlocks between
  -- concurrent relinks crossing the same pair.
  if tg_op = 'UPDATE' and old.client_id is distinct from new.client_id then
    if old.client_id is null then
      perform public.recompute_client_stage(new.client_id);
    elsif new.client_id is null then
      perform public.recompute_client_stage(old.client_id);
    elsif old.client_id < new.client_id then
      perform public.recompute_client_stage(old.client_id);
      perform public.recompute_client_stage(new.client_id);
    else
      perform public.recompute_client_stage(new.client_id);
      perform public.recompute_client_stage(old.client_id);
    end if;
  else
    perform public.recompute_client_stage(new.client_id);
  end if;

  -- The same care for cases: filing or moving a job changes two of them, and
  -- recompute_case_stage takes a row lock, so order the pair by id.
  if tg_op = 'UPDATE' and old.case_id is distinct from new.case_id then
    if old.case_id is null then
      perform public.recompute_case_stage(new.case_id);
    elsif new.case_id is null then
      perform public.recompute_case_stage(old.case_id);
    elsif old.case_id < new.case_id then
      perform public.recompute_case_stage(old.case_id);
      perform public.recompute_case_stage(new.case_id);
    else
      perform public.recompute_case_stage(new.case_id);
      perform public.recompute_case_stage(old.case_id);
    end if;
  else
    perform public.recompute_case_stage(new.case_id);
  end if;

  return new;
end;
$function$;

-- case_id joins the column list, so filing or moving a job recomputes the
-- cases it left and joined. Without this the trigger would only fire on a
-- status change and a freshly filed job would not move its case.
drop trigger if exists jobs_sync_client_stage on public.jobs;
create trigger jobs_sync_client_stage
  after insert or delete or update of status, client_id, case_id
  on public.jobs
  for each row execute function public.trg_jobs_sync_client_stage();

-- ---------------------------------------------------------------------------
-- 3. Stop stamping the client's stage onto every case.
--
-- This is the change that makes everything above mean something. While this
-- trigger exists, two cases of one client can never disagree, and any per-case
-- control a person uses is overwritten the next time the client's stage moves.
drop trigger if exists clients_sync_stage_to_conversations on public.clients;
drop function if exists public.sync_client_stage_to_conversations();

-- ---------------------------------------------------------------------------
-- 4. Seed the cases that already have jobs.
--
-- Every live case currently carries a stage copied from its client. For the
-- handful with jobs filed under them that copy may now be wrong, so recompute
-- them once from their own jobs. Cases with no jobs are left exactly as they
-- are: their copied stage is a reasonable starting point and a person can
-- change it.
do $$
declare r record;
begin
  for r in
    select distinct case_id from public.jobs where case_id is not null
  loop
    perform public.recompute_case_stage(r.case_id);
  end loop;
end $$;

notify pgrst, 'reload schema';
