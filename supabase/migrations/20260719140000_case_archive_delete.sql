-- Case archive + delete lifecycle.
-- Archive hides a case from the main list; restore brings it back; if left
-- archived for 60 days it is permanently purged. Delete is immediate and
-- permanent. A case delete NEVER removes the customer (clients row).
-- Save to supabase/migrations/ after running.

-- 1. Archive state on the case
alter table brain_conversations
  add column if not exists archived_at timestamptz;

create index if not exists brain_conversations_archived_at_idx
  on brain_conversations (archived_at);

comment on column brain_conversations.archived_at is
  'When set, the case is archived (hidden from the main list). Restorable by clearing this. Auto-purged 60 days after this timestamp by the daily cleanup.';

-- 2. Archive a case
create or replace function archive_case(p_conversation_id uuid)
returns void
language sql
as $$
  update brain_conversations
  set archived_at = now()
  where id = p_conversation_id
    and archived_at is null;
$$;

-- 3. Restore an archived case
create or replace function restore_case(p_conversation_id uuid)
returns void
language sql
as $$
  update brain_conversations
  set archived_at = null
  where id = p_conversation_id;
$$;

-- 4. Permanently delete ONE case and everything tied to it.
-- Deletes the draft and events first, then the case. Customer is untouched.
create or replace function delete_case(p_conversation_id uuid)
returns void
language plpgsql
as $$
begin
  delete from case_drafts where case_id = p_conversation_id;
  delete from brain_events where conversation_id = p_conversation_id;
  delete from brain_conversations where id = p_conversation_id;
end;
$$;

-- 5. Purge all archived cases older than 60 days. Called daily by Make.
-- Returns the number of cases purged, so the scenario can log it.
create or replace function purge_expired_archived_cases()
returns integer
language plpgsql
as $$
declare
  v_ids uuid[];
  v_count integer;
begin
  select array_agg(id) into v_ids
  from brain_conversations
  where archived_at is not null
    and archived_at < now() - interval '60 days';

  if v_ids is null then
    return 0;
  end if;

  delete from case_drafts where case_id = any(v_ids);
  delete from brain_events where conversation_id = any(v_ids);
  delete from brain_conversations where id = any(v_ids);

  v_count := array_length(v_ids, 1);
  return coalesce(v_count, 0);
end;
$$;

notify pgrst, 'reload schema';
