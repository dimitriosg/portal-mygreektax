-- Cases P3 (schema only): a job can belong to a case.
--
-- This migration assigns NO job to any case and changes no financial figure.
-- Every jobs.case_id starts NULL and stays NULL until a person sets it. Jobs
-- keep their client_id, so every job continues to count towards its client's
-- totals exactly as it does today -- case_id = NULL means "not filed under a
-- case yet", never "does not count".
--
-- Cross-client assignment is rejected by the database rather than by
-- application code, using a composite foreign key rather than a trigger:
--
--   jobs (case_id, client_id) -> brain_conversations (id, client_id)
--
-- A composite foreign key defaults to MATCH SIMPLE, so it is NOT checked while
-- case_id is NULL. That is exactly the behaviour this migration needs: today's
-- 57 unassigned jobs all pass, and every assignment from the moment it is made
-- is checked. Filing a job under a case belonging to a different client is
-- refused by Postgres, with no code path able to bypass it. Nothing silently
-- re-parents the job.
--
-- Verified against production before writing this: brain_conversations has 0
-- rows with a null client_id and 0 duplicate (id, client_id) pairs, and
-- jobs.client_id is already NOT NULL with 0 orphans, so every statement below
-- takes cleanly.

alter table public.jobs
  add column if not exists case_id uuid;

comment on column public.jobs.case_id is
  'The case this job is filed under. NULL means not filed yet, not that the '
  'job does not count -- jobs.client_id is what keeps it in the client total. '
  'Only ever set by a person, never inferred.';

-- Partial: the only queries that use it look for jobs of a given case, and
-- the NULL rows are the majority until triage is done.
create index if not exists jobs_case_id_idx
  on public.jobs (case_id)
  where case_id is not null;

-- Required before the composite foreign key can reference (id, client_id).
-- 0 nulls today. This is a one-way door for any future path that wanted to
-- create a case before knowing its client; nothing does, and nothing should --
-- open_case() takes the client id as its first argument.
alter table public.brain_conversations
  alter column client_id set not null;

alter table public.brain_conversations
  add constraint brain_conversations_id_client_key unique (id, client_id);

-- ON DELETE SET NULL (case_id), not RESTRICT.
--
-- RESTRICT looks safer and is wrong here. public.delete_case() and
-- public.purge_expired_archived_cases() both DELETE from brain_conversations,
-- and the purge runs weekly (n8n 40, Sunday 12:30 Athens) over every archived
-- case older than 60 days in one statement. Under RESTRICT a single job filed
-- under a single archived case would abort that whole bulk purge, and it would
-- fail every week from then on.
--
-- Setting only case_id to NULL is what the column list is for: client_id is
-- NOT NULL, so the plain SET NULL form would try to null it too and fail. The
-- job survives, returns to unfiled, and stays with its client. The filing
-- decision is not lost either -- the job_case_assigned row in activity_events
-- still records who filed it, when, where and why.
--
-- Cross-client assignment is unaffected: it is refused at assignment time, not
-- at delete time. Verified both ways in rolled-back transactions against
-- production before this landed.
alter table public.jobs
  add constraint jobs_case_same_client
  foreign key (case_id, client_id)
  references public.brain_conversations (id, client_id)
  on delete set null (case_id);

notify pgrst, 'reload schema';
