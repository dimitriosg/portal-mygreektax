-- 20260827171747_draft_version_generations_only.sql
--
-- record_case_draft_version() records GENERATIONS only. It no longer tries to
-- work out whether a sent email was edited, because it cannot.
--
-- Why the old version could not work
-- ----------------------------------
-- The previous function stamped sent_at / sent_text / sent_mode on the latest
-- version row when case_drafts.is_approved flipped to true, deciding as_is vs
-- edited by comparing new.proposed_draft against the stored draft_text.
--
-- Those two strings are never equal, whatever the operator does. The Brain
-- writes PLAIN TEXT into proposed_draft. AiReviewDesk converts it to paragraph
-- HTML, stitches a signature onto the end, and DOMPurify-sanitizes the result
-- before posting it. So the comparison recorded EVERY send as "edited", and
-- the one row in the table that carries a sent_mode says "edited" against a
-- 91 character draft and a 1085 character send.
--
-- Only the browser knows whether the body was touched. So /webhooks/send-
-- approved now owns the send stamp and posts an explicit sent_mode computed
-- from the editor state. This function gets out of its way.
--
-- Second bug closed here
-- ---------------------
-- The old stamp branch required is_approved to move false -> true. A second
-- send left is_approved already true, fell through to the insert below, saw a
-- changed proposed_draft, and wrote the sent HTML into the history as though
-- the Brain had just generated it. Resends silently corrupted the only quality
-- metric this project has.
--
-- The discriminator used below is safe because the Brain's upsert sets
-- is_approved: false explicitly on every generation (src/index.js in
-- brain-mygreektax). An UPDATE that leaves is_approved true is therefore
-- always a send and never a generation.
--
-- Note for whoever rebuilds this database from migrations: case_draft_versions
-- and the original trigger were created in the SQL editor and never committed,
-- so no migration in this directory creates them. That gap is real and is
-- tracked separately. This file assumes both already exist.

create or replace function public.record_case_draft_version()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  next_no integer;
begin
  -- Only cases that live on the conversation spine carry a version history.
  if not exists (select 1 from public.brain_conversations bc where bc.id = new.case_id) then
    return new;
  end if;

  begin
    -- A send. The route stamps the version row itself. Do nothing, and in
    -- particular do not fall through to the insert below.
    if tg_op = 'UPDATE' and new.is_approved is true then
      return new;
    end if;

    -- A generation. New row whenever the draft text actually moved.
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

  -- Deliberately swallowed. A failure to record history must never be able to
  -- block a client email or a Brain write. The warning goes to the Postgres
  -- log.
  exception when others then
    raise warning 'record_case_draft_version skipped for case %: %', new.case_id, sqlerrm;
  end;

  return new;
end;
$function$;

comment on function public.record_case_draft_version() is
  'Records a case_draft_versions row per Brain generation. Sends are stamped by /webhooks/send-approved, not here: the desk HTML-ises and signs the draft before sending, so no server side comparison can tell as_is from edited.';

notify pgrst, 'reload schema';
