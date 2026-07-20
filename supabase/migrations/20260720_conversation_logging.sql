-- MyGreekTax :: outbound conversation logging tables
-- Commit this to supabase/migrations/ (do not run ad hoc in the SQL editor only).
-- NOTE: lead_id is typed uuid to match leads.id. If leads.id is bigint, change it to bigint.

create table if not exists public.conversation_messages (
    id                    uuid primary key default gen_random_uuid(),
    provider              text not null,
    provider_message_id   text not null,
    lead_id               uuid references public.leads(id),
    direction             text not null default 'outbound',
    from_email            text,
    to_email              text,
    subject               text,
    status                text,
    accepted_at           timestamptz,
    delivered_at          timestamptz,
    failed_at             timestamptz,
    failure_reason        text,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    unique (provider, provider_message_id)
);

create table if not exists public.conversation_events (
    id                       uuid primary key default gen_random_uuid(),
    conversation_message_id  uuid references public.conversation_messages(id) on delete cascade,
    provider                 text not null,
    provider_event_id        text not null,
    event_type               text not null,
    occurred_at              timestamptz,
    payload                  jsonb,
    created_at               timestamptz not null default now(),
    unique (provider, provider_event_id)
);

create index if not exists idx_conv_msg_lead      on public.conversation_messages (lead_id);
create index if not exists idx_conv_msg_provmsgid on public.conversation_messages (provider, provider_message_id);
create index if not exists idx_conv_evt_msg       on public.conversation_events   (conversation_message_id);
