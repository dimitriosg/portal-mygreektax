import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { listChangeRequests, decideChangeRequest } from "@/lib/jobs.functions";
import { useAuth } from "@/lib/auth-context";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/utils";

export const Route = createFileRoute("/admin/change-requests")({ component: Page });

function Page() {
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

  const listFn = useServerFn(listChangeRequests);
  const decideFn = useServerFn(decideChangeRequest);
  const qc = useQueryClient();
  const [status, setStatus] = useState<"pending" | "approved" | "rejected" | "cancelled" | "all">(
    "pending",
  );

  const q = useQuery({
    queryKey: ["change-requests", status],
    queryFn: () => listFn({ data: { status } }),
    enabled: !!isAdmin && sessionReady,
  });

  useEffect(() => {
    if (q.error && isAuthSessionError(q.error)) {
      navigate({ to: "/login", replace: true });
    }
  }, [q.error, navigate]);

  const decide = useMutation({
    mutationFn: (vars: { id: string; decision: "approved" | "rejected" }) =>
      decideFn({ data: vars }),
    onSuccess: () => {
      toast.success("Decision recorded");
      qc.invalidateQueries({ queryKey: ["change-requests"] });
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
      <div className="mx-auto max-w-5xl px-4 py-6 text-sm text-muted-foreground">Loading...</div>
    );
  }
  if (!isAdmin) return null;
  const requests = q.data?.requests ?? [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:py-8 space-y-6">
      <div>
        <Link to="/admin" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to admin
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Change requests</h1>
        <p className="text-sm text-muted-foreground">
          Partner-submitted job changes awaiting your review.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(["pending", "approved", "rejected", "cancelled", "all"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={status === s ? "default" : "outline"}
            onClick={() => setStatus(s)}
          >
            {s}
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{requests.length} request(s)</CardTitle>
        </CardHeader>
        <CardContent>
          {q.error && (
            <p className="mb-4 text-sm text-destructive">
              Could not load change requests: {getErrorMessage(q.error)}
            </p>
          )}
          {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!q.isLoading && requests.length === 0 && (
            <p className="text-sm text-muted-foreground">No requests.</p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2">Job</th>
                  <th className="px-3 py-2">Partner</th>
                  <th className="px-3 py-2">Field</th>
                  <th className="px-3 py-2">Current → Requested</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <Link
                        to="/jobs/$jobId"
                        params={{ jobId: r.airtable_job_id }}
                        className="font-medium hover:underline"
                      >
                        {r.job_code ?? r.airtable_job_id}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{r.requester_name ?? r.requester_email ?? "—"}</td>
                    <td className="px-3 py-2">{r.field_name}</td>
                    <td className="px-3 py-2">
                      {(r.current_value || "—") + " → " + (r.requested_value || "—")}
                      {r.reason && (
                        <div className="text-xs text-muted-foreground mt-1">Reason: {r.reason}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">{r.status}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(r.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      {r.status === "pending" && (
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            onClick={() => decide.mutate({ id: r.id, decision: "approved" })}
                            disabled={decide.isPending}
                          >
                            Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => decide.mutate({ id: r.id, decision: "rejected" })}
                            disabled={decide.isPending}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
