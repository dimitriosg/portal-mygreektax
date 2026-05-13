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

| Layer        | Technology                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Framework    | [TanStack Start](https://tanstack.com/start) + [TanStack Router](https://tanstack.com/router)                            |
| UI           | [React](https://react.dev) + [shadcn/ui](https://ui.shadcn.com) + [Tailwind CSS v4](https://tailwindcss.com)             |
| Server State | [TanStack Query](https://tanstack.com/query)                                                                             |
| Auth         | [Supabase](https://supabase.com)                                                                                         |
| Data         | [Airtable](https://airtable.com) (job records)                                                                           |
| Drag & Drop  | [@dnd-kit](https://dndkit.com)                                                                                           |
| Runtime      | [Cloudflare Workers](https://workers.cloudflare.com) via [Wrangler](https://developers.cloudflare.com/workers/wrangler/) |
| Analytics    | [Plausible](https://plausible.io)                                                                                        |
| Built with   | [Lovable](https://lovable.dev) + GitHub Copilot                                                                          |

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

Production runtime variables and secrets live in the Cloudflare Workers dashboard. Do not commit `.env.production` or any real environment values to this repository.

For local development, use a local `.env` file or `.dev.vars` (both ignored by git). `.env.example` documents the safe placeholder keys:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
AIRTABLE_API_KEY=your-airtable-api-key
AIRTABLE_BASE_ID=your-airtable-base-id
AIRTABLE_TABLE_JOBS=your-airtable-jobs-table-id
AIRTABLE_TABLE_CLIENTS=your-airtable-clients-table-id
AIRTABLE_TABLE_SERVICE_CATALOG=your-airtable-service-catalog-table-id
AIRTABLE_TABLE_ACCOUNTANTS=your-airtable-accountants-table-id
PLAUSIBLE_API_KEY=your-plausible-api-key
```

- `VITE_SUPABASE_URL` is the client-side Supabase URL.
- `VITE_SUPABASE_PUBLISHABLE_KEY` is the required client-side Supabase publishable key.
- `SUPABASE_PUBLISHABLE_KEY` is an optional server-side alias for the publishable key when configured in Cloudflare.
- `SUPABASE_URL` is optional; server code falls back to `VITE_SUPABASE_URL` when it is not set.
- `SUPABASE_SERVICE_ROLE_KEY` is required for server-side admin operations.
- `AIRTABLE_API_KEY` is required for Airtable API access.
- `AIRTABLE_BASE_ID` configures the Airtable base ID at runtime.
- `AIRTABLE_TABLE_JOBS`, `AIRTABLE_TABLE_CLIENTS`, `AIRTABLE_TABLE_SERVICE_CATALOG`, and `AIRTABLE_TABLE_ACCOUNTANTS` configure the Airtable table IDs at runtime.
- `PLAUSIBLE_API_KEY` is optional and only needed for the analytics panel.

For production:

- Set `AIRTABLE_BASE_ID` and the Airtable table IDs in Cloudflare Workers Variables.
- Store `AIRTABLE_API_KEY` in Cloudflare Workers Secrets.
- Treat the current hardcoded Airtable IDs only as temporary backward-compatible fallbacks during rollout.

### Deploy

There is no `deploy` script in `package.json`. To deploy manually after installing Wrangler CLI, run:

```bash
wrangler deploy
```

Cloudflare Workers remains the production runtime, and the required production Variables and Secrets should be managed in the Cloudflare dashboard.

---

## Admin recovery / break-glass procedure

This procedure is only for trusted maintainers. Do not expose admin recovery through the public app, and do not commit production variables or secrets to git; production values remain in Cloudflare Workers and Supabase.

The recovery script requires `SUPABASE_SERVICE_ROLE_KEY` plus `SUPABASE_URL` (or `VITE_SUPABASE_URL`) so it can look up an existing Supabase Auth user by email and grant that user the `admin` role in `public.user_roles`.

```bash
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
node scripts/grant-admin.mjs --email admin@example.com
```

You can also run the package script:

```bash
SUPABASE_URL=https://your-project.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key \
npm run admin:grant -- --email admin@example.com
```

If the user does not already exist in Supabase Auth, the script exits with an error and does not create the account automatically. Create the user manually in Supabase Auth first, then run the recovery command.

Recommended operational backup:

- Keep one secondary admin account controlled by the owner.
- Do not expose admin recovery through the public app.

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

Ensure `.env`, `.env.*`, `.dev.vars`, and `.wrangler/` stay ignored by git, while keeping `.env.example` safe to commit. All production secrets must be stored in Cloudflare Workers Variables and Secrets.
