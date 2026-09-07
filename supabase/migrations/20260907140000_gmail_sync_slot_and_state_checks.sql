-- 20260907140000_gmail_sync_slot_and_state_checks.sql
--
-- Two corrections to 20260907120000, both raised in review of PR #125 and both
-- confirmed against the code.
--
-- 1. THE MANUAL REFRESH COOLDOWN WAS NOT ATOMIC.
--
-- requestGmailSync read sync_runs to see whether a portal-triggered run had
-- started in the last minute, and then inserted its own row as a second
-- statement. Under READ COMMITTED those are two snapshots: two requests
-- arriving together both see no recent run, both insert, and both POST to the
-- n8n webhook. The limit the spec asks for — one manual run per minute — was
-- therefore bypassable by ordinary concurrency, which is exactly the case it
-- exists to prevent, since each run reads the whole Gmail window and the whole
-- messages table.
--
-- A unique index cannot express "at most one row in a rolling minute", and a
-- single `insert ... where not exists` does not help either: the subquery reads
-- the same pre-insert snapshot in both transactions. The claim has to be
-- serialised. pg_advisory_xact_lock does that with one well-known key and no
-- new table: the second caller blocks until the first commits, then sees its
-- row and is refused. The lock is transaction-scoped, and PostgREST runs each
-- RPC in its own transaction, so it is always released.
--
-- 2. status AND triggered_by ACCEPTED ANY TEXT.
--
-- The portal treats 'running' as in flight and 'failed' as an error, and
-- anything else as success. A typo from the n8n side — 'succeed', 'ok', 'done'
-- — would therefore render as a completed refresh with a green timestamp. That
-- is the silent-staleness failure this feature exists to remove, arriving
-- through the back door. The database now refuses the typo instead.

-- ---------------------------------------------------------------------------
-- 1. State constraints on sync_runs
-- ---------------------------------------------------------------------------
--
-- Added as constraints rather than an enum type so the allowed set can be
-- widened later without an ALTER TYPE and a rewrite. Guarded on pg_constraint
-- so the migration re-runs clean.
--
-- THE GUARD MUST BE SCOPED TO conrelid, NOT JUST conname.
--
-- conname is not unique across a database. `context.sync_runs` already exists
-- in this one — the Claude context mirror — and it already carries a constraint
-- called `sync_runs_status_check`, with a different vocabulary
-- ('running','ok','partial','failed'). The first version of this migration
-- guarded on conname alone, matched that unrelated constraint, and silently
-- skipped adding the status check to public.sync_runs: the migration reported
-- success and did nothing. Filtering on conrelid is what makes the guard mean
-- "on this table".

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sync_runs'::regclass
      and conname = 'sync_runs_status_check'
  ) then
    alter table public.sync_runs
      add constraint sync_runs_status_check
      check (status in ('running', 'succeeded', 'failed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sync_runs'::regclass
      and conname = 'sync_runs_triggered_by_check'
  ) then
    alter table public.sync_runs
      add constraint sync_runs_triggered_by_check
      check (triggered_by in ('schedule', 'portal'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. claim_gmail_sync_slot — the atomic replacement for check-then-insert
-- ---------------------------------------------------------------------------
--
-- Returns the new sync_runs id when the caller may start a manual run, or null
-- when one already started inside the cooldown. The caller POSTs to n8n only on
-- a non-null return, so a refused claim cannot fire the webhook.
--
-- Deliberately NOT security definer. service_role already holds insert on
-- sync_runs and bypasses RLS, so the function needs no elevated rights, and a
-- definer function here would be a privilege surface for no gain. Execute is
-- revoked from public and granted only to service_role, which is the only
-- caller: the portal reaches it through supabaseAdmin behind requireAdminAccess.

create or replace function public.claim_gmail_sync_slot(p_cooldown_seconds integer default 60)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  -- One well-known key for this slot. hashtext is stable within a major
  -- version, and the key only has to be consistent between concurrent callers.
  perform pg_advisory_xact_lock(hashtext('public.claim_gmail_sync_slot:gmail'));

  if exists (
    select 1
    from public.sync_runs
    where source = 'gmail'
      and triggered_by = 'portal'
      and started_at >= now() - make_interval(secs => p_cooldown_seconds)
  ) then
    return null;
  end if;

  insert into public.sync_runs (source, status, triggered_by)
  values ('gmail', 'running', 'portal')
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.claim_gmail_sync_slot(integer) is
  'Atomically reserves the next manual Gmail sync slot. Returns the new sync_runs id, or null when a portal-triggered run already started within p_cooldown_seconds. Takes a transaction-level advisory lock so two concurrent portal requests cannot both claim: the check and the insert were separate statements before this, and both callers could pass the check and both fire the n8n webhook.';

revoke all on function public.claim_gmail_sync_slot(integer) from public;
revoke all on function public.claim_gmail_sync_slot(integer) from anon, authenticated;
grant execute on function public.claim_gmail_sync_slot(integer) to service_role;

notify pgrst, 'reload schema';
