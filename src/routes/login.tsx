import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const navigate = useNavigate();
  const { user, sessionReady } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (user && sessionReady) {
      console.info("[login] redirecting after auth bootstrap", { userId: user.id });
      setLoading(false);
      navigate({ to: "/dashboard", replace: true });
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
      console.info("[login] sign-in accepted, waiting for auth bootstrap");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
      return;
    } finally {
      if (!signInAccepted) {
        setLoading(false);
      }
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Partner sign in</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Access is by invitation only. Client tracking links open directly and do not require a
        login.
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
    </div>
  );
}
