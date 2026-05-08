## Plan — Plausible Analytics integration

Plausible has no native Lovable connector, so we wire it up directly: their script tag for page views, their `window.plausible(...)` API for custom events, and their Stats API (server-side, with an API key) for an in-app dashboard panel.

### 1. Plausible setup (you do this in plausible.io)

You'll need to do this once before we ship code:

- Add **`portal.mygreektax.eu`** as a site in Plausible. This is the only site we'll send to in production.
- Generate a **Stats API key** (Settings → API Keys) — we'll store it as a Lovable Cloud secret named `PLAUSIBLE_API_KEY` so the admin dashboard can read stats server-side.
- Optional: enable the "outbound links" and "file downloads" extensions in your Plausible site settings.

The `*.lovable.app` preview URLs will NOT send to Plausible — the script auto-skips any host that isn't your configured production domain, so dev/preview traffic never pollutes the stats.

### 2. Tracking script (page views)

Inject Plausible's script into the document head from the root route (`src/routes/__root.tsx`) using TanStack's `head()` API. The script is gated so it only runs on `portal.mygreektax.eu`:

- Use the `script.tagged-events.outbound-links.file-downloads.js` variant so we get pageviews + outbound link clicks + file downloads + named custom events out of the box.
- `data-domain="portal.mygreektax.eu"` — Plausible uses this to associate hits with the right site.
- A small inline guard: only load the script when `window.location.hostname === "portal.mygreektax.eu"`. This prevents preview/`*.lovable.app` traffic from being counted.
- Define a no-op `window.plausible` shim so `plausible(...)` calls don't crash on previews.

SPA navigations (TanStack Router client-side route changes) are auto-tracked by Plausible's script — no manual page-view firing needed.

### 3. Custom events (partner & customer activity)

Add a thin helper `src/lib/analytics.ts` with `track(eventName, props?)` that calls `window.plausible(eventName, { props })` if it exists. Then fire events at meaningful, privacy-safe points:

**Partner side** (authenticated users):
- `partner_login` — fired once after successful login redirect (with `props.partner_role` = "partner" | "admin").
- `job_created` — when admin creates a new job from the New job dialog (props: tier, service).
- `job_status_changed` — when a job moves between statuses (props: from, to).
- `tracking_link_created` — when admin generates a client tracking link.
- `partner_invite_sent` — when admin sends a partner invite.
- `partner_invite_accepted` — on the invite-acceptance flow completion.

**Customer side** (public tracking page `/track/$token`):
- `tracking_page_viewed` — fires automatically (page view).
- `tracking_link_opened` — same trigger as above but as a named event so it's filterable from generic page views (props: job tier).

**Important — what we will NOT send to Plausible:**
- No emails, no full names, no Airtable IDs, no job IDs, no tokens. Plausible is privacy-first and we keep it that way.
- Props are limited to coarse categorical values (tier name, status name, role).

### 4. Embed stats inside the app

Add an "Analytics" panel on the admin overview page (`src/routes/admin.tsx`, gated to admins only):

- New server function `getPlausibleStats` in `src/lib/analytics.functions.ts` that calls Plausible's Stats API (`/api/v1/stats/aggregate`, `/timeseries`, `/breakdown`) with `process.env.PLAUSIBLE_API_KEY`. The key never reaches the browser.
- The panel shows:
  - **Aggregate KPIs** for last 30 days: visitors, page views, bounce rate, avg visit duration.
  - **Timeseries chart** (visitors per day, last 30 days) — rendered with the existing `recharts` setup if present, otherwise a simple sparkline.
  - **Top pages** breakdown (last 7 days).
  - **Top custom events** breakdown (last 7 days) — filtered to our event names so admins can see partner/customer activity counts.
- Wrapped in TanStack Query with a 5-minute stale time so we don't hammer the Plausible API.

### 5. Cookie banner / consent

Plausible doesn't use cookies and isn't subject to GDPR cookie-consent. No banner is needed.

### Files to create

- `src/lib/analytics.ts` — client-side `track()` helper.
- `src/lib/analytics.functions.ts` — `getPlausibleStats` server function (admin-only via `requireSupabaseAuth` + admin role check).
- `src/components/admin-analytics.tsx` — the Analytics panel component.

### Files to edit

- `src/routes/__root.tsx` — inject Plausible script (host-gated) via `head()`.
- `src/routes/admin.tsx` — render `<AdminAnalytics />`.
- `src/lib/auth-context.tsx` (or wherever post-login redirect lives) — fire `partner_login` event.
- `src/lib/jobs.functions.ts` callers — fire `job_created`, `job_status_changed` from the UI side after successful mutations.
- `src/components/admin-partners.tsx` — fire `partner_invite_sent` and `tracking_link_created`.
- `src/routes/track.$token.tsx` — fire `tracking_link_opened`.
- `src/routes/invite.$token.tsx` — fire `partner_invite_accepted`.

### Secret

- `PLAUSIBLE_API_KEY` — added via Lovable Cloud secrets after you generate it in Plausible Settings → API Keys. We'll request it once you confirm the plan.

### Out of scope

- No analytics on Lovable previews (intentional, to keep stats clean).
- No per-user heatmaps or session replays — Plausible doesn't do that.
- No marketing-funnel attribution beyond what Plausible's Goals feature provides.
