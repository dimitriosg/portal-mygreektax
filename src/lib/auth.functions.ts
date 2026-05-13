import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { airtableGet, TABLES, type AirtableRecord, type AccountantFields } from "./airtable.server";
import { resolveUserAccess } from "./access-context.server";

// Called right after an invited user signs in. Checks if the user's email matches
// an Accountant in Airtable and, if so, creates partner_profile + partner role.
export const linkPartnerProfile = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { userId, claims } = context;
    const email = (claims.email as string | undefined)?.toLowerCase();
    const access = await resolveUserAccess({ userId, email });
    if (access.accessStatus === "verification_failed") {
      return {
        linked: false,
        isAdmin: false,
        accessType: access.accessType,
        accessStatus: access.accessStatus,
        accessError: access.accessError,
      };
    }
    if (!email) {
      return {
        linked: false,
        isAdmin: access.isAdmin,
        accessType: access.accessType,
        accessStatus: access.accessStatus,
        accessError: access.accessError,
      };
    }
    if (access.isAdmin) {
      return {
        linked: !!access.partner,
        isAdmin: true,
        accessType: "admin" as const,
        accessStatus: access.accessStatus,
        accessError: access.accessError,
      };
    }

    const { data: existing } = await supabaseAdmin
      .from("partner_profiles")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (existing) {
      return {
        linked: true,
        isAdmin: false,
        accessType: "partner" as const,
        accessStatus: "resolved" as const,
        accessError: null,
      };
    }

    const safe = email.replace(/'/g, "\\'");
    const result = await airtableGet(TABLES.accountants, {
      filterByFormula: `LOWER({Email}) = '${safe}'`,
      maxRecords: "1",
    });
    const records = result.records as AirtableRecord<AccountantFields>[];
    if (records.length === 0) {
      return {
        linked: false,
        isAdmin: false,
        accessType: "unauthorized" as const,
        accessStatus: "unauthorized" as const,
        accessError: null,
      };
    }

    const accountant = records[0];
    await supabaseAdmin.from("partner_profiles").insert({
      user_id: userId,
      airtable_accountant_id: accountant.id,
      full_name: accountant.fields.Name ?? null,
      email,
    });
    await supabaseAdmin.from("user_roles").insert({ user_id: userId, role: "partner" }).select();
    return {
      linked: true,
      isAdmin: false,
      accessType: "partner" as const,
      accessStatus: "resolved" as const,
      accessError: null,
    };
  });

export const getMyContext = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    return resolveUserAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
  });
