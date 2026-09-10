-- Applied 2026-09-10 via Supabase MCP, file committed same session.
--
-- Priority is policy, not content, so it is applied by rule rather than passed
-- through sync_document. Idempotent: the nightly sync calls it after mirroring
-- and it only writes rows whose rank actually changed, so it never touches
-- content_hash or the version history.
create or replace function context.apply_priorities()
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with ranked as (
      select id,
        case
          when source = 'skill'                 then 10
          when source = 'project_doc'           then 20
          when path like '/projects/019e022a-%' then 20
          when path = '/areas/mygreektax.md'    then 30
          when path like '/projects/019d9bb4-%' then 40
          when path like '/projects/019e20be-%' then 45
          else 100
        end::smallint as p
      from context.documents
    )
  update context.documents d
     set priority = r.p
    from ranked r
   where r.id = d.id
     and d.priority is distinct from r.p;

  get diagnostics n = row_count;
  return n;
end;
$$;

comment on function context.apply_priorities() is
  'Reapplies the authority ranking. Lower wins where two documents disagree. Call after every sync run.';

notify pgrst, 'reload schema';
