// Server-only Airtable helpers via the Lovable connector gateway.
const GATEWAY_URL = "https://connector-gateway.lovable.dev/airtable";
export const BASE_ID = "appBJ9yHC38YHvvSw";

export const TABLES = {
  jobs: "tblpH2ULYydRB3exW",
  clients: "tbl70xa6gossiWTMg",
  serviceCatalog: "tblMaCJtLqPXKv5XR",
  accountants: "tblwNZNcrnaJMaq1w",
} as const;

const GENERIC_ERROR = "Service temporarily unavailable. Please try again.";

function authHeaders() {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  if (!LOVABLE_API_KEY) {
    console.error("[airtable] LOVABLE_API_KEY is not configured");
    throw new Error(GENERIC_ERROR);
  }
  if (!AIRTABLE_API_KEY) {
    console.error("[airtable] AIRTABLE_API_KEY is not configured");
    throw new Error(GENERIC_ERROR);
  }
  return {
    Authorization: `Bearer ${LOVABLE_API_KEY}`,
    "X-Connection-Api-Key": AIRTABLE_API_KEY,
  };
}

async function logAndThrow(method: string, path: string, res: Response): Promise<never> {
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  console.error(`[airtable] ${method} ${path} failed [${res.status}]: ${body}`);
  throw new Error(GENERIC_ERROR);
}

export async function airtableGet(path: string, query?: Record<string, string>) {
  const url = new URL(`${GATEWAY_URL}/v0/${BASE_ID}/${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: authHeaders() });
  } catch (e) {
    console.error(`[airtable] GET ${path} network error:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("GET", path, res);
  return res.json();
}

export async function airtablePatch(table: string, recordId: string, fields: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}/v0/${BASE_ID}/${table}/${recordId}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
  } catch (e) {
    console.error(`[airtable] PATCH ${table}/${recordId} network error:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("PATCH", `${table}/${recordId}`, res);
  return res.json();
}

export async function airtablePost(table: string, fields: Record<string, unknown>) {
  let res: Response;
  try {
    res = await fetch(`${GATEWAY_URL}/v0/${BASE_ID}/${table}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
  } catch (e) {
    console.error(`[airtable] POST ${table} network error:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("POST", table, res);
  const json = (await res.json()) as { records: Array<{ id: string; fields: Record<string, unknown> }> };
  return json.records[0];
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
