-- 20260904180504_context_mirror_sync_functions.sql
--
-- Context mirror, phase 3 of claude/context-mirror-supabase-plan-2026-09.md
--
-- The scheduled sync runs in a fresh Claude session three times a day. Asking
-- that session to compose the compare-archive-upsert logic in raw SQL, 46
-- times, is the fragile part. These functions move that logic into the
-- database so the sync only has to pass in what it read.
--
-- Nothing here changes any table. Functions only.

-- ---------------------------------------------------------------------------
-- start_sync_run: opens a run row and returns its id.
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
  insert into context.sync_runs (status, trigger)
  values ('running', p_trigger)
  returning id into v_id;
  return v_id;
end;
$$;

comment on function context.start_sync_run(text) is
  'Opens a sync run. Pass the trigger (scheduled, manual, backfill). Returns the run id to pass to sync_document.';


-- ---------------------------------------------------------------------------
-- sync_document: the whole compare-archive-upsert in one call.
--
-- Returns 'added', 'changed' or 'unchanged' so the caller can count without
-- reading anything back.
--
-- On a change, the previous body is copied into document_versions BEFORE the
-- row is overwritten. That archive is the reason for running three times a
-- day rather than once.
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
  v_hash text;
  v_cur  context.documents%rowtype;
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

  -- new document
  if not found then
    insert into context.documents (
      source, path, title, body, scope, doc_type, tags,
      content_hash, byte_size, source_updated_at, is_current
    ) values (
      p_source, p_path, p_title, coalesce(p_body, ''), p_scope, p_doc_type,
      coalesce(p_tags, '{}'), v_hash, octet_length(coalesce(p_body, '')),
      p_source_updated_at, true
    );
    return 'added';
  end if;

  -- unchanged: confirm it is still current, touch synced_at, nothing else
  if v_cur.content_hash = v_hash and v_cur.is_current then
    update context.documents
    set synced_at = now(),
        scope = p_scope,
        doc_type = p_doc_type,
        tags = coalesce(p_tags, '{}')
    where id = v_cur.id;
    return 'unchanged';
  end if;

  -- changed: archive the old body first
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

  return 'changed';
end;
$$;

comment on function context.sync_document(text, text, text, text, text, text, text[], timestamptz, uuid) is
  'Upserts one mirrored document. Hashes the body, archives the previous version when it differs, and returns added, changed or unchanged. The only write path the scheduled sync should use.';


-- ---------------------------------------------------------------------------
-- mark_missing: anything not seen in this run is no longer in the source.
-- Rows are never deleted, only flagged, so history survives a deletion and a
-- re-added document flips back to current on its next sync.
-- ---------------------------------------------------------------------------

create or replace function context.mark_missing(p_source text, p_seen_paths text[])
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
  return v_count;
end;
$$;

comment on function context.mark_missing(text, text[]) is
  'Flags documents of one source that were not seen in this run as no longer current. Refuses an empty list, because an empty list would retire the whole mirror.';


-- ---------------------------------------------------------------------------
-- finish_sync_run: closes the run with its counts.
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
      docs_seen    = p_docs_seen,
      docs_added   = p_docs_added,
      docs_changed = p_docs_changed,
      docs_removed = p_docs_removed,
      error        = p_error,
      notes        = p_notes
  where id = p_id;
end;
$$;

comment on function context.finish_sync_run(uuid, text, integer, integer, integer, integer, text, text) is
  'Closes a sync run. A run with no finished_at died mid-flight and should be treated as a failure.';


-- ---------------------------------------------------------------------------
-- last_sync: one row, for a quick health check from anywhere.
-- ---------------------------------------------------------------------------

create or replace view context.last_sync
with (security_invoker = false) as
select
  r.id,
  r.started_at,
  r.finished_at,
  r.status,
  r.trigger,
  r.docs_seen,
  r.docs_added,
  r.docs_changed,
  r.docs_removed,
  r.error,
  now() - r.started_at as age
from context.sync_runs r
order by r.started_at desc
limit 1;

comment on view context.last_sync is
  'The most recent sync run. If status is not ok, or age is well over eight hours on a weekday, the mirror is stale.';


-- ---------------------------------------------------------------------------
-- Grants. The sync itself runs as service_role. n8n gets the health view only.
-- ---------------------------------------------------------------------------

revoke all on function context.start_sync_run(text) from public;
revoke all on function context.sync_document(text, text, text, text, text, text, text[], timestamptz, uuid) from public;
revoke all on function context.mark_missing(text, text[]) from public;
revoke all on function context.finish_sync_run(uuid, text, integer, integer, integer, integer, text, text) from public;

grant execute on function context.start_sync_run(text) to service_role;
grant execute on function context.sync_document(text, text, text, text, text, text, text[], timestamptz, uuid) to service_role;
grant execute on function context.mark_missing(text, text[]) to service_role;
grant execute on function context.finish_sync_run(uuid, text, integer, integer, integer, integer, text, text) to service_role;

grant select on context.last_sync to n8n_readonly;
grant select on context.last_sync to n8n_assistant;

notify pgrst, 'reload schema';
