-- 20260902133923_context_mirror_schema.sql
--
-- Context mirror, phase 1 of claude/context-mirror-supabase-plan-2026-09.md
--
-- Creates the `context` schema: a one-way mirror of Claude memory files and
-- PIPELINE project docs, pushed by a scheduled Claude session three times a
-- day on weekdays. Read by n8n, Lambda and Claude sessions so every agent
-- works from the same operating context.
--
-- This is a MIRROR, not a master. Rows are overwritten by the next sync.
-- Never hand-edit these tables.
--
-- This is context, not canon. public.knowledge_base remains the only source
-- a client-facing draft may quote as settled tax fact.

create schema if not exists context;

comment on schema context is
  'One-way mirror of Claude memory and PIPELINE project docs. Written only by the scheduled sync. Hand edits are lost on the next run.';

-- pg_trgm powers fuzzy lookup of Greek AADE terminology (ΑΦΜ, Παράρτημα Α,
-- κλειδάριθμος) which the english text search config indexes verbatim.
create extension if not exists pg_trgm with schema extensions;


-- ---------------------------------------------------------------------------
-- sync_runs: one row per scheduled fire. Without this there is no way to tell
-- a quiet sync from a broken one.
-- ---------------------------------------------------------------------------

create table if not exists context.sync_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',
  trigger       text,
  docs_seen     integer not null default 0,
  docs_added    integer not null default 0,
  docs_changed  integer not null default 0,
  docs_removed  integer not null default 0,
  error         text,
  notes         text
);

comment on table context.sync_runs is
  'One row per sync run. status: running, ok, partial, failed. A run that never reached finished_at died mid-flight.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sync_runs_status_check') then
    alter table context.sync_runs
      add constraint sync_runs_status_check
      check (status in ('running', 'ok', 'partial', 'failed'));
  end if;
end $$;

create index if not exists sync_runs_started_at_idx
  on context.sync_runs (started_at desc);


-- ---------------------------------------------------------------------------
-- documents: one row per source document, upserted on (source, path).
-- ---------------------------------------------------------------------------

create table if not exists context.documents (
  id                uuid primary key default gen_random_uuid(),
  source            text not null,
  path              text not null,
  title             text,
  body              text not null default '',
  scope             text not null default 'mgt',
  doc_type          text,
  tags              text[] not null default '{}',
  content_hash      text not null,
  byte_size         integer,
  source_updated_at timestamptz,
  first_seen_at     timestamptz not null default now(),
  synced_at         timestamptz not null default now(),
  last_changed_at   timestamptz not null default now(),
  is_current        boolean not null default true,
  search_vector     tsvector generated always as (
                      to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, ''))
                    ) stored
);

comment on table context.documents is
  'Mirror of Claude memory files and PIPELINE project docs. Upserted on (source, path); content_hash drives change detection. scope gates what n8n can see: only mgt and shared reach context.mgt_documents.';

comment on column context.documents.scope is
  'mgt = MyGreekTax operating context. shared = applies everywhere (preferences, voice). personal = private life, never reaches an agent. restricted = MGT but contains wholesale prices or margins, Claude sessions only.';

comment on column context.documents.is_current is
  'false when the source document has disappeared. Rows are never deleted, so history survives and a re-added document flips back to true.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'documents_source_check') then
    alter table context.documents
      add constraint documents_source_check
      check (source in ('memory', 'project_doc'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'documents_scope_check') then
    alter table context.documents
      add constraint documents_scope_check
      check (scope in ('mgt', 'shared', 'personal', 'restricted'));
  end if;
end $$;

create unique index if not exists documents_source_path_key
  on context.documents (source, path);

create index if not exists documents_search_vector_idx
  on context.documents using gin (search_vector);

create index if not exists documents_body_trgm_idx
  on context.documents using gin (body extensions.gin_trgm_ops);

create index if not exists documents_title_trgm_idx
  on context.documents using gin (title extensions.gin_trgm_ops);

create index if not exists documents_scope_current_idx
  on context.documents (scope, is_current);

create index if not exists documents_tags_idx
  on context.documents using gin (tags);


-- ---------------------------------------------------------------------------
-- document_versions: append-only history. A new row whenever content_hash
-- changes, holding the body that was just superseded. This is what makes
-- "what changed in my thinking since Friday" answerable, and the only reason
-- three syncs a day beat one.
-- ---------------------------------------------------------------------------

create table if not exists context.document_versions (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references context.documents (id) on delete cascade,
  sync_run_id   uuid references context.sync_runs (id) on delete set null,
  content_hash  text not null,
  title         text,
  body          text not null,
  superseded_at timestamptz not null default now()
);

comment on table context.document_versions is
  'Append-only. Holds the previous body of a document at the moment it changed. Never updated, never deleted by the sync.';

create index if not exists document_versions_document_id_idx
  on context.document_versions (document_id, superseded_at desc);


-- ---------------------------------------------------------------------------
-- The only object n8n is granted on. scope keeps personal memory files and
-- wholesale pricing docs out of anything an agent can read.
-- ---------------------------------------------------------------------------

create or replace view context.mgt_documents
with (security_invoker = false) as
select
  id,
  source,
  path,
  title,
  body,
  doc_type,
  tags,
  source_updated_at,
  last_changed_at,
  synced_at
from context.documents
where is_current
  and scope in ('mgt', 'shared');

comment on view context.mgt_documents is
  'Agent-facing read surface. Excludes personal and restricted scopes by construction. Grant n8n on this view only, never on context.documents.';


-- ---------------------------------------------------------------------------
-- RLS: on, with no policies. anon and authenticated get nothing. service_role
-- and the schema owner bypass. This data never reaches a browser.
-- ---------------------------------------------------------------------------

alter table context.documents         enable row level security;
alter table context.document_versions enable row level security;
alter table context.sync_runs         enable row level security;


-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on schema context from public;

grant usage on schema context to service_role;
grant usage on schema context to n8n_readonly;
grant usage on schema context to n8n_assistant;

grant select, insert, update, delete on all tables in schema context to service_role;

grant select on context.mgt_documents to n8n_readonly;
grant select on context.mgt_documents to n8n_assistant;

alter default privileges in schema context
  grant select, insert, update, delete on tables to service_role;

notify pgrst, 'reload schema';
