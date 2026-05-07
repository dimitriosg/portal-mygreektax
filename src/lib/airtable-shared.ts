export const JOB_STATUSES = [
  "To Assign",
  "Sent",
  "In Progress",
  "Delivered",
  "Invoiced",
  "Paid",
  "Completed",
  "Pending",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const STATUS_PROGRESS: Record<string, number> = {
  "To Assign": 5,
  Sent: 15,
  "In Progress": 40,
  Pending: 50,
  Delivered: 70,
  Invoiced: 85,
  Paid: 95,
  Completed: 100,
};