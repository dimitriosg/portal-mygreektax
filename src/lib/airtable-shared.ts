export const JOB_STATUSES = [
  "To Assign",
  "Pending",
  "Paid",
  "In Progress",
  "Delivered",
  "Invoiced",
  "Completed",
  "Cancelled / NMF",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

const JOB_STATUS_SET = new Set<string>(JOB_STATUSES);
const NON_OVERDUE_JOB_STATUS_SET = new Set<string>(["Completed", "Cancelled / NMF"]);
const PROGRESS_STAGE_JOB_STATUS_SET = new Set<string>(
  JOB_STATUSES.filter((status) => status !== "Cancelled / NMF"),
);

export const STATUS_PROGRESS: Record<string, number> = {
  "To Assign": 5,
  Pending: 20,
  Paid: 35,
  "In Progress": 55,
  Delivered: 75,
  Invoiced: 90,
  Completed: 100,
  "Cancelled / NMF": 0,
};

export function isJobStatus(status?: string | null): status is JobStatus {
  return typeof status === "string" && JOB_STATUS_SET.has(status);
}

/** Unknown or legacy statuses sort after the active Airtable workflow. */
export function getJobStatusSortOrder(status?: string | null) {
  return isJobStatus(status) ? JOB_STATUSES.indexOf(status) : JOB_STATUSES.length;
}

export function isOverdueEligibleStatus(status?: string | null) {
  return !NON_OVERDUE_JOB_STATUS_SET.has(status ?? "");
}

export function hasJobProgressStage(
  status?: string | null,
): status is Exclude<JobStatus, "Cancelled / NMF"> {
  return typeof status === "string" && PROGRESS_STAGE_JOB_STATUS_SET.has(status);
}
