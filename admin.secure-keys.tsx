import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { generateKeyPair } from "@/lib/secure-crypto";
import { useAuth } from "@/lib/auth-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/admin/secure-keys")({
  component: SecureKeysPage,
  head: () => ({
    meta: [
      { title: "Secure form keys · MyGreekTax" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

type Generated = { publicKey: string; privateKey: string; fingerprint: string };

function SecureKeysPage() {
  const { isAdmin, sessionReady } = useAuth();
  const [pair, setPair] = useState<Generated | null>(null);
  const [busy, setBusy] = useState(false);

  if (!sessionReady) return null;

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <p className="text-sm text-muted-foreground">Not available for this account.</p>
      </div>
    );
  }

  const generate = async () => {
    setBusy(true);
    try {
      setPair(await generateKeyPair());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Key generation failed.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error("Copy failed. Select the text and copy manually.");
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Secure form keypair</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Generates an RSA-OAEP 4096 keypair in this browser. Nothing is sent anywhere. The
            public key goes into the repo so client browsers can encrypt with it. The private key
            goes into Bitwarden and nowhere else, in particular not into the repo, not into a
            Cloudflare secret, and not into an environment variable. Putting it on a server would
            defeat the entire design.
          </p>
          <p className="text-sm text-muted-foreground">
            Generating a new pair does not invalidate the old one. Rotate by replacing the public
            key in config and keeping the old private key in Bitwarden until every payload
            encrypted with it has been read and deleted.
          </p>
          <Button onClick={generate} disabled={busy}>
            {busy ? "Generating…" : pair ? "Generate another pair" : "Generate keypair"}
          </Button>
        </CardContent>
      </Card>

      {pair && (
        <Card>
          <CardHeader>
            <CardTitle>Fingerprint {pair.fingerprint}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label>Public key — paste into src/config/secure-form-key.ts</Label>
              <Textarea readOnly value={pair.publicKey} rows={5} className="font-mono text-xs" />
              <Button variant="outline" size="sm" onClick={() => copy(pair.publicKey, "Public key")}>
                Copy public key
              </Button>
            </div>

            <div className="space-y-2">
              <Label>Private key — paste into Bitwarden now, before leaving this page</Label>
              <Textarea readOnly value={pair.privateKey} rows={7} className="font-mono text-xs" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy(pair.privateKey, "Private key")}
              >
                Copy private key
              </Button>
              <p className="text-sm text-muted-foreground">
                This is shown once. Reloading loses it, and any payload already encrypted with the
                matching public key becomes permanently unreadable.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
