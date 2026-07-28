import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { openRequest, submitCredentials } from "@/lib/secure-credentials";
import { encryptPayload, type CredentialPayload } from "@/lib/secure-crypto";
import {
  SECURE_FORM_PUBLIC_KEY,
  SECURE_FORM_KEY_FINGERPRINT,
  secureFormKeyConfigured,
} from "@/config/secure-form-key";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export const Route = createFileRoute("/secure-form/$token")({
  component: SecureFormPage,
  head: () => ({
    meta: [{ title: "Secure form · MyGreekTax" }, { name: "robots", content: "noindex, nofollow" }],
  }),
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-xl p-6">
      <Card>
        <CardContent className="space-y-5 pt-6">{children}</CardContent>
      </Card>
    </div>
  );
}

function SecureFormPage() {
  const { token } = Route.useParams();

  const [afm, setAfm] = useState("");
  const [amka, setAmka] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [twoFactor, setTwoFactor] = useState("No");
  const [notes, setNotes] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["secure-form", token],
    queryFn: () => openRequest(token),
    retry: false,
  });

  if (isLoading) {
    return (
      <Shell>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-32 w-full" />
      </Shell>
    );
  }

  if (!secureFormKeyConfigured()) {
    return (
      <Shell>
        <h1 className="text-lg font-medium">This form is not ready yet</h1>
        <p className="text-sm text-muted-foreground">
          Please contact us at hello@mygreektax.eu and we will send you a working link.
        </p>
      </Shell>
    );
  }

  if (!data?.valid) {
    return (
      <Shell>
        <h1 className="text-lg font-medium">This link is no longer active</h1>
        <p className="text-sm text-muted-foreground">
          It may have expired or been replaced. Reply to our email and we will send you a fresh one.
          Please do not send your password by email in the meantime.
        </p>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <h1 className="text-lg font-medium">Thank you, that is encrypted and received</h1>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            We will use it once, to register the authorisation for the service you asked us about,
            then delete it.
          </p>
          <p>You will hear from us by email within one business day.</p>
          <p>
            Please do not send your password again through email or any messaging app. You do not
            need to send it to us a second time.
          </p>
        </div>
      </Shell>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!consent) {
      toast.error("Please tick the consent box to continue.");
      return;
    }
    if (!username.trim() || !password) {
      toast.error("Username and password are both needed.");
      return;
    }

    setBusy(true);
    try {
      const payload: CredentialPayload = {
        afm: afm.trim(),
        amka: amka.trim(),
        username: username.trim(),
        password,
        twoFactor,
        notes: notes.trim(),
        submittedAt: new Date().toISOString(),
      };
      const ciphertext = await encryptPayload(payload, SECURE_FORM_PUBLIC_KEY);

      setPassword("");
      setUsername("");

      await submitCredentials({
        token,
        ciphertext,
        keyFingerprint: SECURE_FORM_KEY_FINGERPRINT,
      });
      setDone(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div className="flex items-center justify-between">
        <span className="text-base font-medium">MyGreekTax</span>
        <span className="rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
          Encrypted in your browser
        </span>
      </div>

      <div>
        <h1 className="text-xl font-medium">{data.firstName ? `Hi ${data.firstName}` : "Hello"}</h1>
        <p className="text-sm text-muted-foreground">
          {data.serviceLabel
            ? `Authorisation setup for ${data.serviceLabel}`
            : "Authorisation setup"}
        </p>
      </div>

      <div className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
        We use this login once, to register the authorisation that lets our licensed accountant file
        for you. We do not file anything with it ourselves.
      </div>

      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="afm">ΑΦΜ (tax number)</Label>
            <Input
              id="afm"
              value={afm}
              onChange={(e) => setAfm(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="amka">ΑΜΚΑ (optional)</Label>
            <Input
              id="amka"
              value={amka}
              onChange={(e) => setAmka(e.target.value)}
              placeholder="Leave blank if none"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="username">TAXISnet username</Label>
            <Input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">TAXISnet password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="twoFactor">Two-factor authentication on myAADE</Label>
          <select
            id="twoFactor"
            value={twoFactor}
            onChange={(e) => setTwoFactor(e.target.value)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
          >
            <option>No</option>
            <option>Yes, I will send the code when you ask</option>
            <option>I am not sure</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="notes">Anything else we should know (optional)</Label>
          <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </div>

        <div className="flex items-start gap-3 border-t pt-4">
          <Checkbox
            id="consent"
            checked={consent}
            onCheckedChange={(v) => setConsent(v === true)}
            className="mt-1"
          />
          <Label htmlFor="consent" className="text-sm font-normal text-muted-foreground">
            I am providing this voluntarily so MyGreekTax can register an authorisation on my
            behalf. It will be used only for that, kept encrypted, deleted on request, and never
            shared.
          </Label>
        </div>

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Encrypting…" : "Encrypt and send"}
        </Button>

        <p className="text-center text-xs text-muted-foreground">
          Nothing leaves this page unencrypted, including to us. Prefer to set this up yourself?
          Reply to our email and we will guide you through it.
        </p>
      </form>
    </Shell>
  );
}
