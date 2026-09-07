/**
 * "3 min ago" / "2 days ago" / "Never".
 *
 * Lifted verbatim out of src/components/admin-partners.tsx, where it had been
 * module-private, when the correspondence header needed the same thing. Two
 * copies of a phrasing rule is how "5 days ago" and "5 days" end up on the same
 * screen, so there is one, here, and admin-partners imports it.
 *
 * `now` is a parameter with a default so callers can pin it and so this stays
 * testable — the same reason src/lib/reports-aggregate.ts takes one.
 *
 * This is deliberately relative and locale-free. Anywhere it is shown, pair it
 * with an absolute Athens timestamp on hover (athensFullStamp from
 * src/lib/case-thread.ts): relative is what the eye reads, absolute is what
 * settles an argument about when something actually happened.
 */
export function relativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "Never";
  const ms = now.getTime() - then;
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  // The boundary is in days, not months. Deciding it on `months < 12` leaves a
  // five-day hole: 360 to 364 days is 12 whole 30-day months, so it fell
  // through to the year branch and floor(360/365) printed "0 years ago". That
  // was live in admin-partners' "Last seen" column before this helper moved
  // here, and it now also feeds the correspondence freshness line.
  if (days < 365) {
    const months = Math.floor(days / 30);
    return `${months} month${months === 1 ? "" : "s"} ago`;
  }
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
