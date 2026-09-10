-- Applied 2026-09-10 via Supabase MCP, file committed same session.
--
-- Only the source validation changes. The table constraint already allowed
-- 'skill' after 20260910173543, but the function validates independently and
-- rejected it, which is why the first skill load failed. Identical signature,
-- so this replaces the function rather than creating a second overload.
-- SECURITY DEFINER and the pinned search_path are preserved deliberately.
create or replace function context.sync_document(
    p_source text, p_path text, p_title text, p_body text, p_scope text,
    p_doc_type text, p_tags text[],
    p_source_updated_at timestamp with time zone default null::timestamp with time zone,
    p_sync_run_id uuid default null::uuid)
returns text
language plpgsql
security definer
set search_path to 'context', 'extensions', 'public'
as $function$
declare
v_hash text;
v_cur context.documents%rowtype;
v_result text;
begin
if p_source not in ('memory', 'project_doc', 'skill') then
raise exception 'sync_document: bad source %, expected memory, project_doc or skill', p_source;
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

if p_sync_run_id is not null then
update context.sync_runs
set docs_seen = docs_seen + 1,
docs_added = docs_added + (case when v_result = 'added' then 1 else 0 end),
docs_changed = docs_changed + (case when v_result = 'changed' then 1 else 0 end)
where id = p_sync_run_id;
end if;

return v_result;
end;
$function$;

notify pgrst, 'reload schema';
