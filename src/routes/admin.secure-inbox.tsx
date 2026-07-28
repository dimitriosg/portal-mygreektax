import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  listSubmissions,
  createRequest,
  markAccessed,
  deleteSubmission,
  type SubmissionRow,
} from "@/lib/secure-credentials";
import { decryptPayload, type CredentialPayload } from "@/lib/secure-crypto";
import { SECURE_FORM_KEY_FINGERPRINT } from "@/config/secure-form-key";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/secure-inbox")({
  component: SecureInboxPage,
  head: () => ({
    meta: [
      { title: "Secure inbox · MyGreekTax" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

const SERVICES = [
  "Annual tax return (E1)",
  "ENFIA",
  "AFM registration",
  "Rental income declaration",
  "Tax residency transfer",
  "Other",
];

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function SecureInboxPage() {
  const { isAdmin, sessionReady } = useAuth();
  const [privateKey, setPrivateKey] = useState("");
  const [revealed, setRevealed] = useState<Record<string, CredentialPayload>>({});
  const [clientId, setClientId] = useState("");
  const [service, setService] = useState(SERVICES[0]);
  const [note, setNote] = useState("");
  const [newLink, setNewLink] = useState("");
  const [busy, setBusy] = useState(false);

  const submissions = useQuery({
    queryKey: ["credential-submissions"],
    queryFn: listSubmissions,
    enabled: sessionReady && isAdmin,
  });

  const clients = useQuery({
    queryKey: ["credential-clients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("clients")
        .select("id, full_name, client_code")
        .order("full_name", { ascending: true });
      if (error) throw new Error(error.message);
      return data ?? [];
    },
    enabled: sessionReady && isAdmin,
  });

  if (!sessionReady) return null;

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">Not available for this account.</p>
      </div>
    );
  }

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Copy failed.");
    }
  };

  const generateLink = async () => {
    setBusy(true);
    try {
      const token = await createRequest({
        clientId: clientId || null,
        serviceLabel: service,
        note,
      });
      setNewLink(`${window.location.origin}/secure-form/${token}`);
      setNote("");
      toast.success("Link created.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create the link.");
    } finally {
      setBusy(false);
    }
  };

  const reveal = async (row: SubmissionRow) => {
    if (!privateKey.trim()) {
      toast.error("Paste your private key first.");
      return;
    }
    if (!row.ciphertext) {
      toast.error("This submission has no payload left.");
      return;
    }
    try {
      const payload = await decryptPayload(row.ciphertext, privateKey.trim());
      setRevealed((prev) => ({ ...prev, [row.id]: payload }));
      await markAccessed(row.id, service);
      submissions.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not decrypt.");
    }
  };

  const destroy = async (row: SubmissionRow) => {
    if (!window.confirm("Wipe this credential permanently? The audit row is kept.")) return;
    try {
      await deleteSubmission(row.id);
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
      toast.success("Credential wiped.");
      submissions.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete.");
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Private key</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Textarea
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            rows={4}
            placeholder="Paste from Bitwarden. Held in this tab only, never sent anywhere, cleared on reload."
            className="font-mono text-xs"
          />
          <p className="text-sm text-muted-foreground">
            Current key fingerprint is {SECURE_FORM_KEY_FINGERPRINT}. A row showing a different
            fingerprint needs the retired key that matches it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Create a form link</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="client">Client</Label>
              <select
                id="client"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
              >
                <option value="">Not linked to a client</option>
                {(clients.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.full_name ?? c.client_code ?? c.id}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service">Service</Label>
              <select
                id="service"
                value={service}
                onChange={(e) => setService(e.target.value)}
                className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
              >
                {SERVICES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="note">Internal note (optional)</Label>
            <Input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <Button onClick={generateLink} disabled={busy}>
            {busy ? "Creating…" : "Create link"}
          </Button>
          {newLink && (
            <div className="space-y-2 rounded-md bg-muted p-3">
              <p className="font-mono text-xs break-all">{newLink}</p>
              <Button variant="outline" size="sm" onClick={() => copy(newLink, "Link")}>
                Copy link
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Submissions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {submissions.isLoading && <Skeleton className="h-24 w-full" />}
          {!submissions.isLoading && (submissions.data ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing submitted yet.</p>
          )}
          {(submissions.data ?? []).map((row) => {
            const payload = revealed[row.id];
            return (
              <div key={row.id} className="space-y-3 rounded-md border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {row.clients?.full_name ?? row.clients?.client_code ?? "Unlinked"}
                  </span>
                  <Badge variant={row.status === "active" ? "default" : "secondary"}>
                    {row.status}
                  </Badge>
                  {row.key_fingerprint !== SECURE_FORM_KEY_FINGERPRINT && (
                    <Badge variant="outline">key {row.key_fingerprint}</Badge>
                  )}
                </div>

                <p className="text-sm text-muted-foreground">
                  Submitted {formatDate(row.submitted_at)} · delete by{" "}
                  {formatDate(row.retain_until)} · opened {row.access_count}×
                </p>

                {payload && (
                  <div className="space-y-2 rounded-md bg-muted p-3 font-mono text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="break-all">user: {payload.username}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copy(payload.username, "Username")}
                      >
                        Copy
                      </Button>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="break-all">pass: {payload.password}</span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copy(payload.password, "Password")}
                      >
                        Copy
                      </Button>
                    </div>
                    <p>ΑΦΜ: {payload.afm || "—"}</p>
                    <p>ΑΜΚΑ: {payload.amka || "—"}</p>
                    <p>2FA: {payload.twoFactor}</p>
                    {payload.notes && <p>notes: {payload.notes}</p>}
                  </div>
                )}

                <div className="flex gap-2">
                  {row.status === "active" && !payload && (
                    <Button size="sm" onClick={() => reveal(row)}>
                      Reveal
                    </Button>
                  )}
                  {row.status !== "deleted" && (
                    <Button size="sm" variant="destructive" onClick={() => destroy(row)}>
                      Wipe
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
