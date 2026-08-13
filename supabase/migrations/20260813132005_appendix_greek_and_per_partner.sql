-- 20260813132005_appendix_greek_and_per_partner.sql
--
-- Catch-up migration. Everything in here was already run in the SQL editor on
-- 13/08/2026 and is live. This file exists so the repo matches the database.
-- It is idempotent and safe to re-run.
--
-- Contains no prices, so it is safe for a public repo. The wholesale and retail
-- figures live only in the Claude project doc claude/rate-card-seed-sql.md.
--
-- What it does:
--   1. Greek service names on service_catalog (service_name_el)
--   2. Shortened English names so the "(English / CODE)" line does not nest brackets
--   3. in_appendix flag marking the 40 services that form a partner appendix
--   4. v_partner_appendix rebuilt to expose the Greek name and a Greek unit label
--   5. get_partner_appendix(uuid), so each partner sees only their own card and a
--      partner with no card still sees all 40 services as placeholders

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

alter table public.service_catalog add column if not exists service_name_el text;
alter table public.service_catalog add column if not exists in_appendix boolean not null default false;

comment on column public.service_catalog.service_name_el is
  'Greek service name. Shown first in the partner appendix; the English name and code go underneath.';
comment on column public.service_catalog.in_appendix is
  'True for services that form a partner rate card. Drives the placeholder list for a partner with no agreed lines yet.';

grant select (service_name_el, in_appendix) on public.service_catalog to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Greek names
-- ---------------------------------------------------------------------------

update public.service_catalog sc set service_name_el = v.el
from (values
 ('SRV-B01','E1 Ετήσια Φορολογική Δήλωση'),
 ('SRV-B09','E1 με Πρόσθετα Στοιχεία'),
 ('SRV-B10','E1 με Εισοδήματα Αλλοδαπής και ΣΑΔΦ'),
 ('SRV-B11','E1 Αλλοδαπής, Επιπλέον ΣΑΔΦ'),
 ('SRV-B12','E1 Εκπρόθεσμη Δήλωση'),
 ('SRV-B02','E2 Δήλωση Μισθωμάτων'),
 ('SRV-B13','E2 Επιπλέον Γραμμή Μισθώματος'),
 ('SRV-B03','E3 Δήλωση Επιχειρηματικής Δραστηριότητας'),
 ('SRV-B04','E9 Δήλωση Ακινήτων'),
 ('SRV-B06','ΕΝΦΙΑ, Υπολογισμός και Υποβολή'),
 ('SRV-B07','Δηλώσεις Παρελθόντων Ετών'),
 ('SRV-B08','Τροποποιητική Δήλωση'),
 ('SRV-B15','E1 Θανόντος, Υποβολή από Κληρονόμο'),
 ('SRV-C01','Αλλαγή Φορολογικής Κατοικίας προς Ελλάδα, Απλή'),
 ('SRV-C10','Αλλαγή Φορολογικής Κατοικίας προς Ελλάδα, Μεσαία Πολυπλοκότητα'),
 ('SRV-C11','Αλλαγή Φορολογικής Κατοικίας προς Ελλάδα, Σύνθετη'),
 ('SRV-C02','Αλλαγή Φορολογικής Κατοικίας προς Εξωτερικό, Απλή'),
 ('SRV-C12','Αλλαγή Φορολογικής Κατοικίας προς Εξωτερικό, Σύνθετη'),
 ('SRV-C03','Άρθρο 5Α, Καθεστώς Non-Dom'),
 ('SRV-C04','Άρθρο 5Β, Συνταξιούχοι Αλλοδαπής'),
 ('SRV-C05','Άρθρο 5Γ, Αλλοδαποί Εργαζόμενοι'),
 ('SRV-C06','Πιστοποιητικό Φορολογικής Κατοικίας'),
 ('SRV-C08','Δέσμη Φορολογικής Κατοικίας, Μεταβολή με Παρελθόντα Έτη και Τρέχουσα E1'),
 ('SRV-C09','Δέσμη Φορολογικής Κατοικίας, Επιπλέον Παρελθόν Έτος'),
 ('SRV-A01','Έκδοση ΑΦΜ, Μόνο Αριθμός'),
 ('SRV-A12','Έκδοση ΑΦΜ με Κλειδάριθμο, TAXISnet και myAADE'),
 ('SRV-A10','Ενεργοποίηση TAXISnet και myAADE'),
 ('SRV-A11','Δ210, Διόρθωση Στοιχείων Μητρώου'),
 ('SRV-A14','ΑΦΜ Κατοίκου Εξωτερικού με Έρευνα Μητρώου'),
 ('SRV-A15','ΑΦΜ Μόνο, Πελάτης στο Εξωτερικό'),
 ('SRV-D01','Έναρξη Ατομικής Επιχείρησης και Εγγραφή ΕΦΚΑ'),
 ('SRV-D03','Μηνιαία Λογιστική Παρακολούθηση'),
 ('SRV-D04','Εγγραφή στο Μητρώο ΦΠΑ'),
 ('SRV-D05','Τριμηνιαία Δήλωση ΦΠΑ'),
 ('SRV-D09','Θεραπεία ΓΕΜΗ και Συμμόρφωση ΙΚΕ'),
 ('SRV-E01','Επιστολές ΑΑΔΕ, Μετάφραση και Απάντηση'),
 ('SRV-E09','Γραπτή Συμβουλευτική Ανασκόπηση'),
 ('SRV-E10','Δήλωση Κληρονόμων και Αποτύπωση Περιουσίας'),
 ('SRV-E11','Φορολογικός Εκπρόσωπος, Έτος 1'),
 ('SRV-E12','Φορολογικός Εκπρόσωπος, Ετήσια Ανανέωση'),
 ('SRV-H03','Επιδόματα, ΟΠΕΚΑ, ΑΑΔΕ και ΔΥΠΑ')
) as v(code, el)
where sc.service_code = v.code;

-- ---------------------------------------------------------------------------
-- 3. Shorter English names, so the muted "(English / CODE)" line has no nested
--    brackets. SRV-D03 is also renamed: it is billed monthly, not annually.
-- ---------------------------------------------------------------------------

update public.service_catalog sc set service_name = v.en
from (values
 ('SRV-A10','TAXISnet and myAADE Activation'),
 ('SRV-A11','AFM Registry Data Correction'),
 ('SRV-A12','AFM plus Setup'),
 ('SRV-A01','AFM Registration'),
 ('SRV-A14','AFM for Non-Resident with Registry Search'),
 ('SRV-A15','AFM Only, Client Abroad'),
 ('SRV-B09','E1 with Extras'),
 ('SRV-B10','E1 with Foreign Income and Tax Treaty'),
 ('SRV-B12','E1 Late Filing'),
 ('SRV-B03','E3 Business Activity Declaration'),
 ('SRV-C08','Residency Bundle'),
 ('SRV-D01','Freelancer Setup and EFKA Registration'),
 ('SRV-D03','Monthly Bookkeeping Retainer'),
 ('SRV-D04','VAT Registration'),
 ('SRV-E01','Tax Authority Letters'),
 ('SRV-E10','Estate Access and Snapshot'),
 ('SRV-H03','Allowances')
) as v(code, en)
where sc.service_code = v.code;

-- ---------------------------------------------------------------------------
-- 4. Which services form an appendix
-- ---------------------------------------------------------------------------

update public.service_catalog set in_appendix = false;
update public.service_catalog set in_appendix = true
where service_code in (
 'SRV-B01','SRV-B09','SRV-B10','SRV-B11','SRV-B12','SRV-B02','SRV-B13','SRV-B03','SRV-B04',
 'SRV-B06','SRV-B07','SRV-B08','SRV-B15',
 'SRV-C01','SRV-C10','SRV-C11','SRV-C02','SRV-C12','SRV-C03','SRV-C04','SRV-C05','SRV-C06','SRV-C08','SRV-C09',
 'SRV-A01','SRV-A12','SRV-A10','SRV-A11','SRV-A14','SRV-A15',
 'SRV-D01','SRV-D03','SRV-D04','SRV-D05','SRV-D09',
 'SRV-E01','SRV-E10','SRV-E11','SRV-E12','SRV-H03'
);
-- SRV-E09 (written advisory review) is deliberately excluded: in-house work with
-- no partner involvement, so it does not belong on a partner's rate card.

-- ---------------------------------------------------------------------------
-- 5. View: Greek name and Greek unit label
-- ---------------------------------------------------------------------------

drop view if exists public.v_partner_appendix;
create view public.v_partner_appendix
with (security_invoker = true) as
select
  prc.partner_user_id,
  sc.category,
  sc.service_code,
  sc.service_name_el,
  sc.service_name,
  prc.wholesale_price,
  prc.price_unit,
  case prc.price_unit
    when 'per_job'        then 'εργασία'
    when 'per_month'      then 'μήνα'
    when 'per_year'       then 'έτος'
    when 'per_person'     then 'άτομο'
    when 'per_line'       then 'γραμμή'
    when 'per_treaty'     then 'ΣΑΔΦ'
    when 'per_extra_year' then 'επιπλέον έτος'
  end as price_unit_el,
  prc.sla_days,
  prc.status,
  prc.notes,
  prc.effective_from
from public.partner_rate_cards prc
join public.service_catalog sc on sc.id = prc.service_id
where prc.effective_to is null;

grant select on public.v_partner_appendix to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Per-partner appendix with placeholders
--
-- A partner can never read another partner's card: the parameter is ignored
-- unless the caller is admin. A partner with no agreed lines still gets all 40
-- services back, with wholesale_price null and has_line false.
-- ---------------------------------------------------------------------------

create or replace function public.get_partner_appendix(p_partner_user_id uuid default null)
returns table (
  partner_user_id  uuid,
  partner_name     text,
  category         text,
  service_code     text,
  service_name_el  text,
  service_name     text,
  wholesale_price  numeric,
  price_unit       public.price_unit,
  price_unit_el    text,
  sla_days         text,
  status           public.rate_status,
  notes            text,
  has_line         boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
  v_admin  boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  v_admin := public.has_role(auth.uid(), 'admin'::app_role);

  if v_admin then
    v_target := coalesce(p_partner_user_id, auth.uid());
  else
    if not exists (
      select 1 from public.partner_profiles pp
      where pp.user_id = auth.uid() and pp.disabled_at is null
    ) then
      raise exception 'forbidden: active partner or admin required' using errcode = '42501';
    end if;
    v_target := auth.uid();
  end if;

  return query
  select
    v_target,
    pp.full_name,
    sc.category,
    sc.service_code,
    sc.service_name_el,
    sc.service_name,
    prc.wholesale_price,
    prc.price_unit,
    case prc.price_unit
      when 'per_job'        then 'εργασία'
      when 'per_month'      then 'μήνα'
      when 'per_year'       then 'έτος'
      when 'per_person'     then 'άτομο'
      when 'per_line'       then 'γραμμή'
      when 'per_treaty'     then 'ΣΑΔΦ'
      when 'per_extra_year' then 'επιπλέον έτος'
    end,
    prc.sla_days,
    prc.status,
    prc.notes,
    (prc.id is not null)
  from public.service_catalog sc
  left join public.partner_rate_cards prc
         on prc.service_id = sc.id
        and prc.partner_user_id = v_target
        and prc.effective_to is null
  left join public.partner_profiles pp on pp.user_id = v_target
  where sc.in_appendix
  order by sc.category, sc.service_code;
end;
$$;

revoke all on function public.get_partner_appendix(uuid) from public;
grant execute on function public.get_partner_appendix(uuid) to authenticated;

commit;

notify pgrst, 'reload schema';
