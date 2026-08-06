-- newsletter_subscribers.status: default 'pending' -> 'active'
--
-- WHY: MyGreekTax moved from double opt-in to single opt-in. Submitting the
-- popup IS the consent event; there is no confirmation click to wait for.
--
-- The n8n "Newsletter capture" workflow already inserts 'active' explicitly.
-- The Make scenario "Newsletter Capture (Web -> EmailOctopus + CRM)", which is
-- the standby that receives signups only when n8n is unreachable, does NOT map
-- the status column at all: its Supabase module maps email, source and table
-- only. It therefore relies on this default. While the default was 'pending',
-- every signup caught by the fallback would have landed ineligible for the
-- newsletter, because the sender requires status = 'active'. That is a silent
-- failure: the visitor sees success, the row exists, and the person is never
-- emailed.
--
-- Changing the default rather than editing the Make blueprint keeps the rule in
-- one place, so any future writer that omits status also gets it right.
--
-- Existing rows are untouched. This is DDL on the column default only.
--
-- Already applied to the live database and recorded in schema_migrations as
-- 20260806084312, which is what this filename is timestamped to match, so the
-- CLI treats it as applied rather than re-running it. The notify below is
-- therefore a no-op against production. It is here for the case where this
-- file does execute, a replay onto a fresh or staging database, where
-- PostgREST would otherwise serve from a stale schema cache.

alter table public.newsletter_subscribers
  alter column status set default 'active';

notify pgrst, 'reload schema';
