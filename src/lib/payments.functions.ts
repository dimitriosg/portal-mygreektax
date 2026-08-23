import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-client-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { requireAdminAccess } from "./access-context.server";
import { buildPaymentNote } from "./payments-shared";

// Payment links, slice 1. Tokens carry the amount (clients.deposit means
// "already paid", not "expected") and nothing in here writes to `clients`.
// Payment signals are fast and untrusted: they are forwarded to n8n by the
// /pay/signal route, never recorded here.

export const PAYMENT_KINDS = ["deposit", "balance", "other"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const PAYMENT_TOKEN_PATTERN = /^pay_[A-Za-z0-9_-]{22}$/;

const PAYMENT_TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// 'pay_' + 22 url-safe chars from a CSPRNG. 256 % 64 === 0, so masking a
// random byte down to 6 bits picks alphabet characters without modulo bias.
function newPaymentToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(22));
  let token = "pay_";
  for (const byte of bytes) token += PAYMENT_TOKEN_ALPHABET[byte & 63];
  return token;
}

function isExpired(expiresAt: string | null): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() < Date.now();
}

// ============================================================
// Public: /pay/$token page data (no auth)
// ============================================================

export type PublicPaymentErrorCode = "invalid" | "revoked" | "expired" | "temporary_unavailable";

export type PublicPaymentData = {
  ok: true;
  token: string;
  firstName: string;
  caseCode: string | null;
  amount: number;
  currency: string;
  kind: string;
  paymentReference: string;
  alreadyPaid: boolean;
  revolutHandle: string | null;
  iban: string | null;
  accountName: string | null;
};

export type PublicPaymentResult =
  PublicPaymentData | { ok: false; errorCode: PublicPaymentErrorCode };

function firstNameOnly(fullName: string | null): string {
  const first = (fullName ?? "").trim().split(/\s+/)[0];
  return first || "there";
}

// Read-only: rendering the page must not log anything. Gmail's image proxy,
// Outlook SafeLinks and antivirus scanners all prefetch links, so the view
// signal is fired by a JS beacon from the page instead (see /pay/signal).
export const getPublicPayment = createServerFn({ method: "GET" })
  .inputValidator((d: { token: string }) => z.object({ token: z.string().max(128) }).parse(d))
  .handler(async ({ data }): Promise<PublicPaymentResult> => {
    const token = data.token.trim();
    if (!PAYMENT_TOKEN_PATTERN.test(token)) {
      return { ok: false, errorCode: "invalid" };
    }

    const { data: row, error } = await supabaseAdmin
      .from("payment_tokens")
      .select("*")
      .eq("token", token)
      .maybeSingle();

    if (error) {
      console.warn("[getPublicPayment] lookup failed", { message: error.message });
      return { ok: false, errorCode: "temporary_unavailable" };
    }
    if (!row) return { ok: false, errorCode: "invalid" };
    if (row.revoked_at) return { ok: false, errorCode: "revoked" };
    if (isExpired(row.expires_at)) return { ok: false, errorCode: "expired" };

    // First name only — no email, no address, no case history.
    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("full_name")
      .eq("id", row.client_id)
      .maybeSingle();
    if (clientError) {
      console.warn("[getPublicPayment] client lookup failed", { message: clientError.message });
      return { ok: false, errorCode: "temporary_unavailable" };
    }

    const paymentReference =
      row.note?.trim() || [row.case_code, row.kind].filter(Boolean).join(" ") || row.kind;

    const revolutHandle = process.env.MGT_REVOLUT_HANDLE ?? null;
    const iban = process.env.MGT_IBAN ?? null;
    const accountName = process.env.MGT_ACCOUNT_NAME ?? null;

    // No Revolut handle and no bank details means the client has no way to
    // pay. That is always misconfiguration on our side, never a client
    // problem, so it is an error rather than a warning. The page withholds
    // the payment section and the claim button in this state.
    if (!revolutHandle && !iban && !accountName) {
      console.error("[getPublicPayment] no payment method configured", {
        tokenPrefix: row.token.slice(0, 8),
        missing: ["MGT_REVOLUT_HANDLE", "MGT_IBAN", "MGT_ACCOUNT_NAME"],
      });
    }

    return {
      ok: true,
      token: row.token,
      firstName: firstNameOnly(client?.full_name ?? null),
      caseCode: row.case_code,
      amount: row.amount,
      currency: row.currency,
      kind: row.kind,
      paymentReference,
      alreadyPaid: !!row.paid_at,
      revolutHandle,
      iban,
      accountName,
    };
  });

// ============================================================
// Admin: mint, list and revoke payment tokens
// ============================================================

// Stages where money is plausible; used to filter the client picker.
export const PAYMENT_CLIENT_STAGES = ["Quoted", "Active", "Delivered"] as const;

export type PaymentClientOption = {
  id: string;
  case_code: string | null;
  client_code: string | null;
  full_name: string | null;
  stage: string | null;
  balance_due: number | null;
  // All read-only. quote_amount and balance_due are derived by database
  // triggers from sum(jobs.client_fee); deposit is written by confirm_payment()
  // and by nothing else. Nothing here ever writes any of the three.
  quote_amount: number | null;
  deposit: number | null;
};

export const listPaymentClients = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const { data, error } = await supabaseAdmin
      .from("clients")
      .select("id, case_code, client_code, full_name, stage, balance_due, quote_amount, deposit")
      .in("stage", [...PAYMENT_CLIENT_STAGES])
      .order("full_name", { ascending: true });
    if (error) {
      console.error("[listPaymentClients] query failed", { message: error.message });
      throw new Error("A database error occurred. Please try again.");
    }
    return { clients: (data ?? []) as PaymentClientOption[] };
  });

export const createPaymentToken = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator(
    (d: {
      clientId: string;
      amount: number;
      kind: PaymentKind;
      expiresInDays?: number;
      note?: string;
    }) =>
      z
        .object({
          clientId: z.string().uuid("Invalid client id"),
          amount: z
            .number()
            .positive("Amount must be greater than zero")
            .max(9_999_999_999, "Amount too large")
            .transform((v) => Math.round(v * 100) / 100),
          kind: z.enum(PAYMENT_KINDS),
          expiresInDays: z.number().int().min(1).max(365).optional(),
          note: z.string().trim().max(120).optional(),
        })
        .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: client, error: clientError } = await supabaseAdmin
      .from("clients")
      .select("id, case_code, full_name, quote_amount, deposit")
      .eq("id", data.clientId)
      .maybeSingle();
    if (clientError) {
      console.error("[createPaymentToken] client lookup failed", { message: clientError.message });
      throw new Error("A database error occurred. Please try again.");
    }
    if (!client) throw new Error("Client not found.");

    // Authoritative: unless the admin overrode it, the server builds the note.
    // It reaches the Revolut transaction record, so the case serial and the
    // label always survive the length cap. The label comes from the share of
    // the quote, deliberately not from `kind` — the two can disagree.
    const note =
      data.note ||
      buildPaymentNote({
        caseCode: client.case_code,
        fullName: client.full_name,
        amount: data.amount,
        quoteAmount: client.quote_amount,
        depositSoFar: client.deposit,
      });
    const token = newPaymentToken();
    const expiresAt = data.expiresInDays
      ? new Date(Date.now() + data.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const { error: insertError } = await supabaseAdmin.from("payment_tokens").insert({
      token,
      client_id: client.id,
      case_code: client.case_code,
      amount: data.amount,
      kind: data.kind,
      note,
      expires_at: expiresAt,
      created_by: context.userId,
    });
    if (insertError) {
      console.error("[createPaymentToken] insert failed", { message: insertError.message });
      throw new Error("Could not create the payment link. Please try again.");
    }

    return { token, note, expires_at: expiresAt };
  });

export type PaymentTokenStatus = "open" | "opened" | "claimed" | "revoked" | "expired" | "paid";

export type PaymentTokenSummary = {
  token: string;
  client_id: string;
  case_code: string | null;
  amount: number;
  currency: string;
  kind: string;
  note: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  paid_at: string | null;
  open_count: number;
  first_opened_at: string | null;
  last_opened_at: string | null;
  last_country: string | null;
  clientName: string | null;
  status: PaymentTokenStatus;
  lastClaimAt: string | null;
};

export const listPaymentTokens = createServerFn({ method: "GET" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ tokens: PaymentTokenSummary[] }> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: rows, error } = await supabaseAdmin
      .from("payment_tokens")
      .select("*, clients(full_name)")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) {
      console.error("[listPaymentTokens] query failed", { message: error.message });
      throw new Error("A database error occurred. Please try again.");
    }

    const tokens = (rows ?? []).map((r) => r.token);
    const lastClaimByToken = new Map<string, string>();
    if (tokens.length > 0) {
      const { data: claims, error: claimsError } = await supabaseAdmin
        .from("payment_signals")
        .select("token, seen_at")
        .eq("source", "portal_claim")
        .in("token", tokens)
        .order("seen_at", { ascending: false });
      if (claimsError) {
        // Claims only refine the status column; the list is still useful without them.
        console.warn("[listPaymentTokens] claims lookup failed", { message: claimsError.message });
      }
      for (const claim of claims ?? []) {
        if (claim.token && !lastClaimByToken.has(claim.token)) {
          lastClaimByToken.set(claim.token, claim.seen_at);
        }
      }
    }

    return {
      tokens: (rows ?? []).map((row) => {
        const lastClaimAt = lastClaimByToken.get(row.token) ?? null;
        const status: PaymentTokenStatus = row.paid_at
          ? "paid"
          : row.revoked_at
            ? "revoked"
            : isExpired(row.expires_at)
              ? "expired"
              : lastClaimAt
                ? "claimed"
                : row.open_count > 0
                  ? "opened"
                  : "open";
        return {
          token: row.token,
          client_id: row.client_id,
          case_code: row.case_code,
          amount: row.amount,
          currency: row.currency,
          kind: row.kind,
          note: row.note,
          created_at: row.created_at,
          expires_at: row.expires_at,
          revoked_at: row.revoked_at,
          paid_at: row.paid_at,
          open_count: row.open_count,
          first_opened_at: row.first_opened_at,
          last_opened_at: row.last_opened_at,
          last_country: row.last_country,
          clientName: row.clients?.full_name ?? null,
          status,
          lastClaimAt,
        };
      }),
    };
  });

export const revokePaymentToken = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().regex(PAYMENT_TOKEN_PATTERN, "Invalid token") }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });
    const { error } = await supabaseAdmin
      .from("payment_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token", data.token)
      .is("revoked_at", null);
    if (error) {
      console.error("[revokePaymentToken] update failed", { message: error.message });
      throw new Error("Could not revoke the payment link. Please try again.");
    }
    return { ok: true as const };
  });
