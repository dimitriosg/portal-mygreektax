import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  createPaymentToken,
  listPaymentClients,
  listPaymentTokens,
  revokePaymentToken,
  PAYMENT_KINDS,
  type PaymentKind,
  type PaymentTokenStatus,
} from "@/lib/payments.functions";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buildPaymentLink } from "@/lib/tracking-links";
import { formatDate, formatDateTime, cn } from "@/lib/utils";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/payments")({
  component: PaymentsPage,
});

const KIND_LABELS: Record<PaymentKind, string> = {
  deposit: "Deposit",
  balance: "Balance",
  other: "Other",
};

const STATUS_STYLES: Record<PaymentTokenStatus, string> = {
  open: "border-border bg-muted/40 text-muted-foreground",
  opened: "border-brand/40 bg-brand/10 text-brand",
  claimed: "border-warning/40 bg-warning/10 text-warning",
  paid: "border-success/40 bg-success/10 text-success",
  revoked: "border-destructive/40 bg-destructive/10 text-destructive",
  expired: "border-border bg-muted/40 text-muted-foreground",
};

// A Greek keyboard produces "150,00". type="number" would reject that and the
// submit button would sit disabled with nothing explaining why, so the field is
// plain text and both separators are accepted. Returns null when unparseable,
// which drives the validation message rather than a silent dead end.
function parseAmountInput(raw: string): number | null {
  const normalised = raw.trim().replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;
  const value = Number(normalised);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function formatAmount(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function PaymentsPage() {
  const { user, loading, sessionReady, isAdmin } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (loading) return;
    if (!user) {
      navigate({ to: "/login", replace: true });
      return;
    }
    if (!sessionReady) return;
    if (!isAdmin) navigate({ to: "/dashboard", replace: true });
  }, [loading, sessionReady, user, isAdmin, navigate]);

  const fetchClients = useServerFn(listPaymentClients);
  const fetchTokens = useServerFn(listPaymentTokens);
  const createFn = useServerFn(createPaymentToken);
  const revokeFn = useServerFn(revokePaymentToken);
  const qc = useQueryClient();

  const clientsQ = useQuery({
    queryKey: ["payment-clients"],
    queryFn: () => fetchClients(),
    enabled: !!isAdmin && sessionReady,
  });
  const tokensQ = useQuery({
    queryKey: ["payment-tokens"],
    queryFn: () => fetchTokens(),
    enabled: !!isAdmin && sessionReady,
  });

  useEffect(() => {
    const authError = [clientsQ.error, tokensQ.error].find(isAuthSessionError);
    if (authError) navigate({ to: "/login", replace: true });
  }, [clientsQ.error, tokensQ.error, navigate]);

  const [clientId, setClientId] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState<PaymentKind>("deposit");
  const [expiresInDays, setExpiresInDays] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [noteTouched, setNoteTouched] = useState(false);
  const [lastCreated, setLastCreated] = useState<{ token: string; note: string } | null>(null);

  const selectedClient = useMemo(
    () => clientsQ.data?.clients.find((c) => c.id === clientId),
    [clientsQ.data, clientId],
  );

  // Default note: case reference FIRST — the Revolut note field truncates
  // around 64 characters. Editable, but re-derived until the admin touches it.
  useEffect(() => {
    if (noteTouched) return;
    const caseCode = selectedClient?.case_code ?? "";
    setNote([caseCode, kind].filter(Boolean).join(" "));
  }, [selectedClient, kind, noteTouched]);

  const parsedAmount = parseAmountInput(amount);
  const amountEntered = amount.trim() !== "";
  const amountInvalid = amountEntered && parsedAmount === null;
  const canCreate = !!clientId && parsedAmount !== null;

  const createMut = useMutation({
    mutationFn: () =>
      createFn({
        data: {
          clientId,
          amount: parsedAmount ?? 0,
          kind,
          expiresInDays: expiresInDays === "" ? undefined : expiresInDays,
          note: note.trim() || undefined,
        },
      }),
    onSuccess: ({ token, note: createdNote }) => {
      setLastCreated({ token, note: createdNote });
      toast.success("Payment link created");
      qc.invalidateQueries({ queryKey: ["payment-tokens"] });
    },
    onError: (e) => {
      if (isAuthSessionError(e)) {
        navigate({ to: "/login", replace: true });
        return;
      }
      toast.error(getErrorMessage(e));
    },
  });

  const revokeMut = useMutation({
    mutationFn: (token: string) => revokeFn({ data: { token } }),
    onSuccess: () => {
      toast.success("Payment link revoked");
      qc.invalidateQueries({ queryKey: ["payment-tokens"] });
    },
    onError: (e) => {
      if (isAuthSessionError(e)) {
        navigate({ to: "/login", replace: true });
        return;
      }
      toast.error(getErrorMessage(e));
    },
  });

  if (loading || (!!user && !sessionReady)) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground">Loading...</div>
    );
  }
  if (!isAdmin) return null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:py-8 space-y-6">
      <div>
        <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to admin
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Payment links</h1>
        <p className="text-sm text-muted-foreground">
          One link per payment. The page shows the client how to pay; opens and "I've paid" taps
          arrive as signals — none of it confirms a real payment.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-4 py-5">
          <h2 className="text-sm font-semibold">New payment link</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1 text-xs text-muted-foreground lg:col-span-2">
              <span>Client / case</span>
              <select
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="w-full rounded border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                <option value="">
                  {clientsQ.isLoading ? "Loading clients…" : "Select a client…"}
                </option>
                {clientsQ.data?.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {[c.case_code, c.full_name].filter(Boolean).join(" — ")} · {c.stage}
                    {c.balance_due != null ? ` · due ${formatAmount(c.balance_due, "EUR")}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Amount (EUR)</span>
              <Input
                type="text"
                inputMode="decimal"
                placeholder="150.00"
                aria-invalid={amountInvalid}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {amountInvalid && (
                <span className="block text-destructive">
                  Enter an amount like 150 or 150,00 — digits with at most two decimals.
                </span>
              )}
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Kind</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as PaymentKind)}
                className="w-full rounded border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                {PAYMENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground">
              <span>Expiry (optional)</span>
              <select
                value={expiresInDays}
                onChange={(e) =>
                  setExpiresInDays(e.target.value === "" ? "" : Number(e.target.value))
                }
                className="w-full rounded border border-input bg-background px-2 py-2 text-sm text-foreground"
              >
                <option value="">No expiry</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
                <option value={30}>30 days</option>
                <option value={60}>60 days</option>
                <option value={90}>90 days</option>
              </select>
            </label>
            <label className="space-y-1 text-xs text-muted-foreground lg:col-span-2">
              <span>Note (prefills the Revolut reference — case code first, ~64 chars)</span>
              <Input
                value={note}
                maxLength={120}
                onChange={(e) => {
                  setNoteTouched(true);
                  setNote(e.target.value);
                }}
              />
            </label>
            <div className="flex items-end lg:col-span-2">
              <Button
                onClick={() => createMut.mutate()}
                disabled={!canCreate || createMut.isPending}
              >
                {createMut.isPending ? "Generating…" : "Generate payment link"}
              </Button>
            </div>
          </div>

          {lastCreated && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2.5">
              <code className="min-w-0 flex-1 truncate text-xs">
                {buildPaymentLink(lastCreated.token)}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(buildPaymentLink(lastCreated.token));
                  toast.success("Link copied");
                }}
              >
                Copy link
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[900px] text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2">Client</th>
              <th className="px-3 py-2">Case</th>
              <th className="px-3 py-2 text-right">Amount</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Opens</th>
              <th className="px-3 py-2">Last open</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2">Expires</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {tokensQ.isLoading && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {tokensQ.error && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-destructive">
                  Could not load payment links: {getErrorMessage(tokensQ.error)}
                </td>
              </tr>
            )}
            {!tokensQ.isLoading && (tokensQ.data?.tokens.length ?? 0) === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-muted-foreground">
                  No payment links yet.
                </td>
              </tr>
            )}
            {tokensQ.data?.tokens.map((t) => {
              const canRevoke = t.status !== "revoked" && t.status !== "paid";
              return (
                <tr key={t.token} className="border-t border-border hover:bg-muted/30">
                  <td className="px-3 py-2 font-medium">{t.clientName ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{t.case_code ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">
                    {formatAmount(t.amount, t.currency)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {KIND_LABELS[t.kind as PaymentKind] ?? t.kind}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
                        STATUS_STYLES[t.status],
                      )}
                      title={t.lastClaimAt ? `Claimed ${formatDateTime(t.lastClaimAt)}` : undefined}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{t.open_count}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {t.last_opened_at ? formatDateTime(t.last_opened_at) : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{formatDate(t.created_at)}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {t.expires_at ? formatDate(t.expires_at) : "—"}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard?.writeText(buildPaymentLink(t.token));
                        toast.success("Link copied");
                      }}
                    >
                      Copy
                    </Button>
                    {canRevoke && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive"
                        disabled={revokeMut.isPending}
                        onClick={() => revokeMut.mutate(t.token)}
                      >
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
