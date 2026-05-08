import { render } from "@react-email/components";
import * as React from "react";
import { template as activitySummaryTemplate } from "./email-templates/activity-summary";
import type {
  ActivitySummarySection,
  ActivitySummaryRow,
} from "./email-templates/activity-summary";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const SENDER_DOMAIN = "notify.portal.mygreektax.eu";
const FROM_DOMAIN = "portal.mygreektax.eu";
const SITE_NAME = "My Greek Tax";
const TZ = "Europe/Athens";

function genToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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
    const label = formatAthens(start, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
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
  tracking_link_opened: "Tracking links opened (customers)",
};

function describeRow(ev: any): ActivitySummaryRow {
  const md = (ev.metadata ?? {}) as Record<string, any>;
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
  const actor = ev.event_type === "tracking_link_opened" ? `Customer${actorEmail}` : `${actorName}${actorEmail}`;

  let description: string;
  switch (ev.event_type) {
    case "partner_login":
      description = `Logged in (${md.role ?? "user"})`;
      break;
    case "partner_invite_accepted":
      description = `Accepted partner invitation`;
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
    case "tracking_link_opened":
      description = `Opened tracking link for ${md.jobCode ?? ev.subject_label ?? "a job"} (status: ${md.status ?? "—"})`;
      break;
    default:
      description = ev.event_type;
  }
  return { when, actor, description };
}

export async function buildSummary(period: SummaryPeriod) {
  const { start, end, label } = computeRange(period);
  const { data: events, error } = await supabaseAdmin
    .from("activity_events" as any)
    .select("*")
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString())
    .order("occurred_at", { ascending: true });
  if (error) throw new Error(`Failed to load activity events: ${error.message}`);

  const grouped: Record<string, any[]> = {};
  for (const ev of (events ?? []) as any[]) {
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
    "tracking_link_opened",
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

async function listAdminEmails(): Promise<string[]> {
  const { data: roles } = await supabaseAdmin
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin");
  const ids = (roles ?? []).map((r) => r.user_id).filter(Boolean);
  const out: string[] = [];
  for (const id of ids) {
    const { data } = await supabaseAdmin.auth.admin.getUserById(id);
    const email = data?.user?.email;
    if (email) out.push(email);
  }
  return Array.from(new Set(out.map((e) => e.toLowerCase())));
}

async function enqueueOne(recipient: string, summary: Awaited<ReturnType<typeof buildSummary>>) {
  const normalized = recipient.toLowerCase();
  const { data: suppressed } = await supabaseAdmin
    .from("suppressed_emails" as any)
    .select("id")
    .eq("email", normalized)
    .maybeSingle();
  if (suppressed) return { skipped: true, reason: "suppressed" };

  // Get/create unsubscribe token.
  let unsubscribeToken: string | null = null;
  const { data: existing } = await supabaseAdmin
    .from("email_unsubscribe_tokens" as any)
    .select("token, used_at")
    .eq("email", normalized)
    .maybeSingle();
  if (existing && !(existing as any).used_at) {
    unsubscribeToken = (existing as any).token;
  } else if (!existing) {
    unsubscribeToken = genToken();
    await supabaseAdmin
      .from("email_unsubscribe_tokens" as any)
      .upsert({ token: unsubscribeToken, email: normalized }, { onConflict: "email", ignoreDuplicates: true } as any);
  }

  const props = {
    period: summary.period,
    rangeLabel: summary.rangeLabel,
    totals: summary.totals,
    sections: summary.sections,
  };
  const element = React.createElement(activitySummaryTemplate.component, props);
  const html = await render(element);
  const text = await render(element, { plainText: true });

  const subject =
    typeof activitySummaryTemplate.subject === "function"
      ? (activitySummaryTemplate.subject as (d: any) => string)(props)
      : (activitySummaryTemplate.subject as string);

  const messageId = crypto.randomUUID();
  const idem = `activity-summary-${summary.period}-${summary.rangeLabel}-${normalized}`;

  await supabaseAdmin.from("email_send_log" as any).insert({
    message_id: messageId,
    template_name: "activity-summary",
    recipient_email: recipient,
    status: "pending",
  });

  const { error: enqueueError } = await supabaseAdmin.rpc("enqueue_email" as any, {
    queue_name: "transactional_emails",
    payload: {
      message_id: messageId,
      to: recipient,
      from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      sender_domain: SENDER_DOMAIN,
      subject,
      html,
      text,
      purpose: "transactional",
      label: "activity-summary",
      idempotency_key: idem,
      unsubscribe_token: unsubscribeToken,
      queued_at: new Date().toISOString(),
    },
  } as any);

  if (enqueueError) {
    await supabaseAdmin.from("email_send_log" as any).insert({
      message_id: messageId,
      template_name: "activity-summary",
      recipient_email: recipient,
      status: "failed",
      error_message: "Failed to enqueue activity summary",
    });
    return { skipped: false, error: enqueueError.message };
  }
  return { skipped: false };
}

export async function sendSummaryToAdmins(period: SummaryPeriod) {
  const summary = await buildSummary(period);
  const admins = await listAdminEmails();
  const results: Record<string, any> = {};
  for (const email of admins) {
    results[email] = await enqueueOne(email, summary);
  }
  return { period, range: summary.rangeLabel, totalEvents: summary.totalEvents, recipients: admins.length, results };
}

/** Returns true if the current Athens local time matches `hour` (and optional weekday). */
export function isAthensTimeMatch(hour: number, weekday?: "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun"): boolean {
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