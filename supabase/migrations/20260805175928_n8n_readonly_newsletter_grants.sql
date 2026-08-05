-- 20260805175928_n8n_readonly_newsletter_grants.sql
--
-- The n8n_readonly role was created for the Morning digest workflow and holds
-- SELECT on public.clients and nothing else. The Newsletter send and
-- EmailOctopus sync workflows on n8n.mygreektax.eu need four more tables, so
-- both failed with "permission denied for table newsletter_subscribers".
--
-- This grants the minimum each workflow actually uses. No DELETE is granted
-- anywhere, and no table outside the five named here is reachable by the role.
-- The role name is now misleading and is worth renaming in a later migration.
--
-- Reads and writes by workflow:
--   Newsletter send    reads newsletter_subscribers, suppressed_emails, email_send_log
--                      writes email_unsubscribe_tokens, email_send_log
--   EmailOctopus sync  reads and writes newsletter_subscribers
--                      writes suppressed_emails

grant select, insert, update on public.newsletter_subscribers   to n8n_readonly;
grant select, insert         on public.suppressed_emails        to n8n_readonly;
grant select, insert         on public.email_send_log           to n8n_readonly;
grant select, insert         on public.email_unsubscribe_tokens to n8n_readonly;

-- n8n_readonly has rolbypassrls = false, so grants alone are not sufficient on
-- a table with RLS enabled. suppressed_emails, email_send_log and
-- email_unsubscribe_tokens already carry policies scoped to the public role,
-- which n8n_readonly is a member of. newsletter_subscribers has RLS enabled and
-- no policies at all, so it needs explicit ones, following the naming of the
-- existing n8n_readonly_select_clients policy.

drop policy if exists n8n_readonly_select_newsletter_subscribers on public.newsletter_subscribers;
create policy n8n_readonly_select_newsletter_subscribers
  on public.newsletter_subscribers
  for select
  to n8n_readonly
  using (true);

drop policy if exists n8n_readonly_insert_newsletter_subscribers on public.newsletter_subscribers;
create policy n8n_readonly_insert_newsletter_subscribers
  on public.newsletter_subscribers
  for insert
  to n8n_readonly
  with check (true);

drop policy if exists n8n_readonly_update_newsletter_subscribers on public.newsletter_subscribers;
create policy n8n_readonly_update_newsletter_subscribers
  on public.newsletter_subscribers
  for update
  to n8n_readonly
  using (true)
  with check (true);

notify pgrst, 'reload schema';
