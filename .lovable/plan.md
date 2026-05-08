# Partner Invitations (Admin-Only Onboarding)

Replace public partner signup with an admin-issued invite flow. Admins create the partner record from the console, then either email the invite link or copy it to send manually. The partner clicks the link, sets a password, and signs in normally afterward.

## 1. Remove public signup

- **`src/routes/login.tsx`**: drop the `mode` toggle and the signup branch. Keep email + password sign-in only. Add a small "Forgot password?" link (out of scope for this plan, but leave room).
- Remove the "Need an account? Create one" button.
- Update copy: "Partner & admin sign in. Access is by invitation only."
- Lock down public signup at the auth provider level: disable open signups (`disable_signup: true`) so even a direct `supabase.auth.signUp` call from outside is rejected.

## 2. Database changes

New table `partner_invites`:

| column | type | notes |
|---|---|---|
| id | uuid PK | |
| token | text unique | 32-byte random hex, stored hashed (sha256) |
| email | text | normalized lowercase |
| first_name | text | |
| last_name | text | |
| airtable_accountant_id | text | links to Airtable Accountants record (optional at create time, can be created on accept) |
| created_by | uuid | admin user id |
| created_at | timestamptz | default now() |
| expires_at | timestamptz | default now() + 7 days |
| consumed_at | timestamptz | nullable |
| consumed_user_id | uuid | nullable |

RLS:
- Admins can do everything (`has_role(auth.uid(), 'admin')`).
- No public/anon select. Token validation happens server-side via service role inside a server function.

## 3. Server functions (`src/lib/invites.functions.ts`)

All admin-gated functions check `has_role` via `supabaseAdmin` after `requireSupabaseAuth`:

- `createPartnerInvite({ firstName, lastName, email, airtableAccountantId? })`
  - Admin only. Normalizes email, generates 32-byte token, stores sha256 hash, returns the **plaintext token + invite URL** to the admin once.
  - Optionally creates an Airtable Accountant record up-front, or links to existing one by id.
- `sendInviteEmail({ inviteId })` — admin only. Enqueues a branded email via Lovable Email infrastructure containing the invite link.
- `getInviteByToken({ token })` — public (no auth). Returns `{ firstName, lastName, email }` if token is valid, unconsumed, and unexpired. Otherwise returns `{ valid: false }` with no detail.
- `acceptPartnerInvite({ token, password })` — public. Validates token, creates the auth user via `supabaseAdmin.auth.admin.createUser` with `email_confirm: true` and the chosen password, creates the `partner_profiles` row linked to the Airtable accountant, assigns `partner` role, marks the invite consumed, and signs the user in (returns a session or asks the client to call `signInWithPassword` immediately after).
- `listPartnerInvites()` / `revokePartnerInvite({ inviteId })` — admin only, for the management UI.

Rate-limit `getInviteByToken` and `acceptPartnerInvite` (simple per-IP counter via a small `invite_attempts` table, or in-memory if acceptable). Always use timing-safe comparison on the token hash.

## 4. Admin console UI (`src/routes/admin.tsx` — new "Partners" section)

Add a new card/tab "Partners":
- Table of existing partners (from `partner_profiles`) and pending invites (from `partner_invites` where `consumed_at IS NULL`).
- Button **"Invite partner"** → dialog with: First name, Last name, Email, optional Airtable Accountant link (dropdown of existing Accountants from Airtable, or "Create new").
- On submit, call `createPartnerInvite`. On success, open a follow-up dialog showing:
  - The full invite URL
  - Two buttons: **"Send via email"** (calls `sendInviteEmail`) and **"Copy link"** (clipboard)
  - The token plaintext is shown only on this screen and never again (re-issuing requires revoke + new invite).
- Each pending invite row: shows expiry, has "Resend email", "Copy link" (re-shows URL since admin can re-derive — actually cannot, since hash is stored; provide "Revoke & reissue" instead), and "Revoke".

## 5. Public invite acceptance route (`src/routes/invite.$token.tsx`)

Public route, mirrors the styling of `/track/$token`:
- On mount, calls `getInviteByToken`.
- If invalid/expired: friendly card "This invitation link is no longer valid. Please contact your administrator."
- If valid: shows "Welcome, {firstName}" + email (read-only) + password + confirm password fields. Validate with Zod (min 12 chars, mix recommended).
- On submit: call `acceptPartnerInvite`, then `supabase.auth.signInWithPassword`, then redirect to `/dashboard`.

## 6. Email template

Use Lovable's transactional email infrastructure (already used for auth emails if set up):
- Subject: "You've been invited to MyGreekTax Partner Portal"
- Body: branded with the existing logo + colors, one CTA button to the invite URL, expiry note ("This link expires in 7 days").

## 7. Security details

- Tokens: 32 bytes from `crypto.randomBytes`, hex-encoded. Stored as sha256 hash; never log plaintext.
- Single use: `consumed_at` set atomically with the user creation. Use a transaction/RPC to avoid races.
- Email match: the auth user is created with the invited email; the partner cannot change it during acceptance.
- Existing-email guard: if `auth.users` already has that email, return a clear admin-side error instead of creating a duplicate.
- Strip the invite token from URL after acceptance (`history.replaceState`).
- Audit: keep `created_by` and `consumed_at` for traceability.

## What we are not doing

- No self-service partner signup anywhere.
- No "secret universal link" — every invite is per-partner.
- Forgot-password flow is unchanged (out of scope; can be added later).

## Open question (default if you don't answer)

If you don't already have Lovable Emails / a verified email domain set up, the "Send via email" button will be disabled until that's configured. The "Copy link" path works regardless. Default: I'll wire the email button to gracefully degrade to "Email not configured — copy link instead" if no domain is active, and we can set up the email domain in a follow-up.
