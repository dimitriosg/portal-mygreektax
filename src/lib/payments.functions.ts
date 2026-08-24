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
      currency?: string;
      regeneratedFromToken?: string;
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
          // Not a form field — the column defaults to EUR and every row is EUR
          // today. It exists so a reissue carries the original token's currency
          // rather than silently resetting it to the default.
          currency: z.string().trim().length(3).toUpperCase().optional(),
          // Set when this mint replaces an existing token at a corrected
          // amount: payment_tokens.regenerated_from_token exists for exactly
          // this, so "I picked the wrong figure" never becomes an in-place
          // edit of a link that may already be in the client's inbox.
          regeneratedFromToken: z.string().regex(PAYMENT_TOKEN_PATTERN).optional(),
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
      regenerated_from_token: data.regeneratedFromToken ?? null,
      ...(data.currency ? { currency: data.currency } : {}),
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
  regenerated_from_token: string | null;
  // The confirmed payment this token resolved to, when it has one. Correcting
  // an amount needs the payment id, not the token: confirm_payment books the
  // token's amount into `payments`, and that row is what gets corrected.
  payment: { id: string; amount: number; currency: string; status: string } | null;
  // True when the payments lookup itself failed, as distinct from finding
  // nothing. A paid row with no payment and no explanation is indistinguishable
  // from a row that is meant to have no actions.
  paymentLookupFailed: boolean;
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
    const paymentByToken = new Map<
      string,
      { id: string; amount: number; currency: string; status: string }
    >();
    let paymentLookupFailed = false;
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

      // Confirmed rows only, newest first. payments.token has no unique index —
      // only payments_external_id_key, which the manual path satisfies with
      // 'manual:' || token — so a second writer (a bank import matching to a
      // token under a different external_id) could produce a second row. With
      // first-row-wins below, an unordered query would then hand an arbitrary
      // payment id to correct_payment. Ordering makes it the newest confirmed
      // payment, which is well defined.
      const { data: payments, error: paymentsError } = await supabaseAdmin
        .from("payments")
        .select("id, token, amount, currency, status")
        .in("token", tokens)
        .eq("status", "confirmed")
        .order("received_at", { ascending: false });
      if (paymentsError) {
        // Not fatal: the list must still render. But the row has to be able to
        // say why its action is missing, or a transient failure looks exactly
        // like a row that is meant to have no actions.
        console.warn("[listPaymentTokens] payments lookup failed", {
          message: paymentsError.message,
        });
        paymentLookupFailed = true;
      }
      for (const payment of payments ?? []) {
        if (payment.token && !paymentByToken.has(payment.token)) {
          paymentByToken.set(payment.token, {
            id: payment.id,
            amount: payment.amount,
            currency: payment.currency,
            status: payment.status,
          });
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
          regenerated_from_token: row.regenerated_from_token,
          payment: paymentByToken.get(row.token) ?? null,
          paymentLookupFailed,
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

// ============================================================
// Admin: confirm, edit and correct
//
// confirm_payment and correct_payment both RETURN a row rather than throwing:
// `applied: false` with a `reason` is an expected outcome — a stale click on a
// page that has moved on — not an error. Both are reached only through
// supabaseAdmin, the service-role client, behind requireAdminAccess. Nothing
// on the public /pay/$token page can touch either.
// ============================================================

export type ConfirmPaymentReason = "confirmed" | "already_paid" | "revoked" | "unknown_token";

export type ConfirmPaymentResult = {
  applied: boolean;
  reason: ConfirmPaymentReason | string;
  paymentId: string | null;
  amount: number | null;
  currency: string | null;
  caseCode: string | null;
  stageBefore: string | null;
  stageAfter: string | null;
  deposit: number | null;
  balanceDue: number | null;
};

export const confirmPaymentToken = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { token: string }) =>
    z.object({ token: z.string().regex(PAYMENT_TOKEN_PATTERN, "Invalid token") }).parse(d),
  )
  .handler(async ({ data, context }): Promise<ConfirmPaymentResult> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: rows, error } = await supabaseAdmin.rpc("confirm_payment", {
      p_token: data.token,
    });
    if (error) {
      console.error("[confirmPaymentToken] rpc failed", { message: error.message });
      throw new Error("Could not confirm the payment. Please try again.");
    }
    const row = rows?.[0];
    if (!row) throw new Error("Could not confirm the payment. Please try again.");

    return {
      applied: row.applied,
      reason: row.reason,
      paymentId: row.payment_id,
      amount: row.amount,
      currency: row.currency,
      caseCode: row.case_code,
      stageBefore: row.stage_before,
      stageAfter: row.stage_after,
      deposit: row.deposit,
      balanceDue: row.balance_due,
    };
  });

// The note is display text and the Revolut deep-link only — it carries no
// financial semantics, so unlike the amount it is safe to edit in place. Still
// unpaid tokens only: once a payment is booked the note is part of the record.
export const updatePaymentTokenNote = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { token: string; note: string }) =>
    z
      .object({
        token: z.string().regex(PAYMENT_TOKEN_PATTERN, "Invalid token"),
        note: z.string().trim().min(1, "The note cannot be empty").max(120),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: updated, error } = await supabaseAdmin
      .from("payment_tokens")
      .update({ note: data.note })
      .eq("token", data.token)
      .is("paid_at", null)
      .select("token")
      .maybeSingle();
    if (error) {
      console.error("[updatePaymentTokenNote] update failed", { message: error.message });
      throw new Error("Could not save the note. Please try again.");
    }
    // No row came back: the token was paid (or vanished) between render and
    // submit. Report it as an outcome so the page can re-read, not as an error.
    if (!updated) return { ok: false as const, reason: "not_editable" as const };
    return { ok: true as const, note: data.note };
  });

export type CorrectPaymentReason =
  "corrected" | "unknown_payment" | "not_confirmed" | "invalid_amount" | "no_change";

export type CorrectPaymentResult = {
  applied: boolean;
  reason: CorrectPaymentReason | string;
  paymentId: string | null;
  oldAmount: number | null;
  newAmount: number | null;
  currency: string | null;
  caseCode: string | null;
  deposit: number | null;
  balanceDue: number | null;
};

// Corrects the amount booked against an already-confirmed payment. The
// function adjusts clients.deposit by the delta and deliberately does NOT
// touch clients.stage — a correction that changes whether a case should have
// crossed into Active is a human judgement, so nothing here re-evaluates it.
export const correctPaymentAmount = createServerFn({ method: "POST" })
  .middleware([attachSupabaseAuth, requireSupabaseAuth])
  .inputValidator((d: { paymentId: string; newAmount: number; reason: string }) =>
    z
      .object({
        paymentId: z.string().uuid("Invalid payment id"),
        newAmount: z
          .number()
          .positive("Amount must be greater than zero")
          .max(9_999_999_999, "Amount too large")
          .transform((v) => Math.round(v * 100) / 100),
        // The function takes p_reason as optional, but an audit row with a null
        // reason defeats the point of writing one, so it is required here.
        reason: z.string().trim().min(1, "A reason is required").max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<CorrectPaymentResult> => {
    await requireAdminAccess({
      userId: context.userId,
      email: context.claims.email as string | undefined,
    });

    const { data: rows, error } = await supabaseAdmin.rpc("correct_payment", {
      p_payment_id: data.paymentId,
      p_new_amount: data.newAmount,
      p_reason: data.reason,
    });
    if (error) {
      console.error("[correctPaymentAmount] rpc failed", { message: error.message });
      throw new Error("Could not correct the payment. Please try again.");
    }
    const row = rows?.[0];
    if (!row) throw new Error("Could not correct the payment. Please try again.");

    return {
      applied: row.applied,
      reason: row.reason,
      paymentId: row.payment_id,
      oldAmount: row.old_amount,
      newAmount: row.new_amount,
      currency: row.currency,
      caseCode: row.case_code,
      deposit: row.deposit,
      balanceDue: row.balance_due,
    };
  });
