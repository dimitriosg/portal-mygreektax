-- 20260805180413_n8n_readonly_email_table_policies.sql
--
-- Follows 20260805175928_n8n_readonly_newsletter_grants.sql.
--
-- The grants in that migration were necessary but not sufficient. RLS on
-- email_unsubscribe_tokens, email_send_log and suppressed_emails is enforced by
-- policies whose expression is auth.role() = 'service_role'. That is a JWT claim
-- read through PostgREST. n8n connects to Postgres directly as n8n_readonly with
-- no JWT, so auth.role() evaluates to null and every one of those policies fails
-- closed. The symptom was "new row violates row-level security policy for table
-- email_unsubscribe_tokens" on the first live Newsletter send.
--
-- Worth noting the existing policies are stricter than the grants suggest: anon
-- and authenticated hold full table grants on these tables but cannot actually
-- write through them, because auth.role() is not service_role. The policies are
-- doing the real work. Leaving them untouched and adding role-scoped policies
-- for n8n_readonly keeps that property.
--
-- n8n_readonly gets read and insert only. It cannot update or delete a token, a
-- send log row or a suppression, so it can never retract a client unsubscribe.

drop policy if exists n8n_readonly_select_email_unsubscribe_tokens on public.email_unsubscribe_tokens;
create policy n8n_readonly_select_email_unsubscribe_tokens
  on public.email_unsubscribe_tokens for select to n8n_readonly using (true);

drop policy if exists n8n_readonly_insert_email_unsubscribe_tokens on public.email_unsubscribe_tokens;
create policy n8n_readonly_insert_email_unsubscribe_tokens
  on public.email_unsubscribe_tokens for insert to n8n_readonly with check (true);

drop policy if exists n8n_readonly_select_email_send_log on public.email_send_log;
create policy n8n_readonly_select_email_send_log
  on public.email_send_log for select to n8n_readonly using (true);

drop policy if exists n8n_readonly_insert_email_send_log on public.email_send_log;
create policy n8n_readonly_insert_email_send_log
  on public.email_send_log for insert to n8n_readonly with check (true);

drop policy if exists n8n_readonly_select_suppressed_emails on public.suppressed_emails;
create policy n8n_readonly_select_suppressed_emails
  on public.suppressed_emails for select to n8n_readonly using (true);

drop policy if exists n8n_readonly_insert_suppressed_emails on public.suppressed_emails;
create policy n8n_readonly_insert_suppressed_emails
  on public.suppressed_emails for insert to n8n_readonly with check (true);

notify pgrst, 'reload schema';
