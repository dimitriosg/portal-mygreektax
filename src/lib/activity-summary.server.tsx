import type {
  ActivitySummarySection,
  ActivitySummaryRow,
} from "./email-templates/activity-summary";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Database } from "@/integrations/supabase/types";
import { listAdminEmails } from "./access-context.server";
import { refuseOutboundEmail } from "./outbound-email.server";

const TZ = "Europe/Athens";

type ActivityEventRow = Database["public"]["Tables"]["activity_events"]["Row"];
type ActivityEventMetadata = Record<string, string | number | null | undefined>;

function formatAthens(date: Date, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, ...opts }).format(date);
}

export type SummaryPeriod = "daily" | "weekly";

/** Returns inclusive start (UTC ISO) and exclusive end (UTC ISO) plus a label. */
export function computeRange(period: SummaryPeriod, now: Date = new Date()) {
  // We use Postgres-like math via JS: yesterday in Athens for daily,
  // previous Mon-Sun for weekly.
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // YYYY-MM-DD in Athens

  // Find the Athens TZ offset (in minutes) at this moment.
  const offsetParts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const tzn = offsetParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+02:00";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(tzn);
  const sign = m && m[1] === "-" ? -1 : 1;
  const offH = m ? parseInt(m[2], 10) : 2;
  const offM = m && m[3] ? parseInt(m[3], 10) : 0;
  const offsetMs = sign * (offH * 60 + offM) * 60000;

  const todayAthensMidnightUtc = new Date(`${ymd}T00:00:00Z`).getTime() - offsetMs;

  if (period === "daily") {
    const start = new Date(todayAthensMidnightUtc - 86400000);
    const end = new Date(todayAthensMidnightUtc);
    const label = formatAthens(start, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    return { start, end, label };
  }

  // Weekly: previous Mon 00:00 Athens through this Mon 00:00 Athens.
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(now);
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const dayNum = map[wd] ?? 1;
  const daysSinceMonday = dayNum - 1;
  const thisMonAthensMidnightUtc = todayAthensMidnightUtc - daysSinceMonday * 86400000;
  const start = new Date(thisMonAthensMidnightUtc - 7 * 86400000);
  const end = new Date(thisMonAthensMidnightUtc);
  const startLabel = formatAthens(start, { weekday: "short", day: "numeric", month: "short" });
  const endLabel = formatAthens(new Date(end.getTime() - 86400000), {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return { start, end, label: `${startLabel} – ${endLabel}` };
}

const TYPE_TITLES: Record<string, string> = {
  partner_login: "Partner logins",
  partner_invite_accepted: "Partner invitations accepted",
  partner_disabled: "Partners disabled",
  partner_enabled: "Partners re-enabled",
  job_created: "Jobs created",
  job_status_changed: "Job status changes",
  tracking_link_created: "Tracking links created (admin)",
  tracking_link_regenerated: "Tracking links regenerated (admin)",
  tracking_link_opened: "Tracking links opened (customers)",
  tracking_link_extended: "Tracking links extended (admin)",
};

function describeRow(ev: ActivityEventRow): ActivitySummaryRow {
  const md = (ev.metadata ?? {}) as ActivityEventMetadata;
  const when = formatAthens(new Date(ev.occurred_at), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const actorName = ev.actor_name ?? ev.actor_email ?? "Unknown";
  const actorEmail = ev.actor_email ? ` (${ev.actor_email})` : "";
  const actor =
    ev.event_type === "tracking_link_opened"
      ? `Customer${actorEmail}`
      : `${actorName}${actorEmail}`;

  let description: string;
  switch (ev.event_type) {
    case "partner_login":
      description = `Logged in (${md.role ?? "user"})`;
      break;
    case "partner_invite_accepted":
      description = `Accepted partner invitation`;
      break;
    case "partner_disabled":
      description = `Disabled partner ${ev.subject_label ?? md.target_email ?? ""}`;
      break;
    case "partner_enabled":
      description = `Re-enabled partner ${ev.subject_label ?? md.target_email ?? ""}`;
      break;
    case "job_created":
      description = `Created job ${md.jobCode ?? ev.subject_label ?? ""} (${md.status ?? "—"})`;
      break;
    case "job_status_changed":
      description = `${md.jobCode ?? ev.subject_label ?? "Job"} — ${md.from ?? "—"} → ${md.to ?? "—"}`;
      break;
    case "tracking_link_created":
      description = `Generated tracking link for ${md.jobCode ?? ev.subject_label ?? "a job"}${md.recipient ? ` (sent to ${md.recipient})` : ""}`;
      break;
    case "tracking_link_regenerated":
      description = `Regenerated tracking link for ${md.jobCode ?? ev.subject_label ?? "a job"}${md.recipient ? ` (sent to ${md.recipient})` : ""}`;
      break;
    case "tracking_link_opened":
      description = `Opened tracking link for ${md.jobCode ?? ev.subject_label ?? "a job"} (status: ${md.status ?? "—"})`;
      break;
    case "tracking_link_extended":
      description = `Extended tracking link for ${ev.subject_label ?? "a job"} by ${md.daysAdded ?? "?"} days (new expiry: ${md.newExpiresAt ?? "—"})`;
      break;
    default:
      description = ev.event_type;
  }
  return { when, actor, description };
}

export async function buildSummary(period: SummaryPeriod) {
  const { start, end, label } = computeRange(period);
  const { data: events, error } = await supabaseAdmin
    .from("activity_events")
    .select("*")
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString())
    .order("occurred_at", { ascending: true });
  if (error) throw new Error(`Failed to load activity events: ${error.message}`);

  const grouped: Record<string, ActivityEventRow[]> = {};
  for (const ev of events ?? []) {
    (grouped[ev.event_type] ||= []).push(ev);
  }

  const order = [
    "partner_login",
    "partner_invite_accepted",
    "partner_disabled",
    "partner_enabled",
    "job_created",
    "job_status_changed",
    "tracking_link_created",
    "tracking_link_regenerated",
    "tracking_link_opened",
    "tracking_link_extended",
  ];
  const sections: ActivitySummarySection[] = order
    .filter((t) => grouped[t]?.length)
    .map((t) => ({
      title: TYPE_TITLES[t] ?? t,
      count: grouped[t].length,
      rows: grouped[t].map(describeRow),
    }));

  const totals = sections.map((s) => ({ label: s.title, value: s.count }));

  return { period, rangeLabel: label, totals, sections, totalEvents: (events ?? []).length };
}

// Refuses. The portal has no transactional sender -- see
// src/lib/outbound-email.server.ts for the full reason, including why this is
// not being repointed at Mailgun in the portal.
//
// LOUDEST IN PRINCIPLE, QUIETEST IN PRACTICE. sendSummaryToAdmins below is the
// only caller of this, and it has no callers of its own anywhere in the repo:
// no route, no server function, no scheduled trigger, nothing in SQL. The
// activity summary cannot currently be triggered at all, which is consistent
// with the queue holding three partner invites and nothing else. Refusing here
// changes the behaviour of a path nobody can reach today; it is done so that
// whoever wires a trigger finds a refusal rather than a silent enqueue.
//
// REMOVED WITH THE ENQUEUE, recoverable from git when n8n takes this over: the
// suppressed_emails check, the get-or-create of the unsubscribe token, and the
// React Email render (email-templates/activity-summary.tsx is still present and
// still the source of the wording). buildSummary above is untouched -- it reads
// activity_events and composes the digest, which is the part worth keeping and
// the part n8n will want handed to it.
async function enqueueOne(
  recipient: string,
  summary: Awaited<ReturnType<typeof buildSummary>>,
): Promise<never> {
  void summary;
  return refuseOutboundEmail({
    templateName: "activity-summary",
    recipientEmail: recipient,
  });
}

export async function sendSummaryToAdmins(period: SummaryPeriod) {
  const summary = await buildSummary(period);
  const admins = await listAdminEmails();
  const results: Record<string, Awaited<ReturnType<typeof enqueueOne>>> = {};
  for (const email of admins) {
    results[email] = await enqueueOne(email, summary);
  }
  return {
    period,
    range: summary.rangeLabel,
    totalEvents: summary.totalEvents,
    recipients: admins.length,
    results,
  };
}

/** Returns true if the current Athens local time matches `hour` (and optional weekday). */
export function isAthensTimeMatch(
  hour: number,
  weekday?: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun",
): boolean {
  const now = new Date();
  const h = parseInt(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now),
    10,
  );
  if (h !== hour) return false;
  if (weekday) {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(now);
    if (wd !== weekday) return false;
  }
  return true;
}
