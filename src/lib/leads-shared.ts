// Shared constants for the pipeline (formerly "Leads CRM") view (mirrors
// airtable-shared.ts for Jobs). As of Task 4, leads and clients are the same
// Airtable record — this is the single Stage vocabulary for that pipeline,
// from first contact through to a completed engagement.

export const CLIENT_STAGES = [
  "Potential",
  "Quoted",
  "Active",
  "Delivered",
  "Complete",
  "Parked",
  "Lost",
] as const;

export type ClientStage = (typeof CLIENT_STAGES)[number];

export const LEAD_URGENCY_OPTIONS = ["Within a week", "This month", "Just exploring"] as const;

export type LeadUrgency = (typeof LEAD_URGENCY_OPTIONS)[number];

// getClientStageSortOrder() and its isClientStage() helper lived here until the
// partner reply box was deleted, which was their only caller. They ranked a
// stage by its position in CLIENT_STAGES, and the deposit gate in
// src/lib/case-composer.ts deliberately stopped using that reading: the array
// is a display order, so Parked and Lost sort after Active and a quoted lead
// that went quiet read as paid. Anything reaching for an ordering here should
// read that comment first.
