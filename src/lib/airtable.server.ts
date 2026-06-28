// Server-only Airtable helpers.
// This project uses the direct Airtable REST API only.
const AIRTABLE_API_URL = "https://api.airtable.com";
// Backward-compatibility fallback only. Cloudflare Workers Variables should be
// the production source of truth for Airtable base and table IDs.
const LEGACY_BASE_ID = "appBJ9yHC38YHvvSw";
const LEGACY_TABLES = {
  jobs: "tblpH2ULYydRB3exW",
  clients: "tbl70xa6gossiWTMg",
  serviceCatalog: "tblMaCJtLqPXKv5XR",
  accountants: "tblwNZNcrnaJMaq1w",
} as const;

// CRM base (front of funnel) — separate Airtable base from the Ops Tracker above.
const LEGACY_CRM_BASE_ID = "apphw8Y9Tn3L40lF1";
const LEGACY_CRM_TABLES = {
  leads: "tblUIFo0VNNmdTDeQ",
} as const;

export const BASE_ID = process.env.AIRTABLE_BASE_ID || LEGACY_BASE_ID;
export const CRM_BASE_ID = process.env.AIRTABLE_CRM_BASE_ID || LEGACY_CRM_BASE_ID;

export const TABLES = {
  jobs: process.env.AIRTABLE_TABLE_JOBS || LEGACY_TABLES.jobs,
  clients: process.env.AIRTABLE_TABLE_CLIENTS || LEGACY_TABLES.clients,
  serviceCatalog: process.env.AIRTABLE_TABLE_SERVICE_CATALOG || LEGACY_TABLES.serviceCatalog,
  accountants: process.env.AIRTABLE_TABLE_ACCOUNTANTS || LEGACY_TABLES.accountants,
} as const;

export const CRM_TABLES = {
  leads: process.env.AIRTABLE_TABLE_LEADS || LEGACY_CRM_TABLES.leads,
} as const;

const GENERIC_ERROR = "Service temporarily unavailable. Please try again.";
type AirtableQueryValue = string | string[] | undefined;
export type AirtableQuery = Record<string, AirtableQueryValue>;

function getAirtableHeaders(): Record<string, string> {
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

  if (!AIRTABLE_API_KEY) {
    console.error("[airtable] AIRTABLE_API_KEY is not configured");
    throw new Error(GENERIC_ERROR);
  }

  return {
    Authorization: `Bearer ${AIRTABLE_API_KEY}`,
  };
}

function getAirtableUrl(path: string, query?: AirtableQuery, baseId: string = BASE_ID) {
  const url = new URL(`${AIRTABLE_API_URL}/v0/${baseId}/${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
        continue;
      }
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function logAndThrow(method: string, path: string, res: Response): Promise<never> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  console.error(`[airtable] ${method} ${path} failed [${res.status}]: ${body}`);
  throw new Error(GENERIC_ERROR);
}

export async function airtableGet(path: string, query?: AirtableQuery, baseId?: string) {
  const url = getAirtableUrl(path, query, baseId);
  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: getAirtableHeaders() });
  } catch (e) {
    console.error(`[airtable] GET ${path} network error:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("GET", path, res);
  return res.json();
}

export async function airtableListAll<T = Record<string, unknown>>(
  table: string,
  query?: AirtableQuery,
  baseId?: string,
) {
  const querySnapshot = query
    ? Object.fromEntries(
        Object.entries(query).map(([key, value]) => [
          key,
          Array.isArray(value) ? [...value] : value,
        ]),
      )
    : {};
  const records: AirtableRecord<T>[] = [];
  let offset: string | undefined;

  do {
    const page = (await airtableGet(
      table,
      {
        ...querySnapshot,
        ...(offset ? { offset } : {}),
      },
      baseId,
    )) as {
      records?: AirtableRecord<T>[];
      offset?: string;
    };
    records.push(...(page.records ?? []));
    offset = page.offset;
  } while (offset);

  return { records };
}

export async function airtablePatch(
  table: string,
  recordId: string,
  fields: Record<string, unknown>,
  baseId?: string,
) {
  const url = getAirtableUrl(`${table}/${recordId}`, undefined, baseId);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "PATCH",
      headers: { ...getAirtableHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
  } catch (e) {
    console.error(`[airtable] PATCH ${table}/${recordId} network error:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("PATCH", `${table}/${recordId}`, res);
  return res.json();
}

export async function airtablePost(
  table: string,
  fields: Record<string, unknown>,
  baseId?: string,
) {
  const url = getAirtableUrl(table, undefined, baseId);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { ...getAirtableHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
  } catch (e) {
    console.error(`[airtable] POST ${table} network error:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("POST", table, res);
  const json = (await res.json()) as {
    records: Array<{ id: string; fields: Record<string, unknown> }>;
  };
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
  "Next Action Needed"?: string;
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
  "Admin Internal Notes"?: string;
  "Partner Progress Notes"?: string;
  "Client Visible Note"?: string;
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

export type LeadFields = {
  "Lead Name"?: string;
  Email?: string;
  Phone?: string;
  Company?: string;
  Urgency?: string;
  "Referral source"?: string;
  "Submission date"?: string;
  "Acknowledgment date"?: string;
  "Lead status"?: string;
  "Acknowledgment sent"?: string;
  "Lead value"?: number;
  Situation?: string;
  Notes?: string;
  "Source detail"?: string;
  "Lost reason"?: string;
  "Last follow-up date"?: string;
  Stage?: string;
  "Next action date"?: string;
  "Last activity"?: string;
  "Ops Client Record ID"?: string;
};

export { JOB_STATUSES, STATUS_PROGRESS } from "./airtable-shared";
