-- Cases, phase 1 of 8: open_case() becomes the only door to case creation.
--
-- WHAT THIS DOES
--   1. Adds brain_conversations.title (what the case is about) and a unique
--      index on (client_id, case_number).
--   2. Adds public.open_case(), the single authority for creating a case.
--   3. Adds public.reopen_case(), the "revive a closed case" action.
--   4. Adds the clients_open_first_case trigger, so every new client gets
--      CS001 in the same transaction. This is the ONLY automatic case
--      creation in the system.
--   5. Rewrites resolve_case_for_inbound so inbound email NEVER creates a
--      case for a client that already exists.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   No job, payment, message or activity row is touched. No money moves. No
--   case is created by this migration itself -- the trigger only fires on
--   future client inserts. Applying this changes zero existing rows except
--   the two ALTERs below.
--
-- NOT CHANGED, ON PURPOSE
--   public.confirm_payment keeps its three positional parameters and all
--   fifteen return columns. n8n "62 - Payment settle" calls it as
--   select * from public.confirm_payment($1,$2,$3) and reads 13 of those
--   columns by name for the client receipt. Nothing here goes near it.

-- ---------------------------------------------------------------------------
-- 1. Columns and constraints
-- ---------------------------------------------------------------------------

-- What the case is about, in Jim's words. Distinct from `subject`, which is
-- the email subject line the case happened to start from.
alter table public.brain_conversations
  add column if not exists title text;

-- closed_at already exists on this table (added earlier, never populated);
-- reopen_case() below is the first thing to clear it, and case closing in P7
-- is the first thing to set it. Deliberately not re-added here.

-- Case numbers are per client, not global: CLT0001 has CS001 and CS002 while
-- CLT0002 has its own CS001. Global uniqueness comes from the serial, which
-- embeds the client code and is already covered by the existing partial
-- unique index brain_conversations_case_serial_key.
--
-- This is the belt to that index's braces: open_case() takes a per-client
-- advisory lock before reading max(case_number), and this constraint is what
-- catches a second code path writing the table directly. Verified against
-- production before writing: zero null case_numbers, zero duplicate
-- (client_id, case_number) pairs, so it takes cleanly.
create unique index if not exists brain_conversations_client_case_number_key
  on public.brain_conversations (client_id, case_number)
  where client_id is not null and case_number is not null;

-- 9 of 60 clients have no email address on file. The first-case trigger below
-- fires for every client insert, so a NOT NULL here would make a client with
-- no email impossible to create at all. A case for a client we have no email
-- for is a real state; inventing an address to satisfy a constraint is not,
-- and an invented address is one bad join away from being emailed.
alter table public.brain_conversations
  alter column customer_email drop not null;

-- ---------------------------------------------------------------------------
-- 2. open_case() -- the single authority for creating a case
-- ---------------------------------------------------------------------------
-- Mirrors the house rule already established by createClientWithCode in
-- src/lib/client-code.server.ts: the numbering logic lives in exactly one
-- place, and every caller goes through it rather than reimplementing it.

create or replace function public.open_case(
  p_client_id uuid,
  p_title     text default null,
  p_source    text default 'manual'
)
returns table (
  out_case_id        uuid,
  out_case_serial_id text,
  out_case_number    integer
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client   public.clients%rowtype;
  v_bare_clt text;
  v_next     integer;
  v_serial   text;
  v_conv     public.brain_conversations%rowtype;
  v_title    text := nullif(btrim(coalesce(p_title, '')), '');
  v_attempt  integer := 0;
begin
  if p_client_id is null then
    raise exception 'open_case requires a client id';
  end if;

  select * into v_client from public.clients where id = p_client_id;
  if not found then
    raise exception 'open_case: client % not found', p_client_id;
  end if;

  v_bare_clt := substring(v_client.client_code from '(CLT[0-9]+)');
  if v_bare_clt is null then
    raise exception 'open_case: client % has no usable client_code (%)',
      p_client_id, coalesce(v_client.client_code, '<null>');
  end if;

  -- Serialise numbering per client, so two cases opened for the same client
  -- at the same moment cannot both read the same max(case_number). The lock
  -- is per client, so two different clients never wait on each other.
  perform pg_advisory_xact_lock(hashtext('case_seq_' || p_client_id::text));

  loop
    v_attempt := v_attempt + 1;

    select coalesce(max(case_number), 0) + 1
      into v_next
      from public.brain_conversations
     where client_id = p_client_id;

    v_serial := 'MGT-CS' || lpad(v_next::text, 3, '0') || '-' || v_bare_clt;

    begin
      insert into public.brain_conversations
        (customer_id, customer_email, client_id, case_serial_id, case_number,
         title, stage, conversation_type, status)
      values
        (v_client.client_code,
         nullif(btrim(lower(coalesce(v_client.email, ''))), ''),
         p_client_id, v_serial, v_next,
         v_title, 'Potential', 'lead', 'active')
      returning * into v_conv;
      exit;
    exception when unique_violation then
      -- Someone wrote the table without taking the lock. Re-read and retry
      -- once; a second failure is a real problem and is allowed to surface.
      if v_attempt >= 2 then
        raise;
      end if;
    end;
  end loop;

  insert into public.activity_events
    (event_type, actor_name, subject_label, metadata)
  values
    ('case_opened',
     'System - open_case (' || coalesce(p_source, 'manual') || ')',
     coalesce(v_client.full_name, v_client.client_code, p_client_id::text),
     jsonb_build_object(
       'leadId',       p_client_id::text,
       'clientCode',   v_client.client_code,
       'caseId',       v_conv.id::text,
       'caseSerialId', v_conv.case_serial_id,
       'caseNumber',   v_conv.case_number,
       'title',        v_title,
       'source',       coalesce(p_source, 'manual')));

  return query
    select v_conv.id, v_conv.case_serial_id, v_conv.case_number;
end;
$function$;

comment on function public.open_case(uuid, text, text) is
  'The only way a case is created. Allocates the next per-client case_number '
  'under a per-client advisory lock, mints MGT-CSnnn-CLTnnnn, logs case_opened. '
  'Called by the clients_open_first_case trigger for CS001 and by an admin for '
  'CS002 onwards. Inbound email must never call this for an existing client.';

-- ---------------------------------------------------------------------------
-- 3. reopen_case() -- "revive a closed case"
-- ---------------------------------------------------------------------------

create or replace function public.reopen_case(
  p_case_id uuid,
  p_reason  text default null
)
returns table (
  out_case_id        uuid,
  out_case_serial_id text,
  out_stage          text,
  out_status         text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_conv        public.brain_conversations%rowtype;
  v_stage_before text;
  v_client      public.clients%rowtype;
begin
  select * into v_conv from public.brain_conversations where id = p_case_id;
  if not found then
    raise exception 'reopen_case: case % not found', p_case_id;
  end if;

  v_stage_before := v_conv.stage;

  update public.brain_conversations
     set closed_at  = null,
         archived_at = null,
         status     = 'active',
         stage      = case when stage in ('Complete', 'Lost') then 'Active' else stage end
   where id = p_case_id
  returning * into v_conv;

  select * into v_client from public.clients where id = v_conv.client_id;

  insert into public.activity_events
    (event_type, actor_name, subject_label, metadata)
  values
    ('case_reopened', 'System - reopen_case',
     coalesce(v_client.full_name, v_conv.case_serial_id, p_case_id::text),
     jsonb_build_object(
       'leadId',       v_conv.client_id::text,
       'caseId',       v_conv.id::text,
       'caseSerialId', v_conv.case_serial_id,
       'from',         v_stage_before,
       'to',           v_conv.stage,
       'reason',       nullif(btrim(coalesce(p_reason, '')), '')));

  return query
    select v_conv.id, v_conv.case_serial_id, v_conv.stage, v_conv.status;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Every new client gets CS001 -- the only automatic case creation
-- ---------------------------------------------------------------------------
-- On the table rather than in application code, so this is true for manual
-- entry, for Tally intake, and for any path added later, from one place.
-- AFTER INSERT only: an UPDATE path would silently mint CS002.

create or replace function public.tg_clients_open_first_case()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  perform public.open_case(new.id, null, 'first_case');
  return new;
end;
$function$;

drop trigger if exists clients_open_first_case on public.clients;
create trigger clients_open_first_case
  after insert on public.clients
  for each row
  execute function public.tg_clients_open_first_case();

-- ---------------------------------------------------------------------------
-- 5. Inbound email never creates a case for an existing client
-- ---------------------------------------------------------------------------
-- Signature and return columns are unchanged: src/routes/webhooks/lead-intake.ts
-- and src/routes/webhooks/case-create.ts both call this by name over PostgREST.
--
-- Behaviour change:
--   new client            -> the trigger above opens CS001; we attach to it
--   exactly one open case -> attach to it (this is "continue an open case")
--   more than one open    -> attach to NONE, flag needs_routing_review,
--                            return a null conversation id. The person picks.
--   no open case at all   -> same. Continue, reopen or open a new one is a
--                            decision, not something email gets to make.
--
-- out_conversation_id is therefore nullable now. Callers must tolerate it.

create or replace function public.resolve_case_for_inbound(
  p_email             text,
  p_name              text default null,
  p_nationality       text default null,
  p_message           text default null,
  p_external_event_id text default null,
  p_provider          text default 'form',
  p_subject           text default null
)
returns table (
  out_conversation_id uuid,
  out_client_id       uuid,
  out_client_code     text,
  out_case_serial_id  text,
  out_case_number     integer,
  out_is_new_customer boolean,
  out_is_new_case     boolean
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_email           text := lower(btrim(p_email));
  v_client          public.clients%rowtype;
  v_is_new_customer boolean := false;
  v_is_new_case     boolean := false;
  v_next_clt        integer;
  v_conv            public.brain_conversations%rowtype;
  v_open_count      integer;
begin
  if v_email is null or v_email = '' then
    raise exception 'resolve_case_for_inbound requires a non-empty email';
  end if;

  -- 1. Find or create the customer.
  select * into v_client
    from public.clients
   where lower(btrim(email)) = v_email
   limit 1;

  if not found then
    perform pg_advisory_xact_lock(hashtext('clt_number_seq'));

    select coalesce(max((substring(client_code from 'CLT0*([0-9]+)'))::int), 0) + 1
      into v_next_clt
      from public.clients
     where client_code ~ '^CLT[0-9]';

    -- The clients_open_first_case trigger fires on this insert and opens
    -- CS001 in the same transaction, so by the time we look below there is
    -- exactly one open case. The case exists because a client was created,
    -- not because an email arrived.
    insert into public.clients (client_code, full_name, email, nationality, status, stage)
    values ('CLT' || lpad(v_next_clt::text, 4, '0') || '-XX',
            p_name, v_email, p_nationality, 'Prospect', 'Potential')
    returning * into v_client;

    v_is_new_customer := true;
    v_is_new_case     := true;
  end if;

  -- 2. Which case does this belong to? Never open one here.
  select count(*)
    into v_open_count
    from public.brain_conversations
   where client_id = v_client.id
     and archived_at is null
     and coalesce(stage, 'Potential') not in ('Complete', 'Lost');

  if v_open_count = 1 then
    select * into v_conv
      from public.brain_conversations
     where client_id = v_client.id
       and archived_at is null
       and coalesce(stage, 'Potential') not in ('Complete', 'Lost')
     limit 1;
  else
    -- Zero open cases, or more than one. Either way this is a routing
    -- decision for a person: continue an existing case, reopen a closed one,
    -- or open a new one. Flag the client's most recent case so the portal can
    -- surface it, and return no case.
    update public.brain_conversations
       set status = 'needs_routing_review'
     where id = (
       select id from public.brain_conversations
        where client_id = v_client.id
        order by case_number desc nulls last
        limit 1
     )
     and status is distinct from 'needs_routing_review';

    v_is_new_case := false;
  end if;

  -- 3. Log the inbound message onto the case, when we have one. With no case
  --    resolved there is nowhere to log it: brain_events hangs off a
  --    conversation. The message is not lost -- the Gmail sync writes it to
  --    public.messages on its own schedule, and P7 gives it a queue.
  if v_conv.id is not null
     and p_message is not null
     and length(btrim(p_message)) > 0 then
    insert into public.brain_events
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

  return query
    select v_conv.id, v_client.id, v_client.client_code,
           v_conv.case_serial_id, v_conv.case_number,
           v_is_new_customer, v_is_new_case;
end;
$function$;

comment on function public.resolve_case_for_inbound(text, text, text, text, text, text, text) is
  'Resolves inbound mail to a client and, where it is unambiguous, to one of '
  'that client''s open cases. NEVER creates a case for a client that already '
  'exists: with no open case or more than one, it returns a null '
  'out_conversation_id and flags needs_routing_review for a person to decide. '
  'A brand new client gets CS001 from the clients_open_first_case trigger.';

notify pgrst, 'reload schema';
