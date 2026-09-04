-- 20260904202700_report_data_quality_counts_what_it_claims.sql
--
-- Two of the four checks in v_report_data_quality did not measure what their
-- labels said. Neither was wrong by accident; both inherited an assumption that
-- has since stopped being true, and one of them could never have reached zero.
--
-- A separate migration rather than an edit to 20260904201500, because that file
-- is already applied and recorded in schema_migrations, so editing it would
-- change the repo without changing this database. Only v_report_data_quality
-- moves; the other four views are untouched and nothing depends on this one.
--
-- WHY payments_unlinked WAS COUNTING THE WRONG THING.
--
-- It was `count(*) from public.payments` — every payment ever received, on the
-- premise that payments has no job_id so none of them can be tied to a job.
-- That premise was true when the check was written and is no longer. Since
-- 20260901191346, payment_tokens carries job_id, so a payment that arrived
-- through a job-scoped link can be traced to its job via payments.token even
-- though payments itself still has no job_id column.
--
-- The practical failure was not the off-by-one. This row is meant to be a
-- countdown: it exists to show progress toward the point where cash reporting
-- becomes possible, and reaching zero is the signal. Counting every payment
-- meant it could only ever climb, no matter how many links were job-scoped —
-- a progress bar that runs backwards. Now it counts the payments that genuinely
-- cannot be attributed, so sending job-scoped links moves it the right way.
--
-- WHY THE QUOTE GAP WAS UNDERSTATING ITSELF.
--
-- It summed a signed difference, so a client quoted 400 over and a client
-- quoted 400 under cancelled out to nothing while both records were wrong.
-- Against live data the signed total is 717 and the absolute total is 1,115,
-- so roughly 398 of real disagreement was invisible on the one panel that
-- exists to make disagreement visible. Summing the absolute per-client
-- difference is the honest measure of "how much is there to reconcile".
--
-- The join stays an inner join, deliberately. A left join was proposed and
-- would raise the number to 3,286, but the extra 2,569 comes from 10 clients
-- holding a quote with no live job at all: leads that never converted and
-- clients whose every job was cancelled. That is real, and it is a different
-- question — quoted work not currently live — which belongs in its own row if
-- it is wanted. A quote has nothing to drift from until there are jobs to
-- disagree with, and the inner join finds exactly the three disagreeing
-- clients the tracker review found by hand.

drop view if exists public.v_report_data_quality;

create view public.v_report_data_quality
with (security_invoker = true) as
select 'jobs_missing_wholesale' as check_key,
       'Live jobs with no accountant fee set' as label,
       count(*)::numeric as value
from public.v_report_jobs where wholesale_missing and not is_cancelled
union all
-- Unattributable means no token, or a token minted before links carried a job.
-- left join then `t.job_id is null` catches both, and counts down as job-scoped
-- links replace them.
select 'payments_unlinked',
       'Payments that cannot be attributed to a job',
       count(*)::numeric
from public.payments p
left join public.payment_tokens t on t.token = p.token
where t.job_id is null
union all
-- abs per client, then sum: opposite-signed drifts must not cancel. Still the
-- one place in these views that reads a client-level money column, and still
-- read only to measure the disagreement rather than to report a figure.
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
   or (stage = 'Parked'   and status = 'Prospect');

comment on view public.v_report_data_quality is
  'Four drift checks behind the data quality panel on /admin/reports. payments_unlinked counts only payments that genuinely cannot be traced to a job, so it falls as job-scoped payment links replace untraceable ones. client_quote_vs_jobs_gap sums the absolute per-client difference so opposite drifts cannot cancel, and reads clients.quote_amount solely to measure that disagreement.';

grant select on public.v_report_data_quality to service_role;

notify pgrst, 'reload schema';
