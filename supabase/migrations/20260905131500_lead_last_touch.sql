-- 20260905131500_lead_last_touch.sql
--
-- Adds last_touch_at to v_report_lead_lifecycle, because the "gone quiet"
-- watchlist was accusing active clients of having been abandoned.
--
-- WHAT WAS WRONG.
--
-- The watchlist used clients.last_activity, falling back to created_at when it
-- was null. That column is populated on 28 of 55 clients and is not maintained,
-- so the fallback did the work — and the fallback is the client's birthday.
-- Measured against production the day this was written:
--
--   Angel Enriquez     reported 62 days quiet, actually touched that same day
--   Alexandros Cocolis reported 36 days quiet, actually touched that same day
--
-- Both had live jobs moving. Every one of the 12 open leads had been touched
-- within 14 days, so the honest length of that list is zero. A watchlist that
-- names people who need nothing is worse than no watchlist: it costs a check
-- each time and teaches you to stop reading it.
--
-- WHAT last_touch_at IS.
--
-- The most recent of three signals that actually move when work happens:
-- clients.last_activity where it is set, the newest activity_events row for
-- that lead, and the newest job change for that client. Coalesced to
-- created_at so it is never null — a lead with no recorded activity at all is
-- genuinely as old as it is, and that is the one case the old rule got right.
--
-- The same uuid guard as the rest of this view: 20 activity_events rows carry a
-- legacy Airtable record id and cannot be linked to a client.

-- v_report_data_quality selects from this view for its out-of-order check, so
-- it has to come down first and go back up after. Dropped and recreated
-- unchanged rather than left alone, because a plain drop of the lifecycle view
-- fails with 2BP01 while the dependant exists.
drop view if exists public.v_report_data_quality;
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
),
-- Any event about this lead, not just a stage change: a field edit, a tracking
-- link opened, a payment confirmed. All of them mean somebody touched it.
event_touch as (
  select (ae.metadata->>'leadId')::uuid as client_id, max(ae.occurred_at) as touched_at
  from public.activity_events ae
  where ae.metadata->>'leadId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  group by 1
),
-- Work moving is activity too, and it is the signal that caught both of the
-- false positives above.
job_touch as (
  select j.client_id,
         max(greatest(coalesce(j.updated_at, j.created_at),
                      coalesce(j.date_sent::timestamptz, j.created_at))) as touched_at
  from public.jobs j
  group by 1
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
  -- greatest() ignores nulls and every argument is coalesced, so this is never
  -- null and never earlier than the lead itself.
  greatest(
    coalesce(c.last_activity, c.created_at),
    coalesce(et.touched_at,   c.created_at),
    coalesce(jt.touched_at,   c.created_at)
  )                   as last_touch_at,
  c.next_action,
  c.next_action_date
from public.clients c
left join event_touch et on et.client_id = c.id
left join job_touch   jt on jt.client_id = c.id;

comment on view public.v_report_lead_lifecycle is
  'One row per client with the first moment it reached each stage of the closing cycle, reconstructed from activity_events. active_at is the deposit milestone (entry to Active is deposit-gated). Milestones are first arrival, not current stage, because stages move backwards. last_touch_at is the newest of clients.last_activity, any activity event for the lead, and any job change — clients.last_activity alone is unmaintained and made active clients look abandoned. Carries no money column.';

grant select on public.v_report_lead_lifecycle to service_role;

-- ---------------------------------------------------------------------------
-- v_report_data_quality, restored exactly as 20260904210000 left it
-- ---------------------------------------------------------------------------

create view public.v_report_data_quality
with (security_invoker = true) as
select 'jobs_missing_wholesale' as check_key,
       'Live jobs with no accountant fee set' as label,
       count(*)::numeric as value
from public.v_report_jobs where wholesale_missing and not is_cancelled
union all
select 'payments_unlinked', 'Payments that cannot be attributed to a job', count(*)::numeric
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
select 'stage_status_conflict', 'Clients whose stage and status contradict each other', count(*)::numeric
from public.clients
where (stage = 'Lost'     and status = 'Active')
   or (stage = 'Complete' and status = 'Prospect')
   or (stage = 'Parked'   and status = 'Prospect')
union all
select 'lead_history_unlinkable', 'Lead stage changes that cannot be linked to a client', count(*)::numeric
from public.activity_events
where event_type = 'lead_stage_changed'
  and metadata->>'leadId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
union all
select 'lead_milestones_out_of_order',
       'Leads whose closing-cycle milestones are recorded out of sequence', count(*)::numeric
from public.v_report_lead_lifecycle
where active_at < quoted_at or complete_at < active_at or delivered_at < active_at;

comment on view public.v_report_data_quality is
  'Six drift checks behind the data quality panel on /admin/reports. payments_unlinked counts only payments that genuinely cannot be traced to a job. client_quote_vs_jobs_gap sums the absolute per-client difference so opposite drifts cannot cancel, and reads clients.quote_amount solely to measure that disagreement. The two lead_* checks measure history the funnel cannot use.';

grant select on public.v_report_data_quality to service_role;

notify pgrst, 'reload schema';
