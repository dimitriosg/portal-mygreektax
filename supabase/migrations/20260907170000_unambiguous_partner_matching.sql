-- 20260907170000_unambiguous_partner_matching.sql
--
-- Stop attaching a partner message to more than one case, and make the messages
-- that go unattached countable instead of silent.
--
-- WHAT WAS WRONG.
--
-- v_case_messages matched partner mail on the CLTnnnn code in the subject
-- against left(client_code, 7). client_code is unique; its first seven
-- characters are not. 'CLT0041-XX' and 'CLT0041-SO' are two different clients
-- sharing prefix CLT0041, so a partner message whose subject said CLT0041 would
-- join to both rows and appear in both case timelines.
--
-- 20260907120000 documented this and left it, on the reasoning that dropping
-- the message undercounts and the data cannot say which of the two clients it
-- is about. That reasoning was incomplete. A double does not merely inflate a
-- count: on the per-case page it puts a message about one client into a
-- different client's conversation, and the whole premise of the feature is that
-- a case's page can be trusted. Wrong attribution is worse than absence.
--
-- WHAT THIS DOES INSTEAD.
--
-- A subject prefix is used only when it identifies exactly one client. An
-- ambiguous prefix attaches to nobody — and then, so that the exclusion is not
-- the silent undercount that was the objection to dropping in the first place,
-- v_case_correspondence_unmatched lists every partner message that failed to
-- attach, with the reason.
--
-- ZERO ROWS CHANGE TODAY. No partner message mentions CLT0041, so
-- v_case_messages still returns 113 and v_case_correspondence still returns 19.
-- This is a rule change, not a data change.

drop view if exists public.v_case_correspondence_unmatched;
drop view if exists public.v_case_correspondence;
drop view if exists public.v_case_messages;

-- ---------------------------------------------------------------------------
-- 1. v_case_messages, with the prefix required to be unambiguous
-- ---------------------------------------------------------------------------
--
-- The prefix CTE is computed once per query rather than as a correlated
-- subquery per row. It carries only the count: the join still matches on
-- left(client_code, 7), and the CTE's job is purely to gate that match on the
-- prefix being unique. Resolving the client id inside the CTE would have been
-- the obvious alternative and does not work — there is no min(uuid) in
-- Postgres, and casting through text to get one would be inventing a tie-break
-- for exactly the ambiguous case this migration exists to refuse.

create view public.v_case_messages
with (security_invoker = true) as
with prefix as (
  select
    left(client_code, 7) as clt,
    count(*)             as clients
  from public.clients
  where client_code is not null
  group by left(client_code, 7)
),
tagged as (
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
  on (t.party = 'client' and c.id = t.client_id)
  or (
    t.party = 'partner'
    and left(c.client_code, 7) = t.subject_clt
    and exists (
      select 1 from prefix p where p.clt = t.subject_clt and p.clients = 1
    )
  )
where t.party in ('client', 'partner');

comment on view public.v_case_messages is
  'One row per Gmail message that belongs to a case, with party = client | partner. Client mail matches on messages.client_id; partner mail (Chrysostomos, who has no client_id) matches on the CLTnnnn code in the subject against left(client_code,7), but only where that prefix identifies exactly one client — an ambiguous prefix attaches to nobody rather than to several. The inner join also drops non-case mail (Instagram, bank, AADE, phishing) and partner mail with no code in the subject. Everything it drops is listed in v_case_correspondence_unmatched. snippet is ~300 characters, not the full body.';

revoke all on public.v_case_messages from anon, authenticated;
grant select on public.v_case_messages to service_role;

-- ---------------------------------------------------------------------------
-- 2. v_case_correspondence, unchanged in body, recreated because it depends
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- 3. v_case_correspondence_unmatched — what the matching rule could not place
-- ---------------------------------------------------------------------------
--
-- One row per partner message that did not attach to a case, with the reason,
-- so that an exclusion is a number on the page rather than a quiet absence.
-- This is the half of "exclude ambiguous prefixes" that makes the exclusion
-- honest; without it the fix above would trade a visible double for an
-- invisible drop.
--
-- Two reasons, and they mean different things:
--
--   no_case_code   The subject carries no CLTnnnn at all. Three rows today, all
--                  the multi-case digest thread 'ΣΥΝΟΨΗ ΑΝΑΘΕΣΕΩΝ', which is
--                  not about one case and correctly attaches to none. This
--                  becomes worth acting on if the subject convention lapses.
--   ambiguous_code The prefix matches more than one client_code. Zero rows
--                  today. Whoever sees one has to decide by hand which case the
--                  message belongs to; the fix is a fuller case identifier in
--                  the subject line, not a tie-break here.
--
-- Client mail is out of scope: it matches on client_id, which is either set or
-- not, so there is no ambiguity to report.

create view public.v_case_correspondence_unmatched
with (security_invoker = true) as
with prefix as (
  select
    left(client_code, 7) as clt,
    count(*)             as clients
  from public.clients
  where client_code is not null
  group by left(client_code, 7)
),
partner_mail as (
  select
    m.message_id,
    m.thread_id,
    m.direction,
    m.ts,
    m.subject,
    upper((regexp_match(coalesce(m.subject, ''), 'CLT[0-9]{4}'))[1]) as subject_clt
  from public.messages m
  where m.from_addr = 'chris_fta@yahoo.gr'
     or m.to_addr   = 'chris_fta@yahoo.gr'
)
select
  pm.message_id,
  pm.thread_id,
  pm.direction,
  pm.ts,
  pm.subject,
  pm.subject_clt,
  coalesce(p.clients, 0) as matching_clients,
  case
    when pm.subject_clt is null then 'no_case_code'
    else 'ambiguous_code'
  end as reason,
  'https://mail.google.com/mail/u/0/#all/' || pm.thread_id as gmail_url
from partner_mail pm
left join prefix p on p.clt = pm.subject_clt
where pm.subject_clt is null       -- no CLTnnnn in the subject at all
   or coalesce(p.clients, 0) <> 1; -- or the prefix names none, or several

comment on view public.v_case_correspondence_unmatched is
  'Partner messages that v_case_messages could not attach to exactly one case, with reason = no_case_code (no CLTnnnn in the subject) or ambiguous_code (the prefix matches more than one client_code, or none). Exists so that excluding a message is a visible count rather than a silent undercount. Three rows today, all the ΣΥΝΟΨΗ ΑΝΑΘΕΣΕΩΝ digest thread, which is genuinely about no single case.';

revoke all on public.v_case_correspondence_unmatched from anon, authenticated;
grant select on public.v_case_correspondence_unmatched to service_role;

notify pgrst, 'reload schema';
