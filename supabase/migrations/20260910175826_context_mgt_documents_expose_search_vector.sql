-- Applied 2026-09-10 via Supabase MCP, file committed same session.
--
-- Appended at the end so create or replace is allowed and existing grants hold.
-- Exposing the generated search_vector lets the n8n case assistant search the
-- mirror using the index on context.documents rather than re-tokenising 390 kB
-- of body text on every question.
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
 priority,
 search_vector
from context.documents
where is_current
 and scope = any (array['mgt'::text, 'shared'::text]);

grant select (search_vector) on context.mgt_documents to n8n_readonly;

notify pgrst, 'reload schema';
