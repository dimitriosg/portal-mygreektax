# Beautify the client tracking page

Redesign `/track/$token` into a polished, branded experience for clients — premium-minimal aesthetic with a horizontal progress stepper, MyGreekTax branded header, and an estimated time remaining indicator.

## Visual direction

Premium-minimal, calm and trustworthy. Soft gradient background, generous whitespace, refined typography, subtle elevation on cards, a discreet brand accent color. Mobile-first and fully responsive.

## Files to change

### 1. `src/styles.css`
Add a few brand tokens used by the tracking page (kept as semantic CSS variables in `oklch`, both light and dark mode):
- `--brand` and `--brand-foreground` (MyGreekTax accent — refined deep blue/teal)
- `--brand-muted` (soft tinted surface for header band)
- `--gradient-hero` (subtle top-to-bottom gradient for the page background)
- `--shadow-soft` (low, diffuse elevation for cards)

### 2. `src/assets/mygreektax-logo.png` (new)
Generate a small, refined wordmark/monogram logo with `imagegen` (transparent PNG, premium quality) — clean, professional, suitable for a tax service. Imported as an ES module into the tracking page.

### 3. `src/routes/track.$token.tsx` (main redesign)

**Header band**
- Soft branded strip across the top with the MyGreekTax logo + name on the left and a subtle "Job tracker" label on the right.
- Below it, a warm greeting (`Hello {clientName}`) with a one-line description of the service and job code styled as a small chip/badge.

**Horizontal stepper (replaces vertical list + bar)**
- 6 stages (Sent → In Progress → Delivered → Invoiced → Paid → Completed) shown as numbered circles connected by a thin line.
- Completed stages: filled with brand color + checkmark icon.
- Current stage: ringed/highlighted with a soft pulse, label bold below.
- Upcoming stages: muted outline.
- On mobile: horizontally scrollable with snap points, or compressed into a tight row that still fits 360px width (icons + small numbers, label only under the active step).
- A thin progress line behind the circles fills proportionally to `data.progress`.

**Status summary card**
- Large current status label, small percentage, a refined slim progress bar underneath as a secondary cue.
- Status badge color-mapped (e.g. Pending = amber, In Progress = blue, Completed = green) using semantic tokens.

**Timeline / dates card**
- "Started" and "Expected by" with icons (Calendar, Clock from lucide-react).
- New: **Estimated time remaining** — computed client-side from `data.sla`:
  - If `sla` is in the future: show "X days remaining" (or "Due today" / "Due tomorrow").
  - If past and not completed: show "X days overdue" in a warning color.
  - If status is Completed: show "Delivered on time" or "Completed".
  - Hidden gracefully when `sla` is null.

**Latest update card**
- Keep current notes card but with a quote/message icon and slightly softer typography.

**Footer**
- Tiny line: "Secured tracking link · MyGreekTax" with a small lock icon, muted.

### 4. SEO / `<head>`
Add a `head()` to the route with title `Track your job · MyGreekTax` and a generic meta description. No og:image (link is private/per-client).

## Technical notes

- All colors via semantic tokens in `src/styles.css` — no hard-coded hex in the component.
- Icons from `lucide-react` (already in deps): `Check`, `Calendar`, `Clock`, `Lock`, `MessageSquare`, `ShieldCheck`.
- `STAGES` array stays the same; "Pending" maps to position before "In Progress" (treated as still at "Sent" in the stepper, but shown explicitly in the status card).
- Date math for "remaining" uses local Date; reuse `formatDate` from `@/lib/utils`.
- No backend / server-function changes; `getClientTracking` already returns everything needed (`status`, `progress`, `sla`, `dateSent`, `notes`, `clientName`, `serviceName`, `jobCode`).
- Loading state replaced with a skeleton matching the new layout (using existing `Skeleton` component) instead of a plain "Loading…" line.
- Error state keeps the generic "invalid or expired" message (security fix preserved).

## Out of scope
- No changes to authenticated dashboard, admin, or job pages.
- No new server functions, DB migrations, or auth changes.
- No contact-accountant CTA (not requested).
