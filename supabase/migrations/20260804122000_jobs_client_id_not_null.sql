-- Enforce "no jobs without a lead" at the database level.
--
-- PRECONDITION: zero rows from
--   select id, job_code from public.jobs where client_id is null;
-- As of 04 Aug 2026 one orphan exists (JB100). Assign it to its client via
-- the admin job edit first, then run this. The guard below makes running it
-- early fail loudly instead of half-applying.
--
-- Deleting a client that still has jobs is not allowed. The portal prechecks
-- this in deleteLead and shows a friendly error; at the DB level the FK is
-- switched from ON DELETE SET NULL (which would now collide with NOT NULL and
-- raise a confusing not-null violation) to ON DELETE RESTRICT, so a raw delete
-- fails with a clear foreign-key error instead.

do $$
begin
  if exists (select 1 from public.jobs where client_id is null) then
    raise exception
      'jobs.client_id backfill incomplete: run the orphan audit and assign clients first';
  end if;
end $$;

alter table public.jobs alter column client_id set not null;

alter table public.jobs drop constraint if exists jobs_client_id_fkey;
alter table public.jobs
  add constraint jobs_client_id_fkey
    foreign key (client_id) references public.clients(id) on delete restrict;

notify pgrst, 'reload schema';
