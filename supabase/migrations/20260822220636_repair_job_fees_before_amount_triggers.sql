-- 20260822220636_repair_job_fees_before_amount_triggers.sql
--
-- Data repair. MUST run before 20260822220637_amount_derivation_triggers.sql.
--
-- Those triggers make jobs.client_fee the source of truth for
-- clients.quote_amount. Applied to the data as it stood, that would have
-- silently rewritten three client-facing figures — most seriously CLT0048,
-- an Active case whose quote would have halved from 198 to 99 with its
-- balance dropping to zero. This file fixes the underlying rows first so the
-- derivation changes no total.
--
-- Idempotent: the insert is guarded on job_code, the updates are guarded on
-- the value they replace.

-- CLT0048 is a couple: two people, each quoted 99, 99 paid upfront. Only one
-- job row existed. Mirrors JB131. NOTE: accountant_fee is copied from JB131 —
-- Jim should confirm the partner is charging the same for the second person.
insert into public.jobs (job_code, client_id, service_id, accountant_id, status,
                         date_sent, sla_deadline, accountant_fee, client_fee)
select 'JB138', j.client_id, j.service_id, j.accountant_id, j.status,
       j.date_sent, j.sla_deadline, j.accountant_fee, 99
from public.jobs j
where j.job_code = 'JB131'
  and not exists (select 1 from public.jobs x where x.job_code = 'JB138');

-- CLT0009: the total was 249. deposit 124.50 is exactly half of 249, so the
-- client record was right and the job fee of 250 was the typo.
update public.jobs set client_fee = 249
where job_code = 'JB111' and client_fee = 250;

-- Five clients carried a quote_amount while their single job had no
-- client_fee — a newer flow writing the roll-up and never the atom. Push the
-- quote down into the job so it becomes the source without changing a total.
-- Guarded to clients with exactly one job, so nothing is misallocated.
update public.jobs j
   set client_fee = c.quote_amount
  from public.clients c
 where j.client_id = c.id
   and j.client_fee is null
   and c.quote_amount is not null
   and (select count(*) from public.jobs k where k.client_id = c.id) = 1;
