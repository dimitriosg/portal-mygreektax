-- case_partner_drafts
--
-- The Brain's Greek draft to the accountant partner. One row per case, upserted
-- on case_id by the Lambda running in mode "partner", read by the "Follow up
-- with partner" box in the case desk.
--
-- Why a separate table rather than columns on case_drafts: case_drafts is
-- upserted onConflict case_id by the customer drafting path, and the trigger
-- trg_record_case_draft_version fires on every insert or update of that table.
-- Hanging partner columns off it would entangle the two paths and produce
-- spurious version rows on the customer history. This table leaves both the
-- customer path and the version trigger completely untouched.
--
-- pricing_flag is the R2 pricing firewall backstop. The Lambda scans the
-- generated text for currency figures and sets this true when it finds one, so
-- the desk can warn before anything is sent. It records a suspicion, not a
-- verdict: the text is never silently edited, because the operator has to see
-- what the model actually wrote.
--
-- No version history in v1. If it is wanted later, an audience column on
-- case_draft_versions is cleaner than a second history table.
--
-- Audience: admin only. Partner drafts contain internal case reasoning and
-- must never be readable by a partner logged into the portal.

-- drafted_for_email records which partner the draft was written for. R6 says
-- never reference what one partner said when writing to another, and the
-- recipient dropdown is one click away from the draft, so the desk compares
-- this against the selected recipient and warns on a mismatch rather than
-- letting partner A's context reach partner B silently.
create table if not exists public.case_partner_drafts (
  id                uuid primary key default gen_random_uuid(),
  case_id           uuid not null references public.brain_conversations(id) on delete cascade,
  subject           text,
  body              text,
  internal_notes    text,
  pricing_flag      boolean not null default false,
  drafted_for_email text,
  model             text,
  last_updated      timestamptz not null default now()
);

-- One draft per case. This is the conflict target the Lambda upserts on, so it
-- has to exist before the Brain change ships.
create unique index if not exists case_partner_drafts_case_id_key
  on public.case_partner_drafts (case_id);

alter table public.case_partner_drafts enable row level security;

-- Admin only, all verbs. Same shape as case_notes_admin_all and
-- case_draft_versions_admin_all, deliberately narrower than the older
-- authenticated + true policies on brain_events and case_drafts.
drop policy if exists case_partner_drafts_admin_all on public.case_partner_drafts;
create policy case_partner_drafts_admin_all
  on public.case_partner_drafts
  for all
  to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

notify pgrst, 'reload schema';
