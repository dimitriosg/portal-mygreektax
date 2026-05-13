import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  createPartnerInvite,
  listPartnerInvites,
  listPartnerProfilesAdmin,
  revokePartnerInvite,
  setPartnerDisabled,
} from "@/lib/invites.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";

type AirtableAcc = { id: string; fields: { Name?: string } };

type IssuedInvite = { url: string; email: string; firstName: string };

const INACTIVE_DAYS = 30;

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function partnerStatus(p: { disabled_at: string | null; last_seen_at: string | null }) {
  if (p.disabled_at) return "disabled" as const;
  if (!p.last_seen_at) return "inactive" as const;
  const days = (Date.now() - new Date(p.last_seen_at).getTime()) / 86400000;
  return days <= INACTIVE_DAYS ? ("active" as const) : ("inactive" as const);
}

function buildInviteMailto(invite: IssuedInvite) {
  const subject = "Your My Greek Tax partner portal invitation";
  const greeting = invite.firstName ? `Hi ${invite.firstName},` : "Hi,";
  const body = [
    greeting,
    "You have been invited to access the My Greek Tax partner portal.",
    "Please use the secure invitation link below to create your account:",
    invite.url,
    "This invitation link is personal. Please do not forward it.",
    "Thank you,",
    "My Greek Tax",
  ].join("\n\n");

  return `mailto:${encodeURIComponent(invite.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function openInviteEmailDraft(invite: IssuedInvite) {
  window.location.href = buildInviteMailto(invite);
  track("partner_invite_email_draft_opened");
  toast.success("Email draft opened");
}

function getRecoveryRedirectUrl() {
  return `${window.location.origin}/login?mode=recovery`;
}

export function PartnersSection({
  accountants,
  enabled = true,
}: {
  accountants: AirtableAcc[];
  enabled?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fetchInvites = useServerFn(listPartnerInvites);
  const fetchPartners = useServerFn(listPartnerProfilesAdmin);
  const createFn = useServerFn(createPartnerInvite);
  const revokeFn = useServerFn(revokePartnerInvite);
  const toggleDisabledFn = useServerFn(setPartnerDisabled);

  const invitesQ = useQuery({
    queryKey: ["partner-invites"],
    queryFn: () => fetchInvites(),
    enabled,
  });
  const partnersQ = useQuery({
    queryKey: ["partners"],
    queryFn: () => fetchPartners(),
    enabled,
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    airtableAccountantId: "",
  });
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const handleMutationError = (error: unknown) => {
    if (isAuthSessionError(error)) {
      navigate({ to: "/login", replace: true });
      return;
    }
    toast.error(getErrorMessage(error));
  };

  const createMut = useMutation({
    mutationFn: (vars: typeof form) =>
      createFn({
        data: {
          firstName: vars.firstName,
          lastName: vars.lastName,
          email: vars.email,
          airtableAccountantId: vars.airtableAccountantId || undefined,
        },
      }),
    onSuccess: (res) => {
      const url = `${window.location.origin}/invite/${res.token}`;
      setIssued({ url, email: form.email, firstName: form.firstName });
      setOpen(false);
      setForm({ firstName: "", lastName: "", email: "", airtableAccountantId: "" });
      qc.invalidateQueries({ queryKey: ["partner-invites"] });
    },
    onError: handleMutationError,
  });

  const revokeMut = useMutation({
    mutationFn: (inviteId: string) => revokeFn({ data: { inviteId } }),
    onSuccess: () => {
      toast.success("Invite revoked");
      qc.invalidateQueries({ queryKey: ["partner-invites"] });
    },
    onError: handleMutationError,
  });

  const [confirm, setConfirm] = useState<{ userId: string; name: string; disable: boolean } | null>(
    null,
  );

  const toggleMut = useMutation({
    mutationFn: (vars: { userId: string; disabled: boolean }) => toggleDisabledFn({ data: vars }),
    onSuccess: (_d, vars) => {
      toast.success(vars.disabled ? "Partner access disabled" : "Partner access enabled");
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ["partners"] });
    },
    onError: handleMutationError,
  });

  const partners = partnersQ.data?.partners ?? [];
  const allInvites = invitesQ.data?.invites ?? [];
  const pending = allInvites.filter((i) => !i.consumed_at && new Date(i.expires_at) > new Date());

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Invite link copied");
    } catch {
      toast.message("Copy failed", { description: url });
    }
  };

  const sendRecoveryLink = async (email: string) => {
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: getRecoveryRedirectUrl(),
      });
      if (error) throw error;
      toast.success("Recovery link sent.");
    } catch {
      toast.error("Could not send a recovery link right now.");
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Partners</h2>
          <p className="text-sm text-muted-foreground">Invite accountants and manage access.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>+ Invite partner</Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Invite a partner</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>First name</Label>
                  <Input
                    value={form.firstName}
                    onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Last name</Label>
                  <Input
                    value={form.lastName}
                    onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Link to Airtable accountant (optional)</Label>
                <select
                  value={form.airtableAccountantId}
                  onChange={(e) => setForm({ ...form, airtableAccountantId: e.target.value })}
                  className="w-full rounded border border-input bg-background px-2 py-2 text-sm"
                >
                  <option value="">- None -</option>
                  {accountants.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.fields.Name ?? a.id}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={!form.firstName || !form.lastName || !form.email || createMut.isPending}
                onClick={() => createMut.mutate(form)}
              >
                {createMut.isPending ? "Creating..." : "Create invite"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Issued link dialog */}
      <Dialog open={!!issued} onOpenChange={(o) => !o && setIssued(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Invitation created</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Share this link with{" "}
              <span className="font-medium text-foreground">{issued?.email}</span>. For security,
              the link is shown only once, copy it now.
            </p>
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs break-all font-mono">
              {issued?.url}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssued(null)}>
              Close
            </Button>
            <Button variant="outline" onClick={() => issued && copyLink(issued.url)}>
              Copy link
            </Button>
            <Button onClick={() => issued && openInviteEmailDraft(issued)}>Open email draft</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pending invites */}
      <Card className="mb-4">
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-3">
            <div className="text-sm font-medium">Pending invitations ({pending.length})</div>
            <div className="text-xs text-muted-foreground">Partners who haven't accepted yet.</div>
          </div>
          {invitesQ.error ? (
            <div className="px-4 py-6 text-sm text-destructive">
              Could not load invites: {getErrorMessage(invitesQ.error)}
            </div>
          ) : pending.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No pending invites.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Expires</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((i) => (
                    <tr key={i.id} className="border-t border-border">
                      <td className="px-3 py-2">
                        {i.first_name} {i.last_name}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{i.email}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatDate(i.expires_at)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => revokeMut.mutate(i.id)}
                          disabled={revokeMut.isPending}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Active partners */}
      <Card>
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-3">
            <div className="text-sm font-medium">Active partners ({partners.length})</div>
            <div className="text-xs text-muted-foreground">
              Partners with an account. "Inactive" = no login in the last {INACTIVE_DAYS} days.
            </div>
          </div>
          {partnersQ.error ? (
            <div className="px-4 py-6 text-sm text-destructive">
              Could not load partners: {getErrorMessage(partnersQ.error)}
            </div>
          ) : partners.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No partners yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Airtable</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Last seen</th>
                    <th className="px-3 py-2">Joined</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {partners.map((p) => {
                    const acc = accountants.find((a) => a.id === p.airtable_accountant_id);
                    const status = partnerStatus(p);
                    const isDisabled = status === "disabled";
                    return (
                      <tr key={p.user_id} className="border-t border-border">
                        <td className="px-3 py-2">{p.full_name ?? "-"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.email}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {acc?.fields.Name ?? p.airtable_accountant_id ?? "-"}
                        </td>
                        <td className="px-3 py-2">
                          {status === "active" ? (
                            <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400">
                              Active
                            </Badge>
                          ) : status === "inactive" ? (
                            <Badge variant="secondary">Inactive</Badge>
                          ) : (
                            <Badge variant="destructive">Disabled</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {relativeTime(p.last_seen_at)}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatDate(p.created_at)}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {!isDisabled && (
                                <DropdownMenuItem onClick={() => void sendRecoveryLink(p.email)}>
                                  Send recovery link
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem
                                onClick={() =>
                                  setConfirm({
                                    userId: p.user_id,
                                    name: p.full_name ?? p.email,
                                    disable: !isDisabled,
                                  })
                                }
                              >
                                {isDisabled ? "Enable access" : "Disable access"}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm?.disable ? "Disable partner access?" : "Enable partner access?"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {confirm?.disable ? (
              <>
                <span className="font-medium text-foreground">{confirm?.name}</span> will be signed
                out immediately and won't be able to sign back in.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">{confirm?.name}</span> will be able to
                sign in again with their existing credentials.
              </>
            )}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm?.disable ? "destructive" : "default"}
              disabled={toggleMut.isPending}
              onClick={() =>
                confirm && toggleMut.mutate({ userId: confirm.userId, disabled: confirm.disable })
              }
            >
              {toggleMut.isPending
                ? "Saving..."
                : confirm?.disable
                  ? "Disable access"
                  : "Enable access"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
