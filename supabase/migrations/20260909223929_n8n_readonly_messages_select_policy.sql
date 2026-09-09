-- Applied 2026-09-09 via Supabase MCP, file committed same session.
--
-- Follow-up to 20260909222129_grant_messages_read_to_n8n_readonly.sql. The
-- column grant alone was not enough. public.messages has RLS enabled, and with
-- no policy for n8n_readonly every row was filtered out, so the digest query
-- succeeded and returned nulls for last_outbound, last_inbound and last_touch.
-- A silent wrong answer, which is worse than the permission error it replaced.
--
-- Same shape as n8n_readonly_select_clients, _jobs and _brain_conversations.
-- using (true) is safe because the column grant still limits n8n_readonly to
-- client_id, ts and direction. Message content stays unreadable.

drop policy if exists n8n_readonly_select_messages on public.messages;

create policy n8n_readonly_select_messages
  on public.messages
  for select
  to n8n_readonly
  using (true);
