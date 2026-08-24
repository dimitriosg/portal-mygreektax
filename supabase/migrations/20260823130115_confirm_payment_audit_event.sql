-- confirm_payment: emit activity_events so payment-driven stage moves are auditable.
--
-- Why: recompute_client_stage() already logs job-driven stage changes with
-- via = 'job_sync'. The confirm flow logged nothing, so the deposit gate's only
-- legitimate crossing was the one move the audit trail could not show. Anyone
-- reading the feed saw every illegitimate-looking move and none of the real ones.
--
-- Two rows on an applied confirm, because they are two distinct facts:
--   payment_confirmed   always -- money landed, with amount/kind/token
--   lead_stage_changed  only when the stage actually moved, in the SAME shape
--                       recompute_client_stage uses, so both sources sort and
--                       read identically in one feed
--
-- Deliberately inside the existing transaction rather than best-effort: if the
-- audit write fails the payment write rolls back with it. An audit row that can
-- silently go missing is worse than a confirm that visibly fails and is retried
-- (the Telegram node already retries 3x, and the function is idempotent).
--
-- Nothing else changes. Column qualification is preserved throughout: RETURNS
-- TABLE creates OUT params (amount, deposit, currency, case_code ...) that
-- shadow bare column names and fail at runtime rather than at creation.

create or replace function public.confirm_payment(p_token text)
returns table (
  applied boolean, reason text, payment_id uuid, amount numeric, currency text,
  full_name text, first_name text, email text, case_code text,
  stage_before text, stage_after text, deposit numeric, balance_due numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  t   public.payment_tokens%rowtype;
  c   public.clients%rowtype;
  pid uuid;
  s_before text;
begin
  select * into t from public.payment_tokens where token = btrim(p_token);

  if not found then
    return query select false, 'unknown_token', null::uuid, null::numeric, null::text,
                        null::text, null::text, null::text, null::text, null::text,
                        null::text, null::numeric, null::numeric;
    return;
  end if;

  select * into c from public.clients where id = t.client_id;
  s_before := c.stage;

  if t.paid_at is not null then
    return query select false, 'already_paid', null::uuid, t.amount, t.currency,
                        c.full_name, split_part(coalesce(c.full_name,''),' ',1), c.email,
                        coalesce(t.case_code, c.case_code), s_before, s_before,
                        c.deposit, c.balance_due;
    return;
  end if;

  if t.revoked_at is not null then
    return query select false, 'revoked', null::uuid, t.amount, t.currency,
                        c.full_name, split_part(coalesce(c.full_name,''),' ',1), c.email,
                        coalesce(t.case_code, c.case_code), s_before, s_before,
                        c.deposit, c.balance_due;
    return;
  end if;

  insert into public.payments (external_id, source, amount, currency, received_at,
                               client_id, token, match_confidence, kind, status, confirmed_at)
  values ('manual:' || t.token, 'manual', t.amount, t.currency, now(),
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
                        c.deposit, c.balance_due;
    return;
  end if;

  update public.payment_tokens set paid_at = now() where token = t.token;

  update public.payment_signals
     set resolved_payment_id = pid
   where token = t.token and resolved_payment_id is null;

  -- deposit is the only written fact; balance_due follows via its own trigger.
  -- Stage advances only from Quoted: a payment on an Active or Complete case
  -- is a balance payment, not a gate crossing.
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
    ('payment_confirmed', null, null, 'System — payment confirm',
     coalesce(c.full_name, t.client_id::text),
     jsonb_build_object(
       'leadId',    t.client_id::text,
       'paymentId', pid::text,
       'caseCode',  coalesce(t.case_code, c.case_code),
       'amount',    t.amount,
       'currency',  t.currency,
       'kind',      t.kind,
       'token',     t.token,
       'depositAfter', c.deposit,
       'balanceAfter', c.balance_due,
       'via',       'payment_confirm'));

  -- Audit: the gate crossing, only when one actually happened. Same shape as
  -- recompute_client_stage so both sources read as one feed.
  if c.stage is distinct from s_before then
    insert into public.activity_events
      (event_type, actor_user_id, actor_email, actor_name, subject_label, metadata)
    values
      ('lead_stage_changed', null, null, 'System — payment confirm',
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
                      c.deposit, c.balance_due;
end
$fn$;

-- Postgres grants EXECUTE on a newly created function to PUBLIC. On a SECURITY
-- DEFINER function reachable as a PostgREST RPC that would let anyone holding
-- the anon key confirm payments. CREATE OR REPLACE preserves the existing ACL,
-- but these are restated so a fresh replay of this file lands safe too.
revoke all on function public.confirm_payment(text) from public;
revoke all on function public.confirm_payment(text) from anon, authenticated;
grant execute on function public.confirm_payment(text) to n8n_readonly, service_role;
