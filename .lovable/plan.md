## Goal

Give admins full edit power over any job field, and let partners propose changes to a narrow set of fields (SLA Deadline, Status, Notes) that only take effect after admin approval. Every request and decision is logged and surfaced in-app and over email.

## 1. Admin: full job edit

On the job page (`/jobs/$jobId`), when the viewer is admin, replace today's "Status + Notes" mini form with a full **Edit job** panel covering:

- Status, Notes (already there)
- SLA Deadline, Date Sent (date pickers)
- Client Fee, Accountant Fee (numeric)
- Tier, Category (selects, fed from existing service catalog values)
- Service (select from `listServices`)
- Client (searchable select from `listClients`)
- Assigned Accountant (select from `listAccountants` — replaces today's separate assign action)

Backend: extend `updateJob` in `src/lib/jobs.functions.ts` to accept all the above fields, validate with Zod, write to Airtable, and write a `job_events` row per changed field (`event_type: "field_change"`, with `field_name`, `from_value`, `to_value` in metadata) so the existing History panel shows everything.

Partners continue to see only the existing Status + Notes form (unchanged path through `updateJob`).

## 2. Partner: change requests

New table `job_change_requests`:

- `airtable_job_id`, `requested_by` (uuid), `requester_email`, `requester_name`
- `field_name` (`sla_deadline` | `status` | `notes`)
- `current_value`, `requested_value` (text — dates serialised, status as enum string)
- `reason` (text, optional, max 1000)
- `status` (`pending` | `approved` | `rejected` | `cancelled`)
- `decided_by` (uuid), `decided_at`, `decision_note`
- `created_at`
- RLS: admins manage all; partners can `SELECT` and `INSERT` only their own rows where they are the assigned accountant on the job (enforced via a security-definer helper that checks the partner's `airtable_accountant_id` against the job — same pattern already used elsewhere). Partners cannot `UPDATE` once submitted (only `cancel` while still pending, via a dedicated server fn).

On the job page, partner view gets a new **Request a change** card with:

- Field selector: SLA Deadline / Status / Notes
- New value input (date / status select / textarea)
- Optional reason
- Submit → `requestJobChange` server fn

Below it, a **Your requests** list showing pending/approved/rejected/cancelled with timestamps and admin's decision note. Partner can cancel a pending request.

While a partner has a pending request for a given field, the inline Status/Notes form for that field is disabled with a tooltip "Pending approval".

## 3. Approval surface (both)

**Inline on job page (admin only):** new card **Pending change requests** listing each pending request for this job with one-click Approve / Reject. Approve runs `updateJob` server-side with the requested value (so existing field-change logging fires automatically), then marks the request `approved`. Reject just records the decision + optional note. The admin header gets a small badge with the global pending count.

**New admin page `/admin/change-requests`:** searchable, sortable table of all requests across jobs. Columns: Job code, Partner, Field, Current → Requested, Status, Created, Decided. Filters: Status (default Pending), Partner, Field. Row click opens a side sheet with full detail and Approve/Reject controls.

A header link **Change requests** is added to `src/routes/admin.tsx` next to "Tracking links", with the pending count badge.

## 4. Notifications

- **New request → admin**: email all admins (transactional template `partner-change-request`) with job code, partner name, field, current → requested, reason, and a link to the admin review page. Send via the existing transactional pipeline used by tracking-link emails.
- **Decision → partner**: email the requester (`change-request-decision`) with approved/rejected, the field, the new value (if approved), and the admin's note.
- **In-app**: header badge + toast on next visit (admin sees count of pending; partner sees count of recently decided requests they haven't viewed).

No daily digest changes — these are time-sensitive enough to warrant immediate email.

## 5. Audit trail

- Every approve/reject writes to `activity_events` (`event_type: "job_change_request_decided"`) and to `job_events` (so it appears in the job's History timeline alongside the resulting field change).
- Every partner submission writes `activity_events` (`event_type: "job_change_request_created"`).
- The `activity-summary.server.tsx` daily digest gets two new event types rendered.

## Files

**New**
- `supabase/migrations/<ts>_job_change_requests.sql` — table, RLS, helper fn, indexes
- `src/routes/admin.change-requests.tsx` — admin review page
- `src/components/job/admin-edit-panel.tsx` — full admin edit form (extracted to keep `jobs.$jobId.tsx` manageable)
- `src/components/job/partner-request-panel.tsx` — partner submit + history
- `src/components/job/admin-pending-requests.tsx` — inline approval card
- `src/lib/email-templates/partner-change-request.tsx` — admin notification email
- `src/lib/email-templates/change-request-decision.tsx` — partner notification email

**Edited**
- `src/lib/jobs.functions.ts` — extend `updateJob`; add `requestJobChange`, `cancelChangeRequest`, `decideChangeRequest`, `listChangeRequests`, `listJobChangeRequests`, `getPendingRequestCount`
- `src/routes/jobs.$jobId.tsx` — render new panels per role; disable conflicting fields when a partner has a pending request
- `src/routes/admin.tsx` — Change requests link + badge
- `src/lib/activity.server.ts` + `activity-summary.server.tsx` + `email-templates/registry.ts` — new event types and templates
- `supabase/config.toml` — register new transactional templates if needed

## Out of scope

- No partner ability to request changes to fees, client, service, tier, category, accountant, or date sent (admin-only).
- No bulk approve/reject.
- No SMS/push notifications.
- No edit-after-submit for partners (cancel + resubmit instead).
