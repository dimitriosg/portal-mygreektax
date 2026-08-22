-- 20260822174316_payment_tables_n8n_grants.sql
--
-- Fixes: "permission denied for table payment_tokens" on every call to
-- 60 · Payment signal intake (n8n executions 694 and 698, 22 Aug 2026).
--
-- WHY IT BROKE
-- 20260819195806 created payment_tokens / payment_signals / payments with RLS
-- enabled and no policies, on the assumption that only the portal would touch
-- them. The portal reaches Supabase as `service_role`, which both bypasses RLS
-- and is granted by Supabase's default privileges, so the portal was fine.
--
-- n8n does not. Its Postgres credential connects as `n8n_readonly` — a
-- least-privilege role despite the name — which has neither BYPASSRLS nor any
-- grant on the new tables. So the first statement touching payment_tokens
-- failed outright.
--
-- THE HOUSE PATTERN, followed here
-- Every table n8n_readonly can use carries BOTH a GRANT and a matching
-- per-role RLS policy named n8n_readonly_<action>_<table>. See
-- newsletter_subscribers, email_send_log, suppressed_emails,
-- email_unsubscribe_tokens and the read-only grant on clients. A GRANT alone
-- is not enough: RLS is on, so without a policy the role sees zero rows and
-- writes are refused.
--
-- WHAT 60 ACTUALLY NEEDS, and nothing more
--   payment_signals  INSERT  the row it writes
--                    SELECT  the 24h not-exists dedupe check
--   payment_tokens   SELECT  the left join, and the WHERE of the bump update
--                    UPDATE  open_count / first_opened_at / last_opened_at /
--                            last_country on a portal_view
--
-- `payments` is deliberately left alone. Nothing writes to it until
-- 00 · Record payment exists, and write access to the money table should be
-- granted at the moment something needs it, not in advance.
--
-- Idempotent: safe to re-run.

grant select, insert on public.payment_signals to n8n_readonly;
grant select, update on public.payment_tokens  to n8n_readonly;

drop policy if exists n8n_readonly_insert_payment_signals on public.payment_signals;
create policy n8n_readonly_insert_payment_signals
  on public.payment_signals for insert to n8n_readonly
  with check (true);

drop policy if exists n8n_readonly_select_payment_signals on public.payment_signals;
create policy n8n_readonly_select_payment_signals
  on public.payment_signals for select to n8n_readonly
  using (true);

drop policy if exists n8n_readonly_select_payment_tokens on public.payment_tokens;
create policy n8n_readonly_select_payment_tokens
  on public.payment_tokens for select to n8n_readonly
  using (true);

drop policy if exists n8n_readonly_update_payment_tokens on public.payment_tokens;
create policy n8n_readonly_update_payment_tokens
  on public.payment_tokens for update to n8n_readonly
  using (true)
  with check (true);

notify pgrst, 'reload schema';
