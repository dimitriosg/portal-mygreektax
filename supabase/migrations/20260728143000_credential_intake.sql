-- Encrypted client credential intake for authorisation setup.
-- The database stores ciphertext only. Decryption happens in Jim's browser
-- with a private key that never touches this database, Cloudflare, or any
-- environment variable.
--
-- Access model:
--   anon           -> execute on credential_request_open and credential_submit only
--   authenticated  -> full table access gated on has_role(auth.uid(), 'admin')
--
-- No table is readable by anon under any policy.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.credential_requests (
  id              uuid primary key default gen_random_uuid(),
  token           text not null unique,
  client_id       uuid references public.clients(id) on delete cascade,
  service_label   text,
  note            text,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '30 days'),
  revoked_at      timestamptz,
  open_count      integer not null default 0,
  first_opened_at timestamptz,
  last_opened_at  timestamptz
);

comment on table public.credential_requests is
  'One row per secure-form link sent to a client. Token is the only secret in the URL.';

create table if not exists public.credential_submissions (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid not null references public.credential_requests(id) on delete cascade,
  client_id        uuid references public.clients(id) on delete cascade,
  ciphertext       text,
  key_fingerprint  text not null,
  status           text not null default 'active',
  submitted_at     timestamptz not null default now(),
  retain_until     date,
  deleted_at       timestamptz,
  deleted_by       uuid,
  access_count     integer not null default 0,
  last_accessed_at timestamptz
);

comment on column public.credential_submissions.ciphertext is
  'Sealed box, base64. Null once superseded or deleted. Never plaintext.';
comment on column public.credential_submissions.key_fingerprint is
  'Identifies which keypair encrypted this row, so key rotation stays decryptable.';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'credential_submissions_status_check'
  ) then
    alter table public.credential_submissions
      add constraint credential_submissions_status_check
      check (status in ('active', 'superseded', 'deleted'));
  end if;
end $$;

create table if not exists public.credential_access_log (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.credential_submissions(id) on delete cascade,
  actor         uuid,
  action        text not null,
  at            timestamptz not null default now()
);

comment on table public.credential_access_log is
  'Accountability trail: every reveal and every deletion. Required if a client asks what we did with their login.';

create index if not exists credential_requests_client_idx
  on public.credential_requests(client_id);
create index if not exists credential_submissions_client_idx
  on public.credential_submissions(client_id);
create index if not exists credential_submissions_status_idx
  on public.credential_submissions(status);
create index if not exists credential_submissions_retain_idx
  on public.credential_submissions(retain_until) where status = 'active';
create index if not exists credential_access_log_submission_idx
  on public.credential_access_log(submission_id);

-- ---------------------------------------------------------------------------
-- Row level security: admins only, no anon table access whatsoever
-- ---------------------------------------------------------------------------

alter table public.credential_requests    enable row level security;
alter table public.credential_submissions enable row level security;
alter table public.credential_access_log  enable row level security;

drop policy if exists credential_requests_admin_all on public.credential_requests;
create policy credential_requests_admin_all on public.credential_requests
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'::app_role))
  with check (public.has_role(auth.uid(), 'admin'::app_role));

drop policy if exists credential_submissions_admin_all on public.credential_submissions;
create policy credential_submissions_admin_all on public.credential_submissions
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'::app_role))
  with check (public.has_role(auth.uid(), 'admin'::app_role));

drop policy if exists credential_access_log_admin_all on public.credential_access_log;
create policy credential_access_log_admin_all on public.credential_access_log
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'::app_role))
  with check (public.has_role(auth.uid(), 'admin'::app_role));

-- ---------------------------------------------------------------------------
-- Public entry points. These are the only things anon can reach.
-- ---------------------------------------------------------------------------

create or replace function public.credential_request_open(p_token text)
returns table (out_valid boolean, out_first_name text, out_service_label text)
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  select cr.id, cr.revoked_at, cr.expires_at, cr.service_label, c.full_name
    into r
    from public.credential_requests cr
    left join public.clients c on c.id = cr.client_id
   where cr.token = p_token;

  if not found or r.revoked_at is not null or r.expires_at < now() then
    return query select false, null::text, null::text;
    return;
  end if;

  update public.credential_requests
     set open_count      = open_count + 1,
         first_opened_at = coalesce(first_opened_at, now()),
         last_opened_at  = now()
   where id = r.id;

  return query select true,
                      nullif(split_part(coalesce(r.full_name, ''), ' ', 1), ''),
                      r.service_label;
end $$;

comment on function public.credential_request_open(text) is
  'Validates a form token and returns only a first name and service label. Never returns credentials or client ids.';

create or replace function public.credential_submit(
  p_token           text,
  p_ciphertext      text,
  p_key_fingerprint text,
  p_retain_days     integer default 180
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r    public.credential_requests;
  v_id uuid;
begin
  select * into r from public.credential_requests where token = p_token;

  if not found or r.revoked_at is not null or r.expires_at < now() then
    raise exception 'invalid or expired request';
  end if;

  if p_ciphertext is null
     or length(p_ciphertext) < 32
     or length(p_ciphertext) > 20000 then
    raise exception 'invalid payload';
  end if;

  update public.credential_submissions
     set status = 'superseded', ciphertext = null
   where request_id = r.id and status = 'active';

  insert into public.credential_submissions
    (request_id, client_id, ciphertext, key_fingerprint, retain_until)
  values
    (r.id, r.client_id, p_ciphertext, p_key_fingerprint,
     current_date + greatest(coalesce(p_retain_days, 180), 1))
  returning id into v_id;

  if r.client_id is not null then
    update public.clients set taxisnet_access = true where id = r.client_id;
  end if;

  return v_id;
end $$;

comment on function public.credential_submit(text, text, text, integer) is
  'Accepts an encrypted payload against a valid token. Supersedes and wipes any earlier submission for the same request.';

-- ---------------------------------------------------------------------------
-- Admin operations, logged
-- ---------------------------------------------------------------------------

create or replace function public.credential_mark_accessed(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_role(auth.uid(), 'admin'::app_role) then
    raise exception 'not authorised';
  end if;

  update public.credential_submissions
     set access_count     = access_count + 1,
         last_accessed_at = now()
   where id = p_submission_id;

  insert into public.credential_access_log (submission_id, actor, action)
  values (p_submission_id, auth.uid(), 'reveal');
end $$;

create or replace function public.credential_delete(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_role(auth.uid(), 'admin'::app_role) then
    raise exception 'not authorised';
  end if;

  update public.credential_submissions
     set ciphertext = null,
         status     = 'deleted',
         deleted_at = now(),
         deleted_by = auth.uid()
   where id = p_submission_id;

  insert into public.credential_access_log (submission_id, actor, action)
  values (p_submission_id, auth.uid(), 'delete');
end $$;

comment on function public.credential_delete(uuid) is
  'Wipes the ciphertext but keeps the row, so we can still evidence that we held and then destroyed a credential.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.credential_request_open(text) from public;
grant execute on function public.credential_request_open(text) to anon, authenticated;

revoke all on function public.credential_submit(text, text, text, integer) from public;
grant execute on function public.credential_submit(text, text, text, integer) to anon, authenticated;

revoke all on function public.credential_mark_accessed(uuid) from public;
grant execute on function public.credential_mark_accessed(uuid) to authenticated;

revoke all on function public.credential_delete(uuid) from public;
grant execute on function public.credential_delete(uuid) to authenticated;

-- Known trap in this project: without this grant every RLS policy that calls
-- has_role silently returns zero rows for a real browser session.
grant execute on function public.has_role(uuid, app_role) to authenticated;

notify pgrst, 'reload schema';
