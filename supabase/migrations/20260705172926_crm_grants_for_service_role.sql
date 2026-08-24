grant usage on schema public to service_role;
grant select, insert, update, delete on
  public.clients, public.jobs, public.accountants, public.service_catalog, public.messages
  to service_role;
grant select on public.jobs_expanded to service_role;
-- ask PostgREST to reload its schema cache so supabase-js sees the new objects
notify pgrst, 'reload schema';
