-- 20260907120000_case_correspondence_and_sync_runs.sql
--
-- The data layer behind the Correspondence view on /leads: one table that
-- records when the Gmail sync last ran, and two views that resolve
-- public.messages into the two conversations that actually run per case.
--
-- WHY THIS EXISTS AT ALL.
--
-- Case state currently lives in clients.next_action and free-text job notes,
-- both hand-maintained and both already wrong in places. clients.last_activity
-- said one Active client had been silent for five weeks while the mailbox held
-- ten messages with him inside the last fortnight. Two separate conversations
-- run per case — Jim and the client, and Jim and Chrysostomos about that client
-- — and neither has been visible next to the other. The second is where cases
-- stall. These views make both countable from data instead of from notes.
--
-- WHERE THE DATA COMES FROM.
--
-- public.messages, one row per Gmail message, written by n8n workflow
-- uSQOKDb9YLNxiIIT ("20 · Sync Gmail to messages"). Nothing new is recorded to
-- build these views and there is no backfill: they are a reading of rows that
-- are already there.

-- ---------------------------------------------------------------------------
-- 1. sync_runs
-- ---------------------------------------------------------------------------
--
-- WHY A SEPARATE TABLE RATHER THAN max(messages.created_at).
--
-- "Last refreshed" and "when did a new message last land" are different
-- questions and only the second one is answerable from public.messages. On a
-- quiet day max(created_at) reads as hours stale even though the sync ran five
-- minutes ago, and a user correctly reads that as broken. Worse, the failure
-- mode this whole feature exists to remove is silent staleness — a page that
-- looks current and is not — so a run that FAILED has to be distinguishable
-- from a run that succeeded and found nothing. Neither is derivable. The run
-- has to be recorded in its own right.
--
-- Written by n8n (one insert at the start of a run, one update at the end),
-- read by the portal. It is deliberately generic: source is 'gmail' for this
-- feature, but nothing here is Gmail-specific and the next sync that needs a
-- freshness indicator should write here too rather than inventing its own.

create table if not exists public.sync_runs (
  id           uuid primary key default gen_random_uuid(),
  source       text        not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text        not null default 'running',
  rows_written integer     not null default 0,
  error        text,
  triggered_by text        not null default 'schedule'
);

-- The portal's only read is "latest run for this source", so the index carries
-- the source first and the timestamp descending.
create index if not exists sync_runs_source_started_idx
  on public.sync_runs (source, started_at desc);

comment on table public.sync_runs is
  'One row per run of a background sync. Written by n8n, read by the portal to show when data was last refreshed. status is running | succeeded | failed; triggered_by is schedule | portal. Exists because freshness cannot be derived from the synced rows themselves: a quiet period and a broken sync look identical from max(created_at).';

comment on column public.sync_runs.source is
  'Which sync ran. ''gmail'' for the messages sync (n8n workflow uSQOKDb9YLNxiIIT).';
comment on column public.sync_runs.status is
  'running | succeeded | failed. A row left on ''running'' means the workflow died before its closing update, and the portal treats it as in flight, not as success.';
comment on column public.sync_runs.triggered_by is
  'schedule | portal. Distinguishes the 2-hourly cron from a manual Refresh, so a rate limit can count only the manual ones.';

alter table public.sync_runs enable row level security;

-- No policies. public.messages carries client correspondence, which holds
-- whatever a client chose to type: as this migration was written, one July row
-- contained a TAXISnet username and password in plaintext. That row was
-- redacted afterwards (see 20260907160000) and the Gmail sync now masks
-- credential shapes before insert, but the rule stands on the class of data
-- rather than on any one row, so anything reading alongside it stays behind the
-- service role. RLS on with zero policies means authenticated and anon get
-- nothing, and service_role bypasses RLS.
--
-- THE REVOKE IS NOT REDUNDANT, AND THIS WAS LEARNED THE HARD WAY.
--
-- This Supabase project carries default privileges that grant ALL on every new
-- table and view in `public` to anon, authenticated and service_role. So a bare
-- `grant ... to service_role` does not produce "service_role only": it produces
-- service_role plus two roles nobody intended, including INSERT/UPDATE/DELETE.
-- RLS still held when this first went in — anon and authenticated read zero rows
-- from all three objects, verified by probing under `set role` — so nothing
-- leaked. But the grant would become a live write surface the moment anyone adds
-- a policy to sync_runs, and a stock Postgres has no such default privileges, so
-- the mistake is invisible when the migration is tested locally. Revoke first,
-- then grant exactly what is wanted.
revoke all on public.sync_runs from anon, authenticated;
grant select, insert, update on public.sync_runs to service_role;

-- ---------------------------------------------------------------------------
-- 2. v_case_messages — one row per message, resolved to a case
-- ---------------------------------------------------------------------------
--
-- Feeds the per-case side-by-side page, and is the base for
-- v_case_correspondence below, so the matching rule is written exactly once.
--
-- THE TWO MATCHING RULES ARE NOT THE SAME, AND THAT IS THE POINT.
--
-- Client mail matches by address: messages.client_id was resolved at sync time
-- and points at clients.id.
--
-- Partner mail cannot. Chrysostomos is not a client, so every message to or
-- from him carries client_id null. Those attach to a case through the CLTnnnn
-- code in the subject line — 'Re: MGT-CS001-CLT0052: Stephan Polshaw' resolves
-- to clients.client_code 'CLT0052-PL' — which is why the join compares
-- left(client_code, 7) against a code pulled out of the subject.
--
-- WHY THE PARTY TEST PUTS PARTNER FIRST.
--
-- A message that is both addressed to Chrysostomos and carries a client_id
-- would otherwise be counted as client correspondence, which would put a
-- partner exchange in the client column. Today no row is both; the ordering is
-- there so that a future one lands on the right side.
--
-- WHY join AND NOT left join.
--
-- public.messages also holds rows that are neither conversation: Instagram
-- notices, bank mail, AADE notifications and one phishing attempt — 10 rows as
-- at 07/09/2026. The inner join is what drops them, along with partner mail
-- carrying no CLTnnnn code. Both exclusions are intentional. Of 126 rows, 100
-- resolve as client and 13 as partner, so this view returns 113.
--
-- KNOWN LIMIT — THE THREE UNCODED PARTNER MESSAGES.
--
-- The 3 partner rows dropped for having no CLTnnnn code are all the multi-case
-- digest thread 'ΣΥΝΟΨΗ ΑΝΑΘΕΣΕΩΝ', which is not about one case and correctly
-- attaches to none. If the subject convention lapses more widely, the partner
-- columns undercount silently. That is worth a data-quality count; it is not
-- one here.
--
-- DUPLICATE CLTnnnn PREFIXES DOUBLE-COUNT — SUPERSEDED BY 20260907170000.
--
-- client_code is unique but its first seven characters are not:
-- 'CLT0041-XX' and 'CLT0041-SO' are two different clients sharing prefix
-- CLT0041, so as written below a partner message whose subject says CLT0041
-- matches both rows and is counted twice, once against each. This migration
-- left that in, reasoning that the data cannot say which of the two clients
-- such a message is about and that a visible double beats an arbitrary pick.
--
-- That reasoning was wrong about what the double costs. It is not only an
-- inflated count: on the per-case page it puts a message about one client into
-- another client's conversation, and a case timeline you cannot trust is worse
-- than one with a gap in it. 20260907170000 recreates the view with the prefix
-- required to identify exactly one client, and adds
-- v_case_correspondence_unmatched so the messages it declines to place are a
-- count on the page rather than a silent drop. No partner message mentions
-- CLT0041 today, so no row changed: read 20260907170000 for the rule in force.
--
-- KNOWN LIMIT — body IS A SNIPPET.
--
-- The sync writes roughly the first 300 characters, deliberately: full bodies
-- would put client credentials into Supabase. It is aliased to `snippet` here
-- so that no reader of this view mistakes it for the email.

drop view if exists public.v_case_correspondence;
drop view if exists public.v_case_messages;

create view public.v_case_messages
with (security_invoker = true) as
with tagged as (
  select
    m.*,
    case
      when m.from_addr = 'chris_fta@yahoo.gr'
        or m.to_addr   = 'chris_fta@yahoo.gr' then 'partner'
      when m.client_id is not null            then 'client'
      else 'other'
    end as party,
    upper((regexp_match(coalesce(m.subject, ''), 'CLT[0-9]{4}'))[1]) as subject_clt
  from public.messages m
)
select
  t.message_id,
  t.thread_id,
  t.party,
  t.direction,
  t.ts,
  t.subject,
  t.body            as snippet,
  t.from_addr,
  t.to_addr,
  c.id              as client_id,
  c.client_code,
  c.full_name       as client_name,
  c.stage,
  'https://mail.google.com/mail/u/0/#all/' || t.thread_id as gmail_url
from tagged t
join public.clients c
  on (t.party = 'client'  and c.id = t.client_id)
  or (t.party = 'partner' and left(c.client_code, 7) = t.subject_clt)
where t.party in ('client', 'partner');

comment on view public.v_case_messages is
  'One row per Gmail message that belongs to a case, with party = client | partner. Client mail matches on messages.client_id; partner mail (Chrysostomos, who has no client_id) matches on the CLTnnnn code in the subject against left(client_code,7). The inner join deliberately drops non-case mail — Instagram, bank, AADE, phishing — and partner mail with no code in the subject. snippet is ~300 characters, not the full body.';

revoke all on public.v_case_messages from anon, authenticated;
grant select on public.v_case_messages to service_role;

-- ---------------------------------------------------------------------------
-- 3. v_case_correspondence — one row per case
-- ---------------------------------------------------------------------------
--
-- Feeds the consolidated table. Six counts and three dates per case, from the
-- view above so the matching rule cannot drift between the two pages.
--
-- The counts are split by party AND direction rather than totalled because the
-- signal worth surfacing is asymmetric: partner_in 0 alongside partner_out 2
-- means Jim has written and Chrysostomos has not replied, which is where cases
-- stall. A single "partner messages: 2" would hide it.
--
-- max(ts) is null where a party has no messages, and the page renders that as
-- an em-space rather than a zero: no partner row on an Active case usually
-- means the exchange happened on WhatsApp, which is absence of data, not a
-- count of nothing.
--
-- No stage is excluded. Partner correspondence usually sits on Active cases but
-- not always, and filtering by stage is the page's job, not the view's.

create view public.v_case_correspondence
with (security_invoker = true) as
select
  client_id,
  client_code,
  client_name,
  stage,
  count(*) filter (where party = 'client'  and direction = 'Inbound')  as client_in,
  count(*) filter (where party = 'client'  and direction = 'Outbound') as client_out,
  max(ts)  filter (where party = 'client')                             as client_last,
  count(*) filter (where party = 'partner' and direction = 'Inbound')  as partner_in,
  count(*) filter (where party = 'partner' and direction = 'Outbound') as partner_out,
  max(ts)  filter (where party = 'partner')                            as partner_last,
  max(ts)                                                              as any_last
from public.v_case_messages
group by client_id, client_code, client_name, stage;

comment on view public.v_case_correspondence is
  'One row per case with correspondence: six counts (client and partner, inbound and outbound) and three last-message timestamps, aggregated from v_case_messages. A case with no messages at all does not appear. client_last or partner_last null means that conversation has no email on record, which is not the same as zero and is rendered as an em-space rather than a date.';

revoke all on public.v_case_correspondence from anon, authenticated;
grant select on public.v_case_correspondence to service_role;

notify pgrst, 'reload schema';
