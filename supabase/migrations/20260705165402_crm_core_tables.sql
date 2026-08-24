-- CRM source-of-truth tables, migrated off Airtable.
-- Field names mirror the former Airtable schema (see src/lib/airtable.server.ts types);
-- Postgres columns are snake_case and the data layer maps between the two.
-- UUID PKs (opaque, like the old rec-ids); business codes kept as UNIQUE columns.
-- airtable_id retained (nullable) for optional future bridging.

create extension if not exists pgcrypto;

-- Accountants (partners) ---------------------------------------------------
create table if not exists public.accountants (
  id            uuid primary key default gen_random_uuid(),
  airtable_id   text unique,
  name          text,
  email         text,
  status        text,
  specialty     text,
  phone         text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists accountants_email_idx on public.accountants (lower(email));

-- Service catalog ----------------------------------------------------------
create table if not exists public.service_catalog (
  id                 uuid primary key default gen_random_uuid(),
  airtable_id        text unique,
  service_code       text unique,
  service_name       text,
  category           text,
  tier               text,
  base_client_price  numeric,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Clients (unified pipeline: a lead is a client with stage='Potential') ----
create table if not exists public.clients (
  id                uuid primary key default gen_random_uuid(),
  airtable_id       text unique,
  client_code       text unique,
  full_name         text,
  email             text,
  phone             text,
  status            text,
  stage             text,
  source            text,
  urgency           text,
  notes             text,
  lead_value        numeric,
  lost_reason       text,
  next_action       text,
  next_action_date  date,
  last_activity     timestamptz,
  nationality       text,
  afm               text,
  taxisnet_access   boolean,
  cadence           text,
  case_code         text,
  quote_sent_date   date,
  quote_amount      numeric,
  deposit           numeric,
  balance_due       numeric,
  partner_fee       numeric,
  parked_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists clients_email_idx on public.clients (lower(email));
create index if not exists clients_stage_idx on public.clients (stage);

-- Jobs ---------------------------------------------------------------------
create table if not exists public.jobs (
  id                     uuid primary key default gen_random_uuid(),
  airtable_id            text unique,
  job_code               text unique,
  status                 text,
  next_action_needed     text,
  client_id              uuid references public.clients(id) on delete set null,
  accountant_id          uuid references public.accountants(id) on delete set null,
  service_id             uuid references public.service_catalog(id) on delete set null,
  date_sent              date,
  sla_deadline           date,
  accountant_fee         numeric,
  client_fee             numeric,
  admin_internal_notes   text,
  partner_progress_notes text,
  client_visible_note    text,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists jobs_client_idx on public.jobs (client_id);
create index if not exists jobs_accountant_idx on public.jobs (accountant_id);
create index if not exists jobs_status_idx on public.jobs (status);

-- Messages -----------------------------------------------------------------
create table if not exists public.messages (
  id           uuid primary key default gen_random_uuid(),
  airtable_id  text unique,
  message_id   text,
  client_id    uuid references public.clients(id) on delete cascade,
  direction    text,
  ts           timestamptz,
  subject      text,
  body         text,
  thread_id    text,
  from_addr    text,
  to_addr      text,
  created_at   timestamptz not null default now()
);
create index if not exists messages_client_idx on public.messages (client_id);

-- Expanded jobs view: restores the lookup/formula fields Baserow dropped
-- (Service Name/Code, Category, Tier, Base Client Price, Client Code,
-- Client Full Name) plus Margin, by joining the linked records.
create or replace view public.jobs_expanded as
select
  j.*,
  s.service_name        as service_name,
  s.service_code        as service_code,
  s.category            as category,
  s.tier                as tier,
  s.base_client_price   as base_client_price,
  c.client_code         as client_code,
  c.full_name           as client_full_name,
  (coalesce(j.client_fee, 0) - coalesce(j.accountant_fee, 0)) as margin
from public.jobs j
left join public.clients c          on c.id = j.client_id
left join public.service_catalog s  on s.id = j.service_id;

-- updated_at maintenance
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger accountants_set_updated_at     before update on public.accountants     for each row execute function public.set_updated_at();
create trigger service_catalog_set_updated_at before update on public.service_catalog for each row execute function public.set_updated_at();
create trigger clients_set_updated_at         before update on public.clients         for each row execute function public.set_updated_at();
create trigger jobs_set_updated_at            before update on public.jobs            for each row execute function public.set_updated_at();

-- Server-only access: enable RLS with no policies so only the service role
-- (used by the portal's server functions) can read/write. Matches the
-- deny-by-default posture of the existing operational tables.
alter table public.accountants     enable row level security;
alter table public.service_catalog enable row level security;
alter table public.clients         enable row level security;
alter table public.jobs            enable row level security;
alter table public.messages        enable row level security;
