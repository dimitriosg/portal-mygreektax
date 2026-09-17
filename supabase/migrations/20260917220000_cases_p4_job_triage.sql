-- Cases P4: the job triage list.
--
-- READ-ONLY. This migration files no job, creates no case and changes no row.
-- It adds one view gathering what a person needs in order to decide, job by
-- job, which case each of the 50 unfiled jobs belongs to.
--
-- Filing still happens through public.assign_job_to_case(), one confirmation at
-- a time, exactly as the /leads dialog already does it. Nothing here assigns
-- anything, and no bulk action exists: "a person confirms every assignment,
-- including where the evidence looks unambiguous" is a stated rule of this
-- system, and a single button that files twenty jobs is not twenty
-- confirmations.
--
-- WHAT THE EVIDENCE ACTUALLY LOOKS LIKE, measured rather than assumed
--
-- The plan expected case codes to drive this. They barely do. Of 50 unfiled
-- jobs today only 5 carry a case code anywhere -- 2 whose case exists, 3 whose
-- case does not exist yet -- and none carries two conflicting codes. The other
-- 45 have no code at all, so a screen built around code evidence would be
-- empty for 90% of the work.
--
-- What decides the other 45 is far simpler, and it is the number of cases the
-- client has:
--
--   24 jobs (12 clients) -> the client has exactly ONE live case, so there is
--                           exactly one possible destination. Still a person's
--                           click, but not a judgement.
--   26 jobs (21 clients) -> the client has NO live case, so these cannot be
--                           filed at all until one exists. That is what the
--                           case proposals screen is for, and the two chain.
--    0 jobs               -> no client with several cases has an unfiled job,
--                           so no job needs a "which of these?" decision today.
--                           That changes the moment a second case is opened.
--
-- So this view leads with the client's case count, and carries the code
-- evidence alongside for the handful that have it.

create or replace view public.v_unfiled_jobs
with (security_invoker = true) as
with evidence as (
  -- A payment link raised for this job, carrying a case code. Set by a person
  -- at mint time, so it is worth something.
  select t.job_id, t.case_code, 'payment_token'::text as source
    from public.payment_tokens t
   where t.job_id is not null
     and t.case_code ~ '^MGT-CS[0-9]{3}-CLT[0-9]{4}$'

  union all

  -- A payment_confirmed activity row naming both the job and the case. Joined
  -- on job_code because these rows predate activity_events having real foreign
  -- key columns.
  select j.id, a.metadata->>'caseCode', 'payment_confirmed_event'
    from public.activity_events a
    join public.jobs j on j.job_code = a.metadata->>'jobCode'
   where a.metadata->>'caseCode' ~ '^MGT-CS[0-9]{3}-CLT[0-9]{4}$'
),
-- One row per (job, code), however many times that pairing appears.
job_codes as (
  select distinct e.job_id, e.case_code from evidence e
),
-- Live cases per client, with the first one picked out so the "exactly one"
-- case can be offered without a second query. Ordered by case_number so the
-- choice is deterministic rather than whatever the planner returns.
client_cases as (
  select bc.client_id,
         count(*)                                                    as n,
         (array_agg(bc.id order by bc.case_number))[1]               as first_case_id,
         (array_agg(bc.case_serial_id order by bc.case_number))[1]   as first_case_serial_id
    from public.brain_conversations bc
   where bc.archived_at is null
   group by bc.client_id
)
select
  j.id                                                  as job_id,
  j.job_code,
  j.status,
  j.date_sent,
  j.client_fee,
  sc.service_name,
  sc.category                                           as service_category,
  j.client_id,
  cl.client_code,
  cl.full_name                                          as client_name,
  cl.stage                                              as client_stage,

  -- The deciding fact for most of this list.
  coalesce(cc.n, 0)                                     as client_live_cases,

  -- Populated ONLY when the client has exactly one live case, so the screen can
  -- offer that one destination directly instead of making a person pick from a
  -- list of one. Null whenever there is a genuine choice to make, which is the
  -- point: this view never chooses between cases.
  case when cc.n = 1 then cc.first_case_id end          as only_case_id,
  case when cc.n = 1 then cc.first_case_serial_id end   as only_case_serial_id,

  -- The code evidence, for the few jobs that have any. An array because two
  -- codes for one job is a real possibility -- JB148 carried CS001 and CS002
  -- before it was filed by hand -- and a conflict must be shown as a conflict,
  -- never resolved here.
  (select array_agg(distinct jc.case_code order by jc.case_code)
     from job_codes jc where jc.job_id = j.id)          as evidence_codes,
  (select array_agg(distinct e.source order by e.source)
     from evidence e where e.job_id = j.id)             as evidence_sources,

  -- Whether a code found for this job resolves to a real case OF THIS CLIENT.
  -- A code naming another client's case is not a destination for this job, and
  -- the composite foreign key would refuse it anyway.
  (select count(*) from job_codes jc
     join public.brain_conversations bc
       on bc.case_serial_id = jc.case_code
      and bc.client_id = j.client_id
      and bc.archived_at is null
    where jc.job_id = j.id)                             as evidence_cases_that_exist
from public.jobs j
join public.clients cl on cl.id = j.client_id
left join public.service_catalog sc on sc.id = j.service_id
left join client_cases cc on cc.client_id = j.client_id
where j.case_id is null
order by cl.client_code, j.job_code;

comment on view public.v_unfiled_jobs is
  'Jobs with no case, with the context needed to file them: the client, how '
  'many live cases that client has, the single case when there is only one, '
  'and any case-code evidence. Read-only -- filing goes through '
  'assign_job_to_case() one confirmation at a time.';

-- Same ACL discipline as the P2 views. Supabase grants SELECT on new views to
-- anon and authenticated by default; this one exposes client names, stages and
-- job fees, so it is revoked and granted to service_role alone.
revoke all on public.v_unfiled_jobs from public, anon, authenticated;
grant select on public.v_unfiled_jobs to service_role;

notify pgrst, 'reload schema';
