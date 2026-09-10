-- Applied 2026-09-10 via Supabase MCP, file committed same session.
--
-- Columns appended at the end so create or replace is allowed and the existing
-- n8n_readonly grants on the earlier columns survive untouched.
create or replace view context.mgt_documents as
select id,
       source,
       path,
       title,
       body,
       doc_type,
       tags,
       source_updated_at,
       last_changed_at,
       synced_at,
       scope,
       priority
from context.documents
where is_current
  and scope = any (array['mgt'::text, 'shared'::text]);

grant select (scope, priority) on context.mgt_documents to n8n_readonly;

notify pgrst, 'reload schema';
