import { describe, expect, it } from "vitest";

import {
  concentrationFrom,
  filterJobs,
  filterLeads,
  funnelFrom,
  liveTotals,
  monthlyFrom,
  pipelineFrom,
  sourcesFrom,
  totalsOf,
  watchlistFrom,
  type ReportJobRow,
  type ReportLeadRow,
} from "./reports-aggregate";

// These aggregations used to live in SQL views. Moving them into TypeScript is
// only safe if the numbers are identical, so the pipeline cases below assert
// the figures verified against production on 4 September 2026 — 49 jobs, 8,552
// retail, 2,490 wholesale, 6,062 margin — rather than a hand-made fixture.
// Everything else here is a trap the live data actually set.

function job(over: Partial<ReportJobRow> = {}): ReportJobRow {
  return {
    id: "j1",
    job_code: "JB001",
    status: "Completed",
    client_id: "c1",
    client_code: "CLT0001",
    client_name: "A Client",
    service_name: "Service",
    service_code: "SVC",
    retail: 100,
    wholesale: 40,
    gross_margin: 60,
    margin_pct: 0.6,
    month: "2026-08-01",
    wholesale_missing: false,
    is_cancelled: false,
    date_sent: "2026-08-15",
    sla_deadline: null,
    paid_at: null,
    created_at: "2026-08-10T09:00:00Z",
    ...over,
  };
}

function lead(over: Partial<ReportLeadRow> = {}): ReportLeadRow {
  return {
    client_id: "c1",
    client_code: "CLT0001",
    client_name: "A Client",
    source: "Referral",
    current_stage: "Active",
    current_status: "Active",
    lead_created_at: "2026-08-01T09:00:00Z",
    quoted_at: "2026-08-02T09:00:00Z",
    active_at: "2026-08-03T09:00:00Z",
    delivered_at: null,
    complete_at: null,
    lost_at: null,
    parked_at: null,
    last_activity_at: "2026-08-20T09:00:00Z",
    last_touch_at: "2026-08-20T09:00:00Z",
    next_action: null,
    next_action_date: null,
    ...over,
  };
}

describe("pipelineFrom / totalsOf", () => {
  it("reproduces the production totals the SQL view produced", () => {
    // One representative job per status, scaled to the real per-status totals.
    const jobs = [
      job({ status: "Completed", retail: 2020, wholesale: 680, gross_margin: 1340 }),
      job({ status: "In Progress", retail: 3141, wholesale: 1365, gross_margin: 1776 }),
      job({
        status: "Cancelled / NMF",
        retail: 2675,
        wholesale: 395,
        gross_margin: 2280,
        is_cancelled: true,
      }),
      job({ status: "To Assign", retail: 498, wholesale: 50, gross_margin: 448 }),
      job({ status: "Paid", retail: 149, wholesale: 0, gross_margin: 149 }),
      job({ status: "Pending", retail: 69, wholesale: 0, gross_margin: 69 }),
    ];
    const all = totalsOf(pipelineFrom(jobs));
    expect(all.retail).toBe(8552);
    expect(all.wholesale).toBe(2490);
    expect(all.grossMargin).toBe(6062);
    expect(all.marginPct).toBeCloseTo(0.709, 3);

    const live = liveTotals(pipelineFrom(jobs));
    expect(live.retail).toBe(5877);
    expect(live.wholesale).toBe(2095);
    expect(live.grossMargin).toBe(3782);
  });

  it("orders rows by pipeline order, not alphabetically or by size", () => {
    const rows = pipelineFrom([
      job({ status: "Completed" }),
      job({ status: "To Assign" }),
      job({ status: "In Progress" }),
    ]);
    expect(rows.map((r) => r.status)).toEqual(["To Assign", "In Progress", "Completed"]);
  });

  it("keeps an unrecognised status instead of dropping it", () => {
    const rows = pipelineFrom([job({ status: "Some New Status" })]);
    expect(rows.map((r) => r.status)).toEqual(["Some New Status"]);
  });

  it("takes margin over retail, never the mean of the row percentages", () => {
    // A 100% margin on 69 and a 56.5% margin on 3141 average to 78%, which
    // would weight the small job like the large one. The right answer is 57.4%.
    const rows = pipelineFrom([
      job({ status: "Pending", retail: 69, wholesale: 0, gross_margin: 69 }),
      job({ status: "In Progress", retail: 3141, wholesale: 1365, gross_margin: 1776 }),
    ]);
    expect(totalsOf(rows).marginPct).toBeCloseTo(1845 / 3210, 6);
  });

  it("counts jobs with no accountant fee so the margin can be flagged", () => {
    const rows = pipelineFrom([
      job({ status: "To Assign", wholesale_missing: true }),
      job({ status: "To Assign", wholesale_missing: false }),
    ]);
    expect(rows[0].missingWholesale).toBe(1);
  });
});

describe("monthlyFrom", () => {
  it("keeps the three live segments summing to retail whatever the status", () => {
    // Delivered and Invoiced are reachable statuses that an explicit
    // To Assign/Pending/Paid list silently dropped, losing their revenue from
    // every segment of the chart.
    const rows = monthlyFrom([
      job({ status: "Completed", retail: 100 }),
      job({ status: "In Progress", retail: 200 }),
      job({ status: "Delivered", retail: 300 }),
      job({ status: "Invoiced", retail: 400 }),
      job({ status: "To Assign", retail: 500 }),
    ]);
    const m = rows[0];
    expect(m.retail).toBe(1500);
    expect(m.completedRetail + m.inProgressRetail + m.openRetail).toBe(1500);
    expect(m.openRetail).toBe(1200);
  });

  it("excludes cancelled work from the live figures but keeps it visible", () => {
    const rows = monthlyFrom([
      job({ retail: 100 }),
      job({ status: "Cancelled / NMF", retail: 900, is_cancelled: true }),
    ]);
    expect(rows[0].jobs).toBe(1);
    expect(rows[0].retail).toBe(100);
    expect(rows[0].cancelledRetail).toBe(900);
  });
});

describe("concentrationFrom", () => {
  it("computes share against live retail and orders by size", () => {
    const rows = concentrationFrom([
      job({ client_id: "big", retail: 750 }),
      job({ client_id: "small", retail: 250 }),
      job({ client_id: "cancelled", retail: 1000, is_cancelled: true }),
    ]);
    expect(rows.map((r) => r.clientId)).toEqual(["big", "small"]);
    expect(rows[0].shareOfBook).toBeCloseTo(0.75, 6);
  });
});

describe("funnelFrom", () => {
  it("counts leads that ever reached a step, not leads sitting on it now", () => {
    // This lead completed and was reopened, so it is Active today. It has still
    // been quoted, paid and completed, and the funnel must say so.
    const reopened = lead({
      current_stage: "Active",
      quoted_at: "2026-06-01T00:00:00Z",
      active_at: "2026-06-02T00:00:00Z",
      complete_at: "2026-06-10T00:00:00Z",
    });
    const steps = funnelFrom([reopened]);
    expect(steps.map((s) => s.count)).toEqual([1, 1, 1, 0, 1]);
  });

  it("reports conversion against the previous step and the drop-off", () => {
    const leads = [
      lead({ client_id: "a" }),
      lead({ client_id: "b", active_at: null, current_stage: "Quoted" }),
      lead({ client_id: "c", quoted_at: null, active_at: null, current_stage: "Potential" }),
    ];
    const [leadStep, quoted, active] = funnelFrom(leads);
    expect(leadStep.conversion).toBeNull();
    expect(quoted.count).toBe(2);
    expect(quoted.conversion).toBeCloseTo(2 / 3, 6);
    expect(quoted.dropOff).toBe(1);
    expect(active.count).toBe(1);
    expect(active.conversion).toBeCloseTo(0.5, 6);
  });

  it("does not divide by zero when nothing reached the previous step", () => {
    const steps = funnelFrom([]);
    expect(steps.every((s) => s.count === 0)).toBe(true);
    expect(steps[1].conversion).toBeNull();
  });
});

describe("sourcesFrom", () => {
  it("gives leads with no source their own row rather than hiding them", () => {
    // 21 of 54 real leads have no source. Dropping them would flatter the
    // conversion rate of every source that is recorded.
    const rows = sourcesFrom([
      lead({ client_id: "a", source: null }),
      lead({ client_id: "b", source: "   " }),
      lead({ client_id: "c", source: "Referral" }),
    ]);
    expect(rows.map((r) => r.source)).toEqual(["(not recorded)", "Referral"]);
    expect(rows[0].leads).toBe(2);
  });

  it("measures conversion as lead to deposit paid", () => {
    const rows = sourcesFrom([
      lead({ client_id: "a", source: "Google", active_at: "2026-08-03T00:00:00Z" }),
      lead({ client_id: "b", source: "Google", active_at: null }),
    ]);
    expect(rows[0].conversion).toBeCloseTo(0.5, 6);
  });
});

describe("filters", () => {
  it("matches ISO dates inclusively at both ends", () => {
    const jobs = [
      job({ id: "before", date_sent: "2026-07-31" }),
      job({ id: "from", date_sent: "2026-08-01" }),
      job({ id: "to", date_sent: "2026-08-31" }),
      job({ id: "after", date_sent: "2026-09-01" }),
    ];
    const kept = filterJobs(jobs, { from: "2026-08-01", to: "2026-08-31" }).map((j) => j.id);
    expect(kept).toEqual(["from", "to"]);
  });

  it("falls back to created_at when a job was never sent", () => {
    const jobs = [job({ id: "unsent", date_sent: null, created_at: "2026-08-15T10:00:00Z" })];
    expect(filterJobs(jobs, { from: "2026-08-01", to: "2026-08-31" })).toHaveLength(1);
  });

  it("drops undated rows only when a range is actually set", () => {
    const undated = [job({ id: "x", date_sent: null, created_at: null })];
    expect(filterJobs(undated, {})).toHaveLength(1);
    expect(filterJobs(undated, { from: "2026-08-01" })).toHaveLength(0);
  });

  it("treats an empty status or stage list as no filter", () => {
    expect(filterJobs([job()], { status: [] })).toHaveLength(1);
    expect(filterLeads([lead()], { stage: [] })).toHaveLength(1);
    expect(filterLeads([lead({ current_stage: "Parked" })], { stage: ["Active"] })).toHaveLength(0);
  });
});

describe("watchlistFrom", () => {
  const now = new Date("2026-09-04T12:00:00Z");

  it("separates overdue SLA from due-soon, and ignores closed work", () => {
    const jobs = [
      job({ id: "late", status: "In Progress", sla_deadline: "2026-08-30" }),
      job({ id: "soon", status: "In Progress", sla_deadline: "2026-09-08" }),
      job({ id: "far", status: "In Progress", sla_deadline: "2026-10-30" }),
      job({ id: "done", status: "Completed", sla_deadline: "2026-08-01" }),
      job({
        id: "cancelled",
        status: "Cancelled / NMF",
        is_cancelled: true,
        sla_deadline: "2026-08-01",
      }),
    ];
    const w = watchlistFrom(jobs, [], now);
    expect(w.slaOverdue.map((j) => j.id)).toEqual(["late"]);
    expect(w.slaDueSoon.map((j) => j.id)).toEqual(["soon"]);
    expect(w.slaOverdue[0].daysOverdue).toBe(5);
  });

  it("chases quoted leads that never paid, but not ones already parked or lost", () => {
    const leads = [
      lead({ client_id: "chase", active_at: null, current_stage: "Quoted" }),
      lead({ client_id: "parked", active_at: null, current_stage: "Parked" }),
      lead({ client_id: "lost", active_at: null, current_stage: "Lost" }),
      lead({ client_id: "paid", current_stage: "Active" }),
    ];
    const w = watchlistFrom([], leads, now);
    expect(w.quotedNotPaid.map((l) => l.clientId)).toEqual(["chase"]);
  });

  it("does not call a lead quiet when something touched it, whatever last_activity says", () => {
    // Both of these were on the real list: reported 62 and 36 days quiet on the
    // day their own jobs were moving, because clients.last_activity is set on
    // half the table and the fallback was the lead's birthday.
    const leads = [
      lead({
        client_id: "busy",
        current_stage: "Active",
        last_activity_at: null,
        lead_created_at: "2026-07-05T00:00:00Z",
        last_touch_at: "2026-09-04T00:00:00Z",
      }),
      lead({
        client_id: "stale-column",
        current_stage: "Active",
        last_activity_at: "2026-07-31T00:00:00Z",
        last_touch_at: "2026-09-04T00:00:00Z",
      }),
    ];
    expect(watchlistFrom([], leads, now).goneQuiet).toHaveLength(0);
  });

  it("still surfaces a lead that genuinely nothing has touched", () => {
    const leads = [
      lead({
        client_id: "quiet",
        current_stage: "Quoted",
        last_activity_at: null,
        lead_created_at: "2026-06-01T00:00:00Z",
        last_touch_at: "2026-06-01T00:00:00Z",
      }),
      lead({ client_id: "fresh", current_stage: "Quoted", last_touch_at: "2026-09-01T00:00:00Z" }),
    ];
    expect(watchlistFrom([], leads, now).goneQuiet.map((l) => l.clientId)).toEqual(["quiet"]);
  });

  it("does not chase a completed client for a deposit", () => {
    // Five of these were on the real list. They have no Active milestone —
    // their work predates the stage log — but they were delivered and
    // completed, so the deposit plainly arrived.
    const leads = [
      lead({
        client_id: "completed",
        current_stage: "Complete",
        active_at: null,
        complete_at: "2026-08-07T00:00:00Z",
      }),
      lead({
        client_id: "delivered",
        current_stage: "Complete",
        active_at: null,
        delivered_at: "2026-08-07T00:00:00Z",
      }),
      // Complete by stage alone, with no milestone recorded at all.
      lead({ client_id: "stage-only", current_stage: "Complete", active_at: null }),
      lead({ client_id: "genuine", current_stage: "Quoted", active_at: null }),
    ];
    expect(watchlistFrom([], leads, now).quotedNotPaid.map((l) => l.clientId)).toEqual(["genuine"]);
  });
});
