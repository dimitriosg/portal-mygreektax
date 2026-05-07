## My Greek Tax — Partner & Client Portal

A web app that sits on top of your Airtable "Tax Services Operations Tracker". Airtable stays the source of truth; the app gives partners a clean place to update jobs and clients a simple page to follow progress.

### Who uses it

- **You (admin)** — see all jobs, all partners, all clients. Assign jobs, change status, send client links.
- **White-label partners** — log in with email + password. See only the jobs assigned to them. Update status, add notes, upload deliverables.
- **Clients** — open a magic link emailed to them. See progress of their own job only. No password.

### Core screens

**1. Login**
- Email + password for you and partners.
- Magic link request page for clients ("enter your email to get a status link").

**2. Partner dashboard** (`/dashboard`)
- List of jobs assigned to the logged-in partner, filtered by status (To Do / In Progress / Waiting on Client / Done).
- Click a job → job detail page.
- Read-only fields: client name, service type, deadline, fee.
- Editable fields: status, internal notes, partner-side checklist, file attachments.
- "Mark stage complete" button → writes back to Airtable and triggers client notification.

**3. Admin dashboard** (`/admin`, you only)
- All jobs across all partners.
- Assign a partner to a job.
- KPIs: jobs by status, overdue jobs, jobs per partner, completion rate.
- Button: "Send tracking link to client" → emails magic link.

**4. Client tracking page** (`/track/<token>`)
- Branded "My Greek Tax" page.
- Shows the client's job: service, current stage, % progress, expected completion, latest update note.
- Stage timeline (e.g. Documents Received → Review → Filed → Confirmation).
- Optional: upload missing documents, send a message to the partner.

### How it talks to Airtable

- All reads/writes go through secure server functions using the **Airtable connector** (you connect your account once, no API keys to paste).
- We mirror the partner login → Airtable record relationship: each partner record in Airtable has an `email` field; login is matched against it.
- Client magic links are signed tokens tied to a specific job record ID — no client account needed.

### What you'll need to confirm before build

- Share the **Base ID** and the relevant **table names** (Jobs, Partners, Clients, or whatever they're called). I'll inspect the schema via the connector once it's linked.
- Decide whether client emails go through **Resend** (simple, recommended) or another provider you already use.

### Out of scope for v1

- Billing/invoicing (Airtable already tracks fees; we just display them).
- Document e-signature.
- Native mobile app (web is fully mobile responsive).

### Tech notes

- TanStack Start app, Lovable Cloud for partner auth + magic-link tokens, Airtable connector for all job data.
- Partner roles enforced server-side via a `user_roles` table, not stored on profiles.
- Magic-link tokens are signed, single-job-scoped, and expire (default 30 days, configurable).

After you approve, I'll ask you to connect Airtable and Resend, then start with the partner login + dashboard.