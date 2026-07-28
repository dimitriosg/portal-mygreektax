-- Corrections to 20260728143000_credential_intake.sql.
--
-- Already applied to igfwqgiscjpshxfsyunq on 2026-07-28. This file exists so the
-- database can be rebuilt from migrations alone. Every statement is idempotent
-- and safe to re-run.
--
-- Run the statements one at a time in the SQL editor. A multi statement batch
-- against this project silently stops partway and still reports success.
--
-- Four fixes:
--   1. credential_access_log.service_label was never added. The original table was
--      created before the column existed, and `create table if not exists` does not
--      alter an existing table, so re-running the corrected file was a silent no-op.
--   2. credential_mark_accessed gained a p_service_label argument. Each service needs
--      its own authorisation, so the same credential is revealed repeatedly over
--      months and "reveal" on its own is not an answerable audit record. The one
--      argument version is dropped rather than left in place, because an overload
--      whose second argument defaults to null makes single argument calls ambiguous.
--   3. credential_delete and credential_mark_accessed had EXECUTE granted to anon.
--      `revoke all from public` does not remove Supabase's separate default grants
--      to the anon and authenticated roles. Both functions check has_role internally,
--      so this was defence in depth rather than an open hole, but anon has no business here.
--   4. Default retention moved from 180 days to 18 months, expressed as a calendar
--      interval rather than a day count so it lands on the same day of the month.

-- ---------------------------------------------------------------------------
-- 1. Missing column
-- ---------------------------------------------------------------------------

alter table public.credential_access_log
  add column if not exists service_label text;

comment on column public.credential_access_log.service_label is
  'Which service justified this access. Each service needs its own authorisation, so the same credential is used repeatedly over months and "reveal" alone is not an answerable audit record.';

-- ---------------------------------------------------------------------------
-- 2. credential_mark_accessed now records why
-- ---------------------------------------------------------------------------

drop function if exists public.credential_mark_accessed(uuid);

create or replace function public.credential_mark_accessed(
  p_submission_id uuid,
  p_service_label text default null
)
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

  insert into public.credential_access_log (submission_id, actor, action, service_label)
  values (p_submission_id, auth.uid(), 'reveal', p_service_label);
end $$;

comment on function public.credential_mark_accessed(uuid, text) is
  'Logs a reveal against a submission, recording which service justified it. Admin only, checked inside the function because it is security definer.';

-- ---------------------------------------------------------------------------
-- 3. Tighten grants
-- ---------------------------------------------------------------------------

revoke all on function public.credential_mark_accessed(uuid, text) from public;
revoke all on function public.credential_mark_accessed(uuid, text) from anon;
grant execute on function public.credential_mark_accessed(uuid, text) to authenticated;

revoke all on function public.credential_delete(uuid) from anon;

-- ---------------------------------------------------------------------------
-- 4. Default retention: 18 months
-- Signature and parameter names are unchanged, so this replaces rather than overloads.
-- ---------------------------------------------------------------------------

create or replace function public.credential_submit(
  p_token           text,
  p_ciphertext      text,
  p_key_fingerprint text,
  p_retain_days     integer default null
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
     case
       when p_retain_days is null then (current_date + interval '18 months')::date
       else (current_date + make_interval(days => greatest(p_retain_days, 1)))::date
     end)
  returning id into v_id;

  if r.client_id is not null then
    update public.clients set taxisnet_access = true where id = r.client_id;
  end if;

  return v_id;
end $$;

comment on function public.credential_submit(text, text, text, integer) is
  'Accepts an encrypted payload against a valid token. Supersedes and wipes any earlier submission for the same request. Retention defaults to 18 months.';

notify pgrst, 'reload schema';
