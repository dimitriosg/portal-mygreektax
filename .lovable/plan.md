## Goal

Bring the homepage (`src/routes/index.tsx`) in line with the branded look used on the client tracking page (`/track/$token`).

## Changes

**File: `src/routes/index.tsx`**

1. Add a branded header matching `BrandHeader` from the tracking page:
   - MyGreekTax mark (`@/assets/mygreektax-mark.svg`)
   - "MyGreekTax" wordmark with the same olive/italic/brand color treatment
   - Right-side eyebrow label changed to "Partner Workspace" (replacing "Job tracker")

2. Wrap the page in the same hero gradient background (`var(--gradient-hero)`) and full-height layout.

3. Restyle the hero block:
   - Small status pill ("Dedicated Partner Workspace") in the same rounded-border style
   - Serif H1 with italic accent (e.g. *MyGreekTax* Ops or "Welcome to *MyGreekTax* Ops")
   - Muted subtitle
   - Keep the two existing buttons (Partner Login / Admin Login) — no logic changes
   - Keep the customer hint line

4. Add a footer matching the tracking page (ShieldCheck icon + "MyGreekTax" tagline).

5. Add `head()` metadata: title "MyGreekTax · Partner Workspace" and a short description (SEO).

## Out of scope

- No changes to auth, routes, or business logic.
- No changes to other pages.
