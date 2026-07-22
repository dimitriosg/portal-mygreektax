-- 20260722_case_summaries.sql
--
-- Stores one cached internal summary per case, written by the Brain Lambda in
-- "summarize" mode and read by the case page so the summary does not re-run on
-- every visit. The Lambda writes with the service role (bypasses RLS); the
-- portal reads it under the authenticated session, mirroring case_drafts.

create table if not exists public.case_summaries (
  case_id      uuid primary key references public.brain_conversations(id) on delete cascade,
  summary      text not null,
  event_count  integer,
  generated_at timestamptz not null default now()
);

alter table public.case_summaries enable row level security;

-- Authenticated users may read summaries. The portal is admin-gated at the app
-- layer; tighten to admin-only later alongside the clients RLS work if wanted.
drop policy if exists case_summaries_select on public.case_summaries;
create policy case_summaries_select
  on public.case_summaries
  for select
  to authenticated
  using (true);
