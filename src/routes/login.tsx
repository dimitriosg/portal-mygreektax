import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  GENERIC_RECOVERY_SUCCESS_MESSAGE,
  getRecoveryRedirectUrl,
  isPasswordRecoveryPending,
} from "@/lib/auth-recovery";
import { useAuth } from "@/lib/auth-context";
import { debugLog } from "@/lib/debug";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { user, sessionReady } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [recoveryRequestOpen, setRecoveryRequestOpen] = useState(false);
  const [recoveryRequestLoading, setRecoveryRequestLoading] = useState(false);
  const [recoveryRequestMessage, setRecoveryRequestMessage] = useState<string | null>(null);

  const recoveryEmail = useMemo(() => email.trim().toLowerCase(), [email]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const url = new URL(window.location.href);
    if (url.hash !== "#password-reset-success") return;

    toast.success("Password updated. You can now continue.");
    navigate({ to: "/login", hash: undefined, replace: true });
  }, [navigate]);
  useEffect(() => {
    if (user && sessionReady) {
      debugLog("[login] redirecting after auth bootstrap", { userId: user.id });
      setLoading(false);
      navigate({
        to: isPasswordRecoveryPending() ? "/reset-password" : "/dashboard",
        replace: true,
      });
    }
  }, [navigate, sessionReady, user]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    let signInAccepted = false;
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      signInAccepted = true;
      debugLog("[login] sign-in accepted, waiting for auth bootstrap");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
      return;
    } finally {
      if (!signInAccepted) {
        setLoading(false);
      }
    }
  };

  const submitRecoveryRequest = async (e: FormEvent) => {
    e.preventDefault();
    if (!recoveryEmail) return;

    setRecoveryRequestLoading(true);
    setRecoveryRequestMessage(null);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(recoveryEmail, {
        redirectTo: getRecoveryRedirectUrl(),
      });
      if (error) throw error;
      setRecoveryRequestMessage(GENERIC_RECOVERY_SUCCESS_MESSAGE);
    } catch {
      toast.error("Could not send a recovery email right now. Please try again shortly.");
    } finally {
      setRecoveryRequestLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Portal sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Access is invite-only and managed by the MyGreekTax admin. If you need an account, please
        contact your administrator. Client tracking links open directly and do not require a login.
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={loading} className="w-full">
          {loading ? "Please wait…" : "Sign in"}
        </Button>
      </form>
      <div className="mt-4 space-y-3">
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => {
            setRecoveryRequestOpen((open) => !open);
            setRecoveryRequestMessage(null);
          }}
        >
          Forgot password or need access?
        </button>
        {recoveryRequestOpen && (
          <form onSubmit={submitRecoveryRequest} className="space-y-3 rounded-lg border p-4">
            <div className="space-y-1.5">
              <Label htmlFor="recovery-email">Email</Label>
              <Input
                id="recovery-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Enter your invited portal email. We&apos;ll only send a link if it&apos;s already
                authorized.
              </p>
            </div>
            {recoveryRequestMessage && (
              <p className="text-sm text-muted-foreground">{recoveryRequestMessage}</p>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={recoveryRequestLoading} className="flex-1">
                {recoveryRequestLoading ? "Sending…" : "Send access link"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRecoveryRequestOpen(false);
                  setRecoveryRequestMessage(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
