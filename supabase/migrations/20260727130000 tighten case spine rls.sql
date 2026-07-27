-- Tighten RLS on the case spine to admin only.
--
-- Before this, brain_events, brain_conversations and case_drafts each carried
-- a policy granting SELECT to any authenticated user with a qualifier of true.
-- Three partner accounts log into the portal, so every client conversation and
-- every AI draft was readable by them.
--
-- Nothing partner facing reads these tables. Partner access in this schema is
-- scoped to partner_profiles and job_change_requests, both already restricted.
--
-- clients is deliberately not touched here. Partner job views may join it and
-- that needs checking before its policy changes.
--
-- Server side routes use the service role key and bypass RLS, so webhooks and
-- the Brain are unaffected.

drop policy if exists portal_read_brain_events on public.brain_events;
create policy brain_events_admin_read
  on public.brain_events
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists portal_read_conversations on public.brain_conversations;
create policy brain_conversations_admin_read
  on public.brain_conversations
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists portal_read_drafts on public.case_drafts;
create policy case_drafts_admin_read
  on public.case_drafts
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

drop policy if exists portal_update_drafts on public.case_drafts;
create policy case_drafts_admin_update
  on public.case_drafts
  for update
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

notify pgrst, 'reload schema';
