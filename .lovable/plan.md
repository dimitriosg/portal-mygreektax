## Goal

In **Admin overview → Partners**, surface partner status at a glance, show last activity, and let admins disable/enable a partner's access.

## Changes

### 1. Database (migration)

- Add `disabled_at timestamptz` and `disabled_by uuid` columns to `partner_profiles`.
- Add a SQL helper `get_partner_last_seen(uuid[])` returning `(user_id, last_seen_at)` — computed from the most recent `partner_login` event in `activity_events` per user. Admin-only (SECURITY DEFINER, `has_role`).
- (Auth enforcement happens in app code — see step 3 — since revoking Supabase sessions requires the service role.)

### 2. Server functions (`src/lib/invites.functions.ts`)

- Extend `listPartnerProfilesAdmin` to also return `last_seen_at` and `disabled_at` for each partner (single batched call to the new RPC).
- Add `setPartnerDisabled({ userId, disabled })` — admin-only:
  - Updates `partner_profiles.disabled_at` / `disabled_by`.
  - When disabling: calls `supabaseAdmin.auth.admin.signOut(userId, 'global')` to invalidate existing sessions immediately.
  - Logs an `activity_events` row (`partner_disabled` / `partner_enabled`) so it appears in the daily summary.

### 3. Login gate (`src/lib/activity.functions.ts` / auth flow)

- In `recordPartnerLogin` (called right after sign-in): if the user is a partner and `partner_profiles.disabled_at` is set, call `supabase.auth.signOut()` server-side and return `{ disabled: true }`.
- In `auth-context.tsx`: if the response indicates `disabled`, sign out client-side and toast "Your access has been disabled. Please contact your administrator."

### 4. UI (`src/components/admin-partners.tsx`)

Replace the **Active partners** table with new columns:

```text
Name | Email | Airtable | Status | Last seen | Joined | Actions
```

- **Status** badge:
  - `Active` (green) — has account, not disabled, seen in last 30 days.
  - `Inactive` (gray) — has account, not disabled, no login in 30+ days (or never logged in).
  - `Disabled` (red) — `disabled_at` is set.
- **Last seen** column: relative time ("2 hours ago", "5 days ago", "Never") from `last_seen_at`.
- **Actions** column: dropdown with "Disable access" / "Enable access" — opens a small confirm dialog before mutating; on success, invalidates the `partners` query.

For the **Pending invitations** table — no change to columns, but clarify the section subtitle: *"Partners who haven't accepted yet."* And add a tiny help line under the **Active partners** header: *"Partners with an account. 'Inactive' = no login in the last 30 days."*

## Out of scope

- No deletion of partner accounts (only disable/enable).
- No per-partner activity drill-down view (could be a follow-up).
- No change to the daily/weekly summary email template — `partner_disabled` / `partner_enabled` will show up automatically once added to `TYPE_TITLES` in `activity-summary.server.tsx`.
