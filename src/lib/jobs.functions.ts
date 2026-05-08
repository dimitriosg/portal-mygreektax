import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { UAParser } from "ua-parser-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  airtableGet,
  airtablePatch,
  airtablePost,
  TABLES,
  type AirtableRecord,
  type JobFields,
  type ClientFields,
  type AccountantFields,
} from "./airtable.server";
import { JOB_STATUSES, STATUS_PROGRESS } from "./airtable-shared";
import { logActivityEvent } from "./activity.server";

async function getActorIdentity(userId: string): Promise<{ email: string | null; name: string | null }> {
  const [{ data: authUser }, { data: partner }] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(userId),
    supabaseAdmin.from("partner_profiles").select("full_name, email").eq("user_id", userId).maybeSingle(),
  ]);
  const email = authUser?.user?.email ?? partner?.email ?? null;
  const name = partner?.full_name ?? email ?? null;
  return { email, name };
}

async function getRoleAndPartner(userId: string) {
  const [{ data: roles }, { data: partner }] = await Promise.all([
    supabaseAdmin.from("user_roles").select("role").eq("user_id", userId),
    supabaseAdmin.from("partner_profiles").select("*").eq("user_id", userId).maybeSingle(),
  ]);
  const isAdmin = !!roles?.some((r) => r.role === "admin");
  return { isAdmin, partner };
}

function escapeFormula(s: string) {
  return s.replace(/'/g, "\\'");
}

export const listJobs = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d?: { asAccountantId?: string }) =>
    z.object({ asAccountantId: z.string().min(1).max(50).optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { isAdmin, partner } = await getRoleAndPartner(userId);
    if (!isAdmin && !partner) {
      return { jobs: [] as AirtableRecord<JobFields>[], isAdmin: false, clientNames: {} as Record<string, string> };
    }
    // Admin impersonation: filter by chosen accountant
    const impersonateId = isAdmin ? data?.asAccountantId : undefined;
    const filterAccountantId = impersonateId ?? (!isAdmin && partner ? partner.airtable_accountant_id : undefined);
    const data2 = await airtableGet(TABLES.jobs, { pageSize: "100" });
    let jobs = data2.records as AirtableRecord<JobFields>[];
    if (filterAccountantId) {
      jobs = jobs.filter((j) =>
        j.fields["Assigned Accountant"]?.includes(filterAccountantId),
      );
    }
    // Real admins (not impersonating) see real client names
    const clientNames: Record<string, string> = {};
    if (isAdmin && !impersonateId) {
      const ids = Array.from(
        new Set(jobs.flatMap((j) => j.fields.Client ?? []).filter(Boolean)),
      );
      const results = await Promise.all(
        ids.map((id) =>
          airtableGet(`${TABLES.clients}/${id}`)
            .then((r) => r as AirtableRecord<ClientFields>)
            .catch(() => null),
        ),
      );
      for (const c of results) {
        if (c) clientNames[c.id] = c.fields["Full Name"] ?? "";
      }
    }
    return { jobs, isAdmin, clientNames };
  });

export const getJob = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string }) => z.object({ jobId: z.string().min(1).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { isAdmin, partner } = await getRoleAndPartner(userId);
    const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
    if (!isAdmin) {
      const allowed = partner && job.fields["Assigned Accountant"]?.includes(partner.airtable_accountant_id);
      if (!allowed) throw new Error("Forbidden");
    }
    const clientId = job.fields.Client?.[0];
    const accountantId = job.fields["Assigned Accountant"]?.[0];
    const [client, accountant] = await Promise.all([
      clientId ? (airtableGet(`${TABLES.clients}/${clientId}`) as Promise<AirtableRecord<ClientFields>>) : null,
      accountantId ? (airtableGet(`${TABLES.accountants}/${accountantId}`) as Promise<AirtableRecord<AccountantFields>>) : null,
    ]);
    // Partners (and admins while impersonating, via dashboard) should not see real client name.
    // We always strip name for non-admins server-side; admins keep full record.
    const safeClient = isAdmin
      ? client
      : client
        ? ({ ...client, fields: { ...client.fields, "Full Name": undefined, Email: undefined, Phone: undefined } } as AirtableRecord<ClientFields>)
        : null;
    return { job, client: safeClient, accountant, isAdmin };
  });

export const updateJob = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string; status?: string; notes?: string }) =>
    z
      .object({
        jobId: z.string().min(1).max(50),
        status: z.enum(JOB_STATUSES).optional(),
        notes: z.string().max(5000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { isAdmin, partner } = await getRoleAndPartner(userId);
    const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
    if (!isAdmin) {
      const allowed = partner && job.fields["Assigned Accountant"]?.includes(partner.airtable_accountant_id);
      if (!allowed) throw new Error("Forbidden");
    }
    const fields: Record<string, unknown> = {};
    if (data.status) fields["Status"] = data.status;
    if (data.notes !== undefined) fields["Notes"] = data.notes;
    if (Object.keys(fields).length === 0) return { ok: true };
    const previousStatus = job.fields.Status ?? null;
    const previousNotes = job.fields.Notes ?? "";
    await airtablePatch(TABLES.jobs, data.jobId, fields);

    // Resolve actor identity
    const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(userId);
    const actorEmail = authUser?.user?.email ?? null;
    const actorName = partner?.full_name ?? actorEmail ?? null;

    type JobEventInsert = {
      airtable_job_id: string;
      user_id: string;
      actor_email: string | null;
      actor_name: string | null;
      event_type: "status_change" | "comment";
      from_status?: string | null;
      to_status?: string | null;
      comment?: string | null;
    };
    const events: JobEventInsert[] = [];
    if (data.status && data.status !== previousStatus) {
      events.push({
        airtable_job_id: data.jobId,
        user_id: userId,
        actor_email: actorEmail,
        actor_name: actorName,
        event_type: "status_change",
        from_status: previousStatus,
        to_status: data.status,
      });
    }
    if (data.notes !== undefined && data.notes.trim() !== previousNotes.trim() && data.notes.trim() !== "") {
      events.push({
        airtable_job_id: data.jobId,
        user_id: userId,
        actor_email: actorEmail,
        actor_name: actorName,
        event_type: "comment",
        comment: data.notes,
      });
    }
    if (events.length > 0) {
      await supabaseAdmin.from("job_events").insert(events);
    }
    if (data.status && data.status !== previousStatus) {
      await logActivityEvent({
        eventType: "job_status_changed",
        actorUserId: userId,
        actorEmail: actorEmail,
        actorName: actorName,
        subjectLabel: job.fields["Job Code"] ?? data.jobId,
        metadata: {
          from: previousStatus,
          to: data.status,
          jobCode: job.fields["Job Code"] ?? null,
        },
      });
    }
    return { ok: true };
  });

export const listJobEvents = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string }) => z.object({ jobId: z.string().min(1).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { isAdmin, partner } = await getRoleAndPartner(userId);
    if (!isAdmin) {
      const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
      const allowed = partner && job.fields["Assigned Accountant"]?.includes(partner.airtable_accountant_id);
      if (!allowed) throw new Error("Forbidden");
    }
    const { data: rows, error } = await supabaseAdmin
      .from("job_events")
      .select("*")
      .eq("airtable_job_id", data.jobId)
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[listJobEvents] DB error:", error);
      throw new Error("A database error occurred. Please try again.");
    }
    return { events: rows ?? [] };
  });

export const listAccountants = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");
    const data = await airtableGet(TABLES.accountants, { pageSize: "100" });
    return { accountants: data.records as AirtableRecord<AccountantFields>[] };
  });

export const listClients = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");
    const data = await airtableGet(TABLES.clients, { pageSize: "100" });
    return { clients: data.records as AirtableRecord<ClientFields>[] };
  });

export const listServices = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");
    const data = await airtableGet(TABLES.serviceCatalog, { pageSize: "100" });
    const records = data.records as AirtableRecord<Record<string, unknown>>[];
    const asStr = (v: unknown): string => {
      if (v == null) return "";
      if (Array.isArray(v)) return v.map(asStr).filter(Boolean).join(", ");
      return String(v);
    };
    const services = records
      .map((r) => {
        const f = r.fields;
        const code = asStr(f["Service Code"] ?? f["Code"]);
        const tier = asStr(f["Tier"]);
        const category = asStr(f["Category"]);
        const name = asStr(f["Service Name"] ?? f["Name"]);
        return { id: r.id, code, tier, category, name };
      })
      .sort((a, b) =>
        (a.code || a.name).localeCompare(b.code || b.name, undefined, { numeric: true, sensitivity: "base" }),
      );
    return { services };
  });

export const createJob = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: {
    clientId: string;
    serviceId: string;
    accountantId?: string;
    status?: string;
    slaDeadline?: string;
    dateSent?: string;
    notes?: string;
  }) =>
    z
      .object({
        clientId: z.string().min(1).max(50),
        serviceId: z.string().min(1).max(50),
        accountantId: z.string().min(1).max(50).optional(),
        status: z.enum(JOB_STATUSES).optional(),
        slaDeadline: z.string().max(30).optional(),
        dateSent: z.string().max(30).optional(),
        notes: z.string().max(5000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");
    // Compute next Job Code (e.g. JB105) by scanning all existing codes.
    let maxN = 0;
    let prefix = "JB";
    let offset: string | undefined;
    do {
      const q: Record<string, string> = { pageSize: "100", "fields[]": "Job Code" };
      if (offset) q.offset = offset;
      const page = await airtableGet(TABLES.jobs, q);
      const recs = (page.records ?? []) as AirtableRecord<JobFields>[];
      for (const r of recs) {
        const code = r.fields["Job Code"];
        if (!code) continue;
        const m = /^([A-Za-z]+)(\d+)$/.exec(code);
        if (!m) continue;
        prefix = m[1];
        const n = parseInt(m[2], 10);
        if (n > maxN) maxN = n;
      }
      offset = page.offset;
    } while (offset);
    const nextCode = `${prefix}${maxN + 1}`;
    const fields: Record<string, unknown> = {
      "Job Code": nextCode,
      Client: [data.clientId],
      "Service Catalog": [data.serviceId],
    };
    if (data.accountantId) fields["Assigned Accountant"] = [data.accountantId];
    if (data.status) fields["Status"] = data.status;
    if (data.slaDeadline) fields["SLA Deadline"] = data.slaDeadline;
    if (data.dateSent) fields["Date Sent"] = data.dateSent;
    if (data.notes) fields["Notes"] = data.notes;
    const record = await airtablePost(TABLES.jobs, fields);
    const actor = await getActorIdentity(context.userId);
    await logActivityEvent({
      eventType: "job_created",
      actorUserId: context.userId,
      actorEmail: actor.email,
      actorName: actor.name,
      subjectLabel: nextCode,
      metadata: {
        jobCode: nextCode,
        status: data.status ?? "To Assign",
        assigned: data.accountantId ? "yes" : "no",
      },
    });
    return { ok: true, jobId: record.id };
  });

export const getJobOrder = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d?: { scopeKey?: string }) =>
    z.object({ scopeKey: z.string().min(1).max(100).default("default") }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { data: row } = await supabaseAdmin
      .from("job_order_preferences")
      .select("ordered_job_ids")
      .eq("user_id", context.userId)
      .eq("scope_key", data.scopeKey)
      .maybeSingle();
    return { orderedJobIds: (row?.ordered_job_ids ?? []) as string[] };
  });

export const saveJobOrder = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { scopeKey?: string; orderedJobIds: string[] }) =>
    z
      .object({
        scopeKey: z.string().min(1).max(100).default("default"),
        orderedJobIds: z.array(z.string().min(1).max(50)).max(1000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await supabaseAdmin
      .from("job_order_preferences")
      .upsert(
        {
          user_id: context.userId,
          scope_key: data.scopeKey,
          ordered_job_ids: data.orderedJobIds,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,scope_key" },
      );
    if (error) {
      console.error("[saveJobOrder] DB error:", error);
      throw new Error("A database error occurred. Please try again.");
    }
    return { ok: true };
  });

export const clearJobOrder = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d?: { scopeKey?: string }) =>
    z.object({ scopeKey: z.string().min(1).max(100).default("default") }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await supabaseAdmin
      .from("job_order_preferences")
      .delete()
      .eq("user_id", context.userId)
      .eq("scope_key", data.scopeKey);
    return { ok: true };
  });

export const assignPartner = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string; accountantId: string }) =>
    z.object({ jobId: z.string().min(1).max(50), accountantId: z.string().min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");
    await airtablePatch(TABLES.jobs, data.jobId, { "Assigned Accountant": [data.accountantId] });
    return { ok: true };
  });

export const createClientToken = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string }) => z.object({ jobId: z.string().min(1).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");
    const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
    const clientId = job.fields.Client?.[0];
    if (!clientId) throw new Error("Job has no client");
    const client = (await airtableGet(`${TABLES.clients}/${clientId}`)) as AirtableRecord<ClientFields>;
    const email = client.fields.Email;
    if (!email) throw new Error("Client has no email");
    const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabaseAdmin.from("client_tokens").insert({
      token,
      airtable_job_id: data.jobId,
      airtable_client_id: clientId,
      client_email: email,
      expires_at: expires,
      created_by: context.userId,
    });
    if (error) {
      console.error("[createClientToken] DB error:", error);
      throw new Error("Could not create tracking link. Please try again.");
    }
    const actor = await getActorIdentity(context.userId);
    await logActivityEvent({
      eventType: "tracking_link_created",
      actorUserId: context.userId,
      actorEmail: actor.email,
      actorName: actor.name,
      subjectLabel: job.fields["Job Code"] ?? data.jobId,
      metadata: { jobCode: job.fields["Job Code"] ?? null, recipient: email },
    });
    return { token, email };
  });

// Public: client tracking page (no auth)
export const getClientTracking = createServerFn({ method: "GET" })
  .inputValidator((d: { token: string }) => z.object({ token: z.string().min(10).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("client_tokens")
      .select("*")
      .eq("token", data.token)
      .maybeSingle();
    if (error || !row) throw new Error("Invalid link");
    if (new Date(row.expires_at) < new Date()) throw new Error("Link expired");
    const job = (await airtableGet(`${TABLES.jobs}/${row.airtable_job_id}`)) as AirtableRecord<JobFields>;
    const client = (await airtableGet(`${TABLES.clients}/${row.airtable_client_id}`)) as AirtableRecord<ClientFields>;
    const status = job.fields.Status ?? "Pending";

    // --- Capture open analytics (best-effort, never breaks the page) ---
    try {
      const ip =
        getRequestHeader("cf-connecting-ip") ??
        getRequestHeader("x-forwarded-for")?.split(",")[0]?.trim() ??
        null;
      const country = getRequestHeader("cf-ipcountry") ?? null;
      const city = getRequestHeader("cf-ipcity") ?? null;
      const userAgent = getRequestHeader("user-agent") ?? null;
      const referrer = getRequestHeader("referer") ?? null;
      let device: string | null = null;
      let browser: string | null = null;
      let os: string | null = null;
      if (userAgent) {
        const ua = new UAParser(userAgent).getResult();
        device = ua.device.type ?? "desktop";
        browser = [ua.browser.name, ua.browser.version].filter(Boolean).join(" ") || null;
        os = [ua.os.name, ua.os.version].filter(Boolean).join(" ") || null;
      }

      await supabaseAdmin.from("tracking_link_opens").insert({
        token: data.token,
        ip,
        country,
        city,
        user_agent: userAgent,
        device,
        browser,
        os,
        referrer,
        airtable_job_id: row.airtable_job_id,
        client_email: row.client_email,
      });

      const now = new Date().toISOString();
      await supabaseAdmin
        .from("client_tokens")
        .update({
          open_count: (row.open_count ?? 0) + 1,
          last_opened_at: now,
          first_opened_at: row.first_opened_at ?? now,
          last_ip: ip,
          last_country: country,
          last_user_agent: userAgent,
        })
        .eq("token", data.token);
    } catch (e) {
      console.error("[getClientTracking] open analytics failed", e);
    }

    await logActivityEvent({
      eventType: "tracking_link_opened",
      actorEmail: row.client_email ?? null,
      actorName: client.fields["Full Name"] ?? null,
      subjectLabel: job.fields["Job Code"] ?? row.airtable_job_id,
      metadata: { jobCode: job.fields["Job Code"] ?? null, status },
    });
    return {
      clientName: client.fields["Full Name"] ?? "Client",
      jobCode: job.fields["Job Code"] ?? "",
      serviceName: job.fields["Service Name"]?.[0] ?? "Tax service",
      status,
      progress: STATUS_PROGRESS[status] ?? 0,
      sla: job.fields["SLA Deadline"] ?? null,
      dateSent: job.fields["Date Sent"] ?? null,
      notes: job.fields.Notes ?? "",
    };
  });

// ============================================================
// Tracking-link analytics (admin only)
// ============================================================

export type TrackingLinkSummary = {
  token: string;
  airtable_job_id: string;
  airtable_client_id: string;
  client_email: string;
  created_at: string;
  expires_at: string;
  open_count: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
  last_country: string | null;
  last_ip: string | null;
  last_user_agent: string | null;
  jobCode: string | null;
  clientName: string | null;
  status: string | null;
};

export type TrackingOpenRow = {
  id: string;
  opened_at: string;
  ip: string | null;
  country: string | null;
  city: string | null;
  user_agent: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  referrer: string | null;
};

export const getJobTrackingStats = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string }) =>
    z.object({ jobId: z.string().min(1).max(50) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");

    const { data: tokens } = await supabaseAdmin
      .from("client_tokens")
      .select("*")
      .eq("airtable_job_id", data.jobId)
      .order("created_at", { ascending: false })
      .limit(1);
    const token = tokens?.[0];
    if (!token) return { token: null, opens: [] as TrackingOpenRow[] };

    const { data: opens } = await supabaseAdmin
      .from("tracking_link_opens")
      .select("id, opened_at, ip, country, city, user_agent, device, browser, os, referrer")
      .eq("token", token.token)
      .order("opened_at", { ascending: false })
      .limit(20);

    return {
      token: {
        token: token.token,
        created_at: token.created_at,
        expires_at: token.expires_at,
        client_email: token.client_email,
        open_count: token.open_count ?? 0,
        first_opened_at: token.first_opened_at,
        last_opened_at: token.last_opened_at,
        last_country: token.last_country,
        last_ip: token.last_ip,
        last_user_agent: token.last_user_agent,
      },
      opens: (opens ?? []) as TrackingOpenRow[],
    };
  });

export const extendClientToken = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { token: string; days: number }) =>
    z
      .object({
        token: z.string().min(10).max(200),
        days: z.number().int().min(1).max(3650),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");

    const { data: row, error: readErr } = await supabaseAdmin
      .from("client_tokens")
      .select("expires_at, airtable_job_id")
      .eq("token", data.token)
      .maybeSingle();
    if (readErr || !row) throw new Error("Tracking link not found");

    // Extend from whichever is later: now or current expiry, so already-expired
    // links restart from today.
    const base = new Date(
      Math.max(Date.now(), new Date(row.expires_at).getTime()),
    );
    const newExpiry = new Date(
      base.getTime() + data.days * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { error: updErr } = await supabaseAdmin
      .from("client_tokens")
      .update({ expires_at: newExpiry })
      .eq("token", data.token);
    if (updErr) throw new Error(updErr.message);

    const actor = await getActorIdentity(context.userId);
    await supabaseAdmin.from("client_token_events").insert({
      token: data.token,
      event_type: "extended",
      actor_user_id: context.userId,
      actor_email: actor.email,
      actor_name: actor.name,
      metadata: {
        days_added: data.days,
        previous_expires_at: row.expires_at,
        new_expires_at: newExpiry,
      },
    });
    await logActivityEvent({
      eventType: "tracking_link_extended",
      actorUserId: context.userId,
      actorEmail: actor.email,
      actorName: actor.name,
      subjectLabel: row.airtable_job_id,
      metadata: {
        daysAdded: data.days,
        newExpiresAt: newExpiry,
      },
    });

    return { expires_at: newExpiry };
  });

export type ClientTokenEventRow = {
  id: string;
  occurred_at: string;
  event_type: string;
  actor_email: string | null;
  actor_name: string | null;
  metadata: Record<string, unknown>;
};

export const getClientTokenHistory = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().min(10).max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");
    const { data: events, error } = await supabaseAdmin
      .from("client_token_events")
      .select("id, occurred_at, event_type, actor_email, actor_name, metadata")
      .eq("token", data.token)
      .order("occurred_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return { events: (events ?? []) as ClientTokenEventRow[] };
  });

export const listTrackingLinks = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ links: TrackingLinkSummary[] }> => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");

    const { data: rows, error } = await supabaseAdmin
      .from("client_tokens")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    // Enrich with airtable job + client info (best-effort, parallel).
    const enriched = await Promise.all(
      (rows ?? []).map(async (r) => {
        let jobCode: string | null = null;
        let clientName: string | null = null;
        let status: string | null = null;
        try {
          const job = (await airtableGet(
            `${TABLES.jobs}/${r.airtable_job_id}`,
          )) as AirtableRecord<JobFields>;
          jobCode = job.fields["Job Code"] ?? null;
          status = job.fields.Status ?? null;
        } catch {
          /* deleted job */
        }
        try {
          const client = (await airtableGet(
            `${TABLES.clients}/${r.airtable_client_id}`,
          )) as AirtableRecord<ClientFields>;
          clientName = client.fields["Full Name"] ?? null;
        } catch {
          /* deleted client */
        }
        return {
          token: r.token,
          airtable_job_id: r.airtable_job_id,
          airtable_client_id: r.airtable_client_id,
          client_email: r.client_email,
          created_at: r.created_at,
          expires_at: r.expires_at,
          open_count: r.open_count ?? 0,
          first_opened_at: r.first_opened_at,
          last_opened_at: r.last_opened_at,
          last_country: r.last_country,
          last_ip: r.last_ip,
          last_user_agent: r.last_user_agent,
          jobCode,
          clientName,
          status,
        } satisfies TrackingLinkSummary;
      }),
    );

    return { links: enriched };
  });

export const getTrackingLinkOpens = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().min(10).max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { isAdmin } = await getRoleAndPartner(context.userId);
    if (!isAdmin) throw new Error("Forbidden");
    const { data: opens, error } = await supabaseAdmin
      .from("tracking_link_opens")
      .select("id, opened_at, ip, country, city, user_agent, device, browser, os, referrer")
      .eq("token", data.token)
      .order("opened_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { opens: (opens ?? []) as TrackingOpenRow[] };
  });