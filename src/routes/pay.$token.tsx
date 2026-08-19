import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  getPublicPayment,
  type PublicPaymentData,
  type PublicPaymentErrorCode,
  type PublicPaymentResult,
} from "@/lib/payments.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Copy, ExternalLink, Landmark, ShieldCheck } from "lucide-react";
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

function postSignal(token: string, source: "portal_view" | "portal_claim") {
  // A failed signal must never break the page — fire and forget.
  return fetch("/pay/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, source }),
    keepalive: true,
  }).catch(() => undefined);
}

// Tokens this browser session already reported a view for. Module-level so
// StrictMode double-mounts and route remounts still fire exactly one beacon.
const viewedTokens = new Set<string>();

function PayPage() {
  const data = Route.useLoaderData();

  useEffect(() => {
    if (!data?.ok || data.alreadyPaid) return;
    if (viewedTokens.has(data.token)) return;
    viewedTokens.add(data.token);
    void postSignal(data.token, "portal_view");
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
  const [claimed, setClaimed] = useState(false);

  const kindLabel =
    data.kind === "deposit" ? "Deposit" : data.kind === "balance" ? "Balance" : "Payment";

  // Built fresh on each render. Revolut takes the amount in minor units
  // (15000 means €150.00) and truncates the note around 64 characters, which
  // is why the case reference comes first in it.
  const revolutUrl = data.revolutHandle
    ? `https://revolut.me/${data.revolutHandle}?currency=${encodeURIComponent(
        data.currency,
      )}&amount=${Math.round(data.amount * 100)}&note=${encodeURIComponent(data.paymentReference)}`
    : null;

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
        <p className="text-sm text-muted-foreground sm:text-base">
          Here is how to pay your {kindLabel.toLowerCase()} to MyGreekTax.
        </p>
      </section>

      <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
        <CardContent className="p-5 sm:p-7">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {kindLabel} due
          </div>
          <div className="mt-1 font-serif text-4xl font-medium tabular-nums tracking-tight">
            {formatAmount(data.amount, data.currency)}
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            Payment reference:{" "}
            <span className="font-medium text-foreground">{data.paymentReference}</span>
          </div>
        </CardContent>
      </Card>

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

      {(data.iban || data.accountName) && (
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

      <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
        <CardContent className="space-y-3 p-5 sm:p-7">
          {claimed ? (
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
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Done? Let us know so we can look out for your payment.
              </p>
              <Button
                variant="outline"
                className="w-full"
                size="lg"
                onClick={() => {
                  // Disable immediately; n8n deduplicates repeat claims anyway.
                  setClaimed(true);
                  void postSignal(data.token, "portal_claim");
                }}
              >
                I've paid
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
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
