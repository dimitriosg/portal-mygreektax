// Server-only Airtable helpers.
// Prefer direct Airtable API when AIRTABLE_API_KEY is configured.
// Keep Lovable connector gateway support as an optional compatibility path.
const LOVABLE_GATEWAY_URL = "https://connector-gateway.lovable.dev/airtable";
const AIRTABLE_API_URL = "https://api.airtable.com";
export const BASE_ID = "appBJ9yHC38YHvvSw";

export const TABLES = {
  jobs: "tblpH2ULYydRB3exW",
  clients: "tbl70xa6gossiWTMg",
  serviceCatalog: "tblMaCJtLqPXKv5XR",
  accountants: "tblwNZNcrnaJMaq1w",
} as const;

const GENERIC_ERROR = "Service temporarily unavailable. Please try again.";

type AirtableTransport = "direct_airtable" | "lovable_gateway";

function getAirtableConfig(): {
  baseUrl: string;
  transport: AirtableTransport;
  headers: Record<string, string>;
} {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;

  if (!AIRTABLE_API_KEY) {
    console.error("[airtable] AIRTABLE_API_KEY is not configured");
    throw new Error(GENERIC_ERROR);
  }

  // Direct Airtable access is the preferred Cloudflare path because it only needs AIRTABLE_API_KEY.
  // The Lovable gateway is retained only for environments that explicitly provide LOVABLE_API_KEY.
  if (!LOVABLE_API_KEY) {
    console.info("[airtable] using direct Airtable API transport", {
      hasAirtableApiKey: true,
      hasLovableApiKey: false,
    });
    return {
      baseUrl: AIRTABLE_API_URL,
      transport: "direct_airtable",
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      },
    };
  }

  console.info("[airtable] using Lovable connector gateway transport", {
    hasAirtableApiKey: true,
    hasLovableApiKey: true,
  });
  return {
    baseUrl: LOVABLE_GATEWAY_URL,
    transport: "lovable_gateway",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": AIRTABLE_API_KEY,
    },
  };
}

function getAirtableUrl(path: string, query?: Record<string, string>) {
  const config = getAirtableConfig();
  const url = new URL(`${config.baseUrl}/v0/${BASE_ID}/${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return { url, config };
}

async function logAndThrow(method: string, path: string, res: Response, transport: AirtableTransport): Promise<never> {
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  console.error(`[airtable] ${method} ${path} failed via ${transport} [${res.status}]: ${body}`);
  throw new Error(GENERIC_ERROR);
}

export async function airtableGet(path: string, query?: Record<string, string>) {
  const { url, config } = getAirtableUrl(path, query);
  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: config.headers });
  } catch (e) {
    console.error(`[airtable] GET ${path} network error via ${config.transport}:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("GET", path, res, config.transport);
  return res.json();
}

export async function airtablePatch(table: string, recordId: string, fields: Record<string, unknown>) {
  const { url, config } = getAirtableUrl(`${table}/${recordId}`);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "PATCH",
      headers: { ...config.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
  } catch (e) {
    console.error(`[airtable] PATCH ${table}/${recordId} network error via ${config.transport}:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("PATCH", `${table}/${recordId}`, res, config.transport);
  return res.json();
}

export async function airtablePost(table: string, fields: Record<string, unknown>) {
  const { url, config } = getAirtableUrl(table);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: "POST",
      headers: { ...config.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
  } catch (e) {
    console.error(`[airtable] POST ${table} network error via ${config.transport}:`, e);
    throw new Error(GENERIC_ERROR);
  }
  if (!res.ok) await logAndThrow("POST", table, res, config.transport);
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
