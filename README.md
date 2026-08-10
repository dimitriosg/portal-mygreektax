# MyGreekTax Portal

Internal operations console for **MyGreekTax**, the English language layer over Greek tax and administrative filings. This is not a public site and not a client app. It is the private back office that Jim and the accountant partners work in.

The portal does two jobs that grew up at different times and now live side by side:

1. **Case and lead desk with AI assisted drafting.** Inbound leads and client replies land as cases. An admin opens a case, reads the timeline, and presses Generate to have the Brain draft a reply. The draft is edited in a rich text editor, approved, and sent through Mailgun. This is the primary day to day surface.
2. **Partner job tracking.** The original layer. Accountant partners see the jobs assigned to them, reorder them, copy tokenized client tracking links, and raise change requests to an admin. Job records for this layer still live in Airtable.

**Live:** [portal.mygreektax.eu](https://portal.mygreektax.eu)
**Companion repo:** [brain-mygreektax](https://github.com/dimitriosg/brain-mygreektax) holds the drafting Lambda that the Generate button calls.

---

## Architecture

```
 Inbound email / lead (Make.com)
            │  POST + X-Lead-Intake-Secret
            ▼
   /webhooks/lead-intake  ──▶  resolve_case_for_inbound()  ──▶  Supabase
            │                                                     (cases, clients, timeline)
            ▼
      Case desk  (review.$caseId)
            │  Generate  (admin only)
            ▼
   /webhooks/generate-draft  ──▶  Brain Lambda (API Gateway)  ──▶  draft row
            │
            ▼
      Draft review + edit  (AiReviewDesk, TipTap)
            │  Approve
            ▼
   /webhooks/send-approved  ──▶  Mailgun  ──▶  client
            │
            ▼
   /webhooks/mailgun-events  ──▶  email_send_log  (delivered, permanent_fail, temporary_fail)
```

Everything runs as a single TanStack Start application deployed to a Cloudflare Worker. Supabase is the sole system of record: cases, leads, clients, drafts, auth, and delivery logs. The Brain lives in the separate `brain-mygreektax` repo and is reached over HTTPS.

---

## Tech stack

| Layer          | Technology                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| Framework      | TanStack Start with TanStack Router (file based routes)                    |
| UI             | React 19, shadcn/ui (Radix primitives), Tailwind CSS v4                    |
| Server state   | TanStack Query                                                             |
| Auth and data  | Supabase (`@supabase/supabase-js`), the only data store                   |
| Rich text      | TipTap v3 (starter kit, link, underline, color, text style) with DOMPurify |
| Drag and drop  | @dnd-kit (partner job ordering)                                            |
| Email          | React Email templates with a Mailgun send path                            |
| Charts         | Recharts (admin analytics)                                                 |
| Validation     | Zod                                                                        |
| Analytics      | Plausible                                                                  |
| Runtime        | Cloudflare Workers via the Cloudflare Vite plugin and `wrangler.jsonc`     |
| Package manager | Bun locally (`bun.lock`). CI runs on npm and Node 20.                     |

---

## Project structure

```
src/
  routes/                     File based routes
    __root.tsx                App shell, nav, auth context
    index.tsx                 Root redirect
    login.tsx  reset-password.tsx  invite.$token.tsx
    dashboard.tsx             Partner job dashboard (legacy layer)
    jobs.$jobId.tsx           Job detail (legacy layer)
    leads.tsx                 Lead list
    review.$caseId.tsx        Case desk, holds the Generate button
    drafts.tsx                Drafts workspace
    track.$token.tsx          Public client tracking page
    unsubscribe.tsx  email/unsubscribe.ts
    admin.tsx  admin.index.tsx  admin.change-requests.tsx  admin.tracking-links.tsx
    webhooks/                 Machine to machine endpoints (see table below)
  components/
    AiReviewDesk.tsx          Draft edit, approve, send
    RichTextEditor.tsx        TipTap editor
    case-reply-box.tsx        Direct reply composer
    case-summary.tsx
    admin-analytics.tsx  admin-partners.tsx
    tracking-link-preview-notice.tsx
    ui/                       shadcn/ui component set
  integrations/supabase/
    client.ts                 Browser client
    client.server.ts          Admin (service role) client
    auth-middleware.ts  auth-client-middleware.ts  auth-diagnostics.ts
    types.ts
  lib/
    leads.functions.ts  jobs.functions.ts  activity.*  analytics.*
    auth-context.tsx  auth-recovery.ts  invites.functions.ts
    tracking-links.ts  signature.ts  stage-colors.ts  client-code.server.ts
    email-templates/          React Email templates
supabase/
  migrations/                 25 migration files, the migration home for this repo
scripts/
  grant-admin.mjs             Break glass admin recovery
docs/
  smoke-test-checklist.md     Manual critical path checklist
```

---

## Webhook endpoints

These are called by Make.com scenarios and other services, not by the browser. Most verify a shared secret.

| Route                          | Purpose                                                         |
| ------------------------------ | -------------------------------------------------------------- |
| `webhooks/lead-intake.ts`      | Inbound lead or reply, calls `resolve_case_for_inbound()`      |
| `webhooks/case-create.ts`      | Create a case                                                  |
| `webhooks/case-reply.ts`       | Attach an inbound reply to a case                              |
| `webhooks/case-action.ts`      | Case state actions                                             |
| `webhooks/conversation-log.ts` | Log inbound and outbound messages to the case timeline         |
| `webhooks/generate-draft.ts`   | Admin only, calls the Brain to draft a reply                   |
| `webhooks/send-approved.ts`    | Send an approved draft through Mailgun                         |
| `webhooks/mailgun-events.ts`   | Log Mailgun delivery events into `email_send_log`              |
| `webhooks/summarize-case.ts`   | Generate a case summary                                        |
| `webhooks/gmail-sync.ts`       | Gmail inbox sync                                               |
| `webhooks/ops-snapshot.ts`     | Operations snapshot for the Make ops scenario                 |

---

## Getting started

### Prerequisites

- Bun (local package manager and dev server)
- Wrangler CLI and a Cloudflare account with Workers enabled
- A Supabase project (this repo shares one database with `brain-mygreektax`)

### Local development

```
bun install
bun run dev
```

Other scripts: `bun run build`, `bun run preview`, `bun run lint`, `bun run typecheck`, `bun run format`.

### Environment variables

Production runtime variables and secrets live in the Cloudflare Workers dashboard. Do not commit `.env`, `.env.*`, or `.dev.vars`. Only `.env.example` is safe to commit. For local work, use a local `.env` or `.dev.vars` (both git ignored).

The live keys (Supabase is the only valid data store):

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
VITE_ENABLE_DEBUG_DIAGNOSTICS=false
SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
PLAUSIBLE_API_KEY=your-plausible-api-key
LEAD_INTAKE_SECRET=your-long-random-shared-secret
```

Note: `.env.example` still carries `AIRTABLE_*` keys. Those are dead and should be removed from the file. Supabase holds all data now.

Notes:

- `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are the client side Supabase config and are required.
- `SUPABASE_SERVICE_ROLE_KEY` is required for server side admin operations. `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` are optional server side aliases (server code falls back to the `VITE_` values).
- `VITE_ENABLE_DEBUG_DIAGNOSTICS` stays `false`. Enable it only for temporary local or preview troubleshooting, never left on in production.
- `LEAD_INTAKE_SECRET` is checked against the `X-Lead-Intake-Secret` header on `/webhooks/lead-intake`. Generate a long random value, set it here and as the header value in the Make HTTP module, and never commit the real value.
- `PLAUSIBLE_API_KEY` is optional, needed only for the analytics panel.

Some server secrets are set directly in Cloudflare and are deliberately not in `.env.example`: the Brain endpoint and shared secret used by `/webhooks/generate-draft`, and the Mailgun credentials used by `/webhooks/send-approved`. Treat the Cloudflare dashboard as the source of truth for those.

---

## Deploy

There is no deploy script in this repo and no deploy workflow. Deployment happens through the Cloudflare Workers integration: every push to `main` triggers a new Cloudflare build and deploy to `portal.mygreektax.eu`.

Continuous integration is `.github/workflows/ci.yml`, which runs on pull requests and on push to `main`. It checks out the code on Node 20, runs `npm install`, then `typecheck`, `lint`, and `build`.

### Working browser only

This repo is maintained entirely from the GitHub web editor with no local checkout. Because a push to `main` deploys, edits go through a branch and a pull request rather than straight to `main`:

1. In the web editor, when saving, choose "Create a new branch for this commit and start a pull request". Name the branch for the change.
2. Open the PR and wait for CI (typecheck, lint, build) to pass.
3. Merge, then delete the branch with the button GitHub offers right after merge.
4. Keep one change per PR, so a revert is one thing to reverse.

A direct commit to `main` is a deliberate emergency decision, not the default.

---

## Database and migrations

Supabase is the system of record. Migrations live in `supabase/migrations/` (25 files as of this writing), and this is the canonical migration home for the whole project, since it is the larger and better ordered set. Schema changes are committed as migration files, not run only in the SQL editor, so they are reproducible.

Known trap: `src/integrations/supabase/20260721_link_leads_to_cases_on_insert.sql` is a migration sitting outside `supabase/migrations/`, so no tool will ever apply it. Do not assume it is live.

---

## Admin recovery (break glass)

For trusted maintainers only. Do not expose admin recovery through the public app, and do not commit production values. The script looks up an existing Supabase Auth user by email and grants the `admin` role in `public.user_roles`.

```
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
node scripts/grant-admin.mjs --email admin@example.com
```

Or via the package script:

```
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
npm run admin:grant -- --email admin@example.com
```

If the user does not already exist in Supabase Auth, the script exits with an error and creates nothing. Create the user in Supabase Auth first, then rerun. Keep one secondary admin account controlled by the owner as an operational backup.

---

## Smoke testing

Run the manual critical path checklist in [`docs/smoke-test-checklist.md`](https://github.com/dimitriosg/portal-mygreektax/blob/main/docs/smoke-test-checklist.md) after any change to auth, access control, workflow, or tracking. Helper: `bun run smoke:manual`.

---

## Tracking link privacy

Public tracking pages show a short privacy notice and render only client visible updates. Tracking opens keep basic access records (`opened_at` and country) and no longer collect IP, user agent, device, browser, city, or referrer for new opens. Clean up old opens with `select public.cleanup_tracking_link_opens();` (180 day default retention).

---

## Design system

Custom tokens built on OKLCH color, toggled light and dark via the `.dark` class from the header button. Core tokens: `--brand` (amber gold), `--navy` (deep navy backgrounds), `--cream` (off white surfaces), `--olive` (accents). Display font Playfair Display, body font Inter.

---

## Known caveats

Worth knowing before reading the repo in a hurry:

- **About 20 shadow files.** Numerous `.old`, `.backup*.old`, `.old1`, and `.old2` copies sit next to live sources (heaviest around `review.$caseId.tsx`, `AiReviewDesk.tsx`, `drafts.tsx`, and the webhooks). When two files differ only by such a suffix, the one without the suffix is live. Git History already holds every prior version, so these can be deleted in the same PR that supersedes them.
- **Airtable is dead.** Supabase is the only valid data store. The remaining `airtable.server.ts` and `airtable-shared.ts` code, and the `AIRTABLE_*` keys in `.env.example`, are dead artifacts pending removal.
- **A misfiled migration** exists under `src/integrations/supabase/` and never runs (see the Database section).

---

## Security

Keep `.env`, `.env.*`, `.dev.vars`, and `.wrangler/` git ignored, and keep `.env.example` free of real values. Every secret the application itself uses lives in Cloudflare Workers Variables and Secrets and in Supabase, never in git.

There is exactly one deliberate exception, and it is the point of the design rather than an oversight: the private key that decrypts client credential submissions. It is described below and is held outside all three.

### Client TAXISnet credentials

A client may choose to hand over their TAXISnet login so that we can register the authorisation (εξουσιοδότηση) that lets our licensed accountant partner file for them. Where that happens, the credential is stored as ciphertext and nothing more:

- The client's browser encrypts the payload at `/secure-form/$token` before anything leaves the page. Supabase only ever receives an envelope.
- The matching private key is held outside this system entirely. It is not in Supabase, not in a Cloudflare secret, not in an environment variable, and not in this repository. Decryption happens in an admin's browser after the key is pasted in by hand, and the key is dropped on page reload.
- `src/config/secure-form-key.ts` holds the public key. Anyone who can change that file can substitute their own key and silently read every later submission, so changes to it go through a pull request and get read line by line, never straight to `main`.
- Every reveal and every deletion is written to `credential_access_log`, with the service that justified it. A reveal that cannot be logged does not happen.

**Private key custody.** The authoritative copy is a Bitwarden secure note named "MyGreekTax secure form private key", owned by the portal administrator. It must sit in a personal vault, not an organisation vault, because organisation items live in collections and collections are a sharing mechanism.

**Rotation** is additive, never destructive. Generate a new pair at `/admin/secure-keys`, store the new private key alongside the old one, and update the public key and fingerprint in `src/config/secure-form-key.ts` by pull request. Every submission records the fingerprint of the key that encrypted it, so rows written before a rotation stay readable with the retired private key. Retire a private key only once no undeleted submission still carries its fingerprint.

**There is no recovery.** Losing the private key makes every stored submission permanently unreadable. The only remedy is asking affected clients to submit again, so the note should be covered by whatever backup the vault itself provides.

> [!NOTE]
> The privacy policy prerequisite is done. `site-mygreektax` [#11](https://github.com/dimitriosg/site-mygreektax/pull/11) added a TAXISnet credentials section covering client-side encryption, the key held outside these systems, single-purpose use, access logging, the 30-day link expiry and 180-day retention, and consent as the lawful basis. The homepage FAQ, which used to answer this question with a flat "no", now describes the optional route. Links may be issued to real clients.
>
> That page lives on the Astro marketing site rather than in this repository, so anything here that changes what happens to a submission — retention, who can decrypt, what it is used for — needs the policy changed alongside it, not afterwards.

---

*Built with AI assistance, the majority of it by Claude.*
