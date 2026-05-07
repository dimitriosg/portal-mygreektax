// Server-only Airtable helpers via the Lovable connector gateway.
const GATEWAY_URL = "https://connector-gateway.lovable.dev/airtable";
export const BASE_ID = "appBJ9yHC38YHvvSw";

export const TABLES = {
  jobs: "tblpH2ULYydRB3exW",
  clients: "tbl70xa6gossiWTMg",
  serviceCatalog: "tblMaCJtLqPXKv5XR",
  accountants: "tblwNZNcrnaJMaq1w",
} as const;

function authHeaders() {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");
  if (!AIRTABLE_API_KEY) throw new Error("AIRTABLE_API_KEY is not configured");
  return {
    Authorization: `Bearer ${LOVABLE_API_KEY}`,
    "X-Connection-Api-Key": AIRTABLE_API_KEY,
  };
}

export async function airtableGet(path: string, query?: Record<string, string>) {
  const url = new URL(`${GATEWAY_URL}/v0/${BASE_ID}/${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { headers: authHeaders() });
  if (!res.ok) throw new Error(`Airtable GET ${path} failed [${res.status}]: ${await res.text()}`);
  return res.json();
}

export async function airtablePatch(table: string, recordId: string, fields: Record<string, unknown>) {
  const res = await fetch(`${GATEWAY_URL}/v0/${BASE_ID}/${table}/${recordId}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`Airtable PATCH failed [${res.status}]: ${await res.text()}`);
  return res.json();
}

export type AirtableRecord<T = Record<string, unknown>> = {
  id: string;
  createdTime: string;
  fields: T;
};

export type JobFields = {
  "Job Code"?: string;
  Status?: string;
  Client?: string[];
  "Assigned Accountant"?: string[];
  "Service Catalog"?: string[];
  "Service Name"?: string[];
  "Service Code"?: string[];
  Category?: string[];
  Tier?: string[];
  "Date Sent"?: string;
  "SLA Deadline"?: string;
  "Accountant Fee (\u20ac)"?: number;
  "Client Fee (\u20ac)"?: number;
  "Base Client Price (\u20ac)"?: number[];
  Notes?: string;
  "Client Code"?: string[];
};

export type AccountantFields = {
  Name?: string;
  Email?: string;
  Status?: string;
  Specialty?: string;
  Phone?: string;
  Notes?: string;
};

export type ClientFields = {
  "Full Name"?: string;
  "Client Code"?: string;
  Email?: string;
  Phone?: string;
  Status?: string;
  Notes?: string;
};

export { JOB_STATUSES, STATUS_PROGRESS } from "./airtable-shared";