-- case_notes
--
-- Free standing operator notes attached to a case. Mutable by design: Jim
-- edits and deletes these, which is why they are not brain_events rows.
-- brain_events is an append only log keyed on external_event_id; notes are a
-- working document and would fight that invariant.
--
-- include_in_ai controls whether a note is passed to the Brain at draft time.
-- pinned notes render first and act as the standing case brief.
--
-- Audience: admin only. These contain internal reasoning and must never be
-- readable by a partner logged into the portal.

create table if not exists public.case_notes (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.brain_conversations(id) on delete cascade,
  body            text not null,
  pinned          boolean not null default false,
  include_in_ai   boolean not null default true,
  author_user_id  uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists case_notes_conversation_idx
  on public.case_notes (conversation_id, pinned desc, created_at desc);

create index if not exists case_notes_ai_idx
  on public.case_notes (conversation_id)
  where include_in_ai;

alter table public.case_notes enable row level security;

-- Admin only, all verbs. Deliberately narrower than the portal_read_* policies
-- on brain_events and case_drafts, which are authenticated + true and therefore
-- readable by partner accounts.
drop policy if exists case_notes_admin_all on public.case_notes;
create policy case_notes_admin_all
  on public.case_notes
  for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

notify pgrst, 'reload schema';
