import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  clearPasswordRecoveryPending,
  currentUrlIndicatesRecovery,
  isPasswordRecoveryPending,
  markPasswordRecoveryPending,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth-recovery";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const { user, sessionReady } = useAuth();
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [recoveryUpdateLoading, setRecoveryUpdateLoading] = useState(false);
  const [recoveryDetected, setRecoveryDetected] = useState(
    () => currentUrlIndicatesRecovery() || isPasswordRecoveryPending(),
  );

  useEffect(() => {
    if (currentUrlIndicatesRecovery()) {
      setRecoveryDetected(true);
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "PASSWORD_RECOVERY") return;
      markPasswordRecoveryPending();
      setRecoveryDetected(true);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!sessionReady) return;

    if (user && currentUrlIndicatesRecovery() && !isPasswordRecoveryPending()) {
      markPasswordRecoveryPending();
      return;
    }

    if (!user) {
      clearPasswordRecoveryPending();
    }
  }, [recoveryDetected, sessionReady, user]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (nextPassword.length < MIN_PASSWORD_LENGTH) {
      toast.error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (nextPassword !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }

    setRecoveryUpdateLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: nextPassword });
      if (error) throw error;
      clearPasswordRecoveryPending();
      toast.success("Password updated. You can now continue.");

      const { data: sessionData } = await supabase.auth.getSession();
      const hasValidSession = Boolean(sessionData.session?.user);

      navigate({
        to: hasValidSession ? "/dashboard" : "/login",
        hash: hasValidSession ? undefined : "password-reset-success",
        replace: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update your password.");
    } finally {
      setRecoveryUpdateLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Set a new password</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Choose a new password for your MyGreekTax portal account.
      </p>

      {!sessionReady ? (
        <p className="mt-6 text-sm text-muted-foreground">Checking your recovery link…</p>
      ) : !user || !recoveryDetected ? (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            This recovery link is invalid, expired, or has already been used. Request a new link
            from the sign-in page.
          </p>
          <Button variant="outline" className="w-full" onClick={() => navigate({ to: "/login" })}>
            Back to sign in
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="next-password">New password</Label>
            <Input
              id="next-password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={nextPassword}
              onChange={(e) => setNextPassword(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              At least {MIN_PASSWORD_LENGTH} characters.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={recoveryUpdateLoading} className="w-full">
            {recoveryUpdateLoading ? "Saving…" : "Set new password"}
          </Button>
        </form>
      )}
    </div>
  );
}
