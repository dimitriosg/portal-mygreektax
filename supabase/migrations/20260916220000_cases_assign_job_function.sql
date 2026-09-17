-- Filing a job under a case, and its audit row, in ONE transaction.
--
-- This replaces a two-step write from the server function: update jobs, then
-- insert into activity_events. Two PostgREST calls cannot be made atomic from
-- the application, and no ordering fixes it -- audit-first leaves an audit row
-- for an update that then failed, audit-second leaves a filed job with no
-- audit row. Worse, retrying the second case found the job already filed and
-- returned "unchanged", so the missing audit row was never repaired.
--
-- "Every manual job assignment is auditable: who, when, from case, to case"
-- is a stated rule of this system, so it needs to hold structurally rather
-- than by luck. Inside one plpgsql function both writes commit together or
-- neither does.
--
-- The reason is OPTIONAL. It was required at first, and that was wrong: it put
-- friction on every single move, and who/when/from/to already answers "was this
-- deliberate and by whom". A reason adds colour when there is colour to add;
-- demanding one for an obvious filing just trains people to type "x".
--
-- Cross-client assignment is still refused by the composite foreign key
-- jobs (case_id, client_id) -> brain_conversations (id, client_id); the
-- explicit check here exists only to raise a sentence a person can act on
-- instead of a bare 23503.

create or replace function public.assign_job_to_case(
  p_job_id         uuid,
  p_case_id        uuid,
  p_reason         text,
  p_actor_user_id  uuid default null,
  p_actor_email    text default null
)
returns table (
  out_job_id            uuid,
  out_case_id           uuid,
  out_from_case_id      uuid,
  out_to_case_serial_id text,
  out_unchanged         boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_job       public.jobs%rowtype;
  v_case      public.brain_conversations%rowtype;
  v_from_case public.brain_conversations%rowtype;
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  -- FOR UPDATE, and it is load-bearing for the audit trail rather than for the
  -- write. Without it two concurrent filings of the same job both read the old
  -- case_id; Postgres serialises the UPDATEs, but the second caller still holds
  -- its stale local row and logs the wrong "from" case:
  --
  --   A reads J unfiled, B reads J unfiled
  --   A files J into CS001, logs null -> CS001
  --   B files J into CS002, logs null -> CS002   <- should be CS001 -> CS002
  --
  -- Locking the row makes the second caller wait and then read the assignment
  -- that actually precedes its own. "From case" is half of what makes an
  -- assignment auditable, so a plausible-looking wrong value is worse than an
  -- error.
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job % not found', p_job_id;
  end if;

  if p_case_id is not null then
    select * into v_case from public.brain_conversations where id = p_case_id;
    if not found then
      raise exception 'Case % not found', p_case_id;
    end if;
    if v_case.client_id is distinct from v_job.client_id then
      raise exception 'That case belongs to a different client';
    end if;
    if v_case.archived_at is not null then
      raise exception 'That case is archived';
    end if;
  end if;

  -- Nothing to do, and nothing to log: the job is already where it is being
  -- sent. Reported so the caller can say so rather than claiming a change.
  if v_job.case_id is not distinct from p_case_id then
    return query select v_job.id, v_job.case_id, v_job.case_id,
                        v_case.case_serial_id, true;
    return;
  end if;

  if v_job.case_id is not null then
    select * into v_from_case from public.brain_conversations where id = v_job.case_id;
  end if;

  update public.jobs set case_id = p_case_id where id = p_job_id;

  insert into public.activity_events
    (event_type, actor_user_id, actor_email, subject_label, metadata)
  values
    ('job_case_assigned',
     p_actor_user_id,
     nullif(btrim(lower(coalesce(p_actor_email, ''))), ''),
     coalesce(v_job.job_code, v_job.id::text),
     jsonb_build_object(
       'leadId',           v_job.client_id::text,
       'jobId',            v_job.id::text,
       'jobCode',          v_job.job_code,
       'fromCaseId',       v_job.case_id,
       'fromCaseSerialId', v_from_case.case_serial_id,
       'toCaseId',         p_case_id,
       'toCaseSerialId',   v_case.case_serial_id,
       'reason',           v_reason
     ));

  return query select v_job.id, p_case_id, v_job.case_id,
                      v_case.case_serial_id, false;
end;
$function$;

comment on function public.assign_job_to_case(uuid, uuid, text, uuid, text) is
  'Files a job under a case (or unfiles it with a null case) and writes the '
  'job_case_assigned audit row in the same transaction, so an assignment can '
  'never exist without its audit entry. The reason is optional.';

-- Same ACL discipline as the rest of this work: PostgreSQL grants EXECUTE to
-- PUBLIC by default, and Supabase's default privileges additionally grant anon
-- and authenticated explicitly. Both must be revoked, or this SECURITY DEFINER
-- function is callable through PostgREST with only the publishable key.
revoke all on function public.assign_job_to_case(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.assign_job_to_case(uuid, uuid, text, uuid, text)
  to service_role;

notify pgrst, 'reload schema';
