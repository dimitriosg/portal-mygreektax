-- ============================================================================
-- Consolidated migration: Brain knowledge layer + case identity + archive
-- ============================================================================
-- Captures everything applied to the database during the 2026-07-17..19
-- session that was run directly in the SQL editor and not yet recorded as a
-- migration file. Matches the live database state at time of writing.
--
-- This file is IDEMPOTENT and safe to run again: it uses IF NOT EXISTS,
-- CREATE OR REPLACE, and DROP POLICY IF EXISTS throughout. Running it against
-- the current database is a no-op.
--
-- NOTE: the case-archive/delete objects (archived_at column + archive_case,
-- restore_case, delete_case, purge_expired_archived_cases functions) are in a
-- separate committed file, 20260719140000_case_archive_delete.sql, and are
-- intentionally NOT duplicated here.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. KNOWLEDGE LAYER
-- ----------------------------------------------------------------------------

-- knowledge_base governance columns (table pre-existed; these were added)
alter table knowledge_base add column if not exists status text not null default 'draft';
alter table knowledge_base add column if not exists source text;
alter table knowledge_base add column if not exists tax_year int;
alter table knowledge_base add column if not exists review_by date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'knowledge_base_status_check') then
    alter table knowledge_base
      add constraint knowledge_base_status_check check (status in ('draft', 'canonical'));
  end if;
end $$;

create unique index if not exists knowledge_base_slug_key on knowledge_base (slug);

comment on table knowledge_base is
  'Injected into Brain prompts. Only rows with status = canonical AND is_active AND visibility = client_safe are ever injected into client drafting. No client PII, no pricing figures, ever. Rows past review_by are injected flagged as needing re-verification.';

-- knowledge_candidates: Brain-proposed learnings, never injected
create table if not exists knowledge_candidates (
  id uuid primary key default gen_random_uuid(),
  case_id uuid,
  title text not null,
  content text not null,
  category text,
  rationale text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'knowledge_candidates_status_check') then
    alter table knowledge_candidates
      add constraint knowledge_candidates_status_check check (status in ('pending', 'approved', 'rejected'));
  end if;
end $$;

comment on table knowledge_candidates is
  'Brain-proposed learnings awaiting human review. Anonymized patterns only. Rows here are NEVER injected into any prompt. Promotion means manually creating a knowledge_base row from an approved candidate.';

alter table knowledge_base enable row level security;
alter table knowledge_candidates enable row level security;

drop policy if exists portal_read_kb on knowledge_base;
create policy portal_read_kb on knowledge_base for select to authenticated using (true);
drop policy if exists portal_update_kb on knowledge_base;
create policy portal_update_kb on knowledge_base for update to authenticated using (true);
drop policy if exists portal_read_candidates on knowledge_candidates;
create policy portal_read_candidates on knowledge_candidates for select to authenticated using (true);
drop policy if exists portal_update_candidates on knowledge_candidates;
create policy portal_update_candidates on knowledge_candidates for update to authenticated using (true);

-- ----------------------------------------------------------------------------
-- 2. CASE IDENTITY: link brain_conversations to clients + serial ids
-- ----------------------------------------------------------------------------

alter table brain_conversations
  add column if not exists client_id uuid references clients(id) on delete set null,
  add column if not exists case_serial_id text,
  add column if not exists case_number integer,
  add column if not exists stage text not null default 'Potential';

create unique index if not exists brain_conversations_case_serial_key
  on brain_conversations (case_serial_id) where case_serial_id is not null;
create index if not exists brain_conversations_client_id_idx
  on brain_conversations (client_id);
create index if not exists brain_conversations_customer_email_idx
  on brain_conversations (lower(customer_email));

create unique index if not exists brain_events_external_event_id_key
  on brain_events (external_event_id);

comment on column brain_conversations.client_id is
  'FK to the customer in clients. The join that lets the drafts workspace show name, email, and case id together.';
comment on column brain_conversations.case_serial_id is
  'Human-readable case id, format MGT-CSxxx-CLTxxxx. Generated by resolve_case_for_inbound.';
comment on column brain_conversations.stage is
  'Case lifecycle stage. Complete and Lost mean closed; everything else (Potential, Quoted, Active, Parked) is open and a new inbound from the same customer attaches to it.';

-- ----------------------------------------------------------------------------
-- 3. resolve_case_for_inbound: single authority for customer + case identity
-- ----------------------------------------------------------------------------

create or replace function resolve_case_for_inbound(
  p_email text,
  p_name text default null,
  p_nationality text default null,
  p_message text default null,
  p_external_event_id text default null,
  p_provider text default 'form',
  p_subject text default null
)
returns table (
  out_conversation_id uuid,
  out_client_id uuid,
  out_client_code text,
  out_case_serial_id text,
  out_case_number int,
  out_is_new_customer boolean,
  out_is_new_case boolean
)
language plpgsql
as $function$
declare
  v_email text := lower(trim(p_email));
  v_client clients%rowtype;
  v_is_new_customer boolean := false;
  v_is_new_case boolean := false;
  v_next_clt int;
  v_bare_clt text;
  v_conv brain_conversations%rowtype;
  v_next_case_num int;
  v_serial text;
begin
  if v_email is null or v_email = '' then
    raise exception 'resolve_case_for_inbound requires a non-empty email';
  end if;

  -- 1. find or create the customer
  select * into v_client
  from clients
  where lower(trim(email)) = v_email
  limit 1;

  if not found then
    perform pg_advisory_xact_lock(hashtext('clt_number_seq'));

    select coalesce(max((substring(client_code from 'CLT0*([0-9]+)'))::int), 0) + 1
      into v_next_clt
    from clients
    where client_code ~ '^CLT[0-9]';

    insert into clients (client_code, full_name, email, nationality, status, stage)
    values ('CLT' || lpad(v_next_clt::text, 4, '0') || '-XX',
            p_name, v_email, p_nationality, 'Prospect', 'Potential')
    returning * into v_client;

    v_is_new_customer := true;
  end if;

  v_bare_clt := substring(v_client.client_code from '(CLT[0-9]+)');

  -- 2. find an open case for this customer, matched by client_id OR by email
  perform pg_advisory_xact_lock(hashtext('case_seq_' || v_client.id::text));

  select * into v_conv
  from brain_conversations
  where (client_id = v_client.id or lower(trim(customer_email)) = v_email)
    and coalesce(stage, 'Potential') not in ('Complete', 'Lost')
  order by case_number desc nulls last
  limit 1;

  if found then
    if v_conv.client_id is null then
      update brain_conversations
      set client_id = v_client.id,
          customer_id = coalesce(customer_id, v_client.client_code)
      where id = v_conv.id;
      v_conv.client_id := v_client.id;
    end if;
  else
    select coalesce(max(case_number), 0) + 1 into v_next_case_num
    from brain_conversations
    where client_id = v_client.id or lower(trim(customer_email)) = v_email;

    v_serial := 'MGT-CS' || lpad(v_next_case_num::text, 3, '0') || '-' || v_bare_clt;

    insert into brain_conversations
      (customer_id, customer_email, client_id, case_serial_id, case_number,
       subject, stage, conversation_type, status)
    values
      (v_client.client_code, v_email, v_client.id, v_serial, v_next_case_num,
       p_subject, 'Potential', 'lead', 'active')
    returning * into v_conv;

    v_is_new_case := true;
  end if;

  -- 3. optionally log the inbound message (no Brain trigger)
  if p_message is not null and length(trim(p_message)) > 0 then
    insert into brain_events
      (conversation_id, external_event_id, event_type, actor, direction,
       provider, from_email, subject, body_text)
    values
      (v_conv.id,
       coalesce(p_external_event_id,
                'form:' || v_conv.id::text || ':' || extract(epoch from now())::bigint::text),
       'customer_email_received', 'customer', 'inbound',
       p_provider, v_email, p_subject, p_message)
    on conflict (external_event_id) do nothing;
  end if;

  return query select v_conv.id, v_client.id, v_client.client_code,
                      v_conv.case_serial_id, v_conv.case_number,
                      v_is_new_customer, v_is_new_case;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4. GRANTS + RLS for the portal (authenticated role)
-- ----------------------------------------------------------------------------
-- The brain_* tables were created without the standard Supabase grants, so the
-- authenticated role could not reach them (403) even with a policy. These
-- grants plus policies fix that. Reads only; the Brain writes via service_role.

grant select on brain_conversations to authenticated;
grant select on brain_events to authenticated;
grant select on clients to authenticated;

alter table brain_conversations enable row level security;
alter table brain_events enable row level security;
alter table clients enable row level security;

drop policy if exists portal_read_conversations on brain_conversations;
create policy portal_read_conversations on brain_conversations for select to authenticated using (true);

drop policy if exists portal_read_brain_events on brain_events;
create policy portal_read_brain_events on brain_events for select to authenticated using (true);

-- NOTE: this grants read of clients to ANY authenticated user. Tighten to
-- admin-only before partner accounts exist in the portal.
drop policy if exists portal_read_clients on clients;
create policy portal_read_clients on clients for select to authenticated using (true);

notify pgrst, 'reload schema';
