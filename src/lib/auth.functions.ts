import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { airtableGet, TABLES, type AirtableRecord, type AccountantFields } from "./airtable.server";

// Called right after signup/signin. Checks if user's email matches an Accountant
// in Airtable and, if so, creates partner_profile + partner role.
export const linkPartnerProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, claims } = context;
    const email = (claims.email as string | undefined)?.toLowerCase();
    if (!email) return { linked: false, isAdmin: false };

    const { data: roles } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
    const isAdmin = !!roles?.some((r) => r.role === "admin");

    const { data: existing } = await supabaseAdmin
      .from("partner_profiles")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (existing) return { linked: true, isAdmin };

    const safe = email.replace(/'/g, "\\'");
    const result = await airtableGet(TABLES.accountants, {
      filterByFormula: `LOWER({Email}) = '${safe}'`,
      maxRecords: "1",
    });
    const records = result.records as AirtableRecord<AccountantFields>[];
    if (records.length === 0) return { linked: false, isAdmin };

    const accountant = records[0];
    await supabaseAdmin.from("partner_profiles").insert({
      user_id: userId,
      airtable_accountant_id: accountant.id,
      full_name: accountant.fields.Name ?? null,
      email,
    });
    await supabaseAdmin.from("user_roles").insert({ user_id: userId, role: "partner" }).select();
    return { linked: true, isAdmin };
  });

export const getMyContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, claims } = context;
    const [{ data: roles }, { data: partner }] = await Promise.all([
      supabaseAdmin.from("user_roles").select("role").eq("user_id", userId),
      supabaseAdmin.from("partner_profiles").select("*").eq("user_id", userId).maybeSingle(),
    ]);
    return {
      userId,
      email: claims.email as string | undefined,
      isAdmin: !!roles?.some((r) => r.role === "admin"),
      isPartner: !!roles?.some((r) => r.role === "partner"),
      partner,
    };
  });

// First signed-up user (no admins yet) automatically becomes admin.
export const claimFirstAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { count } = await supabaseAdmin
      .from("user_roles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count ?? 0) > 0) return { promoted: false };
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: context.userId, role: "admin" });
    if (error && !error.message.includes("duplicate")) throw new Error(error.message);
    return { promoted: true };
  });