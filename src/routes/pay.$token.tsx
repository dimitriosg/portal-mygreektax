import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  getPublicPayment,
  type PublicPaymentData,
  type PublicPaymentErrorCode,
  type PublicPaymentResult,
} from "@/lib/payments.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Check, Copy, ExternalLink, Landmark, ShieldCheck } from "lucide-react";
import logo from "@/assets/mygreektax-mark.svg";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/pay/$token")({
  // Read-only render: the view signal is fired by a JS beacon below, never by
  // this loader — Gmail's image proxy, Outlook SafeLinks and antivirus
  // scanners all prefetch links and would otherwise log a view on every send.
  loader: async ({ params }): Promise<PublicPaymentResult> => {
    try {
      return await getPublicPayment({ data: { token: params.token } });
    } catch {
      return { ok: false, errorCode: "temporary_unavailable" };
    }
  },
  pendingComponent: LoadingState,
  component: PayPage,
  head: () => ({
    meta: [
      { title: "Payment · MyGreekTax" },
      { name: "description", content: "Secure payment details for your MyGreekTax service." },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { httpEquiv: "Cache-Control", content: "no-store, no-cache, max-age=0, must-revalidate" },
      { httpEquiv: "Pragma", content: "no-cache" },
      { httpEquiv: "Expires", content: "0" },
    ],
  }),
});

// Fire-and-forget. A lost view signal costs us a statistic, so it must never
// surface to the client or delay the page.
function postViewSignal(token: string) {
  return fetch("/pay/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, source: "portal_view" }),
    keepalive: true,
  }).catch(() => undefined);
}

const CLAIM_RETRY_DELAY_MS = 1500;

// The claim is the whole point of this page, so unlike the view it is awaited
// and retried once. A claim that never lands must be reported to the client
// rather than silently swallowed — nothing else records that they said they
// paid. n8n deduplicates repeat claims, so a retry is free.
async function postClaimSignal(token: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_DELAY_MS));
    }
    try {
      const res = await fetch("/pay/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, source: "portal_claim" }),
        keepalive: true,
      });
      if (res.ok) return true;
    } catch {
      // Offline or DNS failure — fall through to the retry, then to the
      // honest failure state.
    }
  }
  return false;
}

// Tokens this browser session already reported a view for. Module-level so
// StrictMode double-mounts and route remounts still fire exactly one beacon.
const viewedTokens = new Set<string>();

// ============================================================
// Stripe.js
// ============================================================

// Loaded from Stripe's own domain rather than bundled. That is not a
// preference: Stripe requires it for PCI compliance, because the file
// self-updates and a vendored copy would go stale. It also keeps
// @stripe/stripe-js out of package.json, which matters here because the whole
// repo is edited through the GitHub web UI and a lockfile change is painful.
const STRIPE_JS_SRC = "https://js.stripe.com/v3/";

type EmbeddedCheckoutInstance = {
  mount: (target: HTMLElement) => void;
  destroy: () => void;
};

type StripeInstance = {
  initEmbeddedCheckout: (options: {
    fetchClientSecret: () => Promise<string>;
  }) => Promise<EmbeddedCheckoutInstance>;
};

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeInstance;
  }
}

// One promise for the whole page load, so a remount reuses the script already
// in the head instead of injecting a second tag.
let stripeJsPromise: Promise<void> | null = null;

function loadStripeJs(): Promise<void> {
  if (stripeJsPromise) return stripeJsPromise;

  stripeJsPromise = new Promise<void>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Stripe.js needs a browser"));
      return;
    }
    if (window.Stripe) {
      resolve();
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${STRIPE_JS_SRC}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      // Let a later attempt retry rather than caching the failure forever.
      stripeJsPromise = null;
      reject(new Error("Stripe.js failed to load"));
    });

    if (!existing) {
      script.src = STRIPE_JS_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
  });

  return stripeJsPromise;
}

function PayPage() {
  const data = Route.useLoaderData();

  useEffect(() => {
    if (!data?.ok || data.alreadyPaid) return;
    if (viewedTokens.has(data.token)) return;
    viewedTokens.add(data.token);
    void postViewSignal(data.token);
  }, [data]);

  return (
    <div className="min-h-screen" style={{ background: "var(--gradient-hero)" }}>
      <BrandHeader />
      <main className="mx-auto max-w-xl px-4 pb-16 pt-6 sm:pt-10">
        {data && !data.ok && <ErrorState errorCode={data.errorCode} />}
        {data?.ok && data.alreadyPaid && <AlreadyPaidState data={data} />}
        {data?.ok && !data.alreadyPaid && <PayContent data={data} />}
      </main>
      <footer className="mx-auto max-w-xl px-4 pb-8 text-center text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          Secure payment link · MyGreekTax
        </span>
      </footer>
    </div>
  );
}

function BrandHeader() {
  return (
    <header className="border-b border-border/40 bg-background/40 backdrop-blur-sm">
      <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-4">
        <div className="flex items-center gap-2.5">
          <img src={logo} alt="MyGreekTax" width={36} height={36} className="h-9 w-9 rounded-md" />
          <span className="font-serif text-lg font-semibold tracking-tight">
            <span className="text-olive">My</span>
            <span className="italic">Greek</span>
            <span className="text-brand">Tax</span>
          </span>
        </div>
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Payment
        </span>
      </div>
    </header>
  );
}

function LoadingState() {
  return (
    <div className="mx-auto max-w-xl space-y-6 px-4 pt-6 sm:pt-10">
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-3/4" />
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}

// A stranger who guesses a token must learn nothing: every failure state is
// the same neutral card with only the retry hint varying.
function ErrorState({ errorCode }: { errorCode: PublicPaymentErrorCode }) {
  const message =
    errorCode === "expired"
      ? "This payment link has expired. Please contact MyGreekTax for a new link."
      : errorCode === "revoked"
        ? "This payment link is no longer available. Please contact MyGreekTax for a new link."
        : errorCode === "temporary_unavailable"
          ? "This payment page is temporarily unavailable. Please try again in a few minutes."
          : "This payment link is invalid. Please contact MyGreekTax if you believe this is a mistake.";

  return (
    <Card className="border-border/60">
      <CardContent className="py-10 text-center">
        <h1 className="text-xl font-semibold">Link not available</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

function AlreadyPaidState({ data }: { data: PublicPaymentData }) {
  return (
    <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
      <CardContent className="py-10 text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
          <Check className="h-6 w-6 text-success" strokeWidth={3} />
        </span>
        <h1 className="mt-4 text-xl font-semibold">This payment is complete</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Thank you, {data.firstName} — we have already received{" "}
          {formatAmount(data.amount, data.currency)}
          {data.caseCode ? <> for {data.caseCode}</> : null}. Nothing more to do here.
        </p>
      </CardContent>
    </Card>
  );
}

function formatAmount(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function PayContent({ data }: { data: PublicPaymentData }) {
  const kindLabel =
    data.kind === "deposit" ? "Deposit" : data.kind === "balance" ? "Balance" : "Payment";

  const isCard = data.method === "stripe";

  // Whether there is any way at all for this client to pay. What that requires
  // depends on the method, but the failure is the same in both cases: our
  // configuration, not theirs. getPublicPayment logs it server-side.
  const canPay = isCard ? !!data.stripePublishableKey : !!data.revolutHandle || hasBank(data);

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        {data.caseCode && (
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            {data.caseCode}
          </div>
        )}
        <h1 className="font-serif text-3xl font-medium tracking-tight sm:text-[2.5rem] sm:leading-[1.1]">
          Hello <span className="italic">{data.firstName}</span>
        </h1>
        {canPay && (
          <p className="text-sm text-muted-foreground sm:text-base">
            {isCard
              ? `Pay your ${kindLabel.toLowerCase()} securely by card below.`
              : `Here is how to pay your ${kindLabel.toLowerCase()} to MyGreekTax.`}
          </p>
        )}
      </section>

      <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
        <CardContent className="p-5 sm:p-7">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {kindLabel} due
          </div>
          <div className="mt-1 font-serif text-4xl font-medium tabular-nums tracking-tight">
            {formatAmount(data.amount, data.currency)}
          </div>
          {/* Only meaningful when the client has to type it into a transfer.
              On the card path Stripe matches the payment for us, and showing a
              reference invites them to think they must do something with it. */}
          {!isCard && (
            <div className="mt-2 text-sm text-muted-foreground">
              Payment reference:{" "}
              <span className="font-medium text-foreground">{data.paymentReference}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {!canPay && <PaymentMethodsUnavailable />}

      {canPay && (isCard ? <CardPayment data={data} /> : <ManualPayment data={data} />)}
    </div>
  );
}

function hasBank(data: PublicPaymentData) {
  return !!(data.iban || data.accountName);
}

// Revolut and bank transfer: we show the details, the client pays elsewhere,
// and tells us they did. Unchanged behaviour, just lifted out of PayContent so
// the card path can sit beside it.
function ManualPayment({ data }: { data: PublicPaymentData }) {
  // Built fresh on each render. Revolut takes the amount in minor units
  // (15000 means €150.00) and truncates the note around 64 characters, which
  // is why the case reference comes first in it.
  const revolutUrl = data.revolutHandle
    ? `https://revolut.me/${data.revolutHandle}?currency=${encodeURIComponent(
        data.currency,
      )}&amount=${Math.round(data.amount * 100)}&note=${encodeURIComponent(data.paymentReference)}`
    : null;

  return (
    <>
      {revolutUrl && (
        <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
          <CardContent className="space-y-3 p-5 sm:p-7">
            <h2 className="font-serif text-lg font-medium">Pay with Revolut</h2>
            <p className="text-sm text-muted-foreground">
              Fastest option — the amount and reference are prefilled.
            </p>
            <Button asChild className="w-full" size="lg">
              <a href={revolutUrl} target="_blank" rel="noopener noreferrer">
                Open Revolut
                <ExternalLink className="ml-2 h-4 w-4" />
              </a>
            </Button>
          </CardContent>
        </Card>
      )}

      {hasBank(data) && (
        <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
          <CardContent className="space-y-4 p-5 sm:p-7">
            <h2 className="flex items-center gap-2 font-serif text-lg font-medium">
              <Landmark className="h-4 w-4 text-brand" />
              Pay by bank transfer
            </h2>
            <div className="space-y-3">
              {data.iban && <CopyRow label="IBAN" value={data.iban} />}
              {data.accountName && <CopyRow label="Account name" value={data.accountName} />}
              <CopyRow label="Payment reference" value={data.paymentReference} />
            </div>
            <p className="text-xs text-muted-foreground">
              Please include the payment reference so we can match your transfer right away.
            </p>
          </CardContent>
        </Card>
      )}

      <ClaimCard token={data.token} />
    </>
  );
}

type CheckoutState = "loading" | "ready" | "failed";

// Stripe Embedded Checkout, mounted into our own page on pay.mygreektax.eu.
//
// There is deliberately no claim button here. A card payment confirms itself
// through the Stripe webhook, so asking the client to also tell us they paid
// would produce a second, unreliable source of truth for the same event.
function CardPayment({ data }: { data: PublicPaymentData }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<CheckoutState>("loading");
  const publishableKey = data.stripePublishableKey;
  const token = data.token;

  useEffect(() => {
    // PayContent will not render this without a key, so reaching here means
    // something upstream changed. Fail visibly rather than sitting on a
    // skeleton forever, which looks like a slow network and invites the
    // client to wait for something that is never coming.
    if (!publishableKey) {
      setState("failed");
      return;
    }

    let cancelled = false;
    let checkout: EmbeddedCheckoutInstance | undefined;

    async function mountCheckout(key: string) {
      try {
        await loadStripeJs();
        if (cancelled) return;

        const stripe = window.Stripe?.(key);
        if (!stripe) throw new Error("Stripe.js loaded but window.Stripe is missing");

        checkout = await stripe.initEmbeddedCheckout({
          // Stripe calls this itself and expects the raw secret back. Note
          // what is NOT sent: no amount, no currency, no line items. The
          // endpoint reads every figure from the database against this token,
          // which is the one property keeping this page from being a way to
          // pay one cent for an eight hundred euro job.
          fetchClientSecret: async () => {
            const res = await fetch("/api/checkout-session", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
            });
            const body = (await res.json().catch(() => ({}))) as {
              clientSecret?: string;
              error?: string;
            };
            if (!res.ok || !body.clientSecret) {
              throw new Error(body.error ?? `Checkout session failed (${res.status})`);
            }
            return body.clientSecret;
          },
        });

        // The await above can outlive the component: a StrictMode double
        // mount, or a client who navigates away while Stripe is still
        // starting. Mounting a dead instance leaves an orphan iframe that
        // blocks the next one, so bail and clean up instead.
        if (cancelled || !containerRef.current) {
          checkout.destroy();
          return;
        }

        checkout.mount(containerRef.current);
        setState("ready");
      } catch (error) {
        if (cancelled) return;
        console.error("[pay] embedded checkout failed to start", error);
        setState("failed");
      }
    }

    void mountCheckout(publishableKey);

    return () => {
      cancelled = true;
      checkout?.destroy();
    };
  }, [publishableKey, token]);

  if (state === "failed") {
    return (
      <Card className="border-warning/40 bg-warning/5" style={{ boxShadow: "var(--shadow-soft)" }}>
        <CardContent className="flex items-start gap-3 p-5 sm:p-7">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          <div>
            <h2 className="font-serif text-lg font-medium">The card form didn't load</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Please refresh the page and try again. If it still doesn't appear, contact MyGreekTax
              and we'll send you another way to pay.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
      <CardContent className="p-4 sm:p-6">
        {state === "loading" && (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {/* Always rendered, because Stripe needs a real node to mount into
            before there is anything to show. Hidden rather than conditional. */}
        <div ref={containerRef} className={cn(state !== "ready" && "hidden")} />
      </CardContent>
    </Card>
  );
}

// Shown only when the Worker has no Revolut handle and no bank details, i.e.
// misconfiguration. Deliberately carries no claim button.
function PaymentMethodsUnavailable() {
  return (
    <Card className="border-warning/40 bg-warning/5" style={{ boxShadow: "var(--shadow-soft)" }}>
      <CardContent className="flex items-start gap-3 p-5 sm:p-7">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div>
          <h2 className="font-serif text-lg font-medium">Payment details coming shortly</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            We're finalising the payment details for this link. Please contact MyGreekTax and we'll
            sort it out right away.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

type ClaimState = "idle" | "sending" | "sent" | "failed";

function ClaimCard({ token }: { token: string }) {
  const [claimState, setClaimState] = useState<ClaimState>("idle");

  return (
    <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
      <CardContent className="space-y-3 p-5 sm:p-7">
        {claimState === "sent" && (
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success/10">
              <Check className="h-4 w-4 text-success" strokeWidth={3} />
            </span>
            <div>
              <div className="font-medium">Thanks — we'll confirm shortly.</div>
              <p className="mt-1 text-sm text-muted-foreground">
                We've been notified and will confirm your payment as soon as it arrives.
              </p>
            </div>
          </div>
        )}

        {claimState === "failed" && (
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div>
              <div className="font-medium">We couldn't reach our system.</div>
              <p className="mt-1 text-sm text-muted-foreground">
                Please pay as normal and email us so we can confirm — your payment details above are
                still correct.
              </p>
            </div>
          </div>
        )}

        {(claimState === "idle" || claimState === "sending") && (
          <>
            <p className="text-sm text-muted-foreground">
              Done? Let us know so we can look out for your payment.
            </p>
            <Button
              variant="outline"
              className="w-full"
              size="lg"
              disabled={claimState === "sending"}
              onClick={async () => {
                // Disabled from the first tap, so exactly one claim is sent.
                setClaimState("sending");
                const delivered = await postClaimSignal(token);
                setClaimState(delivered ? "sent" : "failed");
              }}
            >
              {claimState === "sending" ? "Sending…" : "I've paid"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/60 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="truncate font-mono text-sm font-medium">{value}</div>
      </div>
      <Button
        size="sm"
        variant="ghost"
        className={cn("shrink-0", copied && "text-success")}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            // Clipboard can be unavailable (permissions, http) — leave the value visible.
          }
        }}
      >
        {copied ? (
          <>
            <Check className="mr-1 h-3.5 w-3.5" /> Copied
          </>
        ) : (
          <>
            <Copy className="mr-1 h-3.5 w-3.5" /> Copy
          </>
        )}
      </Button>
    </div>
  );
}
