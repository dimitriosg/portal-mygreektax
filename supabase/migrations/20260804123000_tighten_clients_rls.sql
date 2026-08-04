-- clients: drop the wide-open authenticated read; admin-only from here.
--
-- portal_read_clients was USING (true) for all authenticated users, which let
-- any partner read the whole pipeline — deposits, margins, partner fees —
-- directly over PostgREST with the anon key, bypassing the admin-gated server
-- functions. Server routes use the service role and are unaffected; partners
-- receive client data only through server functions that strip it. The only
-- browser-side readers of clients (drafts, review, secure-inbox) are
-- admin-only screens, so an admin SELECT policy keeps them working.
-- n8n_readonly_select_clients is intentionally left in place.

drop policy if exists portal_read_clients on public.clients;

drop policy if exists clients_admin_read on public.clients;
create policy clients_admin_read
  on public.clients
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'::app_role));

notify pgrst, 'reload schema';
