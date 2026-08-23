-- 20260822220637_amount_derivation_triggers.sql
--
-- Ends the hand-maintenance of money columns on `clients`.
--
-- Before this, quote_amount and balance_due were typed in by hand alongside
-- jobs.client_fee, and had drifted on 3 of 25 cases. You cannot sync two
-- hand-maintained numbers; one has to be the source. Verified against live
-- data first: balance_due = quote_amount - deposit already held on every
-- single row, so it was always derived — just not enforced.
--
--   jobs.client_fee        the atom. The only price anyone types.
--   clients.quote_amount   derived: sum(jobs.client_fee) for that client
--   clients.deposit        a real fact. Written by payment confirmation.
--   clients.balance_due    derived: quote_amount - deposit
--
-- Requires 20260822220636_repair_job_fees_before_amount_triggers.sql first.
-- Idempotent: safe to re-run.

create or replace function public.set_client_balance_due()
returns trigger language plpgsql as $$
begin
  new.balance_due := coalesce(new.quote_amount, 0) - coalesce(new.deposit, 0);
  return new;
end $$;

-- BEFORE, on the same row, so there is no recursion.
drop trigger if exists trg_clients_balance_due on public.clients;
create trigger trg_clients_balance_due
  before insert or update of quote_amount, deposit on public.clients
  for each row execute function public.set_client_balance_due();

create or replace function public.sync_client_quote_amount()
returns trigger language plpgsql as $$
declare
  new_client uuid;
  old_client uuid;
begin
  -- NEW is unassigned on DELETE and OLD on INSERT; branch rather than coalesce.
  if tg_op <> 'DELETE' then new_client := new.client_id; end if;
  if tg_op <> 'INSERT' then old_client := old.client_id; end if;

  if new_client is not null then
    update public.clients c
       set quote_amount = (select sum(j.client_fee) from public.jobs j where j.client_id = new_client)
     where c.id = new_client;
  end if;

  -- a job reassigned to a different client leaves the old one needing a recount
  if old_client is not null and old_client is distinct from new_client then
    update public.clients c
       set quote_amount = (select sum(j.client_fee) from public.jobs j where j.client_id = old_client)
     where c.id = old_client;
  end if;

  return null;
end $$;

drop trigger if exists trg_jobs_sync_quote on public.jobs;
create trigger trg_jobs_sync_quote
  after insert or update or delete on public.jobs
  for each row execute function public.sync_client_quote_amount();

-- One-time reconcile: triggers only fire on future writes. The BEFORE trigger
-- recomputes balance_due as part of this same UPDATE.
--
-- Clients with NO jobs are deliberately excluded — for them quote_amount is
-- the only record of the figure and nulling it would destroy data. Three such
-- rows exist, all Parked. If one is ever revived, create a job carrying the fee.
update public.clients c
   set quote_amount = (select sum(j.client_fee) from public.jobs j where j.client_id = c.id)
 where exists (select 1 from public.jobs j where j.client_id = c.id);

notify pgrst, 'reload schema';
