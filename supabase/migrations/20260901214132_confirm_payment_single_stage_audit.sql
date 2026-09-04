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
  s_pre_update text;
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

  v_external_id := coalesce(nullif(btrim(p_external_id), ''), 'manual:' || t.token);

  insert into public.payments (external_id, source, amount, currency, received_at,
                               client_id, token, match_confidence, kind, status, confirmed_at)
  values (v_external_id, p_source, t.amount, t.currency, now(),
          t.client_id, t.token, 'exact', t.kind, 'confirmed', now())
  on conflict (external_id) do nothing
  returning id into pid;

  if pid is null then
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

  -- Job first: its trigger recomputes clients.stage inside this transaction
  -- and writes its own lead_stage_changed row when it moves the lead.
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

  -- The stage as it stands now, after any trigger has had its say. The audit
  -- below compares against this, not s_before, so a move the trigger already
  -- logged is not logged a second time here.
  select public.clients.stage into s_pre_update
    from public.clients where public.clients.id = t.client_id;

  update public.clients
     set deposit = coalesce(public.clients.deposit, 0) + t.amount,
         stage   = case when public.clients.stage = 'Quoted' then 'Active'
                        else public.clients.stage end
   where public.clients.id = t.client_id
  returning * into c;

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

  -- Only a move made by the update directly above. On the job-linked path the
  -- trigger has usually already moved the lead and logged it, and this is a
  -- no-op; on the legacy no-job path this is the only logger.
  if c.stage is distinct from s_pre_update then
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
         'from',   s_pre_update,
         'to',     c.stage,
         'via',    'payment_confirm'));
  end if;

  -- stage_before stays the true original, so the caller can still say what the
  -- payment changed overall.
  return query select true, 'confirmed', pid, t.amount, t.currency,
                      c.full_name, split_part(coalesce(c.full_name,''),' ',1), c.email,
                      coalesce(t.case_code, c.case_code), s_before, c.stage,
                      c.deposit, c.balance_due, j.job_code, j.status;
end
$fn$;

notify pgrst, 'reload schema';
