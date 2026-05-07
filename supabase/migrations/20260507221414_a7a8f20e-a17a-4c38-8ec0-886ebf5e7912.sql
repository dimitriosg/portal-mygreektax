
create table public.job_events (
  id uuid primary key default gen_random_uuid(),
  airtable_job_id text not null,
  user_id uuid not null,
  actor_email text,
  actor_name text,
  event_type text not null check (event_type in ('status_change','comment')),
  from_status text,
  to_status text,
  comment text,
  impersonated_accountant_id text,
  created_at timestamptz not null default now()
);

create index idx_job_events_job on public.job_events (airtable_job_id, created_at desc);

alter table public.job_events enable row level security;

create policy "Admins manage job events"
on public.job_events for all to authenticated
using (has_role(auth.uid(), 'admin'::app_role))
with check (has_role(auth.uid(), 'admin'::app_role));

create policy "Authenticated read job events"
on public.job_events for select to authenticated
using (true);

create policy "Authenticated insert own job events"
on public.job_events for insert to authenticated
with check (auth.uid() = user_id);
