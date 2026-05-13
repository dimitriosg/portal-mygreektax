import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  airtableGet,
  airtableListAll,
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
import { requireAdminAccess, requireVerifiedAccess } from "./access-context.server";

async function getActorIdentity(
  userId: string,
): Promise<{ email: string | null; name: string | null }> {
  const [{ data: authUser }, { data: partner }] = await Promise.all([
    supabaseAdmin.auth.admin.getUserById(userId),
    supabaseAdmin
      .from("partner_profiles")
      .select("full_name, email")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  const email = authUser?.user?.email ?? partner?.email ?? null;
  const name = partner?.full_name ?? email ?? null;
  return { email, name };
}

async function getAccessContext(userId: string, email?: string | null) {
  return requireVerifiedAccess({ userId, email });
}

function escapeFormula(s: string) {
  return s.replace(/'/g, "\\'");
}

function getPartnerProgressNotes(job: Pick<AirtableRecord<JobFields>, "fields">) {
  const partnerProgressNotes = job.fields["Partner Progress Notes"];
  if (typeof partnerProgressNotes === "string" && partnerProgressNotes.trim() !== "") {
    return partnerProgressNotes;
  }
  return job.fields.Notes ?? "";
}

export const listJobs = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d?: { asAccountantId?: string }) =>
    z.object({ asAccountantId: z.string().min(1).max(50).optional() }).parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { isAdmin, partner } = await getAccessContext(
      userId,
      context.claims.email as string | undefined,
    );
    if (!isAdmin && !partner) {
      return {
        jobs: [] as AirtableRecord<JobFields>[],
        isAdmin: false,
        clientNames: {} as Record<string, string>,
      };
    }
    // Admin impersonation: filter by chosen accountant
    const impersonateId = isAdmin ? data?.asAccountantId : undefined;
    const filterAccountantId =
      impersonateId ?? (!isAdmin && partner ? partner.airtable_accountant_id : undefined);
    const data2 = await airtableListAll<JobFields>(TABLES.jobs, { pageSize: "100" });
    let jobs = data2.records as AirtableRecord<JobFields>[];
    if (filterAccountantId) {
      jobs = jobs.filter((j) => j.fields["Assigned Accountant"]?.includes(filterAccountantId));
    }
    // Real admins (not impersonating) see real client names
    const clientNames: Record<string, string> = {};
    if (isAdmin && !impersonateId) {
      const ids = Array.from(new Set(jobs.flatMap((j) => j.fields.Client ?? []).filter(Boolean)));
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
    const { isAdmin, partner } = await getAccessContext(
      userId,
      context.claims.email as string | undefined,
    );
    const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
    if (!isAdmin) {
      const allowed =
        partner && job.fields["Assigned Accountant"]?.includes(partner.airtable_accountant_id);
      if (!allowed) throw new Error("Forbidden");
    }
    const clientId = job.fields.Client?.[0];
    const accountantId = job.fields["Assigned Accountant"]?.[0];
    const [client, accountant] = await Promise.all([
      clientId
        ? (airtableGet(`${TABLES.clients}/${clientId}`) as Promise<AirtableRecord<ClientFields>>)
        : null,
      accountantId
        ? (airtableGet(`${TABLES.accountants}/${accountantId}`) as Promise<
            AirtableRecord<AccountantFields>
          >)
        : null,
    ]);
    // Partners (and admins while impersonating, via dashboard) should not see real client name.
    // We always strip name for non-admins server-side; admins keep full record.
    const safeClient = isAdmin
      ? client
      : client
        ? ({
            ...client,
            fields: {
              ...client.fields,
              "Full Name": undefined,
              Email: undefined,
              Phone: undefined,
            },
          } as AirtableRecord<ClientFields>)
        : null;
    const safeJob = (() => {
      if (isAdmin) return job;
      const {
        "Admin Internal Notes": _adminInternalNotes,
        "Client Visible Note": _clientVisibleNote,
        ...partnerSafeFields
      } = job.fields;
      return {
        ...job,
        // Keep admin-only notes server-side so partners cannot accidentally read them.
        fields: partnerSafeFields,
      } as AirtableRecord<JobFields>;
    })();
    return { job: safeJob, client: safeClient, accountant, isAdmin };
  });

export const updateJob = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: {
      jobId: string;
      status?: string;
      adminInternalNotes?: string;
      partnerProgressNotes?: string;
      clientVisibleNote?: string;
      slaDeadline?: string | null;
      dateSent?: string | null;
      clientFee?: number | null;
      accountantFee?: number | null;
      tier?: string | null;
      category?: string | null;
      serviceId?: string | null;
      clientId?: string | null;
      accountantId?: string | null;
    }) =>
      z
        .object({
          jobId: z.string().min(1).max(50),
          status: z.enum(JOB_STATUSES).optional(),
          adminInternalNotes: z.string().max(5000).optional(),
          partnerProgressNotes: z.string().max(5000).optional(),
          clientVisibleNote: z.string().max(5000).optional(),
          slaDeadline: z.string().max(30).nullable().optional(),
          dateSent: z.string().max(30).nullable().optional(),
          clientFee: z.number().min(0).max(1_000_000).nullable().optional(),
          accountantFee: z.number().min(0).max(1_000_000).nullable().optional(),
          tier: z.string().max(100).nullable().optional(),
          category: z.string().max(100).nullable().optional(),
          serviceId: z.string().min(1).max(50).nullable().optional(),
          clientId: z.string().min(1).max(50).nullable().optional(),
          accountantId: z.string().min(1).max(50).nullable().optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { isAdmin, partner } = await getAccessContext(
      userId,
      context.claims.email as string | undefined,
    );
    const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
    if (!isAdmin) {
      const allowed =
        partner && job.fields["Assigned Accountant"]?.includes(partner.airtable_accountant_id);
      if (!allowed) throw new Error("Forbidden");
      const partnerFields = new Set(["jobId", "status", "partnerProgressNotes"]);
      for (const k of Object.keys(data)) {
        if (!partnerFields.has(k) && data[k as keyof typeof data] !== undefined) {
          throw new Error(
            "Partners can only update status and partner progress notes directly. Submit a change request for other fields.",
          );
        }
      }
    }
    const fields: Record<string, unknown> = {};
    if (data.status) fields["Status"] = data.status;
    if (data.partnerProgressNotes !== undefined) {
      // Use the dedicated Airtable field on write; legacy Notes is read-only fallback.
      fields["Partner Progress Notes"] = data.partnerProgressNotes;
    }
    if (isAdmin) {
      if (data.adminInternalNotes !== undefined) {
        fields["Admin Internal Notes"] = data.adminInternalNotes;
      }
      if (data.clientVisibleNote !== undefined) {
        fields["Client Visible Note"] = data.clientVisibleNote;
      }
      if (data.slaDeadline !== undefined) fields["SLA Deadline"] = data.slaDeadline ?? null;
      if (data.dateSent !== undefined) fields["Date Sent"] = data.dateSent ?? null;
      if (data.clientFee !== undefined) fields["Client Fee (\u20ac)"] = data.clientFee ?? null;
      if (data.accountantFee !== undefined)
        fields["Accountant Fee (\u20ac)"] = data.accountantFee ?? null;
      if (data.tier !== undefined) fields["Tier"] = data.tier ? [data.tier] : null;
      if (data.category !== undefined) fields["Category"] = data.category ? [data.category] : null;
      if (data.serviceId !== undefined)
        fields["Service Catalog"] = data.serviceId ? [data.serviceId] : [];
      if (data.clientId !== undefined) fields["Client"] = data.clientId ? [data.clientId] : [];
      if (data.accountantId !== undefined)
        fields["Assigned Accountant"] = data.accountantId ? [data.accountantId] : [];
    }
    if (Object.keys(fields).length === 0) return { ok: true };
    const previousStatus = job.fields.Status ?? null;
    const previousPartnerProgressNotes = getPartnerProgressNotes(job);
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
      event_type: "status_change" | "comment" | "field_change";
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
    if (
      data.partnerProgressNotes !== undefined &&
      data.partnerProgressNotes.trim() !== previousPartnerProgressNotes.trim() &&
      data.partnerProgressNotes.trim() !== ""
    ) {
      events.push({
        airtable_job_id: data.jobId,
        user_id: userId,
        actor_email: actorEmail,
        actor_name: actorName,
        event_type: "comment",
        comment: data.partnerProgressNotes,
      });
    }
    // Log other admin field changes as comment-style events.
    if (isAdmin) {
      const fieldChangeMap: Array<[string, unknown, unknown]> = [
        ["SLA deadline", job.fields["SLA Deadline"], data.slaDeadline],
        ["Date sent", job.fields["Date Sent"], data.dateSent],
        ["Client fee", job.fields["Client Fee (\u20ac)"], data.clientFee],
        ["Accountant fee", job.fields["Accountant Fee (\u20ac)"], data.accountantFee],
        ["Tier", job.fields.Tier?.[0], data.tier],
        ["Category", job.fields.Category?.[0], data.category],
        ["Service", job.fields["Service Catalog"]?.[0], data.serviceId],
        ["Client", job.fields.Client?.[0], data.clientId],
        ["Assigned accountant", job.fields["Assigned Accountant"]?.[0], data.accountantId],
      ];
      for (const [label, prev, next] of fieldChangeMap) {
        if (next === undefined) continue;
        const prevStr = prev == null ? "" : String(prev);
        const nextStr = next == null ? "" : String(next);
        if (prevStr === nextStr) continue;
        events.push({
          airtable_job_id: data.jobId,
          user_id: userId,
          actor_email: actorEmail,
          actor_name: actorName,
          event_type: "comment",
          comment: `${label}: ${prevStr || "—"} → ${nextStr || "—"}`,
        });
      }
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
    const { isAdmin, partner } = await getAccessContext(
      userId,
      context.claims.email as string | undefined,
    );
    if (!isAdmin) {
      const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
      const allowed =
        partner && job.fields["Assigned Accountant"]?.includes(partner.airtable_accountant_id);
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
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const data = await airtableListAll<AccountantFields>(TABLES.accountants, { pageSize: "100" });
    return { accountants: data.records as AirtableRecord<AccountantFields>[] };
  });

export const listClients = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const data = await airtableListAll<ClientFields>(TABLES.clients, { pageSize: "100" });
    return { clients: data.records as AirtableRecord<ClientFields>[] };
  });

export const listServices = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const data = await airtableListAll(TABLES.serviceCatalog, { pageSize: "100" });
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
        (a.code || a.name).localeCompare(b.code || b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
    return { services };
  });

export const createJob = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: {
      clientId: string;
      serviceId: string;
      accountantId?: string;
      status?: string;
      slaDeadline?: string;
      dateSent?: string;
      partnerProgressNotes?: string;
    }) =>
      z
        .object({
          clientId: z.string().min(1).max(50),
          serviceId: z.string().min(1).max(50),
          accountantId: z.string().min(1).max(50).optional(),
          status: z.enum(JOB_STATUSES).optional(),
          slaDeadline: z.string().max(30).optional(),
          dateSent: z.string().max(30).optional(),
          partnerProgressNotes: z.string().max(5000).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    // Compute next Job Code (e.g. JB105) by scanning all existing codes.
    let maxN = 0;
    let prefix = "JB";
    const existingJobs = await airtableListAll<JobFields>(TABLES.jobs, {
      pageSize: "100",
      "fields[]": "Job Code",
    });
    for (const r of existingJobs.records) {
      const code = r.fields["Job Code"];
      if (!code) continue;
      const m = /^([A-Za-z]+)(\d+)$/.exec(code);
      if (!m) continue;
      prefix = m[1];
      const n = parseInt(m[2], 10);
      if (n > maxN) maxN = n;
    }
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
    if (data.partnerProgressNotes) fields["Partner Progress Notes"] = data.partnerProgressNotes;
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
    const access = await getAccessContext(
      context.userId,
      context.claims.email as string | undefined,
    );
    if (!access.isAdmin && !access.isPartner) {
      return { orderedJobIds: [] as string[] };
    }
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
    const access = await getAccessContext(
      context.userId,
      context.claims.email as string | undefined,
    );
    if (!access.isAdmin && !access.isPartner) throw new Error("Forbidden");
    const { error } = await supabaseAdmin.from("job_order_preferences").upsert(
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
    const access = await getAccessContext(
      context.userId,
      context.claims.email as string | undefined,
    );
    if (!access.isAdmin && !access.isPartner) throw new Error("Forbidden");
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
    z
      .object({ jobId: z.string().min(1).max(50), accountantId: z.string().min(1).max(50) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    await airtablePatch(TABLES.jobs, data.jobId, { "Assigned Accountant": [data.accountantId] });
    return { ok: true };
  });

export const createClientToken = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string }) => z.object({ jobId: z.string().min(1).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
    const clientId = job.fields.Client?.[0];
    if (!clientId) throw new Error("Job has no client");
    const client = (await airtableGet(
      `${TABLES.clients}/${clientId}`,
    )) as AirtableRecord<ClientFields>;
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
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().min(10).max(200) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { data: row, error } = await supabaseAdmin
      .from("client_tokens")
      .select("*")
      .eq("token", data.token)
      .maybeSingle();
    if (error || !row) throw new Error("Invalid link");
    if (new Date(row.expires_at) < new Date()) throw new Error("Link expired");
    const job = (await airtableGet(
      `${TABLES.jobs}/${row.airtable_job_id}`,
    )) as AirtableRecord<JobFields>;
    const client = (await airtableGet(
      `${TABLES.clients}/${row.airtable_client_id}`,
    )) as AirtableRecord<ClientFields>;
    const status = job.fields.Status ?? "Pending";

    // --- Capture minimal open analytics (best-effort, never breaks the page) ---
    try {
      const country = getRequestHeader("cf-ipcountry") ?? null;

      await supabaseAdmin.from("tracking_link_opens").insert({
        token: data.token,
        country,
        airtable_job_id: row.airtable_job_id,
      });

      const now = new Date().toISOString();
      await supabaseAdmin
        .from("client_tokens")
        .update({
          open_count: (row.open_count ?? 0) + 1,
          last_opened_at: now,
          first_opened_at: row.first_opened_at ?? now,
          last_country: country,
          last_ip: null,
          last_user_agent: null,
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
      clientVisibleNote: job.fields["Client Visible Note"] ?? "",
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
  jobCode: string | null;
  clientName: string | null;
  status: string | null;
};

export type TrackingOpenRow = {
  id: string;
  opened_at: string;
  country: string | null;
};

export const getJobTrackingStats = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string }) => z.object({ jobId: z.string().min(1).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

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
      .select("id, opened_at, country")
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
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: row, error: readErr } = await supabaseAdmin
      .from("client_tokens")
      .select("expires_at, airtable_job_id")
      .eq("token", data.token)
      .maybeSingle();
    if (readErr || !row) throw new Error("Tracking link not found");

    // Extend from whichever is later: now or current expiry, so already-expired
    // links restart from today.
    const base = new Date(Math.max(Date.now(), new Date(row.expires_at).getTime()));
    const newExpiry = new Date(base.getTime() + data.days * 24 * 60 * 60 * 1000).toISOString();

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
  metadata: {
    days_added?: number;
    previous_expires_at?: string;
    new_expires_at?: string;
  };
};

export const getClientTokenHistory = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().min(10).max(200) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
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
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

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
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const { data: opens, error } = await supabaseAdmin
      .from("tracking_link_opens")
      .select("id, opened_at, country")
      .eq("token", data.token)
      .order("opened_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    return { opens: (opens ?? []) as TrackingOpenRow[] };
  });

// ============================================================
// Job change requests (partner → admin approval workflow)
// ============================================================

const CHANGE_FIELDS = ["sla_deadline", "status", "notes"] as const;
export type ChangeFieldName = (typeof CHANGE_FIELDS)[number];

export type JobChangeRequestRow = {
  id: string;
  airtable_job_id: string;
  job_code: string | null;
  requested_by: string;
  requester_email: string | null;
  requester_name: string | null;
  field_name: ChangeFieldName;
  current_value: string | null;
  requested_value: string | null;
  reason: string | null;
  status: "pending" | "approved" | "rejected" | "cancelled";
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

function jobFieldCurrentValue(job: AirtableRecord<JobFields>, field: ChangeFieldName): string {
  switch (field) {
    case "sla_deadline":
      return job.fields["SLA Deadline"] ?? "";
    case "status":
      return job.fields.Status ?? "";
    case "notes":
      return getPartnerProgressNotes(job);
  }
}

export const requestJobChange = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: { jobId: string; field: ChangeFieldName; requestedValue: string; reason?: string }) =>
      z
        .object({
          jobId: z.string().min(1).max(50),
          field: z.enum(CHANGE_FIELDS),
          requestedValue: z.string().max(5000),
          reason: z.string().max(1000).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { isAdmin, partner } = await getAccessContext(
      userId,
      context.claims.email as string | undefined,
    );
    if (isAdmin) throw new Error("Admins should edit jobs directly, not request changes.");
    if (!partner) throw new Error("Forbidden");
    const job = (await airtableGet(`${TABLES.jobs}/${data.jobId}`)) as AirtableRecord<JobFields>;
    const allowed = job.fields["Assigned Accountant"]?.includes(partner.airtable_accountant_id);
    if (!allowed) throw new Error("Forbidden");

    if (
      data.field === "status" &&
      !(JOB_STATUSES as readonly string[]).includes(data.requestedValue)
    ) {
      throw new Error("Invalid status value");
    }

    const currentValue = jobFieldCurrentValue(job, data.field);
    if (currentValue === data.requestedValue) {
      throw new Error("Requested value matches the current value.");
    }

    // Block duplicate pending request for same field.
    const { data: existing } = await supabaseAdmin
      .from("job_change_requests")
      .select("id")
      .eq("airtable_job_id", data.jobId)
      .eq("field_name", data.field)
      .eq("status", "pending")
      .maybeSingle();
    if (existing) throw new Error("You already have a pending request for this field.");

    const actor = await getActorIdentity(userId);
    const { data: inserted, error } = await supabaseAdmin
      .from("job_change_requests")
      .insert({
        airtable_job_id: data.jobId,
        job_code: job.fields["Job Code"] ?? null,
        requested_by: userId,
        requester_email: actor.email,
        requester_name: actor.name,
        field_name: data.field,
        current_value: currentValue,
        requested_value: data.requestedValue,
        reason: data.reason ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error(error.message);

    await logActivityEvent({
      eventType: "job_change_request_created",
      actorUserId: userId,
      actorEmail: actor.email,
      actorName: actor.name,
      subjectLabel: job.fields["Job Code"] ?? data.jobId,
      metadata: {
        jobCode: job.fields["Job Code"] ?? null,
        field: data.field,
        from: currentValue,
        to: data.requestedValue,
      },
    });

    // Fire-and-forget admin notification email.
    try {
      const { enqueueChangeRequestAdminEmail } = await import("./change-request-email.server");
      await enqueueChangeRequestAdminEmail({
        jobCode: job.fields["Job Code"] ?? data.jobId,
        jobId: data.jobId,
        partnerName: actor.name ?? actor.email ?? "A partner",
        field: data.field,
        currentValue,
        requestedValue: data.requestedValue,
        reason: data.reason ?? null,
      });
    } catch (e) {
      console.error("[requestJobChange] notification email failed", e);
    }

    return { ok: true, request: inserted as unknown as JobChangeRequestRow };
  });

export const cancelChangeRequest = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await supabaseAdmin
      .from("job_change_requests")
      .update({ status: "cancelled", decided_at: new Date().toISOString() })
      .eq("id", data.id)
      .eq("requested_by", context.userId)
      .eq("status", "pending");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const decideChangeRequest = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { id: string; decision: "approved" | "rejected"; decisionNote?: string }) =>
    z
      .object({
        id: z.string().uuid(),
        decision: z.enum(["approved", "rejected"]),
        decisionNote: z.string().max(1000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: req, error: readErr } = await supabaseAdmin
      .from("job_change_requests")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (readErr || !req) throw new Error("Request not found");
    const r = req as unknown as JobChangeRequestRow;
    if (r.status !== "pending") throw new Error("Request already decided");

    if (data.decision === "approved") {
      // Apply the change via Airtable + log the field change.
      const update: Record<string, unknown> = {};
      if (r.field_name === "sla_deadline") update["SLA Deadline"] = r.requested_value || null;
      if (r.field_name === "status") update["Status"] = r.requested_value;
      if (r.field_name === "notes") update["Partner Progress Notes"] = r.requested_value;
      await airtablePatch(TABLES.jobs, r.airtable_job_id, update);

      const actor = await getActorIdentity(context.userId);
      const eventBase = {
        airtable_job_id: r.airtable_job_id,
        user_id: context.userId,
        actor_email: actor.email,
        actor_name: actor.name,
      };
      if (r.field_name === "status") {
        await supabaseAdmin.from("job_events").insert({
          ...eventBase,
          event_type: "status_change",
          from_status: r.current_value,
          to_status: r.requested_value,
        });
      } else {
        const label = r.field_name === "sla_deadline" ? "SLA deadline" : "Partner / progress notes";
        await supabaseAdmin.from("job_events").insert({
          ...eventBase,
          event_type: "comment",
          comment: `Approved partner request — ${label}: ${r.current_value || "—"} → ${r.requested_value || "—"}`,
        });
      }
    }

    const { error: updErr } = await supabaseAdmin
      .from("job_change_requests")
      .update({
        status: data.decision,
        decided_by: context.userId,
        decided_at: new Date().toISOString(),
        decision_note: data.decisionNote ?? null,
      })
      .eq("id", data.id);
    if (updErr) throw new Error(updErr.message);

    const actor = await getActorIdentity(context.userId);
    await logActivityEvent({
      eventType: "job_change_request_decided",
      actorUserId: context.userId,
      actorEmail: actor.email,
      actorName: actor.name,
      subjectLabel: r.job_code ?? r.airtable_job_id,
      metadata: {
        jobCode: r.job_code,
        field: r.field_name,
        decision: data.decision,
        from: r.current_value,
        to: r.requested_value,
        partner: r.requester_name ?? r.requester_email,
      },
    });

    // Fire-and-forget partner notification email.
    try {
      const { enqueueChangeRequestDecisionEmail } = await import("./change-request-email.server");
      if (r.requester_email) {
        await enqueueChangeRequestDecisionEmail({
          to: r.requester_email,
          partnerName: r.requester_name ?? r.requester_email,
          jobCode: r.job_code ?? r.airtable_job_id,
          field: r.field_name,
          requestedValue: r.requested_value ?? "",
          decision: data.decision,
          decisionNote: data.decisionNote ?? null,
        });
      }
    } catch (e) {
      console.error("[decideChangeRequest] notification email failed", e);
    }

    return { ok: true };
  });

export const listJobChangeRequests = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { jobId: string }) => z.object({ jobId: z.string().min(1).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const { isAdmin, partner } = await getAccessContext(
      userId,
      context.claims.email as string | undefined,
    );
    if (!isAdmin) {
      // Partners only see their own requests for this job.
      if (!partner) return { requests: [] as unknown as JobChangeRequestRow[] };
      const { data: rows } = await supabaseAdmin
        .from("job_change_requests")
        .select("*")
        .eq("airtable_job_id", data.jobId)
        .eq("requested_by", userId)
        .order("created_at", { ascending: false });
      return { requests: (rows ?? []) as unknown as JobChangeRequestRow[] };
    }
    const { data: rows } = await supabaseAdmin
      .from("job_change_requests")
      .select("*")
      .eq("airtable_job_id", data.jobId)
      .order("created_at", { ascending: false });
    return { requests: (rows ?? []) as unknown as JobChangeRequestRow[] };
  });

export const listChangeRequests = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d?: { status?: "pending" | "approved" | "rejected" | "cancelled" | "all" }) =>
    z
      .object({
        status: z.enum(["pending", "approved", "rejected", "cancelled", "all"]).default("pending"),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    let q = supabaseAdmin
      .from("job_change_requests")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.status !== "all") q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { requests: (rows ?? []) as unknown as JobChangeRequestRow[] };
  });

export const getPendingRequestCount = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { isAdmin } = await getAccessContext(
      context.userId,
      context.claims.email as string | undefined,
    );
    if (!isAdmin) return { count: 0 };
    const { count } = await supabaseAdmin
      .from("job_change_requests")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");
    return { count: count ?? 0 };
  });
