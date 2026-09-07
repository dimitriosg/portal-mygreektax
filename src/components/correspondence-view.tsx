import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { getErrorMessage, isAuthSessionError } from "@/lib/auth-errors";
import {
  getCorrespondenceOverview,
  getGmailSyncRun,
  requestGmailSync,
} from "@/lib/correspondence.functions";
import { CorrespondenceTable } from "@/components/correspondence-table";

// Container for the Correspondence view on /leads: owns the query, the refresh
// mutation and the poll that waits for a triggered run to report back.
// CorrespondenceTable below it is presentational and takes finished data.

/** How often the poll asks whether the triggered run has finished. */
const POLL_INTERVAL_MS = 2500;
/**
 * How long to keep asking. The sync reads a 7-day Gmail window and the whole
 * messages table; three minutes is generous. Past it the page stops claiming to
 * know and says so — it does not assert failure, because the run may well still
 * finish and the next load will show it.
 */
const POLL_TIMEOUT_MS = 3 * 60 * 1000;
/** Re-render cadence so "3 min ago" does not sit frozen on screen. */
const CLOCK_TICK_MS = 60_000;

type Props = {
  isAdmin: boolean;
  sessionReady: boolean;
};

export function CorrespondenceView({ isAdmin, sessionReady }: Props) {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const fetchOverview = useServerFn(getCorrespondenceOverview);
  const requestSync = useServerFn(requestGmailSync);
  const fetchRun = useServerFn(getGmailSyncRun);

  const overviewQ = useQuery({
    queryKey: ["correspondence", "overview"],
    queryFn: () => fetchOverview(),
    enabled: !!isAdmin && sessionReady,
  });

  useEffect(() => {
    if (isAuthSessionError(overviewQ.error)) navigate({ to: "/login", replace: true });
  }, [overviewQ.error, navigate]);

  // A clock the relative timestamps read, rather than each of them calling
  // new Date() independently: one instant per render means every row on the
  // page agrees about what "now" is.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const [polling, setPolling] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Set on unmount so an in-flight poll stops touching state after the view is
  // switched away from — the same guard case-summary.tsx uses.
  const cancelled = useRef(false);
  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const pollRun = useCallback(
    async (runId: string) => {
      const startedAt = Date.now();
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelled.current) return;
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
          setRefreshError("The sync is taking longer than expected. Reload in a minute.");
          return;
        }
        let run;
        try {
          run = await fetchRun({ data: { runId } });
        } catch (error) {
          if (cancelled.current) return;
          setRefreshError(getErrorMessage(error));
          return;
        }
        if (cancelled.current) return;
        if (!run || run.status === "running") continue;

        // Terminal either way: pull the table fresh so the new counts land, and
        // let the freshness bar render the outcome from the run row itself.
        await qc.invalidateQueries({ queryKey: ["correspondence"] });
        if (run.status === "failed") {
          setRefreshError(run.error ?? "The sync reported a failure with no detail.");
        } else {
          toast.success(
            run.rows_written > 0
              ? `Synced — ${run.rows_written} new ${run.rows_written === 1 ? "message" : "messages"}.`
              : "Synced — nothing new since the last run.",
          );
        }
        return;
      }
    },
    [fetchRun, qc],
  );

  const refresh = useMutation({
    mutationFn: () => requestSync(),
    onMutate: () => {
      setRefreshError(null);
    },
    onSuccess: async (result) => {
      if (!result.ok) {
        setRefreshError(result.message);
        return;
      }
      // The webhook returns as soon as n8n has queued the run, so the button
      // stays busy through the poll rather than going idle on a run that has
      // not started producing rows yet.
      setPolling(true);
      // Show the 'running' row immediately: the freshness bar reads sync_runs,
      // so this is what turns the line into "Refreshing now…".
      await qc.invalidateQueries({ queryKey: ["correspondence"] });
      try {
        await pollRun(result.runId);
      } finally {
        if (!cancelled.current) setPolling(false);
      }
    },
    onError: (error) => {
      if (isAuthSessionError(error)) {
        navigate({ to: "/login", replace: true });
        return;
      }
      setRefreshError(getErrorMessage(error));
    },
  });

  if (overviewQ.isLoading) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">
          Loading correspondence…
        </CardContent>
      </Card>
    );
  }

  if (overviewQ.error && !isAuthSessionError(overviewQ.error)) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-destructive">
          Could not load correspondence: {getErrorMessage(overviewQ.error)}
        </CardContent>
      </Card>
    );
  }

  const data = overviewQ.data;
  if (!data) return null;

  return (
    <CorrespondenceTable
      rows={data.rows}
      lastRun={data.lastRun}
      refreshConfigured={data.refreshConfigured}
      onRefresh={() => refresh.mutate()}
      refreshing={refresh.isPending || polling}
      refreshError={refreshError}
      now={now}
      unmatched={data.unmatched}
    />
  );
}
