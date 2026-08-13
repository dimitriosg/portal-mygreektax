-- 20260813121834_fix_rate_card_admin_access.sql
--
-- Fixes two defects introduced by 20260813095714_partner_rate_cards.sql.
-- Both were found by CodeRabbit on PR #89 and confirmed against the live database.
--
-- DEFECT 1: v_rate_card_admin is unusable by anyone.
--   The view is security_invoker and projects service_catalog.base_client_price.
--   The same migration revoked that column from `authenticated`. A security_invoker
--   view runs with the caller's privileges, and every portal user is the Postgres
--   role `authenticated` regardless of their app_role, so Postgres rejects the whole
--   query with a permission error. Admin is an app-level role in user_roles, not a
--   database role, so it does not escape this.
--   Verified: has_column_privilege('authenticated','public.service_catalog',
--             'base_client_price','SELECT') = false.
--   The original migration's comment claimed a non-admin would see null retail and
--   margin. That was wrong: nobody sees anything, it errors.
--   It failed closed, so nothing ever leaked.
--
--   Fix: replace the view with a security-definer function that checks
--   has_role(auth.uid(),'admin') and raises 42501 otherwise. The function runs as
--   owner, so column privileges do not block it, and the admin check is explicit
--   rather than implied by a WHERE clause that a later edit could drop.
--
-- DEFECT 2: duplicate updated_at trigger function.
--   public.set_updated_at() already existed. The migration added touch_updated_at(),
--   which is byte-for-byte the same behaviour under a second name. This is exactly
--   the duplicate-function pattern that has already bitten this database with
--   resolve_case_for_inbound. Repoint the triggers and drop the duplicate.
--
-- No data is touched. No destructive statement beyond dropping the duplicate
-- function and the broken view, both created by the previous migration in this
-- same series.

begin;

-- ---------------------------------------------------------------------------
-- 1. Consolidate on the pre-existing set_updated_at()
-- ---------------------------------------------------------------------------

drop trigger if exists partner_rate_cards_touch on public.partner_rate_cards;
create trigger partner_rate_cards_touch
  before update on public.partner_rate_cards
  for each row execute function public.set_updated_at();

drop trigger if exists retail_prices_touch on public.retail_prices;
create trigger retail_prices_touch
  before update on public.retail_prices
  for each row execute function public.set_updated_at();

drop function if exists public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Replace the broken admin view with a guarded function
-- ---------------------------------------------------------------------------

drop view if exists public.v_rate_card_admin;

create or replace function public.get_rate_card_admin()
returns table (
  partner_name                 text,
  partner_user_id              uuid,
  category                     text,
  service_code                 text,
  service_name                 text,
  wholesale_price              numeric,
  retail_price                 numeric,
  margin_eur                   numeric,
  margin_pct                   numeric,
  portal_live_price            numeric,
  portal_mismatch              boolean,
  portal_at_or_below_wholesale boolean,
  price_unit                   public.price_unit,
  sla_days                     text,
  wholesale_status             public.rate_status,
  wholesale_notes              text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_role(auth.uid(), 'admin'::app_role) then
    raise exception 'forbidden: admin role required'
      using errcode = '42501';
  end if;

  return query
  select
    pp.full_name,
    prc.partner_user_id,
    sc.category,
    sc.service_code,
    sc.service_name,
    prc.wholesale_price,
    rp.retail_price,
    (rp.retail_price - prc.wholesale_price),
    case
      when rp.retail_price is null or rp.retail_price = 0 then null
      else round(((rp.retail_price - prc.wholesale_price) / rp.retail_price) * 100, 1)
    end,
    sc.base_client_price,
    case
      when rp.retail_price is not null
       and sc.base_client_price is not null
       and rp.retail_price <> sc.base_client_price then true
      else false
    end,
    case
      when prc.wholesale_price is not null
       and sc.base_client_price is not null
       and sc.base_client_price <= prc.wholesale_price then true
      else false
    end,
    prc.price_unit,
    prc.sla_days,
    prc.status,
    prc.notes
  from public.service_catalog sc
  left join public.retail_prices rp
         on rp.service_id = sc.id and rp.effective_to is null
  left join public.partner_rate_cards prc
         on prc.service_id = sc.id and prc.effective_to is null
  left join public.partner_profiles pp on pp.user_id = prc.partner_user_id
  where rp.id is not null or prc.id is not null;
end;
$$;

comment on function public.get_rate_card_admin() is
  'Internal rate card: wholesale, retail, margin, plus portal_at_or_below_wholesale which turns the loss-making-price check into a live report. Security definer, raises 42501 for any caller without the admin app_role. Replaces v_rate_card_admin, which was unusable because it projected a column revoked from authenticated.';

revoke all on function public.get_rate_card_admin() from public;
grant execute on function public.get_rate_card_admin() to authenticated;

commit;

notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Verification:
--
--   -- as service role, should raise 42501 because auth.uid() is null:
--   select * from public.get_rate_card_admin();
--
--   -- from the portal as hello@mygreektax.eu, should return rows.
--   -- from the portal as any partner, should raise 42501.
--
--   -- confirm the duplicate is gone (expect 1, set_updated_at):
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and proname in ('set_updated_at','touch_updated_at');
-- ---------------------------------------------------------------------------
