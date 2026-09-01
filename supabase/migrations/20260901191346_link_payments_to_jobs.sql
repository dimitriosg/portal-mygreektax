-- 20260901191346_link_payments_to_jobs.sql
--
-- Make a payment know which job it paid for, and mark that job Paid.
--
-- Until now nothing connected money to work. A payment token carried client_id
-- and case_code but never a job, so the database could not answer "was this job
-- paid for". Jobs had no payment concept at all: no paid_at, no payment link,
-- and no Paid status among To Assign / Pending / In Progress / Completed /
-- Cancelled NMF.
--
-- WHY THIS NEEDS NO NEW STAGE LOGIC.
--
-- public.recompute_client_stage already derives clients.stage from job
-- statuses, and its own comment says entry to Active belongs to the deposit
-- gate rather than to the trigger: it returns early while every counted job is
-- still Pending or To Assign. 'Paid' is neither, so a job moving to Paid stops
-- that early return and the existing CASE lands on 'Active'. The rule "job Paid
-- means lead Active" therefore falls out of machinery that already exists. Do
-- not add 'Paid' to that function's v_notstarted count, or a paid job would
-- hold the client out of Active, which is the opposite of the intent.
--
-- WHY THE JOB IS UPDATED BEFORE THE CLIENT IS READ BACK.
--
-- jobs_sync_client_stage fires on the job update and recomputes the client
-- stage inside this same transaction. Updating the job after reading the client
-- would return a stage the trigger then changed, so confirm_payment would
-- report one thing while the database held another, and the Telegram card
-- built from that return would be quietly wrong.
--
-- WHY A PAID JOB CANNOT MOVE BACKWARDS.
--
-- A balance payment can land on a job that is already In Progress or Completed.
-- Setting that to Paid would drag live work back to a pre-work state. So the
-- status only advances out of Pending, To Assign or null, while jobs.paid_at is
-- stamped every time. The money fact is recorded either way; only the work
-- state is protected.
--
-- job_id is nullable on purpose. Every token minted before today has none, a
-- payment may legitimately cover a case rather than one job, and those tokens
-- keep exactly today's behaviour.

-- ---------------------------------------------------------------------------
-- 1. The link, and the money fact on the job
-- ---------------------------------------------------------------------------

alter table public.payment_tokens
  add column if not exists job_id uuid references public.jobs(id) on delete set null;

comment on column public.payment_tokens.job_id is
  'The job this payment request is for, chosen when the link is minted. Null for a case-level payment or for any token minted before 1 Sep 2026. On delete set null: losing a job must never delete the record of money received.';

create index if not exists payment_tokens_job_id_idx
  on public.payment_tokens (job_id)
  where job_id is not null;

alter table public.jobs
  add column if not exists paid_at timestamptz;

comment on column public.jobs.paid_at is
  'When a payment for this job was confirmed. Stamped by confirm_payment even when the status is left alone, so a balance payment on work already In Progress is still recorded.';

-- ---------------------------------------------------------------------------
-- 2. confirm_payment, now job-aware
-- ---------------------------------------------------------------------------

-- Dropped rather than replaced because the RETURNS TABLE shape gains two
-- columns, and `create or replace` cannot change a function's return type.
-- Both signatures are named so the migration is re-runnable either way.
drop function if exists public.confirm_payment(text);
drop function if exists public.confirm_payment(text, text, text);

create or replace function public.confirm_payment(
  p_token       text,
  p_source      text default 'manual',
  p_external_id text default null
)
returns table (
  applied      boolean,
  reason       text,
  payment_id   uuid,
  amount       numeric,
  currency     text,
  full_name    text,
  first_name   text,
  email        text,
  case_code    text,
  stage_before text,
  stage_after  text,
  deposit      numeric,
  balance_due  numeric,
  job_code     text,
  job_status   text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  t   public.payment_tokens%rowtype;
  c   public.clients%rowtype;
  j   public.jobs%rowtype;
  pid uuid;
  s_before text;
  v_external_id text;
begin
  select * into t from public.payment_tokens where token = btrim(p_token);

  if not found then
    return query select false, 'unknown_token', null::uuid, null::numeric, null::text,
                        null::text, null::text, null::text, null::text, null::text,
                        null::text, null::numeric, null::numeric, null::text, null::text;
    return;
  end if;

  select * into c from public.clients where id = t.client_id;
  s_before := c.stage;

  if t.paid_at is not null then
    return query select false, 'already_paid', null::uuid, t.amount, t.currency,
                        c.full_name, split_part(coalesce(c.full_name,''),' ',1), c.email,
                        coalesce(t.case_code, c.case_code), s_before, s_before,
                        c.deposit, c.balance_due, null::text, null::text;
    return;
  end if;

  if t.revoked_at is not null then
    return query select false, 'revoked', null::uuid, t.amount, t.currency,
                        c.full_name, split_part(coalesce(c.full_name,''),' ',1), c.email,
                        coalesce(t.case_code, c.case_code), s_before, s_before,
                        c.deposit, c.balance_due, null::text, null::text;
    return;
  end if;

  -- Falling back to the old value rather than to the token alone keeps every
  -- existing row's format intact and keeps a manual confirm idempotent against
  -- rows written before the source column meant anything.
  v_external_id := coalesce(nullif(btrim(p_external_id), ''), 'manual:' || t.token);

  insert into public.payments (external_id, source, amount, currency, received_at,
                               client_id, token, match_confidence, kind, status, confirmed_at)
  values (v_external_id, p_source, t.amount, t.currency, now(),
          t.client_id, t.token, 'exact', t.kind, 'confirmed', now())
  on conflict (external_id) do nothing
  returning id into pid;

  if pid is null then
    -- a payment row already exists for this token; treat as already handled
    update public.payment_tokens set paid_at = coalesce(paid_at, now()) where token = t.token;
    select * into c from public.clients where id = t.client_id;
    return query select false, 'already_paid', null::uuid, t.amount, t.currency,
                        c.full_name, split_part(coalesce(c.full_name,''),' ',1), c.email,
                        coalesce(t.case_code, c.case_code), s_before, c.stage,
                        c.deposit, c.balance_due, null::text, null::text;
    return;
  end if;

  update public.payment_tokens set paid_at = now() where token = t.token;

  update public.payment_signals
     set resolved_payment_id = pid
   where token = t.token and resolved_payment_id is null;

  -- The job goes FIRST. jobs_sync_client_stage recomputes clients.stage from
  -- job statuses inside this transaction, so any client read taken before this
  -- would be stale by the time the function returns. See the header.
  if t.job_id is not null then
    update public.jobs
       set paid_at = coalesce(public.jobs.paid_at, now()),
           status  = case
                       when public.jobs.status is null
                         or public.jobs.status in ('Pending', 'To Assign')
                       then 'Paid'
                       else public.jobs.status
                     end
     where public.jobs.id = t.job_id
    returning * into j;
  end if;

  -- deposit is the only written fact; balance_due follows via its own trigger.
  -- The Quoted to Active move stays here for tokens with no job, which is every
  -- token minted before today. With a job, the trigger above has usually done
  -- it already and this is a harmless no-op.
  -- columns qualified: RETURNS TABLE creates OUT params that shadow bare
  -- column names (deposit, balance_due, amount...). Unqualified they are
  -- ambiguous and the function errors at runtime, not at creation.
  update public.clients
     set deposit = coalesce(public.clients.deposit, 0) + t.amount,
         stage   = case when public.clients.stage = 'Quoted' then 'Active'
                        else public.clients.stage end
   where public.clients.id = t.client_id
  returning * into c;

  -- Audit: the money itself. Always, including balance payments that move no stage.
  insert into public.activity_events
    (event_type, actor_user_id, actor_email, actor_name, subject_label, metadata)
  values
    ('payment_confirmed', null, null,
     case when p_source = 'manual' then 'System — payment confirm'
          else 'System — payment confirm (' || p_source || ')' end,
     coalesce(c.full_name, t.client_id::text),
     jsonb_build_object(
       'leadId',    t.client_id::text,
       'paymentId', pid::text,
       'caseCode',  coalesce(t.case_code, c.case_code),
       'amount',    t.amount,
       'currency',  t.currency,
       'kind',      t.kind,
       'token',     t.token,
       'source',     p_source,
       'externalId', v_external_id,
       'jobId',      t.job_id::text,
       'jobCode',    j.job_code,
       'jobStatus',  j.status,
       'depositAfter', c.deposit,
       'balanceAfter', c.balance_due,
       'via',       'payment_confirm'));

  -- Audit: the gate crossing, only when one actually happened. Same shape as
  -- recompute_client_stage so both sources read as one feed.
  if c.stage is distinct from s_before then
    insert into public.activity_events
      (event_type, actor_user_id, actor_email, actor_name, subject_label, metadata)
    values
      ('lead_stage_changed', null, null,
       case when p_source = 'manual' then 'System — payment confirm'
            else 'System — payment confirm (' || p_source || ')' end,
       coalesce(c.full_name, t.client_id::text),
       jsonb_build_object(
         'leadId', t.client_id::text,
         'field',  'Stage',
         'from',   s_before,
         'to',     c.stage,
         'via',    'payment_confirm'));
  end if;

  return query select true, 'confirmed', pid, t.amount, t.currency,
                      c.full_name, split_part(coalesce(c.full_name,''),' ',1), c.email,
                      coalesce(t.case_code, c.case_code), s_before, c.stage,
                      c.deposit, c.balance_due, j.job_code, j.status;
end
$fn$;

comment on function public.confirm_payment(text, text, text) is
  'Records a payment against a payment token in one transaction: writes payments, stamps paid_at, resolves the signal, marks the linked job Paid, adds to clients.deposit and moves Quoted to Active. Idempotent. p_source and p_external_id default to the manual values so existing callers are unaffected.';

-- ---------------------------------------------------------------------------
-- 3. Restore grants
-- ---------------------------------------------------------------------------

-- Dropping a function drops its grants with it. n8n_readonly is the role behind
-- the n8n Postgres credential; it has EXECUTE here and no write grant on
-- clients, jobs or payments, which is the entire point of SECURITY DEFINER.
grant execute on function public.confirm_payment(text, text, text) to n8n_readonly;
grant execute on function public.confirm_payment(text, text, text) to service_role;

notify pgrst, 'reload schema';
