import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { enqueuePartnerInviteEmail } from "./invite-email.server";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function assertAdmin(userId: string) {
  const { data: roles } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (!roles?.some((r) => r.role === "admin")) {
    throw new Error("Forbidden");
  }
}

export const createPartnerInvite = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        firstName: z.string().trim().min(1).max(80),
        lastName: z.string().trim().min(1).max(80),
        email: z.string().trim().toLowerCase().email().max(255),
        airtableAccountantId: z.string().trim().max(50).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);

    // Reject if email already linked to a partner profile
    const { data: existingPartner } = await supabaseAdmin
      .from("partner_profiles")
      .select("user_id")
      .eq("email", data.email)
      .maybeSingle();
    if (existingPartner) {
      throw new Error("A partner with this email already exists.");
    }

    // Revoke any other pending invite for this email
    await supabaseAdmin
      .from("partner_invites")
      .update({ consumed_at: new Date().toISOString() })
      .eq("email", data.email)
      .is("consumed_at", null);

    const token = randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);

    const { data: invite, error } = await supabaseAdmin
      .from("partner_invites")
      .insert({
        token_hash: tokenHash,
        email: data.email,
        first_name: data.firstName,
        last_name: data.lastName,
        airtable_accountant_id: data.airtableAccountantId ?? null,
        created_by: context.userId,
      })
      .select("id, expires_at")
      .single();

    if (error || !invite) {
      console.error("[createPartnerInvite] insert failed:", error);
      throw new Error("Could not create invite. Please try again.");
    }

    return { id: invite.id, token, expiresAt: invite.expires_at };
  });

export const listPartnerInvites = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("partner_invites")
      .select("id, email, first_name, last_name, airtable_accountant_id, created_at, expires_at, consumed_at")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[listPartnerInvites] error:", error);
      throw new Error("Could not load invites.");
    }
    return { invites: data ?? [] };
  });

export const revokePartnerInvite = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d) => z.object({ inviteId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("partner_invites")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", data.inviteId)
      .is("consumed_at", null);
    if (error) {
      console.error("[revokePartnerInvite] error:", error);
      throw new Error("Could not revoke invite.");
    }
    return { ok: true };
  });

export const sendPartnerInviteEmail = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        email: z.string().trim().toLowerCase().email().max(255),
        firstName: z.string().trim().min(1).max(80),
        inviteUrl: z.string().trim().url().max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    await enqueuePartnerInviteEmail(data);
    return { ok: true };
  });

export const listPartnerProfilesAdmin = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("partner_profiles")
      .select("user_id, email, full_name, airtable_accountant_id, created_at")
      .order("created_at", { ascending: false });
    if (error) {
      console.error("[listPartnerProfilesAdmin] error:", error);
      throw new Error("Could not load partners.");
    }
    return { partners: data ?? [] };
  });

// Public — no auth middleware
export const getInviteByToken = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().min(32).max(128) }).parse(d))
  .handler(async ({ data }) => {
    const tokenHash = hashToken(data.token);
    const { data: invite } = await supabaseAdmin
      .from("partner_invites")
      .select("first_name, last_name, email, expires_at, consumed_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!invite || invite.consumed_at || new Date(invite.expires_at) < new Date()) {
      return { valid: false as const };
    }
    return {
      valid: true as const,
      firstName: invite.first_name,
      lastName: invite.last_name,
      email: invite.email,
    };
  });

export const acceptPartnerInvite = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().min(32).max(128),
        password: z.string().min(12).max(128),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const tokenHash = hashToken(data.token);
    const { data: invite } = await supabaseAdmin
      .from("partner_invites")
      .select("id, email, first_name, last_name, airtable_accountant_id, expires_at, consumed_at")
      .eq("token_hash", tokenHash)
      .maybeSingle();
    if (!invite || invite.consumed_at || new Date(invite.expires_at) < new Date()) {
      throw new Error("This invitation link is no longer valid.");
    }

    // Create or fetch the auth user
    const fullName = `${invite.first_name} ${invite.last_name}`.trim();
    let userId: string | null = null;
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: invite.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createErr) {
      console.error("[acceptPartnerInvite] createUser:", createErr);
      throw new Error("Could not create your account. The email may already be registered.");
    }
    userId = created.user?.id ?? null;
    if (!userId) throw new Error("Could not create your account.");

    // Link partner profile (best effort)
    await supabaseAdmin
      .from("partner_profiles")
      .upsert(
        {
          user_id: userId,
          email: invite.email,
          full_name: fullName,
          airtable_accountant_id: invite.airtable_accountant_id ?? "",
        },
        { onConflict: "user_id" },
      );

    // Assign partner role
    await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: userId, role: "partner" })
      .select();

    // Mark invite consumed atomically
    const { error: consumeErr } = await supabaseAdmin
      .from("partner_invites")
      .update({ consumed_at: new Date().toISOString(), consumed_user_id: userId })
      .eq("id", invite.id)
      .is("consumed_at", null);
    if (consumeErr) {
      console.error("[acceptPartnerInvite] consume:", consumeErr);
    }

    return { ok: true, email: invite.email };
  });
