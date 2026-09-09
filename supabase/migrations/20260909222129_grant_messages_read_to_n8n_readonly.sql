-- Applied 2026-09-09 via Supabase MCP, file committed same session.
--
-- The Morning digest bucketed case quietness from clients.last_activity, which
-- was null on 5 of 13 open cases and stale on others (CLT0028-SW read 40 days
-- quiet on a day it had traffic). Quietness now derives from message traffic.
--
-- n8n_readonly holds column-level SELECT throughout this schema; public.messages
-- had none, so the digest threw "permission denied for table messages" at runtime.
-- Granting only the three columns the calculation needs. body, subject, from_addr
-- and to_addr stay unreadable to n8n: the digest needs to know that a message
-- existed, when, and which direction it went, never its contents.

grant select (client_id, ts, direction) on public.messages to n8n_readonly;
