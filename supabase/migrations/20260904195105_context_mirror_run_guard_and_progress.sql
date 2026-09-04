-- 20260904195105_context_mirror_run_guard_and_progress.sql
--
-- Two fixes found by the first live sync run on 4 Sep 2026.
--
-- 1. Nothing stopped a second run starting while one was already in flight.
--    The test run closed at 16:35:05 UTC and a second opened at 16:35:27.
--    Two concurrent runs would both write the same rows and both archive
--    versions, so the history would gain duplicate entries for one change.
--
-- 2. sync_runs showed zeroes until finish_sync_run wrote the totals, so a
--    healthy run in progress was indistinguishable from a dead one. Progress
--    had to be inferred from documents.synced_at.
--
-- No table changes. Three functions replaced, same signatures.

-- ---------------------------------------------------------------------------
-- start_sync_run: reap abandoned runs, then refuse to open a second one.
--
-- Returns NULL when a run is already in flight. The caller must treat NULL as
-- "another sync is running, do nothing this time" and stop.
-- ---------------------------------------------------------------------------

create or replace function context.start_sync_run(p_trigger text default 'scheduled')
returns uuid
language plpgsql
security definer
set search_path = context, extensions, public
as $$
declare
  v_id uuid;
begin
  -- A run that has been open for over two hours died without closing itself.
  -- Reap it, otherwise it blocks every future run and leaves last_sync lying.
  update context.sync_runs
  set finished_at = now(),
      status = 'failed',
      error = coalesce(error, 'run exceeded two hours without closing; reaped by a later run')
  where finished_at is null
    and started_at < now() - interval '2 hours';

  -- A real run is still going. Do not start a second one.
  if exists (select 1 from context.sync_runs where finished_at is null) then
    return null;
  end if;

  insert into context.sync_runs (status, trigger)
  values ('running', p_trigger)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function context.start_sync_run(text) is
  'Opens a sync run and returns its id, or NULL if one is already in flight. Reaps runs open for more than two hours as failed. A caller receiving NULL must stop, not proceed without a run id.';


-- ---------------------------------------------------------------------------
-- sync_document: unchanged behaviour, plus live counters on the run row.
--
-- Counting here rather than in the caller means the run row is accurate even
-- if the session dies halfway, and the caller does not have to remember to
-- report anything.
-- ---------------------------------------------------------------------------

create or replace function context.sync_document(
  p_source            text,
  p_path              text,
  p_title             text,
  p_body              text,
  p_scope             text,
  p_doc_type          text,
  p_tags              text[],
  p_source_updated_at timestamptz default null,
  p_sync_run_id       uuid default null
)
returns text
language plpgsql
security definer
set search_path = context, extensions, public
as $$
declare
  v_hash   text;
  v_cur    context.documents%rowtype;
  v_result text;
begin
  if p_source not in ('memory', 'project_doc') then
    raise exception 'sync_document: bad source %, expected memory or project_doc', p_source;
  end if;

  if p_scope not in ('mgt', 'shared', 'personal', 'restricted') then
    raise exception 'sync_document: bad scope %, expected mgt, shared, personal or restricted', p_scope;
  end if;

  v_hash := encode(extensions.digest(coalesce(p_body, ''), 'sha256'), 'hex');

  select * into v_cur
  from context.documents
  where source = p_source and path = p_path;

  if not found then
    insert into context.documents (
      source, path, title, body, scope, doc_type, tags,
      content_hash, byte_size, source_updated_at, is_current
    ) values (
      p_source, p_path, p_title, coalesce(p_body, ''), p_scope, p_doc_type,
      coalesce(p_tags, '{}'), v_hash, octet_length(coalesce(p_body, '')),
      p_source_updated_at, true
    );
    v_result := 'added';

  elsif v_cur.content_hash = v_hash and v_cur.is_current then
    update context.documents
    set synced_at = now(),
        scope = p_scope,
        doc_type = p_doc_type,
        tags = coalesce(p_tags, '{}')
    where id = v_cur.id;
    v_result := 'unchanged';

  else
    insert into context.document_versions (
      document_id, sync_run_id, content_hash, title, body
    ) values (
      v_cur.id, p_sync_run_id, v_cur.content_hash, v_cur.title, v_cur.body
    );

    update context.documents
    set title = p_title,
        body = coalesce(p_body, ''),
        scope = p_scope,
        doc_type = p_doc_type,
        tags = coalesce(p_tags, '{}'),
        content_hash = v_hash,
        byte_size = octet_length(coalesce(p_body, '')),
        source_updated_at = coalesce(p_source_updated_at, v_cur.source_updated_at),
        synced_at = now(),
        last_changed_at = now(),
        is_current = true
    where id = v_cur.id;
    v_result := 'changed';
  end if;

  -- Live progress. Silent when no run id was passed.
  if p_sync_run_id is not null then
    update context.sync_runs
    set docs_seen    = docs_seen + 1,
        docs_added   = docs_added   + (case when v_result = 'added'   then 1 else 0 end),
        docs_changed = docs_changed + (case when v_result = 'changed' then 1 else 0 end)
    where id = p_sync_run_id;
  end if;

  return v_result;
end;
$$;

comment on function context.sync_document(text, text, text, text, text, text, text[], timestamptz, uuid) is
  'Upserts one mirrored document. Hashes the body, archives the previous version when it differs, increments the run counters, and returns added, changed or unchanged. The only write path the scheduled sync should use.';


-- ---------------------------------------------------------------------------
-- mark_missing: unchanged guard, plus it now records the retirements on the
-- run row so docs_removed is live too.
-- ---------------------------------------------------------------------------

create or replace function context.mark_missing(p_source text, p_seen_paths text[], p_sync_run_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = context, extensions, public
as $$
declare
  v_count integer;
begin
  if p_seen_paths is null or array_length(p_seen_paths, 1) is null then
    raise exception 'mark_missing: refusing to run with an empty path list for source %', p_source;
  end if;

  update context.documents
  set is_current = false, synced_at = now()
  where source = p_source
    and is_current
    and path <> all (p_seen_paths);

  get diagnostics v_count = row_count;

  if p_sync_run_id is not null and v_count > 0 then
    update context.sync_runs
    set docs_removed = docs_removed + v_count
    where id = p_sync_run_id;
  end if;

  return v_count;
end;
$$;

comment on function context.mark_missing(text, text[], uuid) is
  'Flags documents of one source that were not seen in this run as no longer current, and records the count on the run. Refuses an empty list, because an empty list would retire the whole mirror.';


-- ---------------------------------------------------------------------------
-- finish_sync_run: never lower a live counter.
--
-- The counters are now maintained by sync_document as the run proceeds. A
-- caller passing its own totals should not be able to zero them, so each
-- count takes the larger of the two.
-- ---------------------------------------------------------------------------

create or replace function context.finish_sync_run(
  p_id           uuid,
  p_status       text default 'ok',
  p_docs_seen    integer default 0,
  p_docs_added   integer default 0,
  p_docs_changed integer default 0,
  p_docs_removed integer default 0,
  p_error        text default null,
  p_notes        text default null
)
returns void
language plpgsql
security definer
set search_path = context, extensions, public
as $$
begin
  update context.sync_runs
  set finished_at  = now(),
      status       = p_status,
      docs_seen    = greatest(docs_seen,    coalesce(p_docs_seen, 0)),
      docs_added   = greatest(docs_added,   coalesce(p_docs_added, 0)),
      docs_changed = greatest(docs_changed, coalesce(p_docs_changed, 0)),
      docs_removed = greatest(docs_removed, coalesce(p_docs_removed, 0)),
      error        = p_error,
      notes        = p_notes
  where id = p_id;
end;
$$;

comment on function context.finish_sync_run(uuid, text, integer, integer, integer, integer, text, text) is
  'Closes a sync run. Counts are maintained live by sync_document, so each figure here takes the larger of the stored and passed values. A run with no finished_at that is over two hours old is reaped by the next start_sync_run.';


-- ---------------------------------------------------------------------------
-- Grants for the new mark_missing signature. The two-argument version is
-- dropped so no caller can reach a variant that skips run accounting.
-- ---------------------------------------------------------------------------

drop function if exists context.mark_missing(text, text[]);

revoke all on function context.mark_missing(text, text[], uuid) from public;
grant execute on function context.mark_missing(text, text[], uuid) to service_role;

notify pgrst, 'reload schema';
