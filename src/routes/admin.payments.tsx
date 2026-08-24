import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  confirmPaymentToken,
  correctPaymentAmount,
  createPaymentToken,
  listPaymentClients,
  listPaymentTokens,
  revokePaymentToken,
  updatePaymentTokenNote,
  PAYMENT_KINDS,
  type PaymentKind,
  type PaymentTokenStatus,
  type PaymentTokenSummary,
} from "@/lib/payments.functions";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildPaymentNote, PAYMENT_NOTE_MAX_LENGTH } from "@/lib/payments-shared";
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
  // Task 4: changing the amount on an unpaid token is a revoke-and-remint, not
  // an in-place edit. A live link may already be in the client's inbox, and a
  // token whose amount changes underneath it is a stealth edit rather than a
  // correction they would notice. payment_tokens.regenerated_from_token exists
  // for exactly this. When set, the mint form above is prefilled from this
  // token and its submit replaces it.
  const [regeneratingFrom, setRegeneratingFrom] = useState<PaymentTokenSummary | null>(null);
  const [regenerateConfirmOpen, setRegenerateConfirmOpen] = useState(false);

  const selectedClient = useMemo(
    () => clientsQ.data?.clients.find((c) => c.id === clientId),
    [clientsQ.data, clientId],
  );

  const parsedAmount = parseAmountInput(amount);
  const amountEntered = amount.trim() !== "";
  const amountInvalid = amountEntered && parsedAmount === null;
  const canCreate = !!clientId && parsedAmount !== null;

  // A generated note always fits, but a hand-typed override skips the helper
  // entirely. Warn rather than block: the same field is the bank-transfer
  // reference, where a longer string is harmless, and a hard maxLength would
  // stop typing with no explanation.
  const noteOverCap = note.trim().length > PAYMENT_NOTE_MAX_LENGTH;

  // Preview of the note the server would build, from the same helper, so what
  // is shown here is what lands in payment_tokens.note. Re-derived until the
  // admin touches the field, after which their text wins. It tracks the amount
  // and not `kind`: the label comes from the money — the share of the quote,
  // or of what is still outstanding once the case has received a deposit.
  useEffect(() => {
    if (noteTouched) return;
    setNote(
      buildPaymentNote({
        caseCode: selectedClient?.case_code,
        fullName: selectedClient?.full_name,
        amount: parsedAmount ?? 0,
        quoteAmount: selectedClient?.quote_amount,
        depositSoFar: selectedClient?.deposit,
      }),
    );
  }, [selectedClient, parsedAmount, noteTouched]);

  // Prefill from the token being replaced: same client, kind and note, only
  // the amount is meant to change.
  useEffect(() => {
    if (!regeneratingFrom) return;
    setClientId(regeneratingFrom.client_id);
    setKind(
      (PAYMENT_KINDS as readonly string[]).includes(regeneratingFrom.kind)
        ? (regeneratingFrom.kind as PaymentKind)
        : "other",
    );
    setAmount(String(regeneratingFrom.amount));
    setNoteTouched(true);
    setNote(regeneratingFrom.note ?? "");
    setExpiresInDays("");
  }, [regeneratingFrom]);

  const createMut = useMutation({
    mutationFn: async () => {
      const replacing = regeneratingFrom?.token;
      const created = await createFn({
        data: {
          clientId,
          amount: parsedAmount ?? 0,
          kind,
          expiresInDays: expiresInDays === "" ? undefined : expiresInDays,
          note: note.trim() || undefined,
          regeneratedFromToken: replacing,
        },
      });
      // Mint first, revoke second, and only on success — a failed mint must
      // never leave the case with no live link. If the revoke half fails the
      // new link is already good, so surface it rather than rolling back.
      let oldRevoked = true;
      if (replacing) {
        try {
          await revokeFn({ data: { token: replacing } });
        } catch {
          oldRevoked = false;
        }
      }
      return { ...created, replacing, oldRevoked };
    },
    onSuccess: ({ token, note: createdNote, replacing, oldRevoked }) => {
      setLastCreated({ token, note: createdNote });
      if (replacing && !oldRevoked) {
        toast.warning("New link created, but the old one could not be revoked — revoke it by hand");
      } else {
        toast.success(
          replacing ? "Replacement link created, old one revoked" : "Payment link created",
        );
      }
      setRegeneratingFrom(null);
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
          <h2 className="text-sm font-semibold">
            {regeneratingFrom ? "Replace payment link" : "New payment link"}
          </h2>
          {regeneratingFrom && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-xs">
              <span>
                Replacing the {formatAmount(regeneratingFrom.amount, regeneratingFrom.currency)}{" "}
                link for {regeneratingFrom.clientName ?? "this client"}
                {regeneratingFrom.case_code ? ` (${regeneratingFrom.case_code})` : ""}. Change the
                amount below — minting the replacement revokes the old link.
              </span>
              <Button size="sm" variant="ghost" onClick={() => setRegeneratingFrom(null)}>
                Cancel replacement
              </Button>
            </div>
          )}
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
              <span>
                Note (reaches the Revolut transaction record — case code first, ~
                {PAYMENT_NOTE_MAX_LENGTH} chars). Edit to override.
              </span>
              <Input
                value={note}
                maxLength={120}
                aria-invalid={noteOverCap}
                onChange={(e) => {
                  setNoteTouched(true);
                  setNote(e.target.value);
                }}
              />
              {noteOverCap && (
                <span className="block text-warning">
                  {note.trim().length} characters — Revolut keeps only the first{" "}
                  {PAYMENT_NOTE_MAX_LENGTH}, so anything after that is lost. Put the case code
                  first.
                </span>
              )}
            </label>
            <div className="flex items-end lg:col-span-2">
              <Button
                onClick={() =>
                  regeneratingFrom ? setRegenerateConfirmOpen(true) : createMut.mutate()
                }
                disabled={!canCreate || createMut.isPending}
              >
                {createMut.isPending
                  ? regeneratingFrom
                    ? "Replacing…"
                    : "Generating…"
                  : regeneratingFrom
                    ? "Replace link"
                    : "Generate payment link"}
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
            {tokensQ.data?.tokens.map((t) => (
              <TokenRow
                key={t.token}
                token={t}
                onRegenerate={() => {
                  setRegeneratingFrom(t);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={regenerateConfirmOpen} onOpenChange={setRegenerateConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace this payment link?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  A new link will be minted at{" "}
                  <strong>{formatAmount(parsedAmount ?? 0, "EUR")}</strong> and the existing{" "}
                  {regeneratingFrom
                    ? formatAmount(regeneratingFrom.amount, regeneratingFrom.currency)
                    : ""}{" "}
                  link will be revoked.
                </p>
                <p>
                  Anyone holding the old link will see it as no longer available, so send the new
                  one. If the client has already paid on the old link, revoke it and confirm that
                  payment instead of replacing it.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRegenerateConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setRegenerateConfirmOpen(false);
                createMut.mutate();
              }}
            >
              Replace link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Both database functions return a row rather than throwing: `applied: false`
// with a reason is an expected outcome — a stale click on a page the world has
// moved past — and must never render as an error. Every reason gets its own
// sentence; the generic fallbacks below are only for a genuinely unexpected
// value, not for any known one.
function confirmReasonSentence(reason: string): string {
  switch (reason) {
    case "already_paid":
      return "Already confirmed — nothing was written.";
    case "revoked":
      return "This link was revoked, so nothing was confirmed.";
    case "unknown_token":
      return "This link no longer exists — nothing was written.";
    default:
      return `Nothing was written (${reason}).`;
  }
}

function correctReasonSentence(reason: string): string {
  switch (reason) {
    case "unknown_payment":
      return "That payment no longer exists — nothing was written.";
    case "not_confirmed":
      return "That payment is not confirmed, so there is nothing to correct.";
    case "invalid_amount":
      return "That amount is not valid — nothing was written.";
    case "no_change":
      return "That is the amount already booked — nothing was written.";
    default:
      return `Nothing was written (${reason}).`;
  }
}

type RowNotice = { tone: "applied" | "neutral"; text: string } | null;

function TokenRow({
  token: t,
  onRegenerate,
}: {
  token: PaymentTokenSummary;
  onRegenerate: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirmFn = useServerFn(confirmPaymentToken);
  const correctFn = useServerFn(correctPaymentAmount);
  const noteFn = useServerFn(updatePaymentTokenNote);
  const revokeFn = useServerFn(revokePaymentToken);

  const [notice, setNotice] = useState<RowNotice>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [correctOpen, setCorrectOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(t.note ?? "");
  const [correctAmount, setCorrectAmount] = useState("");
  const [correctReason, setCorrectReason] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: ["payment-tokens"] });
  const onMutationError = (e: unknown) => {
    if (isAuthSessionError(e)) {
      navigate({ to: "/login", replace: true });
      return;
    }
    toast.error(getErrorMessage(e));
  };

  // The action matrix. Unavailable actions are hidden, not greyed out.
  // `paid` beats `revoked` in the status precedence deliberately: a token paid
  // and later revoked is still a payment that happened, so it keeps offering
  // Correct amount.
  const isLive = t.status === "open" || t.status === "opened" || t.status === "claimed";
  const isPaid = t.status === "paid";

  const confirmMut = useMutation({
    mutationFn: () => confirmFn({ data: { token: t.token } }),
    onSuccess: (res) => {
      if (res.applied) {
        const moved = res.stageBefore !== res.stageAfter;
        setNotice({
          tone: "applied",
          text:
            `Confirmed. Deposit is now ${formatAmount(res.deposit ?? 0, res.currency ?? "EUR")}` +
            ` and the balance ${formatAmount(res.balanceDue ?? 0, res.currency ?? "EUR")}.` +
            (moved ? ` The case moved from ${res.stageBefore} to ${res.stageAfter}.` : ""),
        });
      } else {
        setNotice({ tone: "neutral", text: confirmReasonSentence(res.reason) });
      }
      refresh();
    },
    onError: onMutationError,
  });

  const noteMut = useMutation({
    mutationFn: () => noteFn({ data: { token: t.token, note: noteDraft.trim() } }),
    onSuccess: (res) => {
      setNoteOpen(false);
      setNotice(
        res.ok
          ? { tone: "applied", text: "Note updated." }
          : {
              tone: "neutral",
              text: "This link has been paid, so its note can no longer be edited.",
            },
      );
      refresh();
    },
    onError: onMutationError,
  });

  const correctMut = useMutation({
    mutationFn: () =>
      correctFn({
        data: {
          paymentId: t.payment?.id ?? "",
          newAmount: parseAmountInput(correctAmount) ?? 0,
          reason: correctReason.trim(),
        },
      }),
    onSuccess: (res) => {
      setCorrectOpen(false);
      if (res.applied) {
        const currency = res.currency ?? "EUR";
        setNotice({
          tone: "applied",
          text:
            `Corrected from ${formatAmount(res.oldAmount ?? 0, currency)} to ` +
            `${formatAmount(res.newAmount ?? 0, currency)}. Deposit is now ` +
            `${formatAmount(res.deposit ?? 0, currency)} and the balance ` +
            `${formatAmount(res.balanceDue ?? 0, currency)}. The case stage is unchanged.`,
        });
      } else {
        setNotice({ tone: "neutral", text: correctReasonSentence(res.reason) });
      }
      refresh();
    },
    onError: onMutationError,
  });

  const revokeMut = useMutation({
    mutationFn: () => revokeFn({ data: { token: t.token } }),
    onSuccess: () => {
      toast.success("Payment link revoked");
      refresh();
    },
    onError: onMutationError,
  });

  // Surface 1: everything the dialog can know without calling. invalid_amount
  // and no_change are caught here rather than discovered by the function.
  const parsedCorrection = parseAmountInput(correctAmount);
  const correctionEntered = correctAmount.trim() !== "";
  const correctionInvalid = correctionEntered && parsedCorrection === null;
  const correctionUnchanged =
    parsedCorrection !== null && t.payment != null && parsedCorrection === t.payment.amount;
  const reasonMissing = correctReason.trim() === "";
  const canCorrect =
    parsedCorrection !== null && !correctionUnchanged && !reasonMissing && !!t.payment;

  const noteDraftOverCap = noteDraft.trim().length > PAYMENT_NOTE_MAX_LENGTH;
  const noteUnchanged = noteDraft.trim() === (t.note ?? "").trim();

  return (
    <>
      <tr className="border-t border-border hover:bg-muted/30">
        <td className="px-3 py-2 font-medium">{t.clientName ?? "—"}</td>
        <td className="px-3 py-2 text-muted-foreground">{t.case_code ?? "—"}</td>
        <td className="px-3 py-2 text-right font-semibold tabular-nums">
          {formatAmount(t.amount, t.currency)}
          {t.payment && t.payment.amount !== t.amount && (
            <div className="text-xs font-normal text-muted-foreground">
              booked {formatAmount(t.payment.amount, t.payment.currency)}
            </div>
          )}
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
          {isLive && (
            <>
              <Button size="sm" variant="outline" onClick={() => setConfirmOpen(true)}>
                Confirm now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setNoteDraft(t.note ?? "");
                  setNoteOpen(true);
                }}
              >
                Edit note
              </Button>
              <Button size="sm" variant="ghost" onClick={onRegenerate}>
                Edit amount
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive"
                disabled={revokeMut.isPending}
                onClick={() => revokeMut.mutate()}
              >
                Revoke
              </Button>
            </>
          )}
          {isPaid && t.payment && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCorrectAmount(String(t.payment?.amount ?? ""));
                setCorrectReason("");
                setCorrectOpen(true);
              }}
            >
              Correct amount
            </Button>
          )}
        </td>
      </tr>

      {notice && (
        <tr className="border-t border-border/50">
          <td colSpan={10} className="px-3 py-2">
            <div
              className={cn(
                "flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs",
                notice.tone === "applied"
                  ? "border-success/40 bg-success/5"
                  : "border-border bg-muted/40 text-muted-foreground",
              )}
            >
              <span>{notice.text}</span>
              <button
                className="shrink-0 underline underline-offset-2"
                onClick={() => setNotice(null)}
              >
                Dismiss
              </button>
            </div>
          </td>
        </tr>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm this payment?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  This books {formatAmount(t.amount, t.currency)} against{" "}
                  {t.clientName ?? "this client"}
                  {t.case_code ? ` (${t.case_code})` : ""} and adds it to the deposit.
                </p>
                <p>
                  If the case is still Quoted this also moves it to Active. Only confirm once the
                  money has actually arrived.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={confirmMut.isPending}
              onClick={() => {
                setConfirmOpen(false);
                confirmMut.mutate();
              }}
            >
              {confirmMut.isPending ? "Confirming…" : "Confirm payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit the payment note</DialogTitle>
            <DialogDescription asChild>
              <p className="text-sm">
                This is the reference the client sees, and it reaches the Revolut transaction
                record. It has no other effect.
              </p>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Input
              value={noteDraft}
              maxLength={120}
              aria-invalid={noteDraftOverCap}
              onChange={(e) => setNoteDraft(e.target.value)}
            />
            {noteDraftOverCap && (
              <span className="block text-xs text-warning">
                {noteDraft.trim().length} characters — Revolut keeps only the first{" "}
                {PAYMENT_NOTE_MAX_LENGTH}, so anything after that is lost. Put the case code first.
              </span>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoteOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={noteMut.isPending || noteDraft.trim() === "" || noteUnchanged}
              onClick={() => noteMut.mutate()}
            >
              {noteMut.isPending ? "Saving…" : "Save note"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={correctOpen} onOpenChange={setCorrectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct the recorded amount</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {formatAmount(t.payment?.amount ?? 0, t.payment?.currency ?? t.currency)} is
                  currently booked against {t.clientName ?? "this client"}
                  {t.case_code ? ` (${t.case_code})` : ""}. The deposit will be adjusted by the
                  difference.
                </p>
                <p className="font-medium text-foreground">
                  This changes the recorded amount only — the case stage is left as it is.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>Actual amount received (EUR)</span>
              <Input
                type="text"
                inputMode="decimal"
                value={correctAmount}
                aria-invalid={correctionInvalid || correctionUnchanged}
                onChange={(e) => setCorrectAmount(e.target.value)}
              />
              {correctionInvalid && (
                <span className="block text-destructive">
                  Enter an amount like 150 or 150,00 — digits with at most two decimals.
                </span>
              )}
              {correctionUnchanged && (
                <span className="block text-destructive">
                  That is the amount already booked — change it or cancel.
                </span>
              )}
            </label>
            <label className="block space-y-1 text-xs text-muted-foreground">
              <span>Reason (required — it is written to the audit trail)</span>
              <Textarea
                rows={2}
                value={correctReason}
                aria-invalid={reasonMissing && correctionEntered}
                onChange={(e) => setCorrectReason(e.target.value)}
                placeholder="e.g. bank fee deducted from the transfer"
              />
              {reasonMissing && correctionEntered && (
                <span className="block text-destructive">A reason is required.</span>
              )}
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCorrectOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={!canCorrect || correctMut.isPending}
              onClick={() => correctMut.mutate()}
            >
              {correctMut.isPending ? "Correcting…" : "Correct amount"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
