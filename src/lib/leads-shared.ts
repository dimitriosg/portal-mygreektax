// Shared constants for the pipeline (formerly "Leads CRM") view (mirrors
// airtable-shared.ts for Jobs). As of Task 4, leads and clients are the same
// Airtable record — this is the single Stage vocabulary for that pipeline,
// from first contact through to a completed engagement.

export const CLIENT_STAGES = [
  "Potential",
  "Quoted",
  "Active",
  "Complete",
  "Parked",
  "Lost",
] as const;

export type ClientStage = (typeof CLIENT_STAGES)[number];

export const LEAD_URGENCY_OPTIONS = ["Within a week", "This month", "Just exploring"] as const;

export type LeadUrgency = (typeof LEAD_URGENCY_OPTIONS)[number];

const CLIENT_STAGE_SET = new Set<string>(CLIENT_STAGES);

export function isClientStage(value?: string | null): value is ClientStage {
  return typeof value === "string" && CLIENT_STAGE_SET.has(value);
}

/** Unknown or legacy stages sort after the active pipeline. */
export function getClientStageSortOrder(stage?: string | null) {
  return isClientStage(stage) ? CLIENT_STAGES.indexOf(stage) : CLIENT_STAGES.length;
}
