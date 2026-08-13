import { createServerFn } from "@tanstack/react-start";
import { setResponseStatus } from "@tanstack/react-start/server";
import { z } from "zod";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

export type AppendixRow =
  Database["public"]["Functions"]["get_partner_appendix"]["Returns"][number];

export type AppendixPartnerOption = { userId: string; fullName: string | null };

export const APPENDIX_FORBIDDEN_MESSAGE = "Forbidden";

// Παράρτημα Α, one partner's wholesale rate card.
//
// Every query below runs on context.supabase, the per-request client that
// requireSupabaseAuth builds from the signed-in user's JWT, so the RLS policies
// on partner_profiles / user_roles apply to the caller, and get_partner_appendix
// resolves auth.uid() to the caller too. The service-role admin client is
// deliberately not imported here: it bypasses RLS, and this feature's whole
// security model is that Postgres, not the UI, decides who sees which wholesale
// line. get_partner_appendix ignores p_partner_user_id for a partner and forces
// their own id, so the selector below cannot be used to read another card.
export const getAppendix = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d?: { partnerUserId?: string; impersonatingAccountantId?: string }) =>
    z
      .object({
        partnerUserId: z.string().uuid().optional(),
        impersonatingAccountantId: z.string().uuid().optional(),
      })
      .parse(d ?? {}),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Gate: admin, or partner whose profile is not disabled. Checked here so
    // the request 403s before any rate data is queried; get_partner_appendix
    // raises 42501 on the same condition underneath in case this gate is ever
    // wrong. user_roles and partner_profiles are self-readable under their own
    // RLS, so the caller's JWT is enough to resolve the answer.
    const [rolesRes, profileRes] = await Promise.all([
      supabase.from("user_roles").select("role").eq("user_id", userId),
      supabase
        .from("partner_profiles")
        .select("user_id, full_name, disabled_at")
        .eq("user_id", userId)
        .maybeSingle(),
    ]);

    if (rolesRes.error || profileRes.error) {
      console.error("[appendix] access check failed", {
        userId,
        rolesError: rolesRes.error?.message ?? null,
        profileError: profileRes.error?.message ?? null,
      });
      throw new Error("Could not verify portal access. Please contact the administrator.");
    }

    const roles = (rolesRes.data ?? []).map((row) => row.role);
    const isAdmin = roles.includes("admin");
    const isActivePartner =
      roles.includes("partner") && !!profileRes.data && profileRes.data.disabled_at === null;

    // Thrown as an Error, not a Response: TanStack Start hands a thrown
    // Response back to the caller as a successful raw result, so the loader
    // would never see it as a failure. The Error's message survives
    // serialization and is what the route's error component matches on;
    // setResponseStatus keeps the actual HTTP status a 403.
    if (!isAdmin && !isActivePartner) {
      setResponseStatus(403);
      throw new Error(APPENDIX_FORBIDDEN_MESSAGE);
    }

    // Impersonation. Impersonating does not change auth.uid(), so the database
    // function still sees an admin and would happily take its admin branch and
    // render the admin view. The page has to honour the impersonation itself:
    // an admin viewing as a partner sees exactly what that partner sees, which
    // includes seeing nothing at all when the partner is disabled or is not
    // linked to a portal profile. The id is the accountant id the rest of the
    // impersonation feature uses, matched against airtable_accountant_id the
    // same way listJobs matches it.
    const impersonatedAccountantId = isAdmin ? data.impersonatingAccountantId : undefined;

    if (impersonatedAccountantId) {
      const { data: impersonated, error: impersonatedError } = await supabase
        .from("partner_profiles")
        .select("user_id, full_name, disabled_at")
        .eq("airtable_accountant_id", impersonatedAccountantId)
        .maybeSingle();

      if (impersonatedError) {
        console.error("[appendix] impersonated partner lookup failed", {
          userId,
          message: impersonatedError.message,
        });
        throw new Error("Could not load the rate card. Please try again.");
      }

      // No profile, or a disabled one, is what that partner would hit: the
      // route gate refuses them, so the admin viewing as them sees the refusal.
      if (!impersonated || impersonated.disabled_at !== null) {
        setResponseStatus(403);
        throw new Error(APPENDIX_FORBIDDEN_MESSAGE);
      }

      const { data: impersonatedRows, error: impersonatedRowsError } = await supabase.rpc(
        "get_partner_appendix",
        { p_partner_user_id: impersonated.user_id },
      );

      if (impersonatedRowsError) {
        console.error("[appendix] get_partner_appendix failed while impersonating", {
          userId,
          code: impersonatedRowsError.code,
          message: impersonatedRowsError.message,
        });
        throw new Error("Could not load the rate card. Please try again.");
      }

      return {
        // isAdmin false is what hides the admin header and the partner picker:
        // the page renders as the partner's own card, with no choice to make.
        isAdmin: false,
        partners: [] as AppendixPartnerOption[],
        selectedPartnerId: impersonated.user_id,
        partnerName: impersonatedRows?.[0]?.partner_name ?? impersonated.full_name ?? null,
        impersonatedAccountantId,
        rows: (impersonatedRows ?? []) as AppendixRow[],
      };
    }

    // Only an admin gets a choice of card. The list is the active partners;
    // a disabled partner is not offered, and their card is unreachable anyway.
    let partners: AppendixPartnerOption[] = [];
    let selectedPartnerId: string | null = null;

    if (isAdmin) {
      const { data: profiles, error: partnersError } = await supabase
        .from("partner_profiles")
        .select("user_id, full_name")
        .is("disabled_at", null)
        .order("full_name");

      if (partnersError) {
        console.error("[appendix] partner list failed", {
          userId,
          message: partnersError.message,
        });
        throw new Error("Could not load the partner list. Please try again.");
      }

      partners = (profiles ?? []).map((profile) => ({
        userId: profile.user_id,
        fullName: profile.full_name,
      }));

      // An unknown or absent id falls back to the first partner rather than to
      // the admin's own id, which would render an empty card for no reason.
      const requested = data.partnerUserId;
      selectedPartnerId =
        requested && partners.some((partner) => partner.userId === requested)
          ? requested
          : (partners[0]?.userId ?? null);

      if (!selectedPartnerId) {
        return {
          isAdmin,
          partners,
          selectedPartnerId: null,
          partnerName: null,
          impersonatedAccountantId: null,
          rows: [] as AppendixRow[],
        };
      }
    }

    // Partners pass nothing: the function forces their own id regardless.
    const { data: rpcRows, error: rpcError } = await supabase.rpc(
      "get_partner_appendix",
      selectedPartnerId ? { p_partner_user_id: selectedPartnerId } : {},
    );

    if (rpcError) {
      // 42501 is the function refusing the caller. Treat it as the same
      // forbidden outcome as the gate above rather than a generic failure.
      if (rpcError.code === "42501") {
        setResponseStatus(403);
        throw new Error(APPENDIX_FORBIDDEN_MESSAGE);
      }
      console.error("[appendix] get_partner_appendix failed", {
        userId,
        code: rpcError.code,
        message: rpcError.message,
      });
      throw new Error("Could not load the rate card. Please try again.");
    }

    const rows: AppendixRow[] = rpcRows ?? [];

    return {
      isAdmin,
      partners,
      selectedPartnerId: selectedPartnerId ?? userId,
      partnerName: rows[0]?.partner_name ?? profileRes.data?.full_name ?? null,
      impersonatedAccountantId: null,
      rows,
    };
  });
