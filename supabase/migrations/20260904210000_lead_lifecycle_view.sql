-- 20260904210000_lead_lifecycle_view.sql
--
-- The lead lifecycle spine: one row per client, carrying the moment that client
-- first reached each stage of the closing cycle.
--
-- WHERE THIS DATA COMES FROM, AND WHY IT IS ALREADY HERE.
--
-- Nothing new is recorded to build this. public.activity_events has been
-- logging 'lead_stage_changed' since 12 May 2026 with a metadata payload of
-- {field, from, to, leadId}, which is a complete stage-transition history that
-- until now nothing read. The closing cycle is reconstructed from it rather
-- than from new columns, so there is no backfill and no write path to change.
--
-- WHY 'Active' IS THE DEPOSIT MILESTONE.
--
-- Migration 20260901191346 documents that entry to stage Active belongs to the
-- deposit gate: recompute_client_stage returns early while every counted job is
-- still Pending or To Assign, so a lead only lands on Active once money has
-- arrived. The first transition into Active is therefore the best "deposit
-- paid" signal this database has — 19 clients — and it is far better than the
-- alternatives: jobs.paid_at is populated on 1 job of 47, and payments has 6
-- rows and no job_id at all. Read that column, not the money tables.
--
-- WHY FIRST ARRIVAL, NOT CURRENT STAGE.
--
-- Stages move backwards in this data: Complete -> Active 4 times, Delivered ->
-- Active once, Parked -> Potential 5 times. A lead that completed and reopened
-- has still been quoted, still been paid. So each milestone is min(occurred_at)
-- for that stage — the first time it was reached, never the last, and never the
-- client's current stage. current_stage is carried separately for "where is
-- this lead now", which is a different question and answered differently.
--
-- WHY THE UUID GUARD IS NOT OPTIONAL.
--
-- 20 of the 136 lead_stage_changed rows carry a legacy Airtable record id
-- (recXXXXXXXX) in metadata->>'leadId' rather than a uuid. Casting the column
-- without the regex raises 22P02 and the whole view fails. Those 20 rows are
-- history that cannot be linked to a client, so they are excluded here and
-- counted in v_report_data_quality instead of vanishing quietly.
--
-- WHY quoted_at TAKES THE LATER OF TWO DATES BEFORE TAKING THE EARLIER.
--
-- There are two independent quote signals: clients.quote_sent_date (26 rows)
-- and the first transition into Quoted (21 rows), overlapping on 19. Using both
-- lifts coverage to 28. But quote_sent_date is a date, so it casts to midnight,
-- and a lead created at 14:30 whose quote went out the same day would appear to
-- have been quoted 14 hours before it existed — which it did, for 13 clients,
-- until this clamp. greatest() pins the date-grain signal to no earlier than
-- creation; the case guard is required because greatest() ignores nulls and
-- would otherwise return created_at for every client that was never quoted,
-- marking all 54 as quoted. least() then prefers whichever signal is earlier.
--
-- NO CASH, SAME AS THE REST OF THE REPORTS PAGE.
--
-- This view reads no money column. Note that clients.lead_value belongs to the
-- same drifted client-level family as quote_amount, deposit, balance_due and
-- partner_fee, and is deliberately not carried here either.

drop view if exists public.v_report_lead_lifecycle;

create view public.v_report_lead_lifecycle
with (security_invoker = true) as
with stage_events as (
  select (ae.metadata->>'leadId')::uuid as client_id,
         ae.metadata->>'to'             as to_stage,
         ae.occurred_at
  from public.activity_events ae
  where ae.event_type = 'lead_stage_changed'
    and ae.metadata->>'to' is not null
    and ae.metadata->>'leadId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
first_reach as (
  select client_id, to_stage, min(occurred_at) as reached_at
  from stage_events
  group by client_id, to_stage
)
select
  c.id                as client_id,
  c.client_code,
  c.full_name         as client_name,
  c.source,
  c.stage             as current_stage,
  c.status            as current_status,
  c.created_at        as lead_created_at,
  least(
    (select reached_at from first_reach f where f.client_id = c.id and f.to_stage = 'Quoted'),
    case when c.quote_sent_date is not null
         then greatest(c.quote_sent_date::timestamptz, c.created_at) end
  )                                                                            as quoted_at,
  (select reached_at from first_reach f where f.client_id = c.id and f.to_stage = 'Active')    as active_at,
  (select reached_at from first_reach f where f.client_id = c.id and f.to_stage = 'Delivered') as delivered_at,
  (select reached_at from first_reach f where f.client_id = c.id and f.to_stage = 'Complete')  as complete_at,
  (select reached_at from first_reach f where f.client_id = c.id and f.to_stage = 'Lost')      as lost_at,
  (select reached_at from first_reach f where f.client_id = c.id and f.to_stage = 'Parked')    as parked_at,
  c.last_activity     as last_activity_at,
  c.next_action,
  c.next_action_date
from public.clients c;

comment on view public.v_report_lead_lifecycle is
  'One row per client with the first moment it reached each stage of the closing cycle, reconstructed from activity_events. active_at is the deposit milestone (entry to Active is deposit-gated). Milestones are first arrival, not current stage, because stages move backwards. Carries no money column.';

grant select on public.v_report_lead_lifecycle to service_role;

-- ---------------------------------------------------------------------------
-- Two more data quality checks, for the drift this view exposes
-- ---------------------------------------------------------------------------
--
-- Both are about lead history rather than money, and both are things the funnel
-- would otherwise hide. Same rule as the existing four: non-zero is a warning,
-- not an error.

drop view if exists public.v_report_data_quality;

create view public.v_report_data_quality
with (security_invoker = true) as
select 'jobs_missing_wholesale' as check_key,
       'Live jobs with no accountant fee set' as label,
       count(*)::numeric as value
from public.v_report_jobs where wholesale_missing and not is_cancelled
union all
select 'payments_unlinked',
       'Payments that cannot be attributed to a job',
       count(*)::numeric
from public.payments p
left join public.payment_tokens t on t.token = p.token
where t.job_id is null
union all
select 'client_quote_vs_jobs_gap',
       'Total disagreement between clients.quote_amount and the sum of their jobs',
       coalesce(sum(abs(coalesce(c.quote_amount,0) - coalesce(j.retail,0))),0)
from public.clients c
join (select client_id, sum(retail) as retail from public.v_report_jobs
      where not is_cancelled group by client_id) j on j.client_id = c.id
union all
select 'stage_status_conflict',
       'Clients whose stage and status contradict each other',
       count(*)::numeric from public.clients
where (stage = 'Lost'     and status = 'Active')
   or (stage = 'Complete' and status = 'Prospect')
   or (stage = 'Parked'   and status = 'Prospect')
union all
-- Excluded by the uuid guard in v_report_lead_lifecycle: real history that
-- cannot be attached to a client, so it silently shrinks every funnel figure.
select 'lead_history_unlinkable',
       'Lead stage changes that cannot be linked to a client',
       count(*)::numeric
from public.activity_events
where event_type = 'lead_stage_changed'
  and metadata->>'leadId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
union all
-- A lead recorded as paid before it was quoted, or completed before it was
-- paid. The counts still hold, but any duration measured across those steps
-- would be negative, so the drift is named before anyone measures velocity.
select 'lead_milestones_out_of_order',
       'Leads whose closing-cycle milestones are recorded out of sequence',
       count(*)::numeric
from public.v_report_lead_lifecycle
where active_at < quoted_at
   or complete_at < active_at
   or delivered_at < active_at;

comment on view public.v_report_data_quality is
  'Six drift checks behind the data quality panel on /admin/reports. payments_unlinked counts only payments that genuinely cannot be traced to a job. client_quote_vs_jobs_gap sums the absolute per-client difference so opposite drifts cannot cancel, and reads clients.quote_amount solely to measure that disagreement. The two lead_* checks measure history the funnel cannot use.';

grant select on public.v_report_data_quality to service_role;

notify pgrst, 'reload schema';
