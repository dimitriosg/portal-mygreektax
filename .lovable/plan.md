# Tracking-link analytics

Today every customer open writes a `tracking_link_opened` row to `activity_events`, but nothing is aggregated per link or shown in the UI. We'll add proper counters + an open log, and surface stats both inline on the job page and on a new admin page.

## 1. Database

**Extend `client_tokens`** with aggregate counters:
- `open_count int not null default 0`
- `first_opened_at timestamptz`
- `last_opened_at timestamptz`
- `last_ip text`
- `last_country text`
- `last_user_agent text`

**New table `tracking_link_opens`** (one row per open, for the detail log):
- `id uuid pk`
- `token text not null` (indexed, references the link)
- `opened_at timestamptz default now()`
- `ip text`, `country text`, `city text`
- `user_agent text`, `device text`, `browser text`, `os text`
- `referrer text`

RLS: admin-only read/manage. Inserts happen via service role from the server function.

## 2. Capture on every open

Update `getClientTracking` in `src/lib/jobs.functions.ts`:
- Read request headers via `getRequest()` / `getRequestHeader()`:
  - IP → `cf-connecting-ip` (Cloudflare Worker) with fallback to `x-forwarded-for`
  - Country → `cf-ipcountry` header (free, provided by the Worker runtime — no extra geo service needed)
  - User-Agent → parse with `ua-parser-js` into device/browser/OS
  - Referrer → `referer` header
- Insert a row into `tracking_link_opens`
- `UPDATE client_tokens SET open_count = open_count + 1, last_opened_at = now(), first_opened_at = coalesce(first_opened_at, now()), last_ip = …, last_country = …, last_user_agent = …`
- Keep the existing `activity_events` insert (so the daily admin summary keeps working unchanged).

Privacy note: IP + country are PII. We'll show a small "Customer IPs and approximate location are stored for fraud/abuse review" line on the admin page so it's transparent.

## 3. Inline stats on the job page

In `src/routes/jobs.$jobId.tsx`, next to the existing "Copy client tracking link" button, add a small status block (only when a token exists for the job):

```
Tracking link · 12 opens · last opened 2h ago from Athens, GR
[ Show recent opens ▾ ]
```

Expanding shows the last 10 rows from `tracking_link_opens` (when, country, device/browser).

New server fn: `getJobTrackingStats({ jobId })` → returns the token row + last 10 opens. Admin only.

## 4. New Admin → Tracking links page

New route `src/routes/admin.tracking-links.tsx` (linked from the existing Admin overview). Table columns:

| Job code | Client | Created | Expires | Opens | Last open | Last location | Status |

- Sortable by Last open / Opens.
- Search by job code or client email.
- Row click → drawer with the full open log (date, IP, country, city, device, browser, referrer).
- "Copy link" action per row.
- No revoke button (per your choice — links just expire after 90 days).

New server fn: `listTrackingLinks()` (admin) → joins `client_tokens` with the last open. Pagination by 50.

## 5. Files touched

- New migration: extend `client_tokens`, create `tracking_link_opens` + RLS.
- `src/lib/jobs.functions.ts` — add header parsing, insert into `tracking_link_opens`, increment counters, add `getJobTrackingStats` and `listTrackingLinks`.
- `src/routes/jobs.$jobId.tsx` — inline tracking-link stats panel.
- `src/routes/admin.tracking-links.tsx` — new page.
- `src/routes/admin.tsx` — add nav card linking to the new page.
- `package.json` — add `ua-parser-js` (tiny, Worker-safe, pure JS).

## Out of scope

- Geo lookup beyond Cloudflare's `cf-ipcountry` header (no MaxMind / paid IP lookup).
- Email/Slack notifications on open.
- Revoke button (links expire after 90 days as today).
