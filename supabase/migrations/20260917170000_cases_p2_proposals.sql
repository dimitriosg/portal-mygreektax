-- Cases P2: case proposals.
--
-- READ-ONLY. This migration creates no case, changes no row, and moves no
-- money. It adds two views that gather the evidence a person needs in order to
-- decide, one case at a time, which missing cases are real.
--
-- Why this exists: case serials were minted and used in real correspondence
-- before brain_conversations was the system of record for them. Today nine
-- distinct MGT-CSnnn-CLTnnnn codes appear in client email subjects, in
-- clients.case_code and on payment tokens with no case row behind any of them,
-- and MGT-CS002-CLT0009 is a genuine second case that two people transacted
-- and this database has never held.
--
-- Nothing here creates a case, because a backfill cannot know whether two
-- codes mean two pieces of work or one piece of work that got renamed. That
-- judgement stays with a person, and open_case() is still the only door.

-- ---------------------------------------------------------------------------
-- 1. Case proposals: a code that was used, with no case behind it.
--
-- Evidence, in descending order of how much it is worth:
--
--   message_subject  -- our own serial, put in an outbound subject by us and
--                       carried back verbatim by the client. The strongest,
--                       because it is a label we issued, not a deduction.
--   payment_token    -- set by a person when a payment link was raised.
--   client_case_code -- free text on clients, no foreign key, and the column
--                       family that has already drifted elsewhere in this
--                       database. A hint, never a truth.
--
-- The client segment of the code must match the client the evidence hangs off.
-- Zero rows violate that today across all 323 mentions, but a forwarded email
-- landing on another client's thread would otherwise propose a case under the
-- wrong person, which is the exact failure this whole plan exists to stop.
create or replace view public.v_case_proposals
with (security_invoker = true) as
with evidence as (
  -- regexp_matches(..., 'g') through a lateral, not regexp_match, because
  -- regexp_match returns only the FIRST match in a subject. A reply that
  -- quotes an old CS001 thread while raising CS002 work carries both serials,
  -- and that is the most likely failure this whole design has -- losing the
  -- second one would hide exactly the second case this screen exists to find.
  --
  -- (?![0-9]) after CLT[0-9]{4} stops a longer client number being truncated:
  -- without it, MGT-CS001-CLT00090 silently yields a false MGT-CS001-CLT0009.
  -- Neither case exists in the data today; both are one bad subject away.
  select x[1] as code,
         m.client_id,
         'message_subject'::text as source
    from public.messages m
    cross join lateral regexp_matches(
      m.subject, 'MGT-CS[0-9]{3}-CLT[0-9]{4}(?![0-9])', 'g') as x
   where m.client_id is not null

  union all
  select c.case_code, c.id, 'client_case_code'
    from public.clients c
   where c.case_code ~ '^MGT-CS[0-9]{3}-CLT[0-9]{4}$'

  union all
  select t.case_code, t.client_id, 'payment_token'
    from public.payment_tokens t
   where t.case_code ~ '^MGT-CS[0-9]{3}-CLT[0-9]{4}$'
     and t.client_id is not null
),
orphaned as (
  select e.code, e.client_id, e.source
    from evidence e
    join public.clients cl on cl.id = e.client_id
   where split_part(e.code, '-', 3) = split_part(cl.client_code, '-', 1)
     and not exists (
           select 1 from public.brain_conversations bc
            where bc.case_serial_id = e.code)
)
select
  o.client_id,
  cl.client_code,
  cl.full_name                                        as client_name,
  cl.stage                                            as client_stage,
  o.code                                              as proposed_case_serial_id,
  (substring(o.code from 'CS([0-9]{3})'))::int        as proposed_case_number,
  -- What open_case() would mint for this client AS OF THIS READ. It counts the
  -- same way open_case does -- max(case_number) + 1 over ALL of the client's
  -- cases, archived included -- so the screen can warn when creating a proposal
  -- would produce a different code from the one the client already has.
  --
  -- It is a prediction, not a guarantee, and the screen says so in those words.
  -- open_case() takes a per-client advisory lock before it reads the same
  -- maximum; this view takes no lock, so another case opened for the same
  -- client between this read and the button press moves the answer. open_case()
  -- returns the serial it actually minted and the UI reports that, so the
  -- outcome is always truthful even when the prediction was stale.
  (select coalesce(max(bc.case_number), 0) + 1
     from public.brain_conversations bc
    where bc.client_id = o.client_id)                 as next_case_number,
  count(*)                                            as mentions,
  array_agg(distinct o.source order by o.source)      as sources,
  (select count(*) from public.brain_conversations bc
    where bc.client_id = o.client_id
      and bc.archived_at is null)                     as live_cases,
  (select count(*) from public.jobs j
    where j.client_id = o.client_id)                  as client_jobs,
  (select count(*) from public.jobs j
    where j.client_id = o.client_id
      and j.case_id is null)                          as client_unfiled_jobs
from orphaned o
join public.clients cl on cl.id = o.client_id
group by o.client_id, cl.client_code, cl.full_name, cl.stage, o.code
order by cl.client_code, o.code;

comment on view public.v_case_proposals is
  'Case serials that were used in correspondence, on a payment token or in '
  'clients.case_code but have no brain_conversations row. Read-only evidence '
  'for a person to act on one at a time; creating a case is still open_case().';

-- ---------------------------------------------------------------------------
-- 2. Clients that must have a case and do not.
--
-- The stage rule: Parked and Lost need not have a case. Every other stage
-- must. This view is the assertion behind that rule, and P7 surfaces it as a
-- badge. It is separate from the proposals above because most of these clients
-- have no code evidence at all -- there is nothing to propose, only a gap to
-- fill by hand.
create or replace view public.v_clients_missing_case
with (security_invoker = true) as
select
  cl.id                                               as client_id,
  cl.client_code,
  cl.full_name                                        as client_name,
  cl.stage,
  (select count(*) from public.jobs j
    where j.client_id = cl.id)                        as jobs,
  (select count(*) from public.jobs j
    where j.client_id = cl.id and j.case_id is null)  as unfiled_jobs,
  (select count(*) from public.messages m
    where m.client_id = cl.id)                        as messages,
  -- Same prediction, and needed here for the same reason. This view selects on
  -- the absence of a LIVE case, but open_case() counts archived ones too, so a
  -- client whose only case is archived gets CS002 and not CS001. Three clients
  -- are in exactly that position today -- CLT0010, CLT0011 and CLT0012 -- so a
  -- hardcoded "Open CS001" on this list is wrong for a quarter of it.
  (select coalesce(max(bc.case_number), 0) + 1
     from public.brain_conversations bc
    where bc.client_id = cl.id)                       as next_case_number,
  exists (select 1 from public.v_case_proposals p
           where p.client_id = cl.id)                 as has_code_evidence
from public.clients cl
where cl.stage is distinct from 'Parked'
  and cl.stage is distinct from 'Lost'
  and not exists (
        select 1 from public.brain_conversations bc
         where bc.client_id = cl.id
           and bc.archived_at is null)
order by cl.client_code;

comment on view public.v_clients_missing_case is
  'Clients outside Parked and Lost with no live case. P7 surfaces this as a '
  'badge; the Definition of Done asserts it empty.';

-- ---------------------------------------------------------------------------
-- 3. ACLs.
--
-- Views need this as much as functions do, and for a sharper reason. Supabase's
-- default privileges grant SELECT on new tables and views to anon and
-- authenticated, and a view created without security_invoker runs as its owner,
-- so it reads through RLS on clients, messages and payment_tokens. Left alone,
-- these two would hand every client name, stage and job count to anyone holding
-- the publishable key.
--
-- Both views are also declared security_invoker, which is defence in depth and
-- not the boundary: it makes a reader's own RLS apply if these grants are ever
-- widened by accident. The revokes below are what actually closes the door.
-- Behaviour today is identical either way, because the only caller is
-- service_role, which bypasses RLS.
revoke all on public.v_case_proposals from public, anon, authenticated;
revoke all on public.v_clients_missing_case from public, anon, authenticated;

grant select on public.v_case_proposals to service_role;
grant select on public.v_clients_missing_case to service_role;

notify pgrst, 'reload schema';
