-- Applied 2026-09-10 via Supabase MCP, file committed same session.
--
-- Extend the context mirror so agents can reach MyGreekTax operating knowledge.
--
-- 1. 'skill' joins memory and project_doc as a mirror source. The mgt-* and
--    personal-voice skills are the rules Jim's drafts are judged against, so an
--    agent that cannot read them keeps breaking rules nobody told it about.
-- 2. priority orders documents when two disagree. Lower wins. Jim's call:
--    PIPELINE outranks INTERNAL, but both are MyGreekTax and both stay.
--    Skills outrank descriptions, because a rule beats a summary of a rule.

alter table context.documents drop constraint if exists documents_source_check;

alter table context.documents add constraint documents_source_check
  check (source = any (array['memory'::text, 'project_doc'::text, 'skill'::text]));

alter table context.documents
  add column if not exists priority smallint not null default 100;

comment on column context.documents.priority is
  'Authority rank, lower wins where two documents disagree. 10 skills (binding rules), 20 PIPELINE project, 30 areas/mygreektax, 40 INTERNAL project, 100 default.';

notify pgrst, 'reload schema';

comment on table context.documents is
  'Mirror of Claude memory files, PIPELINE project docs and the MGT skills. Upserted on (source, path); content_hash drives change detection. scope gates what n8n can see: only mgt and shared reach context.mgt_documents. priority orders them when they disagree.';
