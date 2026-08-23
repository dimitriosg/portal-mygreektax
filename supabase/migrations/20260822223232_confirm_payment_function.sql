create or replace function public.confirm_payment(p_token text)
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
as $$
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

  return query select true, 'confirmed', pid, t.amount, t.currency,
                      c.full_name, split_part(coalesce(c.full_name,''),' ',1), c.email,
                      coalesce(t.case_code, c.case_code), s_before, c.stage,
                      c.deposit, c.balance_due;
end $$;

comment on function public.confirm_payment(text) is
  'Confirms one payment token: writes payments, stamps paid_at, resolves the signal, adds to clients.deposit and moves Quoted to Active. Idempotent. SECURITY DEFINER so n8n_readonly needs no write grant on clients.';

-- Functions default to EXECUTE for PUBLIC. On a SECURITY DEFINER function that
-- moves money and stages, that would expose it as a PostgREST RPC to anon.
-- Revoke first, then grant only to the role n8n actually connects as.
revoke all on function public.confirm_payment(text) from public;
revoke all on function public.confirm_payment(text) from anon;
revoke all on function public.confirm_payment(text) from authenticated;
grant execute on function public.confirm_payment(text) to n8n_readonly;

notify pgrst, 'reload schema';
