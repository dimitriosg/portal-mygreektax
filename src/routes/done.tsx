import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Check, Clock, ShieldCheck } from "lucide-react";
import logo from "@/assets/mygreektax-mark.svg";

// The page Stripe returns the client to after the embedded card form, set as
// return_url when the Checkout Session is created. The URL carries a
// session_id, which we hand to /api/checkout-status to find out what happened.
//
// This page reports. It does not confirm. Nothing here writes to our database,
// because a client who pays and then closes the tab never arrives, and a
// confirmation that only fires when someone looks at it is not a
// confirmation. The Stripe webhook is what marks a token paid.
//
// It lives at /done rather than /pay/done because that is the path already
// baked into the return_url of every session Stripe has issued.

export const Route = createFileRoute("/done")({
  component: DonePage,
  head: () => ({
    meta: [
      { title: "Payment · MyGreekTax" },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { httpEquiv: "Cache-Control", content: "no-store, no-cache, max-age=0, must-revalidate" },
    ],
  }),
});

type StatusResult =
  | { state: "checking" }
  | { state: "paid"; email: string | null }
  | { state: "processing"; email: string | null }
  | { state: "incomplete" }
  | { state: "error" };

function DonePage() {
  const [result, setResult] = useState<StatusResult>({ state: "checking" });

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Read from the live URL rather than route search params: Stripe
      // substitutes {CHECKOUT_SESSION_ID} itself, so this is a plain redirect
      // from their domain and not a navigation we control.
      const sessionId = new URLSearchParams(window.location.search).get("session_id");
      if (!sessionId) {
        setResult({ state: "error" });
        return;
      }

      try {
        const res = await fetch(`/api/checkout-status?session_id=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error(`status lookup failed (${res.status})`);
        const body = (await res.json()) as {
          status?: string;
          paymentStatus?: string;
          email?: string | null;
        };
        if (cancelled) return;

        const email = body.email ?? null;
        if (body.status === "complete") {
          // A card clears immediately. Klarna and other delayed methods can
          // finish the session while the money is still in flight, and
          // telling that client "payment received" would be a lie we might
          // have to take back.
          setResult(
            body.paymentStatus === "paid"
              ? { state: "paid", email }
              : { state: "processing", email },
          );
          return;
        }
        setResult({ state: "incomplete" });
      } catch (error) {
        if (cancelled) return;
        console.error("[done] could not check payment status", error);
        setResult({ state: "error" });
      }
    }

    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen" style={{ background: "var(--gradient-hero)" }}>
      <header className="border-b border-border/40 bg-background/40 backdrop-blur-sm">
        <div className="mx-auto flex max-w-xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-2.5">
            <img
              src={logo}
              alt="MyGreekTax"
              width={36}
              height={36}
              className="h-9 w-9 rounded-md"
            />
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

      <main className="mx-auto max-w-xl px-4 pb-16 pt-6 sm:pt-10">
        <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
          <CardContent className="py-10 text-center">
            <StatusBody result={result} />
          </CardContent>
        </Card>
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

function StatusBody({ result }: { result: StatusResult }) {
  if (result.state === "checking") {
    return (
      <div className="mx-auto max-w-sm space-y-3">
        <Skeleton className="mx-auto h-12 w-12 rounded-full" />
        <Skeleton className="mx-auto h-6 w-48" />
        <Skeleton className="mx-auto h-4 w-64" />
      </div>
    );
  }

  if (result.state === "paid") {
    return (
      <>
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success/10">
          <Check className="h-6 w-6 text-success" strokeWidth={3} />
        </span>
        <h1 className="mt-4 text-xl font-semibold">Payment received</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Thank you. Your payment went through
          {result.email ? <> and a receipt is on its way to {result.email}</> : null}. There is
          nothing else you need to do.
        </p>
      </>
    );
  }

  if (result.state === "processing") {
    return (
      <>
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand/10">
          <Clock className="h-6 w-6 text-brand" />
        </span>
        <h1 className="mt-4 text-xl font-semibold">Payment in progress</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Thank you. Your payment is still being processed by your provider
          {result.email ? <>, and we'll email {result.email} once it clears</> : null}. This can
          take a little while. No need to pay again.
        </p>
      </>
    );
  }

  if (result.state === "incomplete") {
    return (
      <>
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-warning/10">
          <AlertCircle className="h-6 w-6 text-warning" />
        </span>
        <h1 className="mt-4 text-xl font-semibold">Payment not completed</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          Nothing was charged. You can go back to your payment link and try again, or contact
          MyGreekTax and we'll help.
        </p>
      </>
    );
  }

  // Either no session id in the URL, or Stripe could not be reached. The
  // client may well have paid, so this must never read as a failed payment.
  return (
    <>
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <AlertCircle className="h-6 w-6 text-muted-foreground" />
      </span>
      <h1 className="mt-4 text-xl font-semibold">We couldn't check this payment</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
        If you completed the card form, your payment is safe and we'll confirm it shortly. Please
        don't pay twice. Contact MyGreekTax if you'd like us to check for you.
      </p>
    </>
  );
}
