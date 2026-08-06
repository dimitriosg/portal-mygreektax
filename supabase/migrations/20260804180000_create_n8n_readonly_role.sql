-- Read-only database role for the n8n automation box.
--
-- DELIBERATE DUPLICATE. The same file, with identical SQL, lives in
-- brain-mygreektax at this same version. The two repos share one database and
-- one migration ledger, so this cannot apply twice: the ledger keys on the
-- version 20260804180000, and whichever repo runs it first satisfies both.
--
-- It is duplicated rather than left in brain alone because portal's
-- 20260805175928_n8n_readonly_newsletter_grants.sql and
-- 20260805180413_n8n_readonly_email_table_policies.sql both grant to
-- n8n_readonly, and a rebuild replaying portal without brain fails on them
-- with 'role "n8n_readonly" does not exist'. The 04 Aug version is load
-- bearing: it sorts before those two, and after
-- 20260804120000_baseline_crm_tables.sql, which creates the public.clients
-- granted on below. A file dated when it was copied here would sort after the
-- grants and fix nothing.
--
-- Keep the two copies interchangeable. They differ today by exactly one line:
-- the notify at the end, which brain's copy predates. That is safe, because a
-- notify is a signal rather than schema state, so whichever copy the ledger
-- happens to run leaves the database in the same condition. Anything that DOES
-- change schema state must be added as a new migration, never by editing this
-- one in one repo only.
--
-- The notify matters little for n8n itself, which connects to Postgres
-- directly as n8n_readonly and never reads through PostgREST, and the policy
-- below is scoped to that role alone so no other role's access changes. It is
-- here for the fresh-rebuild case and to match the convention of every other
-- DDL migration in this directory.
--
-- IF YOU EVER MOVE THIS PROJECT TO CLI-MANAGED PUSHES, READ THIS FIRST. The
-- version here is older than versions already recorded in the remote ledger,
-- and the Supabase CLI refuses that: FindPendingMigrations raises
-- ErrMissingRemote when a local file sorts before the last applied remote
-- migration. The remedy for this file is to mark it applied without running
-- it, which is truthful because the role already exists:
--
--   supabase migration repair --status applied 20260804180000
--
-- That is not a special burden created by this file. The ledger holds 15 rows
-- against 59 migration files across the two repos, and only 4 of those files
-- have a version the ledger knows about, so `supabase db push` cannot run
-- here today regardless. Migrations are applied through the SQL editor and
-- these files are the record. Reconciling the ledger with the files is a
-- separate and much larger job than this migration.
--
-- HISTORY: this role was created manually in the SQL editor on 04/08/2026
-- while wiring the n8n Morning digest workflow. This file records it so a
-- fresh database rebuild recreates it. It is fully guarded, so replaying it
-- against production is a no-op.
--
-- The password is NOT in this file and never will be. It is set out of band
-- (alter role n8n_readonly with password '...') and lives in Bitwarden.
-- After a fresh rebuild the role cannot log in until that is done.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'n8n_readonly') then
    create role n8n_readonly with login
      nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

grant usage on schema public to n8n_readonly;

grant select on public.clients to n8n_readonly;

drop policy if exists n8n_readonly_select_clients on public.clients;

create policy n8n_readonly_select_clients on public.clients
  for select to n8n_readonly using (true);

notify pgrst, 'reload schema';
