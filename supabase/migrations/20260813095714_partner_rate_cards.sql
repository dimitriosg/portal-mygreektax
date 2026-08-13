-- 20260813095714_partner_rate_cards.sql
--
-- Per-partner wholesale rate cards + MyGreekTax retail prices, with the
-- wholesale/retail firewall enforced by Postgres rather than by UI code.
--
-- Model:
--   partner_rate_cards  one wholesale line per (partner, service), versioned by
--                       effective_from / effective_to. Each partner has their own
--                       Παράρτημα Α. Partners see only their own rows.
--   retail_prices       MyGreekTax client-facing price per service. Admin only.
--                       Never visible to any partner, at any layer.
--   v_partner_appendix  what a partner sees: their own wholesale lines only.
--   v_rate_card_admin   what Jim sees: wholesale + retail + margin + a flag where
--                       the live portal price disagrees with the rate card.
--
-- Access control notes:
--   * service_catalog currently has RLS enabled with zero policies, so it is
--     unreachable except via the service role. This migration grants authenticated
--     users column-level SELECT on the descriptive columns only, and explicitly
--     withholds base_client_price, which is a retail figure.
--   * Both views are security_invoker so the caller's RLS applies. They are NOT
--     security definer.
--   * IMPORTANT, application side: the portal reads almost everything through the
--     service-role admin client, which bypasses RLS entirely. The two new routes
--     MUST query with the signed-in user's JWT (anon key + session), or every
--     policy below is decorative and the gate is just an if-statement in React.

begin;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

do $$ begin
  if not exists (select 1 from pg_type where typname = 'price_unit') then
    create type public.price_unit as enum (
      'per_job', 'per_month', 'per_year', 'per_person',
      'per_line', 'per_extra_year', 'per_treaty'
    );
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'rate_status') then
    create type public.rate_status as enum ('confirmed', 'pending', 'case_by_case');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Partner wholesale rate cards
-- ---------------------------------------------------------------------------

create table if not exists public.partner_rate_cards (
  id               uuid primary key default gen_random_uuid(),
  partner_user_id  uuid not null references auth.users(id) on delete cascade,
  service_id       uuid not null references public.service_catalog(id) on delete restrict,
  wholesale_price  numeric(10,2),                        -- null means κατά περίπτωση
  price_unit       public.price_unit  not null default 'per_job',
  sla_days         text,
  status           public.rate_status not null default 'pending',
  notes            text,
  effective_from   date not null default current_date,
  effective_to     date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.partner_rate_cards is
  'Per-partner wholesale price list (Παράρτημα Α). One agreement per partner. Partners read only their own rows.';
comment on column public.partner_rate_cards.wholesale_price is
  'NULL means κατά περίπτωση, agreed ad hoc before assignment.';
comment on column public.partner_rate_cards.effective_to is
  'NULL means this is the line currently in force. Supersede by setting effective_to and inserting a new row.';

-- one line in force per partner per service
create unique index if not exists partner_rate_cards_active_uniq
  on public.partner_rate_cards (partner_user_id, service_id)
  where effective_to is null;

create index if not exists partner_rate_cards_partner_idx
  on public.partner_rate_cards (partner_user_id);

-- ---------------------------------------------------------------------------
-- 3. Retail prices (admin only, never partner-visible)
-- ---------------------------------------------------------------------------

create table if not exists public.retail_prices (
  id             uuid primary key default gen_random_uuid(),
  service_id     uuid not null references public.service_catalog(id) on delete restrict,
  retail_price   numeric(10,2),
  price_unit     public.price_unit  not null default 'per_job',
  status         public.rate_status not null default 'confirmed',
  notes          text,
  effective_from date not null default current_date,
  effective_to   date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.retail_prices is
  'MyGreekTax client-facing prices. Admin only. Must never be exposed to a partner at any layer.';

create unique index if not exists retail_prices_active_uniq
  on public.retail_prices (service_id)
  where effective_to is null;

-- ---------------------------------------------------------------------------
-- 4. updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists partner_rate_cards_touch on public.partner_rate_cards;
create trigger partner_rate_cards_touch
  before update on public.partner_rate_cards
  for each row execute function public.touch_updated_at();

drop trigger if exists retail_prices_touch on public.retail_prices;
create trigger retail_prices_touch
  before update on public.retail_prices
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------

alter table public.partner_rate_cards enable row level security;
alter table public.retail_prices      enable row level security;

-- Partners: read their own lines, and only while their profile is not disabled.
-- The disabled_at check is what stops a former partner keeping sight of the
-- wholesale list after the relationship ends.
drop policy if exists partner_rate_cards_own_read on public.partner_rate_cards;
create policy partner_rate_cards_own_read
  on public.partner_rate_cards
  for select
  to authenticated
  using (
    partner_user_id = auth.uid()
    and exists (
      select 1 from public.partner_profiles pp
      where pp.user_id = auth.uid()
        and pp.disabled_at is null
    )
  );

drop policy if exists partner_rate_cards_admin_all on public.partner_rate_cards;
create policy partner_rate_cards_admin_all
  on public.partner_rate_cards
  for all
  to authenticated
  using      (public.has_role(auth.uid(), 'admin'::app_role))
  with check (public.has_role(auth.uid(), 'admin'::app_role));

-- Retail: admin only. No partner policy exists, deliberately.
drop policy if exists retail_prices_admin_all on public.retail_prices;
create policy retail_prices_admin_all
  on public.retail_prices
  for all
  to authenticated
  using      (public.has_role(auth.uid(), 'admin'::app_role))
  with check (public.has_role(auth.uid(), 'admin'::app_role));

-- ---------------------------------------------------------------------------
-- 6. service_catalog: let authenticated read the descriptive columns only
--
-- service_catalog holds base_client_price, which is retail. Column-level grants
-- keep that column out of reach while still letting a partner see the service
-- names their own rate card refers to. service_role bypasses all of this, so the
-- existing portal code that reads through the admin client is unaffected.
-- ---------------------------------------------------------------------------

drop policy if exists service_catalog_authenticated_read on public.service_catalog;
create policy service_catalog_authenticated_read
  on public.service_catalog
  for select
  to authenticated
  using (true);

revoke select on public.service_catalog from authenticated;
grant  select (id, service_code, service_name, category, tier)
  on public.service_catalog to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Views
-- ---------------------------------------------------------------------------

-- What a partner sees. security_invoker so the policies above apply to the caller.
drop view if exists public.v_partner_appendix;
create view public.v_partner_appendix
with (security_invoker = true) as
select
  prc.partner_user_id,
  sc.category,
  sc.service_code,
  sc.service_name,
  prc.wholesale_price,
  prc.price_unit,
  prc.sla_days,
  prc.status,
  prc.notes,
  prc.effective_from
from public.partner_rate_cards prc
join public.service_catalog sc on sc.id = prc.service_id
where prc.effective_to is null;

comment on view public.v_partner_appendix is
  'Παράρτημα Α as the partner sees it. Wholesale only. No retail, no margin, no other partner.';

grant select on public.v_partner_appendix to authenticated;

-- What Jim sees. Retail is admin-only by RLS, so a partner querying this view
-- gets their wholesale row with retail and margin null, never another partner.
drop view if exists public.v_rate_card_admin;
create view public.v_rate_card_admin
with (security_invoker = true) as
select
  pp.full_name                             as partner_name,
  prc.partner_user_id,
  sc.category,
  sc.service_code,
  sc.service_name,
  prc.wholesale_price,
  rp.retail_price,
  (rp.retail_price - prc.wholesale_price)  as margin_eur,
  case
    when rp.retail_price is null or rp.retail_price = 0 then null
    else round(((rp.retail_price - prc.wholesale_price) / rp.retail_price) * 100, 1)
  end                                      as margin_pct,
  sc.base_client_price                     as portal_live_price,
  case
    when rp.retail_price is not null
     and sc.base_client_price is not null
     and rp.retail_price <> sc.base_client_price then true
    else false
  end                                      as portal_mismatch,
  case
    when prc.wholesale_price is not null
     and sc.base_client_price is not null
     and sc.base_client_price <= prc.wholesale_price then true
    else false
  end                                      as portal_at_or_below_wholesale,
  prc.price_unit,
  prc.sla_days,
  prc.status                               as wholesale_status,
  prc.notes                                as wholesale_notes
from public.service_catalog sc
left join public.retail_prices rp
       on rp.service_id = sc.id and rp.effective_to is null
left join public.partner_rate_cards prc
       on prc.service_id = sc.id and prc.effective_to is null
left join public.partner_profiles pp on pp.user_id = prc.partner_user_id
-- catalogue-driven, so a service with a retail price but no partner line (in-house
-- work such as the written advisory review) and a service with a partner line but
-- no retail price yet both stay visible.
where rp.id is not null or prc.id is not null;

comment on view public.v_rate_card_admin is
  'Internal rate card. Wholesale, retail, margin, plus portal_at_or_below_wholesale which turns the loss-making-price check into a live report.';

grant select on public.v_rate_card_admin to authenticated;

commit;

notify pgrst, 'reload schema';
