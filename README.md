# My Greek Tax — Partner Portal

A private partner portal for **MyGreekTax** — a Greek tax services platform. Accountant partners use this portal to manage assigned tax jobs, track client progress via tokenized links, and submit change requests to admins.

🌐 **Live:** [portal.mygreektax.eu](https://portal.mygreektax.eu)

---

## Features

### Partner View
- View and manage assigned tax jobs
- Drag-and-drop manual job ordering (persisted server-side)
- Overdue jobs badge on nav (red count of jobs past SLA deadline)
- Copy tokenized client tracking links
- Submit change requests to admin
- Job detail view with history timeline

### Admin View
- Full job table with filters (status, service type, tier, partner)
- Skeleton loading states for smooth UX
- Impersonate any partner to see their exact view
- Analytics via Plausible

### General
- Supabase authentication (email/password)
- Dark mode toggle
- Responsive layout (mobile-friendly nav)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [TanStack Start](https://tanstack.com/start) + [TanStack Router](https://tanstack.com/router) |
| UI | [React](https://react.dev) + [shadcn/ui](https://ui.shadcn.com) + [Tailwind CSS v4](https://tailwindcss.com) |
| Server State | [TanStack Query](https://tanstack.com/query) |
| Auth | [Supabase](https://supabase.com) |
| Data | [Airtable](https://airtable.com) (job records) |
| Drag & Drop | [@dnd-kit](https://dndkit.com) |
| Runtime | [Cloudflare Workers](https://workers.cloudflare.com) via [Wrangler](https://developers.cloudflare.com/workers/wrangler/) |
| Analytics | [Plausible](https://plausible.io) |
| Built with | [Lovable](https://lovable.dev) + GitHub Copilot |

---

## Project Structure

```
src/
├── routes/           # File-based routes (TanStack Router)
│   ├── __root.tsx    # App shell, nav, auth context
│   ├── index.tsx     # Root redirect
│   ├── login.tsx     # Auth page
│   ├── dashboard.tsx # Partner dashboard
│   ├── jobs.$jobId.tsx # Job detail page
│   ├── admin.tsx     # Admin panel
│   └── track.$token.tsx # Public client tracking page
├── components/       # Shared UI components
├── lib/              # Auth context, Airtable functions, Supabase client
└── styles.css        # Design tokens (OKLCH color system)
```

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (package manager)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- A Cloudflare account with Workers enabled
- A Supabase project
- An Airtable base with the jobs schema

### Local Development

```bash
# Install dependencies
bun install

# Start dev server
bun run dev
```

### Environment Variables

Create a `.env` file (never commit this) with:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
AIRTABLE_API_KEY=
AIRTABLE_BASE_ID=
AIRTABLE_TABLE_NAME=
PLAUSIBLE_DOMAIN=
```

For production, add these as encrypted secrets in the Cloudflare Workers dashboard.

### Deploy

```bash
bun run deploy
```

This runs `wrangler deploy` and pushes to Cloudflare Workers. Lovable also auto-deploys on every push to `main`.

---

## Deployment Architecture

```
Lovable / Copilot / Direct commits
          │
          ▼
     GitHub main
          │
          ▼
  Cloudflare Workers  ──▶  portal.mygreektax.eu
```

All commits to `main` trigger a new Cloudflare Workers build and deployment.

---

## Design System

The app uses a custom design system built on OKLCH color tokens:

- `--brand` — Amber gold (primary brand colour)
- `--navy` — Deep navy (backgrounds, headers)
- `--cream` — Off-white (surface, cards)
- `--olive` — Olive green (accents)
- `--font-serif` — Playfair Display (brand/logo)
- `--font-sans` — Inter (body text)

Dark mode is supported via the `.dark` class toggled by the header button.

---

## ⚠️ Security Note

Ensure `.env` is listed in `.gitignore` and never committed to the repository. All production secrets must be stored as Cloudflare Workers encrypted environment variables.
