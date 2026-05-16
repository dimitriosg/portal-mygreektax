# Manual Smoke Test Checklist (Critical Access Paths)

Use this checklist after auth, permissions, workflow, or tracking-related changes. Keep tests lightweight and run in a safe non-production environment with seeded admin/partner accounts and representative jobs.

## Scope and intent

- Purpose: fast regression pass for critical portal access paths.
- Type: manual smoke tests (no browser automation required).
- Out of scope for this checklist: deep data validation, load testing, and non-critical UI polish.

## Preconditions

- App is deployed/running with working Supabase auth and Airtable connectivity.
- You have at least:
  - one **admin** account,
  - one **partner** account,
  - at least one partner-assigned job,
  - one client tracking token (valid),
  - optionally one invalid and one expired/revoked token fixture.
- Test in an incognito/private window where noted to avoid stale sessions.

## Critical path smoke tests

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| 1 | Unauthenticated user redirects to login | Open `/dashboard` in incognito while logged out. | Redirects to `/login` without exposing protected data. |
| 2 | Login page loads safely | Open `/login`. | Login page renders normally, no crash, no sensitive debug output. |
| 3 | Invite-only messaging is visible | Navigate to invite entry flow (e.g. invite link / invite route). | Invite-only messaging appears and is understandable. |
| 4 | Password reset/request access flow works | Use reset/request access controls from login-related screens. | User can submit the flow and gets success/next-step confirmation. |
| 5 | Admin can open dashboard | Sign in as admin and open `/dashboard`. | Dashboard loads with expected data access for admin. |
| 6 | Admin can open admin page | As admin, open `/admin`. | Admin page loads successfully. |
| 7 | Partner cannot open admin page | Sign in as partner and open `/admin` directly. | Access denied or redirected safely; no admin data exposure. |
| 8 | Partner sees only assigned jobs | As partner, inspect dashboard list/table. | Only assigned jobs are visible. |
| 9 | Admin impersonation works | As admin, impersonate a partner from admin tooling. | Session/view switches to selected partner scope correctly. |
| 10 | Dashboard filters work | Apply common filters (status/service/tier/partner if available). | Results update correctly and can be reset. |
| 11 | Manual order save/clear works | Reorder jobs manually, save; then clear/reset ordering. | Order persists after save; clear/reset returns expected ordering. |
| 12 | Job detail opens | Open a job detail from dashboard list. | Job detail page loads without error. |
| 13 | Partner can update allowed status/progress fields | As partner, edit fields explicitly allowed to partner role. | Allowed updates save successfully. |
| 14 | Partner cannot update admin-owned fields directly | As partner, attempt to edit restricted/admin-owned fields. | Update blocked or ignored with safe UX feedback. |
| 15 | Partner can submit admin change request | As partner, submit a change request for restricted field changes. | Request is created and visible in appropriate queue/history. |
| 16 | Admin can approve/reject change request | As admin, open change requests and approve one / reject one. | Decision is saved and reflected in job/request state. |
| 17 | Client tracking link opens without login | Open a valid tracking link while logged out. | Tracking page opens and shows client-safe information only. |
| 18 | Invalid tracking token shows safe error | Open tracking URL with invalid token. | Safe, non-sensitive error state is shown. |
| 19 | Expired/revoked tracking token shows safe error (if fixture exists) | Open expired/revoked token link. | Safe error state is shown; no sensitive details leak. |

## Run notes template

Use this quick format to record execution:

- Date:
- Environment (local/staging/prod-like):
- Tester:
- Commit/branch:
- Result summary: `Pass` / `Pass with notes` / `Fail`
- Failures or anomalies:
  - [Scenario #] Description

## Maintenance guidance

- Keep scenarios stable and focused on access-control + critical workflow paths.
- When features change, update this checklist in the same PR.
- Prefer adding automation later only for repeatedly failing/high-risk paths.
