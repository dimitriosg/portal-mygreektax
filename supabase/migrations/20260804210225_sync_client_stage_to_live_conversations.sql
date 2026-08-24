-- Keep brain_conversations.stage in step with clients.stage.
--
-- WHY: the resolver writes stage = 'Potential' at case creation and nothing
-- ever updates it. The portal pipeline edits clients.stage only. As a result
-- every conversation was frozen at Potential, which (a) broke the open/closed
-- split on the Cases page, and (b) made resolve_case_for_inbound reuse
-- completed cases for returning clients instead of opening a new serial,
-- because its "open case" test reads conversation stage.
--
-- FIX: after any change to clients.stage, mirror the new value onto that
-- client's live (non archived) conversations. Archived conversations keep
-- their historical stage. The existing brain_conversations_set_updated_at
-- trigger bumps updated_at on the mirrored rows automatically.
--
-- KNOWN SIMPLIFICATION: this collapses case stage into client stage. Today
-- every client has exactly one case, so they are the same thing. When the
-- portal gains explicit per case stage controls (Cases/Jobs redesign), retire
-- this trigger in favour of real case stage writes.

create or replace function public.sync_client_stage_to_conversations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.brain_conversations
     set stage = new.stage
   where client_id = new.id
     and archived_at is null
     and stage is distinct from new.stage;
  return new;
end;
$$;

revoke all on function public.sync_client_stage_to_conversations() from public;

drop trigger if exists clients_sync_stage_to_conversations on public.clients;

create trigger clients_sync_stage_to_conversations
  after update of stage on public.clients
  for each row
  when (old.stage is distinct from new.stage)
  execute function public.sync_client_stage_to_conversations();

-- One time backfill: bring the 7 drifted live conversations in line now.
update public.brain_conversations b
   set stage = c.stage
  from public.clients c
 where b.client_id = c.id
   and b.archived_at is null
   and b.stage is distinct from c.stage;
