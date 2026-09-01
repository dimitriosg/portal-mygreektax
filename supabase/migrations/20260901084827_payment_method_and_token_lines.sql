-- 20260901084827_payment_method_and_token_lines.sql
--
-- Stripe on pay.mygreektax.eu, schema part.
--
-- Two changes:
--   1. payment_tokens.method  tells the /pay page which experience to render.
--      'stripe' gets the embedded card form and confirms itself from the
--      Stripe webhook. 'revolut' and 'bank' keep today's page with the
--      "I have paid" claim and Jim's Telegram confirm tap.
--   2. payment_token_lines    the itemised breakdown behind a payment request.
--      Lines are the source of truth. payment_tokens.amount is kept as a
--      cached total by trigger, so confirm_payment, the portal and workflows
--      60 and 63 all keep reading the column they already read.
--
-- Additive only. No drops, no data loss. Existing rows default to 'revolut',
-- which is how all thirteen of them were actually paid.

-- ---------------------------------------------------------------------------
-- 1. payment method on the token
-- ---------------------------------------------------------------------------

alter table public.payment_tokens
  add column if not exists method text not null default 'revolut';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payment_tokens_method_check'
  ) then
    alter table public.payment_tokens
      add constraint payment_tokens_method_check
      check (method in ('stripe', 'revolut', 'bank'));
  end if;
end $$;

comment on column public.payment_tokens.method is
  'How this request is meant to be paid. stripe = embedded card form on pay.mygreektax.eu, confirmed automatically by the Stripe webhook. revolut and bank = manual claim, confirmed by Jim tapping Telegram.';

-- ---------------------------------------------------------------------------
-- 2. line items
-- ---------------------------------------------------------------------------

create table if not exists public.payment_token_lines (
  id            uuid primary key default gen_random_uuid(),
  token         text not null references public.payment_tokens(token) on delete cascade,
  position      integer not null default 1,
  service_code  text references public.service_catalog(service_code),
  description   text not null,
  quantity      numeric not null default 1,
  unit_amount   numeric not null,
  created_at    timestamptz not null default now(),
  constraint payment_token_lines_quantity_positive check (quantity > 0)
);

comment on table public.payment_token_lines is
  'Itemised breakdown of a payment request. service_code is null for a free text line such as a pass-through government fee. unit_amount may be negative to express a discount; the token total must still come out above zero.';

create unique index if not exists payment_token_lines_token_position_key
  on public.payment_token_lines (token, position);

create index if not exists payment_token_lines_token_idx
  on public.payment_token_lines (token);

create index if not exists payment_token_lines_service_code_idx
  on public.payment_token_lines (service_code)
  where service_code is not null;

-- ---------------------------------------------------------------------------
-- 3. keep payment_tokens.amount in step with the lines
-- ---------------------------------------------------------------------------

create or replace function public.sync_payment_token_amount()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text := coalesce(new.token, old.token);
  v_total numeric;
begin
  select coalesce(sum(quantity * unit_amount), 0)
    into v_total
    from public.payment_token_lines
   where token = v_token;

  -- A token with no lines keeps whatever amount was set directly. That is the
  -- old single-figure behaviour and it stays valid.
  if v_total <> 0 then
    update public.payment_tokens
       set amount = v_total
     where token = v_token
       and amount is distinct from v_total;
  end if;

  return null;
end;
$$;

comment on function public.sync_payment_token_amount() is
  'Recomputes payment_tokens.amount from payment_token_lines so every existing reader of amount keeps working unchanged.';

drop trigger if exists payment_token_lines_sync_amount on public.payment_token_lines;

create trigger payment_token_lines_sync_amount
  after insert or update or delete on public.payment_token_lines
  for each row execute function public.sync_payment_token_amount();

-- ---------------------------------------------------------------------------
-- 4. RLS, mirroring payment_tokens
-- ---------------------------------------------------------------------------

alter table public.payment_token_lines enable row level security;

-- n8n needs to read lines to build a Stripe session and to describe a payment
-- in Telegram. It never writes them; the portal does that with the service key.
drop policy if exists n8n_readonly_select_payment_token_lines on public.payment_token_lines;
create policy n8n_readonly_select_payment_token_lines
  on public.payment_token_lines
  for select
  to n8n_readonly
  using (true);

grant select on public.payment_token_lines to n8n_readonly;

notify pgrst, 'reload schema';
