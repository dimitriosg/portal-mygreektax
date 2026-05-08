import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPartnerInvite,
  listPartnerInvites,
  listPartnerProfilesAdmin,
  revokePartnerInvite,
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
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";

type AirtableAcc = { id: string; fields: { Name?: string } };

export function PartnersSection({ accountants }: { accountants: AirtableAcc[] }) {
  const qc = useQueryClient();
  const fetchInvites = useServerFn(listPartnerInvites);
  const fetchPartners = useServerFn(listPartnerProfilesAdmin);
  const createFn = useServerFn(createPartnerInvite);
  const revokeFn = useServerFn(revokePartnerInvite);

  const invitesQ = useQuery({ queryKey: ["partner-invites"], queryFn: () => fetchInvites() });
  const partnersQ = useQuery({ queryKey: ["partners"], queryFn: () => fetchPartners() });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", airtableAccountantId: "" });
  const [issued, setIssued] = useState<{ url: string; email: string } | null>(null);

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
      setIssued({ url, email: form.email });
      setOpen(false);
      setForm({ firstName: "", lastName: "", email: "", airtableAccountantId: "" });
      qc.invalidateQueries({ queryKey: ["partner-invites"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const revokeMut = useMutation({
    mutationFn: (inviteId: string) => revokeFn({ data: { inviteId } }),
    onSuccess: () => {
      toast.success("Invite revoked");
      qc.invalidateQueries({ queryKey: ["partner-invites"] });
    },
    onError: (e) => toast.error((e as Error).message),
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
                  <option value="">— None —</option>
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
                disabled={
                  !form.firstName || !form.lastName || !form.email || createMut.isPending
                }
                onClick={() => createMut.mutate(form)}
              >
                {createMut.isPending ? "Creating…" : "Create invite"}
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
              Share this link with <span className="font-medium text-foreground">{issued?.email}</span>.
              For security, the link is shown only once — copy it now.
            </p>
            <div className="rounded-md border border-border bg-muted/40 p-3 text-xs break-all font-mono">
              {issued?.url}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssued(null)}>
              Close
            </Button>
            <Button onClick={() => issued && copyLink(issued.url)}>Copy link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pending invites */}
      <Card className="mb-4">
        <CardContent className="p-0">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            Pending invitations ({pending.length})
          </div>
          {pending.length === 0 ? (
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
                      <td className="px-3 py-2 text-muted-foreground">{formatDate(i.expires_at)}</td>
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
          <div className="border-b border-border px-4 py-3 text-sm font-medium">
            Active partners ({partners.length})
          </div>
          {partners.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">No partners yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-muted/40 text-left">
                  <tr>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Email</th>
                    <th className="px-3 py-2">Airtable</th>
                    <th className="px-3 py-2">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {partners.map((p) => {
                    const acc = accountants.find((a) => a.id === p.airtable_accountant_id);
                    return (
                      <tr key={p.user_id} className="border-t border-border">
                        <td className="px-3 py-2">{p.full_name ?? "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground">{p.email}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {acc?.fields.Name ?? p.airtable_accountant_id ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{formatDate(p.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
