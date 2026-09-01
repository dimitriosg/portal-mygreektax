-- 20260901144249_confirm_payment_source_and_external_id.sql
--
-- Teach public.confirm_payment where a payment came from.
--
-- Until now the function hardcoded the insert into public.payments:
--
--     values ('manual:' || t.token, 'manual', ...)
--
-- That was true when a human tapping Telegram was the only way a payment was
-- ever recorded. Stripe changes it. Every one of the five payments in the table
-- today carries source = 'manual' and external_id = 'manual:<token>', so the
-- source column currently distinguishes nothing, and a card payment written
-- through the same path would be indistinguishable from one Jim confirmed by
-- hand. Worse, the Stripe payment intent would be recorded nowhere, leaving
-- nothing in the database to reconcile a Stripe payout against.
--
-- WHY THE OLD SIGNATURE IS DROPPED EXPLICITLY.
--
-- `create or replace function` matches on name AND argument list, so replacing
-- confirm_payment(text) with confirm_payment(text, text, text) does not replace
-- anything: it creates a SECOND function alongside the first, and Postgres then
-- chooses between them by call shape. That is exactly the failure already in
-- this project's history, two overloads of resolve_case_for_inbound, one of
-- which silently bypassed deduplication.
--
-- So the one-argument signature is dropped by name first. The new three-argument
-- one is then written with `create or replace`, which is about re-runnability
-- rather than overloads: on a second run the drop matches nothing and a bare
-- `create` would fail. Two different concerns, one line each.
--
-- BEHAVIOUR IS UNCHANGED FOR EXISTING CALLERS.
--
-- Both new parameters have defaults matching the old hardcoded values, so
-- n8n workflow "63 · Payment confirm" keeps calling
--
--     select * from public.confirm_payment($1);
--
-- and gets byte-identical results. No n8n change is required by this
-- migration.
--
-- DOUBLE PAYMENT PROTECTION IS UNAFFECTED.
--
-- Two guards exist and neither depends on the external_id format. The first is
-- the `t.paid_at is not null` check near the top, which returns already_paid
-- before any insert is attempted, whatever the source. The second is the
-- unique index payments_external_id_key, which turns a repeated Stripe webhook
-- delivery (same payment intent, same external_id) into a no-op. A token
-- confirmed by hand and then hit by a Stripe webhook is caught by the first
-- guard, not the second, which is why the first has to stay where it is.
--
-- payments_source_check already allows 'stripe' alongside 'poll', 'manual' and
-- 'tasker', so no constraint change is needed. A source outside that list will
-- raise a constraint violation, which is the correct loud failure.

-- ---------------------------------------------------------------------------
-- 1. Drop the single existing signature
-- ---------------------------------------------------------------------------

-- Verified before writing this: pg_proc holds exactly one confirm_payment,
-- confirm_payment(text). If that ever stops being true, this drop is too
-- narrow and the migration must be revisited rather than widened blindly.
drop function if exists public.confirm_payment(text);

-- ---------------------------------------------------------------------------
-- 2. Recreate with source and external reference
-- ---------------------------------------------------------------------------

-- `create or replace` rather than a bare `create`, so re-running this file is a
-- no-op instead of an error. The drop above only removes the OLD one-argument
-- signature; on a second run it matches nothing, and a bare `create` then fails
-- with "function already exists with same argument types". Migrations get
-- re-run more often than anyone plans for.
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
  balance_due  numeric
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
  v_external_id text;
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

  -- The only new logic in the whole function. Falling back to the old value
  -- rather than to the token alone keeps every existing row's format intact
  -- and keeps a manual confirm idempotent against rows written before today.
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
                      c.deposit, c.balance_due;
end
$fn$;

comment on function public.confirm_payment(text, text, text) is
  'Records a payment against a payment token in one transaction: writes payments, stamps paid_at, resolves the signal, adds to clients.deposit and moves Quoted to Active. Idempotent. p_source and p_external_id default to the manual values so existing callers are unaffected; the Stripe webhook passes ''stripe'' and ''stripe:<payment_intent>'' so payouts can be reconciled.';

-- ---------------------------------------------------------------------------
-- 3. Restore grants
-- ---------------------------------------------------------------------------

-- Dropping a function drops its grants with it. n8n_readonly is the role the
-- n8n Postgres credential uses; it has EXECUTE here and no write grant on
-- clients or payments at all, which is the entire point of the function being
-- SECURITY DEFINER.
grant execute on function public.confirm_payment(text, text, text) to n8n_readonly;
grant execute on function public.confirm_payment(text, text, text) to service_role;

notify pgrst, 'reload schema';
