-- Converge n8n_readonly to its intended attributes.
--
-- 20260804180000_create_n8n_readonly_role.sql sets the role attributes inside
-- an `if not exists` guard, so they only apply at the moment the role is
-- created. A database where n8n_readonly already exists keeps whatever it was
-- created with, which could include superuser, createdb, createrole or
-- bypassrls. The guard makes the migration safe to replay but not convergent.
--
-- WHY THIS IS A SEPARATE FILE rather than an edit to that one. That migration
-- is duplicated in brain-mygreektax under the same ledger version, and the
-- ledger applies a version once, so only one of the two copies ever runs.
-- Anything that changes schema state therefore has to be identical in both or
-- the result depends on which repo ran it. A notify can differ harmlessly
-- because it leaves no state behind; role attributes cannot. This repo cannot
-- change brain's copy, so the fix goes in a new version instead, which gets
-- its own ledger row and runs exactly once regardless of repo.
--
-- The version is a fresh timestamp, deliberately later than every row already
-- in the ledger, so it does not reintroduce the out-of-order problem that the
-- backdated 20260804180000 file carries.
--
-- Guarded so it is a no-op where the role does not exist yet, for instance a
-- rebuild that has not reached the 04 Aug migration. Ordering is otherwise
-- unconstrained: it only has to run after the role exists.
--
-- Production already satisfies this. pg_roles currently reports
-- rolbypassrls = false and rolcanlogin = true for n8n_readonly, so this
-- enforces a property that is presently true by accident of how the role was
-- typed into the SQL editor on 04/08/2026. The password is not touched.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'n8n_readonly') then
    alter role n8n_readonly
      login nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
end
$$;

notify pgrst, 'reload schema';
