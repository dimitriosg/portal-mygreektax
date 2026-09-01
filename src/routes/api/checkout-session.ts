import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// POST /api/checkout-session
//
// Called by the browser on the /pay page. Takes a payment token and returns a
// Stripe Embedded Checkout client secret, so the card form renders inside our
// own page on pay.mygreektax.eu and the client never leaves the domain.
//
// AUTHORISATION MODEL, read this before changing anything.
//
// Unlike /webhooks/*, this route is called by the CLIENT's browser, so there is
// no shared secret to present. The payment token IS the credential: it is high
// entropy, it is already what gates the /pay page, and it is single purpose.
// That has one hard consequence, stated here because it is the only thing
// standing between this endpoint and a free money bug:
//
//   THE AMOUNT NEVER COMES FROM THE REQUEST BODY.
//
// The request supplies a token and nothing else that matters. Every figure is
// read from the database. If a future edit adds an amount, currency, price or
// line item that is read off `body`, that edit is a vulnerability, not a
// feature, because anyone holding a link could then pay one cent for an
// eight hundred euro job.
//
// The route fails closed on a missing STRIPE_SECRET_KEY. The lesson from
// /webhooks/conversation-log is that "ship it now, add the secret later" leaves
// no trace when the second half never happens, so a missing secret here is a
// loud 500 rather than a quiet fallback.

const STRIPE_API = "https://api.stripe.com/v1";
const PAYMENT_TOKEN_PATTERN = /^pay_[A-Za-z0-9_-]{22}$/;

// Lazy, request-time client creation, same pattern as /webhooks/conversation-log:
// nothing touches the environment at module load, so a missing variable returns
// readable JSON instead of taking the whole route module down.
let cachedClient: SupabaseClient | undefined;

function getSupabase(): { client: SupabaseClient } | { configError: string } {
  if (cachedClient) return { client: cachedClient };

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    const missing = [
      ...(!url ? ["SUPABASE_URL (or VITE_SUPABASE_URL)"] : []),
      ...(!key ? ["SUPABASE_SERVICE_ROLE_KEY"] : []),
    ];
    return {
      configError: `Missing environment variable(s): ${missing.join(", ")}. Set SUPABASE_URL in wrangler.jsonc vars and SUPABASE_SERVICE_ROLE_KEY as a Secret in the Cloudflare dashboard, then redeploy.`,
    };
  }

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { client: cachedClient };
}

function readString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function maskToken(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

// Euros to cents. Stripe works in the smallest currency unit and the database
// stores decimal euros, so every crossing of that boundary goes through here.
// Rounding rather than truncating, so 49.995 does not quietly become 49.99.
function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}

// Stripe's API is form-encoded, including nested structures, which it expects as
// bracketed keys: line_items[0][price_data][unit_amount]. There is no JSON body
// option, and no Stripe SDK here on purpose. The SDK would mean a dependency and
// a lockfile change, which is awkward from the GitHub web editor and buys
// nothing for two endpoints.
function encodeForm(obj: Record<string, unknown>, prefix = ""): string[] {
  const parts: string[] = [];
  for (const [rawKey, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const key = prefix ? `${prefix}[${rawKey}]` : rawKey;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === "object") {
          parts.push(...encodeForm(item as Record<string, unknown>, `${key}[${index}]`));
        } else {
          parts.push(
            `${encodeURIComponent(`${key}[${index}]`)}=${encodeURIComponent(String(item))}`,
          );
        }
      });
    } else if (typeof value === "object") {
      parts.push(...encodeForm(value as Record<string, unknown>, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts;
}

// Only the fields this route actually reads back. Deliberately narrow rather
// than `any`, so a typo in a field name is a compile error instead of undefined
// at three in the morning.
type StripeObject = {
  id?: string;
  client_secret?: string;
  error?: { message?: string };
};

type StripeResult =
  { ok: true; data: StripeObject } | { ok: false; status: number; message: string };

async function stripePost(
  path: string,
  secretKey: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<StripeResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers,
    body: encodeForm(payload).join("&"),
  });

  const data = (await response.json().catch(() => ({}))) as StripeObject;
  if (!response.ok) {
    const message = data.error?.message ?? `Stripe returned ${response.status}`;
    return { ok: false, status: response.status, message };
  }
  return { ok: true, data };
}

type TokenLine = {
  position: number;
  service_code: string | null;
  description: string;
  quantity: number;
  unit_amount: number;
};

export const Route = createFileRoute("/api/checkout-session")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const stripeKey = process.env.STRIPE_SECRET_KEY;
        if (!stripeKey) {
          console.error("[checkout-session] STRIPE_SECRET_KEY not configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        // Where Stripe sends the client back after the card form completes.
        // Embedded Checkout requires a return_url. Configurable so the sandbox
        // and a preview deployment can point somewhere other than production.
        const returnBase = process.env.PAY_RETURN_BASE_URL || "https://pay.mygreektax.eu";

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        if (typeof body !== "object" || body === null) {
          return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        const token = readString((body as Record<string, unknown>).token, 200);
        if (!token) {
          return Response.json({ error: "Token is required" }, { status: 400 });
        }
        if (!PAYMENT_TOKEN_PATTERN.test(token)) {
          return Response.json({ error: "Invalid token format" }, { status: 400 });
        }

        const supabaseResult = getSupabase();
        if ("configError" in supabaseResult) {
          console.error("[checkout-session] configuration error:", supabaseResult.configError);
          return Response.json(
            { error: "Server misconfigured", detail: supabaseResult.configError },
            { status: 500 },
          );
        }
        const supabase = supabaseResult.client;

        try {
          const { data: tokenRow, error: tokenError } = await supabase
            .from("payment_tokens")
            .select(
              "token, client_id, case_code, amount, currency, kind, note, method, expires_at, revoked_at, paid_at",
            )
            .eq("token", token)
            .maybeSingle();

          if (tokenError) {
            throw new Error(`token lookup failed: ${tokenError.message}`);
          }

          // Every rejection below returns the same shape and deliberately does
          // not say which check failed in a way that helps someone probing
          // tokens. The reason code is for our own page copy, not a hint.
          if (!tokenRow) {
            console.warn("[checkout-session] unknown token");
            return Response.json(
              { error: "This payment link is not valid", reason: "unknown" },
              { status: 404 },
            );
          }
          if (tokenRow.revoked_at) {
            return Response.json(
              { error: "This payment link has been cancelled", reason: "revoked" },
              { status: 409 },
            );
          }
          if (tokenRow.paid_at) {
            return Response.json(
              { error: "This payment has already been made", reason: "paid" },
              { status: 409 },
            );
          }
          if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
            return Response.json(
              { error: "This payment link has expired", reason: "expired" },
              { status: 409 },
            );
          }
          if (tokenRow.method !== "stripe") {
            // A Revolut or bank token must not be payable by card here. The
            // /pay page renders the claim flow for those, and reaching this
            // endpoint with one means the page and the token disagree.
            console.warn("[checkout-session] non-stripe token reached card checkout", {
              method: tokenRow.method,
            });
            return Response.json(
              { error: "This payment link is not a card payment", reason: "method" },
              { status: 409 },
            );
          }

          const currency = (tokenRow.currency ?? "EUR").toLowerCase();

          const { data: lineRows, error: linesError } = await supabase
            .from("payment_token_lines")
            .select("position, service_code, description, quantity, unit_amount")
            .eq("token", token)
            .order("position", { ascending: true });

          if (linesError) {
            throw new Error(`line lookup failed: ${linesError.message}`);
          }

          const lines = (lineRows ?? []) as TokenLine[];
          const tokenAmount = Number(tokenRow.amount);
          const tokenAmountMinor = toMinorUnits(tokenAmount);
          if (
            !Number.isFinite(tokenAmount) ||
            Math.abs(tokenAmount * 100 - tokenAmountMinor) > 0.000001
          ) {
            console.error("[checkout-session] invalid token amount precision", {
              amount: tokenRow.amount,
            });
            return Response.json(
              { error: "This payment link is not valid", reason: "amount" },
              { status: 409 },
            );
          }

          const normalizedLines: Array<TokenLine & { unit_amount_minor: number }> = [];
          for (const line of lines) {
            const quantity = Number(line.quantity);
            const unitAmount = Number(line.unit_amount);
            const unitAmountMinor = toMinorUnits(unitAmount);

            if (!Number.isInteger(quantity) || quantity <= 0) {
              console.error("[checkout-session] invalid line quantity", {
                position: line.position,
                quantity: line.quantity,
              });
              return Response.json(
                { error: "This payment link is not valid", reason: "amount" },
                { status: 409 },
              );
            }
            if (
              !Number.isFinite(unitAmount) ||
              Math.abs(unitAmount * 100 - unitAmountMinor) > 0.000001
            ) {
              console.error("[checkout-session] invalid line amount precision", {
                position: line.position,
                unit_amount: line.unit_amount,
              });
              return Response.json(
                { error: "This payment link is not valid", reason: "amount" },
                { status: 409 },
              );
            }

            normalizedLines.push({
              ...line,
              quantity,
              unit_amount_minor: unitAmountMinor,
            });
          }

          // Stripe will not accept a negative unit_amount, so a discount line
          // cannot be sent as a line item. Positive lines become line items and
          // the negatives are summed into a single one-off amount_off coupon.
          // That is Stripe's own idiom for this and it keeps the discount
          // visible on the client's receipt rather than silently folded into a
          // smaller price.
          const positiveLines = normalizedLines.filter((line) => line.unit_amount_minor > 0);
          const discountTotal = normalizedLines
            .filter((line) => line.unit_amount_minor < 0)
            .reduce((sum, line) => sum + Math.abs(line.unit_amount_minor) * line.quantity, 0);

          const lineItems =
            positiveLines.length > 0
              ? positiveLines.map((line) => ({
                  quantity: line.quantity,
                  price_data: {
                    currency,
                    unit_amount: line.unit_amount_minor,
                    product_data: {
                      name: line.service_code
                        ? `${line.service_code} · ${line.description}`
                        : line.description,
                      metadata: {
                        service_code: line.service_code ?? "",
                      },
                    },
                  },
                }))
              : // No lines recorded: fall back to the single figure on the token.
                // This is how the thirteen pre-existing tokens behave and it
                // stays valid for a quick one-off request.
                [
                  {
                    quantity: 1,
                    price_data: {
                      currency,
                      unit_amount: tokenAmountMinor,
                      product_data: {
                        name:
                          tokenRow.note ??
                          `MyGreekTax ${tokenRow.kind === "balance" ? "balance" : "deposit"}${
                            tokenRow.case_code ? ` · ${tokenRow.case_code}` : ""
                          }`,
                      },
                    },
                  },
                ];

          const grossTotal = lineItems.reduce(
            (sum, item) => sum + item.price_data.unit_amount * item.quantity,
            0,
          );
          const netTotal = grossTotal - discountTotal;

          if (netTotal <= 0) {
            console.error("[checkout-session] refusing a non-positive total", { netTotal });
            return Response.json(
              { error: "This payment link is not valid", reason: "amount" },
              { status: 409 },
            );
          }

          // Sanity check against the cached total on the token. The trigger on
          // payment_token_lines keeps payment_tokens.amount in step, so a
          // mismatch means something wrote around it and the safe move is to
          // refuse rather than charge a figure nobody agreed to.
          const expectedTotal = tokenAmountMinor;
          if (lines.length > 0 && netTotal !== expectedTotal) {
            console.error("[checkout-session] line total does not match token amount", {
              netTotal,
              expectedTotal,
            });
            return Response.json(
              { error: "This payment link is not valid", reason: "mismatch" },
              { status: 409 },
            );
          }

          // Client email, so Stripe's receipt reaches the right person and the
          // form does not ask them to retype an address we already hold.
          const { data: clientRow } = await supabase
            .from("clients")
            .select("email, full_name")
            .eq("id", tokenRow.client_id)
            .maybeSingle();

          // One coupon per discounted token, created fresh. Keyed idempotently
          // so a double click does not leave a trail of identical coupons.
          let couponId: string | undefined;
          if (discountTotal > 0) {
            const coupon = await stripePost(
              "/coupons",
              stripeKey,
              {
                amount_off: discountTotal,
                currency,
                duration: "once",
                name: "Discount",
                metadata: { payment_token: token },
              },
              `coupon:${token}:${discountTotal}`,
            );
            if (!coupon.ok) {
              console.error("[checkout-session] coupon creation failed", coupon.message);
              throw new Error(`coupon creation failed: ${coupon.message}`);
            }
            couponId = coupon.data.id;
          }

          const serviceCodes = lines
            .map((line) => line.service_code)
            .filter((code): code is string => Boolean(code))
            .join(",");

          // Metadata is what n8n reads back off the webhook to find the token,
          // so it is carried on both the session and the payment intent. The
          // payment intent copy is the one that survives onto the charge.
          const metadata = {
            payment_token: token,
            case_code: tokenRow.case_code ?? "",
            client_id: tokenRow.client_id,
            kind: tokenRow.kind,
            service_codes: serviceCodes,
          };

          const session = await stripePost(
            "/checkout/sessions",
            stripeKey,
            {
              ui_mode: "embedded_page",
              mode: "payment",
              return_url: `${returnBase}/done?session_id={CHECKOUT_SESSION_ID}`,
              line_items: lineItems,
              discounts: couponId ? [{ coupon: couponId }] : undefined,
              customer_email: clientRow?.email ?? undefined,
              client_reference_id: tokenRow.case_code ?? token,
              metadata,
              payment_intent_data: {
                metadata,
                description: tokenRow.case_code
                  ? `MyGreekTax ${tokenRow.case_code}`
                  : "MyGreekTax services",
              },
            },
            // Same token and same total returns the same session rather than a
            // new one, so refreshing the pay page does not litter the dashboard.
            `session:${token}:${netTotal}`,
          );

          if (!session.ok) {
            console.error("[checkout-session] session creation failed", session.message);
            return Response.json(
              { error: "Could not start the payment", detail: session.message },
              { status: 502 },
            );
          }

          console.log("[checkout-session] session created", {
            token: maskToken(token),
            case_code: tokenRow.case_code,
            net_total: netTotal,
            lines: lines.length,
            discounted: Boolean(couponId),
          });

          // Only the client secret goes back. No amounts, no ids, nothing the
          // page did not already know.
          return Response.json({ clientSecret: session.data.client_secret });
        } catch (error) {
          console.error("[checkout-session] failed", { error });
          return Response.json(
            {
              error: "Could not start the payment",
              detail: error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          );
        }
      },
    },
  },
});
