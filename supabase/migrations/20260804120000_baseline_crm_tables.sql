-- Baseline for the CRM tables created in the Supabase SQL editor during the
-- Jul 2026 Airtable exit and never committed as migrations: clients, jobs,
-- accountants, service_catalog, messages, and the jobs_expanded view.
--
-- Transcribed verbatim from live introspection (information_schema.columns,
-- pg_constraint, pg_indexes, pg_trigger, pg_policies, pg_get_viewdef) on
-- 04 Aug 2026. Everything is IF NOT EXISTS / OR REPLACE with identical
-- definitions, so running this against production is a no-op; it exists so
-- the schema can be reconstructed from the migration history.

create table if not exists public.accountants (
  id uuid primary key default gen_random_uuid(),
  name text,
  email text,
  status text,
  specialty text,
  phone text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  partner_progress_notes text,
  current_workload numeric
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  client_code text unique,
  full_name text,
  email text,
  phone text,
  status text,
  stage text,
  source text,
  urgency text,
  notes text,
  lead_value numeric,
  lost_reason text,
  next_action text,
  next_action_date date,
  last_activity timestamptz,
  nationality text,
  afm text,
  taxisnet_access boolean,
  cadence text,
  case_code text,
  quote_sent_date date,
  quote_amount numeric,
  deposit numeric,
  balance_due numeric,
  partner_fee numeric,
  parked_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  client_visible_note text,
  thread_id text
);

alter table public.clients add column if not exists gmail_sent_last_sync timestamptz;

create table if not exists public.service_catalog (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  service_code text unique,
  service_name text,
  category text,
  tier text,
  base_client_price numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  notes text
);

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  job_code text unique,
  status text,
  next_action_needed text,
  client_id uuid references public.clients(id) on delete set null,
  accountant_id uuid references public.accountants(id) on delete set null,
  service_id uuid references public.service_catalog(id) on delete set null,
  date_sent date,
  sla_deadline date,
  accountant_fee numeric,
  client_fee numeric,
  admin_internal_notes text,
  partner_progress_notes text,
  client_visible_note text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  airtable_id text unique,
  message_id text,
  client_id uuid references public.clients(id) on delete cascade,
  direction text,
  ts timestamptz,
  subject text,
  body text,
  thread_id text,
  from_addr text,
  to_addr text,
  created_at timestamptz not null default now()
);

create index if not exists accountants_email_idx on public.accountants (lower(email));
create index if not exists clients_email_idx on public.clients (lower(email));
create index if not exists clients_stage_idx on public.clients (stage);
create index if not exists jobs_client_idx on public.jobs (client_id);
create index if not exists jobs_accountant_idx on public.jobs (accountant_id);
create index if not exists jobs_status_idx on public.jobs (status);
create index if not exists messages_client_idx on public.messages (client_id);
create unique index if not exists messages_message_id_uq on public.messages (message_id);

-- Shared updated_at touch trigger (live definition uses SET search_path).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists accountants_set_updated_at on public.accountants;
create trigger accountants_set_updated_at
  before update on public.accountants
  for each row execute function set_updated_at();

drop trigger if exists clients_set_updated_at on public.clients;
create trigger clients_set_updated_at
  before update on public.clients
  for each row execute function set_updated_at();

drop trigger if exists jobs_set_updated_at on public.jobs;
create trigger jobs_set_updated_at
  before update on public.jobs
  for each row execute function set_updated_at();

drop trigger if exists service_catalog_set_updated_at on public.service_catalog;
create trigger service_catalog_set_updated_at
  before update on public.service_catalog
  for each row execute function set_updated_at();

-- RLS is enabled on all five tables. jobs / accountants / service_catalog /
-- messages have no policies (service-role only). clients carries two live
-- SELECT policies (portal_read_clients, n8n_readonly_select_clients) that are
-- deliberately NOT recreated here: portal_read_clients is removed by the later
-- tighten_clients_rls migration and a baseline must not resurrect it, and the
-- n8n_readonly policy depends on an instance-specific role.
alter table public.accountants enable row level security;
alter table public.clients enable row level security;
alter table public.jobs enable row level security;
alter table public.messages enable row level security;
alter table public.service_catalog enable row level security;

-- Denormalised read view used by the portal (reads jobs_expanded, writes jobs).
create or replace view public.jobs_expanded as
select j.id,
  j.job_code,
  j.status,
  j.next_action_needed,
  j.client_id,
  j.accountant_id,
  j.service_id,
  j.date_sent,
  j.sla_deadline,
  j.accountant_fee,
  j.client_fee,
  j.admin_internal_notes,
  j.partner_progress_notes,
  j.client_visible_note,
  j.notes,
  j.created_at,
  j.updated_at,
  s.service_name,
  s.service_code,
  s.category,
  s.tier,
  s.base_client_price,
  c.client_code,
  c.full_name as client_full_name,
  coalesce(j.client_fee, 0::numeric) - coalesce(j.accountant_fee, 0::numeric) as margin
from jobs j
  left join clients c on c.id = j.client_id
  left join service_catalog s on s.id = j.service_id;

notify pgrst, 'reload schema';
