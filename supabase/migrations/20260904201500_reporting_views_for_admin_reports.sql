-- 20260904201500_reporting_views_for_admin_reports.sql
--
-- Five read-only views behind /admin/reports.
--
-- WHY VIEWS AND NOT A QUERY IN THE PAGE.
--
-- Every number on the reports page is arithmetic over jobs. Putting that
-- arithmetic in the React component would mean the margin formula lives in one
-- place today and in three places the first time someone adds a tile. Views keep
-- one definition of retail, wholesale and margin, nothing can go stale the way a
-- materialised table would, and phase 2 (collected, outstanding, receivables)
-- becomes new columns here rather than a rewrite of the page.
--
-- WHY THERE IS NO CASH METRIC IN ANY OF THESE VIEWS.
--
-- Three sources in this database disagree about how much has been collected:
-- payments.amount totals 1,638.50 over 6 rows, clients.deposit totals 3,384.50
-- over 54 clients, and the Google Sheet tracker says 3,607.50 over 27 job rows.
-- The root cause is that public.payments has client_id but no job_id, so money
-- cannot be attributed to the work it paid for. The client-level money columns
-- (quote_amount, deposit, balance_due, partner_fee) were added as a workaround
-- and have since drifted from the jobs they were meant to summarise.
--
-- So jobs is the reporting grain and these views read jobs.client_fee and
-- jobs.accountant_fee only. No collected, outstanding, receivable or cash
-- figure appears anywhere, because a number that is confidently wrong is worse
-- than a number that is absent. payments.job_id is what unlocks the rest; see
-- claude/tracker-migration-plan-2026-09.md.
--
-- THE ONE DELIBERATE EXCEPTION.
--
-- v_report_data_quality reads clients.quote_amount, once, to measure the size of
-- the drift described above. That is the point of the check: it is not a money
-- figure being reported, it is the disagreement being made visible so it gets
-- fixed. No other view here touches a client-level money column, and the page
-- component touches none of them at all.
--
-- SECURITY.
--
-- security_invoker so the base tables' RLS applies to whoever queries. The
-- portal reads these through server functions using the service role, which
-- already bypasses RLS, so service_role is the only grant. Nothing here is
-- exposed to anon or authenticated: the page is admin-only.

-- ---------------------------------------------------------------------------
-- Dropped dependants first. v_report_jobs is the base for the other four, so a
-- plain drop of it would fail while they exist. Reverse dependency order makes
-- the migration re-runnable.
-- ---------------------------------------------------------------------------

drop view if exists public.v_report_data_quality;
drop view if exists public.v_report_client_concentration;
drop view if exists public.v_report_monthly;
drop view if exists public.v_report_pipeline;
drop view if exists public.v_report_jobs;

-- ---------------------------------------------------------------------------
-- 1. v_report_jobs — one row per job, margin computed once
-- ---------------------------------------------------------------------------

create view public.v_report_jobs
with (security_invoker = true) as
select
  j.id,
  j.job_code,
  j.status,
  c.id                as client_id,
  c.client_code,
  c.full_name         as client_name,
  s.service_name,
  s.service_code,
  j.client_fee        as retail,
  j.accountant_fee    as wholesale,
  coalesce(j.client_fee,0) - coalesce(j.accountant_fee,0) as gross_margin,
  case when coalesce(j.client_fee,0) = 0 then null
       else (coalesce(j.client_fee,0) - coalesce(j.accountant_fee,0))
            / j.client_fee end                             as margin_pct,
  -- Month from a real date, never from a hand-typed one. The spreadsheet
  -- carried an MM.YY string that was wrong for four jobs; deriving the month
  -- from date_sent, falling back to created_at, removes that class of error.
  date_trunc('month', coalesce(j.date_sent, j.created_at::date))::date as month,
  -- A null accountant fee is not a zero-cost job, it is an unknown-cost job.
  -- Margin on those rows is overstated, so every consumer can flag it.
  j.accountant_fee is null                                 as wholesale_missing,
  -- coalesce, not a bare equality: jobs.status is nullable, and `null =
  -- 'Cancelled / NMF'` is null, which `where not is_cancelled` then drops. A
  -- job with no status would have vanished from the monthly, concentration and
  -- share-of-book figures while still being counted in the pipeline table and
  -- the tiles. An unknown status is not a cancellation.
  coalesce(j.status,'') = 'Cancelled / NMF'                as is_cancelled,
  j.date_sent,
  j.sla_deadline,
  j.paid_at,
  j.created_at
from public.jobs j
left join public.clients c         on c.id = j.client_id
left join public.service_catalog s on s.id = j.service_id;

comment on view public.v_report_jobs is
  'Reporting grain for /admin/reports: one row per job with retail, wholesale and margin computed once. Deliberately carries no collected, outstanding or cash figure, because payments has no job_id and the client-level money columns have drifted.';

grant select on public.v_report_jobs to service_role;

-- ---------------------------------------------------------------------------
-- 2. v_report_pipeline — the book by job status
-- ---------------------------------------------------------------------------

create view public.v_report_pipeline
with (security_invoker = true) as
select status,
       count(*)                                   as jobs,
       sum(retail)                                as retail,
       sum(wholesale)                             as wholesale,
       sum(gross_margin)                          as gross_margin,
       sum(gross_margin) / nullif(sum(retail),0)  as margin_pct,
       count(*) filter (where wholesale_missing)  as missing_wholesale
from public.v_report_jobs
group by status;

comment on view public.v_report_pipeline is
  'One row per job status. missing_wholesale is how many of those jobs have no accountant fee, which is how far the margin on that row can be trusted.';

grant select on public.v_report_pipeline to service_role;

-- ---------------------------------------------------------------------------
-- 3. v_report_monthly — revenue by month, split by status
-- ---------------------------------------------------------------------------

create view public.v_report_monthly
with (security_invoker = true) as
select month,
       count(*) filter (where not is_cancelled)                as jobs,
       sum(retail)       filter (where not is_cancelled)       as retail,
       sum(gross_margin) filter (where not is_cancelled)       as gross_margin,
       sum(retail) filter (where status = 'Completed')         as completed_retail,
       sum(retail) filter (where status = 'In Progress')       as in_progress_retail,
       -- Open is defined by subtraction, not by listing three statuses. The
       -- listed form silently dropped Delivered, Invoiced and the legacy Sent:
       -- their retail landed in no segment, so the bars under-reported the
       -- month and never reconciled with the live book tile. Today no job sits
       -- in any of those, so this changes no current figure — it stops the
       -- chart losing revenue the first time one does.
       sum(retail) filter (
         where not is_cancelled
           and coalesce(status,'') not in ('Completed','In Progress')
       )                                                       as open_retail,
       sum(retail) filter (where is_cancelled)                 as cancelled_retail
from public.v_report_jobs
group by month;

comment on view public.v_report_monthly is
  'Revenue on the books per month. jobs, retail and gross_margin exclude cancelled work; cancelled_retail is kept as its own column so the chart can show it muted rather than silently dropping it.';

grant select on public.v_report_monthly to service_role;

-- ---------------------------------------------------------------------------
-- 4. v_report_client_concentration — how much of the book sits with whom
-- ---------------------------------------------------------------------------

create view public.v_report_client_concentration
with (security_invoker = true) as
select client_id, client_code, client_name,
       count(*)          as jobs,
       sum(retail)       as retail,
       sum(gross_margin) as gross_margin,
       sum(retail) / nullif((select sum(retail) from public.v_report_jobs
                             where not is_cancelled),0) as share_of_book
from public.v_report_jobs
where not is_cancelled
group by client_id, client_code, client_name;

comment on view public.v_report_client_concentration is
  'Live book per client. share_of_book is a fraction of live retail, not of anything collected.';

grant select on public.v_report_client_concentration to service_role;

-- ---------------------------------------------------------------------------
-- 5. v_report_data_quality — the drift, made visible
-- ---------------------------------------------------------------------------
--
-- This is the reason the page exists until payments.job_id lands. Four checks,
-- each a plain sentence and a number. Non-zero is a warning, not an error:
-- nothing here is broken, it is disagreeing.

create view public.v_report_data_quality
with (security_invoker = true) as
select 'jobs_missing_wholesale' as check_key,
       'Live jobs with no accountant fee set' as label,
       count(*)::numeric as value
from public.v_report_jobs where wholesale_missing and not is_cancelled
union all
-- Every payment, by definition: payments has no job_id, so not one of them can
-- be attributed to a job. This count is the size of the blocker.
select 'payments_unlinked',
       'Payments that cannot be attributed to a job',
       count(*)::numeric from public.payments
union all
-- The one place a client-level money column is read, and only to measure how
-- far it has drifted from the jobs it claims to summarise. See the header.
select 'client_quote_vs_jobs_gap',
       'Gap between clients.quote_amount and the sum of their jobs',
       coalesce(sum(c.quote_amount),0) - coalesce(sum(j.retail),0)
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
  'Four drift checks behind the data quality panel on /admin/reports. client_quote_vs_jobs_gap is the only place in these views that reads a client-level money column, and it reads it to measure the disagreement rather than to report a figure.';

grant select on public.v_report_data_quality to service_role;

notify pgrst, 'reload schema';
