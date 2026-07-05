/* eslint-disable @typescript-eslint/no-explicit-any */
// Server-only CRM data layer.
//
// HISTORY: this module used to call the Airtable REST API. As of the Jul 2026
// Supabase migration the CRM (clients, jobs, accountants, service catalog,
// messages) lives in Postgres (Supabase project "MyGreekTax Portal"). Airtable
// and Baserow are retired.
//
// The exported function names (airtableGet / airtableListAll / airtablePatch /
// airtablePost), the {id, createdTime, fields} record shape, and the Airtable
// field NAMES on `fields` are all kept identical, so the ~17 call-sites did not
// have to change. Postgres columns are snake_case; the per-table maps below
// translate between the two. Record ids are now UUIDs (were "rec…").
//
// Linked records (Client / Assigned Accountant / Service Catalog on jobs,
// Client on messages) are surfaced as arrays of the linked row's id, exactly
// like Airtable did, so `.includes(id)` and `?.[0]` in the call-sites still work.
// The lookup/formula fields Airtable computed (Service Name/Code, Category,
// Tier, Base Client Price, Client Code, Client Full Name on jobs) are rebuilt
// by the `jobs_expanded` Postgres view and surfaced here as read-only arrays.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GENERIC_ERROR = "Service temporarily unavailable. Please try again.";

// The generated Supabase `Database` types don't include the new CRM tables/
// views yet, so use an untyped handle here. Correctness is enforced by the
// field maps below and the Postgres schema, not by TS. (Regenerate types with
// `supabase gen types` later if you want them typed.)
const db = supabaseAdmin as unknown as { from: (table: string) => any };

// Logical table keys used throughout the app map to Postgres table names.
export const TABLES = {
  jobs: "jobs",
  clients: "clients",
  serviceCatalog: "service_catalog",
  accountants: "accountants",
  messages: "messages",
} as const;

// Retained for backward-compatibility with call-sites/imports; unused now.
export const BASE_ID = "supabase";

type AirtableQueryValue = string | string[] | undefined;
export type AirtableQuery = Record<string, AirtableQueryValue>;

export type AirtableRecord<T = Record<string, unknown>> = {
  id: string;
  createdTime: string;
  fields: T;
};

// --- field mapping -------------------------------------------------------
type FieldKind = "text" | "num" | "bool" | "date" | "link" | "lookup" | "lookupNum";
interface FieldDef {
  col: string;
  kind: FieldKind;
}
interface TableConfig {
  readFrom: string; // table or view used for reads
  writeTo: string; // base table used for writes
  fields: Record<string, FieldDef>; // Airtable field name -> column
}

const f = (col: string, kind: FieldKind = "text"): FieldDef => ({ col, kind });

const CONFIG: Record<string, TableConfig> = {
  accountants: {
    readFrom: "accountants",
    writeTo: "accountants",
    fields: {
      Name: f("name"),
      Email: f("email"),
      Status: f("status"),
      Specialty: f("specialty"),
      Phone: f("phone"),
      Notes: f("notes"),
      "Partner Progress Notes": f("partner_progress_notes"),
      "Current Workload": f("current_workload", "num"),
    },
  },
  service_catalog: {
    readFrom: "service_catalog",
    writeTo: "service_catalog",
    fields: {
      "Service Code": f("service_code"),
      "Service Name": f("service_name"),
      Category: f("category"),
      Tier: f("tier"),
      "Base Client Price": f("base_client_price", "num"),
      "Base Client Price (€)": f("base_client_price", "num"),
      Notes: f("notes"),
    },
  },
  clients: {
    readFrom: "clients",
    writeTo: "clients",
    fields: {
      "Full Name": f("full_name"),
      "Client Code": f("client_code"),
      Email: f("email"),
      Phone: f("phone"),
      Status: f("status"),
      Stage: f("stage"),
      Source: f("source"),
      Urgency: f("urgency"),
      Notes: f("notes"),
      "Lead Value (€)": f("lead_value", "num"),
      "Lost Reason": f("lost_reason"),
      "Next Action": f("next_action"),
      "Next Action Date": f("next_action_date", "date"),
      "Last activity": f("last_activity", "date"),
      Nationality: f("nationality"),
      AFM: f("afm"),
      "TAXISnet Access": f("taxisnet_access", "bool"),
      Cadence: f("cadence"),
      "Case Code": f("case_code"),
      "Quote Sent Date": f("quote_sent_date", "date"),
      "Quote Amount €": f("quote_amount", "num"),
      "Deposit €": f("deposit", "num"),
      "Balance Due €": f("balance_due", "num"),
      "Partner Fee €": f("partner_fee", "num"),
      "Parked Reason": f("parked_reason"),
      "Client Visible Note": f("client_visible_note"),
      "Thread ID": f("thread_id"),
    },
  },
  jobs: {
    readFrom: "jobs_expanded",
    writeTo: "jobs",
    fields: {
      "Job Code": f("job_code"),
      Status: f("status"),
      "Next Action Needed": f("next_action_needed"),
      "Date Sent": f("date_sent", "date"),
      "SLA Deadline": f("sla_deadline", "date"),
      "Accountant Fee (€)": f("accountant_fee", "num"),
      "Client Fee (€)": f("client_fee", "num"),
      "Admin Internal Notes": f("admin_internal_notes"),
      "Partner Progress Notes": f("partner_progress_notes"),
      "Client Visible Note": f("client_visible_note"),
      Notes: f("notes"),
      // linked records -> arrays of ids
      Client: f("client_id", "link"),
      "Assigned Accountant": f("accountant_id", "link"),
      "Service Catalog": f("service_id", "link"),
      // lookups rebuilt by the jobs_expanded view (read-only)
      "Service Name": f("service_name", "lookup"),
      "Service Code": f("service_code", "lookup"),
      Category: f("category", "lookup"),
      Tier: f("tier", "lookup"),
      "Base Client Price (€)": f("base_client_price", "lookupNum"),
      "Client Code": f("client_code", "lookup"),
      "Client Full Name": f("client_full_name", "lookup"),
    },
  },
  messages: {
    readFrom: "messages",
    writeTo: "messages",
    fields: {
      "Message ID": f("message_id"),
      Client: f("client_id", "link"),
      Direction: f("direction"),
      Timestamp: f("ts", "date"),
      Subject: f("subject"),
      Body: f("body"),
      "Thread ID": f("thread_id"),
      From: f("from_addr"),
      To: f("to_addr"),
    },
  },
};

function configFor(table: string): TableConfig {
  const cfg = CONFIG[table];
  if (!cfg) {
    console.error(`[crm] unknown table "${table}"`);
    throw new Error(GENERIC_ERROR);
  }
  return cfg;
}

// Postgres row -> Airtable-shaped record
function rowToRecord(cfg: TableConfig, row: Record<string, unknown>): AirtableRecord {
  const fields: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(cfg.fields)) {
    const v = row[def.col];
    if (v === null || v === undefined) continue;
    switch (def.kind) {
      case "num":
        fields[name] = typeof v === "number" ? v : Number(v);
        break;
      case "bool":
        fields[name] = Boolean(v);
        break;
      case "link":
        fields[name] = [String(v)];
        break;
      case "lookup":
        fields[name] = [v];
        break;
      case "lookupNum":
        fields[name] = [typeof v === "number" ? v : Number(v)];
        break;
      default:
        fields[name] = v;
    }
  }
  return {
    id: String(row.id),
    createdTime: (row.created_at as string) ?? new Date().toISOString(),
    fields,
  };
}

// Airtable-shaped fields object -> Postgres columns (for writes)
function fieldsToColumns(
  cfg: TableConfig,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const cols: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields)) {
    const def = cfg.fields[name];
    if (!def) continue; // unknown field -> ignore
    if (def.kind === "lookup" || def.kind === "lookupNum") continue; // read-only, view-derived
    if (def.kind === "link") {
      const id = Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
      cols[def.col] = id ? String(id) : null;
    } else {
      cols[def.col] = value ?? null;
    }
  }
  return cols;
}

function fail(op: string, table: string, error: unknown): never {
  console.error(`[crm] ${op} ${table} failed:`, error);
  throw new Error(GENERIC_ERROR);
}

// --- public API (Airtable-compatible signatures) -------------------------

/**
 * GET. Two shapes, matching the old Airtable helper:
 *  - airtableGet(`${TABLES.x}/${id}`)  -> single AirtableRecord
 *  - airtableGet(TABLES.x, query)      -> { records }  (supports filterByFormula on Email)
 */
export async function airtableGet(
  path: string,
  query?: AirtableQuery,
  _baseId?: string,
): Promise<any> {
  const slash = path.indexOf("/");
  if (slash !== -1) {
    const table = path.slice(0, slash);
    const id = path.slice(slash + 1);
    const cfg = configFor(table);
    const { data, error } = await db.from(cfg.readFrom).select("*").eq("id", id).maybeSingle();
    if (error) fail("GET", table, error);
    if (!data) {
      // Not found: mirror Airtable's 404 as an error so callers that expect a
      // record keep their existing behaviour.
      throw new Error(GENERIC_ERROR);
    }
    return rowToRecord(cfg, data as Record<string, unknown>);
  }

  // list form (used by auth.functions for the accountant email lookup)
  const cfg = configFor(path);
  const { data, error } = await db.from(cfg.readFrom).select("*");
  if (error) fail("GET", path, error);
  let records = (data ?? []).map((r: Record<string, unknown>) =>
    rowToRecord(cfg, r as Record<string, unknown>),
  );
  records = applyFormula(records, query?.filterByFormula);
  const max = query?.maxRecords ? parseInt(String(query.maxRecords), 10) : undefined;
  if (max && records.length > max) records = records.slice(0, max);
  return { records };
}

export async function airtableListAll<T = Record<string, unknown>>(
  table: string,
  query?: AirtableQuery,
  _baseId?: string,
) {
  const cfg = configFor(table);
  const { data, error } = await db
    .from(cfg.readFrom)
    .select("*")
    .order("created_at", { ascending: true });
  if (error) fail("LIST", table, error);
  let records = (data ?? []).map((r: Record<string, unknown>) =>
    rowToRecord(cfg, r as Record<string, unknown>),
  );
  records = applyFormula(records, query?.filterByFormula);
  return { records: records as AirtableRecord<T>[] };
}

export async function airtablePatch(
  table: string,
  recordId: string,
  fields: Record<string, unknown>,
  _baseId?: string,
): Promise<any> {
  const cfg = configFor(table);
  const cols = fieldsToColumns(cfg, fields);
  const { error } = await db.from(cfg.writeTo).update(cols).eq("id", recordId);
  if (error) fail("PATCH", table, error);
  const { data, error: readErr } = await db
    .from(cfg.readFrom)
    .select("*")
    .eq("id", recordId)
    .maybeSingle();
  if (readErr) fail("PATCH-read", table, readErr);
  return rowToRecord(cfg, (data ?? { id: recordId }) as Record<string, unknown>);
}

export async function airtablePost(
  table: string,
  fields: Record<string, unknown>,
  _baseId?: string,
): Promise<any> {
  const cfg = configFor(table);
  const cols = fieldsToColumns(cfg, fields);
  const { data: inserted, error } = await db.from(cfg.writeTo).insert(cols).select("id").single();
  if (error) fail("POST", table, error);
  const id = (inserted as { id: string }).id;
  const { data, error: readErr } = await db
    .from(cfg.readFrom)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (readErr) fail("POST-read", table, readErr);
  return rowToRecord(cfg, (data ?? { id }) as Record<string, unknown>);
}

// Minimal translation of the only filterByFormula shape the app uses:
//   LOWER({Email}) = 'someone@x.com'   (also tolerates {Email} = '...')
function applyFormula(records: AirtableRecord[], formula?: string | string[]): AirtableRecord[] {
  if (!formula || Array.isArray(formula)) return records;
  const m =
    /LOWER\(\{([^}]+)\}\)\s*=\s*'(.*)'/.exec(formula) || /\{([^}]+)\}\s*=\s*'(.*)'/.exec(formula);
  if (!m) return records;
  const field = m[1];
  const value = m[2].replace(/\\'/g, "'").toLowerCase();
  return records.filter((r) => {
    const fv = (r.fields as Record<string, unknown>)[field];
    return typeof fv === "string" && fv.toLowerCase() === value;
  });
}

// --- field type exports (unchanged; keyed by Airtable field name) --------

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
  "Accountant Fee (€)"?: number;
  "Client Fee (€)"?: number;
  "Base Client Price (€)"?: number[];
  "Admin Internal Notes"?: string;
  "Partner Progress Notes"?: string;
  "Client Visible Note"?: string;
  Notes?: string;
  "Client Code"?: string[];
  "Client Full Name"?: string[];
};

export type AccountantFields = {
  Name?: string;
  Email?: string;
  Status?: string;
  Specialty?: string;
  Phone?: string;
  Notes?: string;
  "Partner Progress Notes"?: string;
  "Current Workload"?: number;
};

export type ClientFields = {
  "Full Name"?: string;
  "Client Code"?: string;
  Email?: string;
  Phone?: string;
  Status?: string;
  Notes?: string;
  Stage?: string;
  Source?: string;
  Urgency?: string;
  "Lead Value (€)"?: number;
  "Lost Reason"?: string;
  "Next Action"?: string;
  "Next Action Date"?: string;
  "Last activity"?: string;
  Nationality?: string;
  AFM?: string;
  "TAXISnet Access"?: boolean;
  Cadence?: string;
  "Case Code"?: string;
  "Quote Sent Date"?: string;
  "Quote Amount €"?: number;
  "Deposit €"?: number;
  "Balance Due €"?: number;
  "Partner Fee €"?: number;
  "Parked Reason"?: string;
  "Client Visible Note"?: string;
  "Thread ID"?: string;
};

export type MessageFields = {
  "Message ID"?: string;
  Client?: string[];
  Direction?: string;
  Timestamp?: string;
  Subject?: string;
  Body?: string;
  "Thread ID"?: string;
  From?: string;
  To?: string;
};

export { JOB_STATUSES, STATUS_PROGRESS } from "./airtable-shared";
