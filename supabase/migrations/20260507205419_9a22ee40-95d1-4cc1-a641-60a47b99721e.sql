create type public.app_role as enum ('admin', 'partner');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  unique (user_id, role)
);
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;

create policy "Users can read their own roles" on public.user_roles for select to authenticated using (auth.uid() = user_id);
create policy "Admins manage all roles" on public.user_roles for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

create table public.partner_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  airtable_accountant_id text not null,
  full_name text,
  email text not null,
  created_at timestamptz not null default now()
);
alter table public.partner_profiles enable row level security;
create policy "Partners read own profile" on public.partner_profiles for select to authenticated using (auth.uid() = user_id or public.has_role(auth.uid(), 'admin'));
create policy "Admins manage partner profiles" on public.partner_profiles for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

create table public.client_tokens (
  token text primary key,
  airtable_job_id text not null,
  airtable_client_id text not null,
  client_email text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
alter table public.client_tokens enable row level security;
create policy "Authenticated read tokens" on public.client_tokens for select to authenticated using (true);
create policy "Admins manage tokens" on public.client_tokens for all to authenticated using (public.has_role(auth.uid(), 'admin')) with check (public.has_role(auth.uid(), 'admin'));

create index client_tokens_job_idx on public.client_tokens(airtable_job_id);