-- case_draft_versions
--
-- Append only history of every Brain generation for a case.
--
-- Why a new table rather than columns on case_drafts: case_drafts is upserted
-- on case_id (unique constraint case_drafts_case_id_key), so every regenerate
-- overwrites the previous draft and its internal_notes in place. That history
-- is currently being destroyed on each click.
--
-- case_drafts stays as it is and keeps serving the review desk and the send
-- path. This table records what was generated, what context it was generated
-- from, and what was actually sent.
--
-- draft_text        what the Brain wrote, never modified after insert
-- sent_text         what left the building, null until sent
-- sent_mode         'as_is' when sent_text matches draft_text, else 'edited'
-- context_used      which notes and partner events were in scope, so a draft
--                   that reads oddly later can be judged against what the
--                   Brain was actually shown
--
-- Audience: admin only.

create table if not exists public.case_draft_versions (
  id                  uuid primary key default gen_random_uuid(),
  conversation_id     uuid not null references public.brain_conversations(id) on delete cascade,
  version_no          integer not null,
  draft_text          text not null,
  compliance_insights text,
  context_used        jsonb not null default '{}'::jsonb,
  model               text,
  generated_at        timestamptz not null default now(),
  sent_at             timestamptz,
  sent_text           text,
  sent_mode           text
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'case_draft_versions_sent_mode_check') then
    alter table public.case_draft_versions
      add constraint case_draft_versions_sent_mode_check
      check (sent_mode is null or sent_mode in ('as_is', 'edited'));
  end if;
end $$;

create unique index if not exists case_draft_versions_conv_version_key
  on public.case_draft_versions (conversation_id, version_no);

create index if not exists case_draft_versions_conv_idx
  on public.case_draft_versions (conversation_id, version_no desc);

alter table public.case_draft_versions enable row level security;

drop policy if exists case_draft_versions_admin_all on public.case_draft_versions;
create policy case_draft_versions_admin_all
  on public.case_draft_versions
  for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

notify pgrst, 'reload schema';
