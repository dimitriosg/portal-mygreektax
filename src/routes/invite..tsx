import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { getInviteByToken, acceptPartnerInvite } from "@/lib/invites.functions";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import logo from "@/assets/mygreektax-mark.svg";

export const Route = createFileRoute("/invite/")({
  component: InvitePage,
  head: () => ({
    meta: [
      { title: "Accept invitation · MyGreekTax" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
});

function InvitePage() {
  const { token } = Route.useParams();
  const fetchInvite = useServerFn(getInviteByToken);
  const acceptFn = useServerFn(acceptPartnerInvite);
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["invite", token],
    queryFn: () => fetchInvite({ data: { token } }),
    retry: false,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 12) {
      toast.error("Password must be at least 12 characters.");
      return;
    }
    if (password !== confirm) {
      toast.error("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await acceptFn({ data: { token, password } });
      const { error } = await supabase.auth.signInWithPassword({
        email: res.email,
        password,
      });
      if (error) throw error;
      window.history.replaceState({}, "", "/dashboard");
      toast.success("Welcome aboard!");
      navigate({ to: "/dashboard" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--gradient-hero)" }}>
      <header className="border-b border-border/40 bg-background/40 backdrop-blur-sm">
        <div className="mx-auto flex max-w-xl items-center gap-2.5 px-4 py-4">
          <img src={logo} alt="MyGreekTax" width={36} height={36} className="h-9 w-9 rounded-md" />
          <span className="font-serif text-lg font-semibold tracking-tight">
            <span className="text-olive">My</span>
            <span className="italic">Greek</span>
            <span className="text-brand">Tax</span>
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 pb-16 pt-10">
        {isLoading && (
          <div className="space-y-4">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        )}
        {!isLoading && (!data || !data.valid) && (
          <Card>
            <CardContent className="py-10 text-center">
              <h1 className="text-xl font-semibold">Invitation not available</h1>
              <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
                This invitation link is invalid or has expired. Please contact your administrator
                for a new one.
              </p>
            </CardContent>
          </Card>
        )}
        {!isLoading && data?.valid && (
          <Card style={{ boxShadow: "var(--shadow-soft)" }}>
            <CardHeader>
              <CardTitle className="font-serif text-2xl">
                Welcome, <span className="italic">{data.firstName}</span>
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Set a password to activate your MyGreekTax partner account.
              </p>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Email</Label>
                  <Input value={data.email} disabled readOnly />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pw">Password</Label>
                  <Input
                    id="pw"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">At least 12 characters.</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pw2">Confirm password</Label>
                  <Input
                    id="pw2"
                    type="password"
                    autoComplete="new-password"
                    minLength={12}
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? "Activating…" : "Activate account"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
