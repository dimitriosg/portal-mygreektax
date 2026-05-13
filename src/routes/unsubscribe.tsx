import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

const search = z.object({ token: z.string().optional() });

export const Route = createFileRoute("/unsubscribe")({
  validateSearch: (s) => search.parse(s),
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { token } = Route.useSearch();
  const [state, setState] = useState<
    "loading" | "ready" | "already" | "invalid" | "done" | "submitting" | "error"
  >("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState("invalid");
      return;
    }
    fetch(`/email/unsubscribe?token=${encodeURIComponent(token)}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) return setState("invalid");
        if (data.valid === false && data.reason === "already_unsubscribed")
          return setState("already");
        if (data.valid) return setState("ready");
        setState("invalid");
      })
      .catch(() => setState("invalid"));
  }, [token]);

  const submit = async () => {
    if (!token) return;
    setState("submitting");
    try {
      const r = await fetch(`/email/unsubscribe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await r.json().catch(() => ({}));
      if (data.success) setState("done");
      else if (data.reason === "already_unsubscribed") setState("already");
      else {
        setError(data.error ?? "Could not unsubscribe.");
        setState("error");
      }
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-4 p-6 text-center">
          <h1 className="text-xl font-semibold">Email preferences</h1>
          {state === "loading" && (
            <p className="text-sm text-muted-foreground">Checking your link…</p>
          )}
          {state === "invalid" && (
            <p className="text-sm text-muted-foreground">
              This unsubscribe link is invalid or has expired.
            </p>
          )}
          {state === "already" && (
            <p className="text-sm text-muted-foreground">
              You're already unsubscribed from these emails.
            </p>
          )}
          {state === "ready" && (
            <>
              <p className="text-sm text-muted-foreground">
                Confirm you'd like to stop receiving emails from My Greek Tax.
              </p>
              <Button onClick={submit} className="w-full">
                Confirm unsubscribe
              </Button>
            </>
          )}
          {state === "submitting" && <p className="text-sm text-muted-foreground">Processing…</p>}
          {state === "done" && (
            <p className="text-sm text-foreground">
              You've been unsubscribed. Sorry to see you go.
            </p>
          )}
          {state === "error" && <p className="text-sm text-destructive">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
