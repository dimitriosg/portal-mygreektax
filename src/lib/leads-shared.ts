// Shared constants for the Leads CRM view (mirrors airtable-shared.ts for Jobs).

export const LEAD_STAGES = ["New", "Contacted", "Qualified", "Quoted", "Won", "Lost"] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export const LEAD_STATUSES = [
  "Processing",
  "New",
  "Contacted",
  "Qualified",
  "Quoted",
  "Won",
  "Lost",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_URGENCY_OPTIONS = ["Within a week", "This month", "Just exploring"] as const;

export type LeadUrgency = (typeof LEAD_URGENCY_OPTIONS)[number];

const LEAD_STAGE_SET = new Set<string>(LEAD_STAGES);
const LEAD_STATUS_SET = new Set<string>(LEAD_STATUSES);

export function isLeadStage(value?: string | null): value is LeadStage {
  return typeof value === "string" && LEAD_STAGE_SET.has(value);
}

export function isLeadStatus(value?: string | null): value is LeadStatus {
  return typeof value === "string" && LEAD_STATUS_SET.has(value);
}

/** Unknown or legacy stages sort after the active pipeline. */
export function getLeadStageSortOrder(stage?: string | null) {
  return isLeadStage(stage) ? LEAD_STAGES.indexOf(stage) : LEAD_STAGES.length;
}
