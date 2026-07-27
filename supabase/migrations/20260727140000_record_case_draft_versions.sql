-- Record every draft generation into case_draft_versions.
--
-- Why a trigger rather than application code: /webhooks/generate-draft is
-- asynchronous. It fires the Brain with waitUntil and returns 202 immediately,
-- so no server code ever sees the finished draft. The browser polls case_drafts
-- and would drop the version if the tab were closed. The trigger fires wherever
-- the write comes from, Lambda or portal, watched or not.
--
-- Two behaviours:
--
-- 1. A new or changed proposed_draft that is not an approval creates the next
--    version row for that case.
-- 2. is_approved flipping to true stamps the latest version as sent, and
--    records whether the sent text matched what the Brain wrote ('as_is') or
--    was edited before sending ('edited').
--
-- Defensive by design. case_drafts.case_id points at brain_conversations.id for
-- new spine cases but at clients.id for legacy ones, so the foreign key on
-- case_draft_versions would reject legacy rows. The function checks the
-- conversation exists first and swallows any error, because failing to record
-- history must never block a draft from being written.

create or replace function public.record_case_draft_version()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  next_no integer;
  latest_id uuid;
  latest_text text;
begin
  if not exists (select 1 from public.brain_conversations bc where bc.id = new.case_id) then
    return new;
  end if;

  begin
    if tg_op = 'UPDATE'
       and new.is_approved is true
       and old.is_approved is distinct from true then

      select id, draft_text
        into latest_id, latest_text
        from public.case_draft_versions
       where conversation_id = new.case_id
       order by version_no desc
       limit 1;

      if latest_id is not null then
        update public.case_draft_versions
           set sent_at   = now(),
               sent_text = new.proposed_draft,
               sent_mode = case
                             when new.proposed_draft is not distinct from latest_text
                               then 'as_is'
                             else 'edited'
                           end
         where id = latest_id;
      end if;

      return new;
    end if;

    if tg_op = 'INSERT'
       or new.proposed_draft is distinct from old.proposed_draft then

      select coalesce(max(version_no), 0) + 1
        into next_no
        from public.case_draft_versions
       where conversation_id = new.case_id;

      insert into public.case_draft_versions
        (conversation_id, version_no, draft_text, compliance_insights, generated_at)
      values
        (new.case_id, next_no, new.proposed_draft, new.internal_notes,
         coalesce(new.last_updated, now()));
    end if;

  exception when others then
    raise warning 'record_case_draft_version skipped for case %: %', new.case_id, sqlerrm;
  end;

  return new;
end;
$function$;

drop trigger if exists trg_record_case_draft_version on public.case_drafts;
create trigger trg_record_case_draft_version
  after insert or update on public.case_drafts
  for each row
  execute function public.record_case_draft_version();

notify pgrst, 'reload schema';
