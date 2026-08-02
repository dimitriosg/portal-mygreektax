---
name: mgt-repo-change
description: Safe scoped changes in the MyGreekTax repos (portal-mygreektax, brain-mygreektax) from a browser-only workflow, and the running Step 4 cleanup backlog. Use whenever a file in either repo is being edited, deleted, renamed or moved, whenever a migration filename or location is in question, whenever asked to clean up backup or .old files, whenever a PR is being opened in these repos, and whenever asked "what is left" on the cleanup. Trigger it before touching anything under supabase/migrations/ and before any work in brain-mygreektax, because a push to main there deploys straight to production Lambda.
---

# Changes in the MyGreekTax repos

Jim works entirely in the browser on Windows. No local checkout, no terminal, no git CLI. A revert costs him manual work, so scope discipline replaces the safety habits a local setup would provide.

## Non negotiable

1. **Never commit to `main`.** Always a branch, always a PR. Name the branch for the change, not the date.
2. **One concern per PR.** A PR that touched one thing is one thing to reverse.
3. **In `brain-mygreektax`, merging is deploying.** `.github/workflows/deploy.yml` fires on push to main and calls `aws lambda update-function-code` on `mygreektax-brain` in `eu-north-1`. No review step, no staging. Open the PR and stop. Jim merges.
4. **In `portal-mygreektax`, wait for CI.** `.github/workflows/ci.yml` runs typecheck, lint and build on pull requests. A green PR is the minimum bar.
5. **Report before you change.** Any task with a discovery component produces the report first, in the same session, and the change only covers what the report classified as certain.

## Verdict discipline

Every file you propose to delete, move or rename gets a verdict and evidence:

- `CONFIRMED DEAD`: the live sibling exists and nothing references this file.
- `UNCERTAIN`: anything else.

`UNCERTAIN` never goes in the change. It goes in the report and Jim decides. If two files differ only by a suffix like `.old`, `.backup2` or `_old`, the unsuffixed one is live; if that is not obviously true for a given pair, that pair is the problem and it comes before the change that was requested.

Do not version by filename. Git history holds every prior version and is reachable from the web UI. When a backup is wanted before a risky edit, the branch is the backup.

## Migrations are a different risk class

Deleting a dead `.old` file is inert. Renaming a migration is not: depending on tooling, a rename can make an already applied migration re-run against production.

Rules:

- Never rename, reorder or relocate a file under `supabase/migrations/` without an explicit go-ahead from Jim in that session.
- Never propose a `drop function`, `drop table` or destructive DDL as part of a cleanup task.
- A migration that may already have run in production is a stop-and-ask, always.
- Schema work waits for the staging Supabase project. Production is not the place to discover a re-run.

## Verified production facts

Checked against the live database on 02 Aug 2026. Treat as given, do not re-derive, do not act on them without an instruction:

- `public.resolve_case_for_inbound` exists **twice**, as two independent implementations: a stale 3-arg version (`p_email, p_name, p_nationality`) and the current 7-arg version (adds `p_message, p_external_event_id, p_provider, p_subject`). PostgREST resolves the overload by which keys are in the request body, so a caller omitting those four silently runs the stale function: no message stored, no dedupe on `external_event_id`, duplicate cases on a retried webhook.
- There is **no `leads` table** and no leads-to-cases trigger in production.

## Step 4 backlog

Work the top item unless told otherwise. Update the status line in this file as part of the PR that closes an item.

- [x] `portal-mygreektax` `.old` and `.backup*.old` cleanup. PR #67, merged 02 Aug 2026, 20 files removed.
- [ ] Delete `src/integrations/supabase/20260721_link_leads_to_cases_on_insert.sql`. It sits outside `supabase/migrations/` so it has never run, and the table it targets does not exist. Delete only, do not relocate.
- [ ] Audit every call site of `resolve_case_for_inbound`. Report only: file, line, exact parameter set, and any conditional path that sends fewer than seven. No code changes.
- [ ] `brain-mygreektax` `.old` cleanup: `index.js.old` at root, five `src/index.js.backup*.old`, `wiki/index_old.md`, `wiki/rules/OLD BACKUP/`, `pricing/price-table_old.md`. PR only, never merge.
- [ ] Migration filename fixes, blocked until the staging Supabase project exists: `mgt_ops_snapshot.sql` and `the-identity-link.sql` (no timestamp prefix), `the-ID-generator,sql` (trailing comma, not a `.sql` file), two 8-digit prefixes that sort wrongly, three filenames containing spaces, and `20260717120100_knowledge_seed.sql` existing in both repos against one database.

## Stop and ask

- A caller sends fewer than seven params to `resolve_case_for_inbound`.
- A deletion would touch anything under `supabase/migrations/`.
- A file looks dead but is referenced somewhere unexpected, such as a client-side component or a public route.
- A PR would exceed roughly 25 files.
- The task would require a credential, a Supabase key, an AWS key, or anything from `inbox/` or `raw/`. Those are gitignored deliberately and never enter a session.

## Deliverable format

The PR, plus a table in the reply: file, what it shadows or affects, verdict, evidence. Never merge. Jim reviews.
