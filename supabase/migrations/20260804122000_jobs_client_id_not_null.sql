-- Enforce "no jobs without a lead" at the database level.
--
-- PRECONDITION: zero rows from
--   select id, job_code from public.jobs where client_id is null;
-- As of 04 Aug 2026 one orphan exists (JB100). Assign it to its client via
-- the admin job edit first, then run this. The guard below makes running it
-- early fail loudly instead of half-applying.
--
-- Known consequence: jobs_client_id_fkey is ON DELETE SET NULL, so deleting a
-- client that still has jobs now fails at the DB. The portal prechecks this in
-- deleteLead and shows a friendly error before Postgres ever sees it.

do $$
begin
  if exists (select 1 from public.jobs where client_id is null) then
    raise exception
      'jobs.client_id backfill incomplete: run the orphan audit and assign clients first';
  end if;
end $$;

alter table public.jobs alter column client_id set not null;

notify pgrst, 'reload schema';
