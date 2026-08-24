-- correct_payment: fix the amount on an already-confirmed payment.
--
-- Why: confirm_payment always books payment_tokens.amount verbatim. If the
-- token was minted for the wrong figure, or the client actually sent a
-- different amount than the link asked for, there was previously no way to
-- correct it short of hand-editing payments and clients directly in the SQL
-- editor -- exactly the kind of unaudited drift this project has spent
-- slice 2 eliminating (see recompute_client_stage's deposit-gate guard and
-- confirm_payment's own audit rows).
--
-- Scope, deliberately: amount only. Does not touch clients.stage. A
-- correction that would change whether a case should have crossed Quoted
-- -> Active is left for a human to re-evaluate by hand -- auto-reversing a
-- stage from a later correction is a real decision, not an obvious one,
-- and this function does not make it silently.
--
-- Same shape as confirm_payment: SECURITY DEFINER, restricted to
-- service_role only (this is an admin action, not something n8n calls),
-- writes activity_events in the same transaction so a failed audit write
-- rolls back the correction with it.

create or replace function public.correct_payment(
  p_payment_id uuid,
  p_new_amount numeric,
  p_reason text default null
)
returns table (
  applied     boolean,
  reason      text,
  payment_id  uuid,
  old_amount  numeric,
  new_amount  numeric,
  currency    text,
  full_name   text,
  case_code   text,
  deposit     numeric,
  balance_due numeric
)
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  p       public.payments%rowtype;
  c       public.clients%rowtype;
  v_delta numeric;
begin
  select * into p from public.payments where id = p_payment_id;

  if not found then
    return query select false, 'unknown_payment', p_payment_id, null::numeric, null::numeric,
                        null::text, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  if p.status is distinct from 'confirmed' then
    return query select false, 'not_confirmed', p.id, p.amount, p_new_amount,
                        p.currency, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  if p_new_amount is null or p_new_amount <= 0 then
    return query select false, 'invalid_amount', p.id, p.amount, p_new_amount,
                        p.currency, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  if p_new_amount = p.amount then
    return query select false, 'no_change', p.id, p.amount, p_new_amount,
                        p.currency, null::text, null::text, null::numeric, null::numeric;
    return;
  end if;

  v_delta := p_new_amount - p.amount;

  update public.payments
     set amount = p_new_amount
   where id = p.id;

  update public.clients
     set deposit = coalesce(public.clients.deposit, 0) + v_delta
   where public.clients.id = p.client_id
  returning * into c;

  insert into public.activity_events
    (event_type, actor_user_id, actor_email, actor_name, subject_label, metadata)
  values
    ('payment_corrected', null, null, 'Jim — admin correction',
     coalesce(c.full_name, p.client_id::text),
     jsonb_build_object(
       'leadId',       p.client_id::text,
       'paymentId',    p.id::text,
       'caseCode',     coalesce((select pt.case_code from public.payment_tokens pt where pt.token = p.token), c.case_code),
       'oldAmount',    p.amount,
       'newAmount',    p_new_amount,
       'currency',     p.currency,
       'reason',       p_reason,
       'depositAfter', c.deposit,
       'balanceAfter', c.balance_due,
       'via',          'admin_correction'));

  return query select true, 'corrected', p.id, p.amount, p_new_amount, p.currency,
                      c.full_name,
                      coalesce((select pt.case_code from public.payment_tokens pt where pt.token = p.token), c.case_code),
                      c.deposit, c.balance_due;
end
$fn$;

comment on function public.correct_payment(uuid, numeric, text) is
  'Corrects the amount on an already-confirmed payment: updates payments.amount, adjusts clients.deposit by the delta, and logs a payment_corrected audit event. Does not touch stage. SECURITY DEFINER, service_role only.';

-- Functions default to EXECUTE for PUBLIC. This one moves money on a
-- SECURITY DEFINER function -- revoke first, then grant only to the role
-- the admin Worker actually connects as.
revoke all on function public.correct_payment(uuid, numeric, text) from public;
revoke all on function public.correct_payment(uuid, numeric, text) from anon, authenticated;
grant execute on function public.correct_payment(uuid, numeric, text) to service_role;

notify pgrst, 'reload schema';
