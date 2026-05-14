import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import {
  getClientTracking,
  type PublicTrackingData,
  type PublicTrackingErrorCode,
} from "@/lib/jobs.functions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, Calendar, Check, Clock, MessageSquare, ShieldCheck } from "lucide-react";
import logo from "@/assets/mygreektax-mark.svg";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { isJobStatus, isOverdueEligibleStatus, type JobStatus } from "@/lib/airtable-shared";

export const Route = createFileRoute("/track/$token")({
  component: TrackPage,
  head: () => ({
    meta: [
      { title: "Track your job · MyGreekTax" },
      { name: "description", content: "Live status of your tax service with MyGreekTax." },
      { name: "robots", content: "noindex, nofollow, noarchive" },
      { httpEquiv: "Cache-Control", content: "no-store, no-cache, max-age=0, must-revalidate" },
      { httpEquiv: "Pragma", content: "no-cache" },
      { httpEquiv: "Expires", content: "0" },
    ],
  }),
});

const PUBLIC_TRACKING_STAGES = [
  "Pending",
  "Paid",
  "In Progress",
  "Delivered",
  "Completed",
] as const;

type PublicTrackingStage = (typeof PUBLIC_TRACKING_STAGES)[number];
type PublicTrackingStatus = PublicTrackingStage | "Cancelled";

const PUBLIC_TRACKING_STATUS_MAP: Record<JobStatus, PublicTrackingStatus> = {
  "To Assign": "Pending",
  Pending: "Pending",
  Paid: "Paid",
  "In Progress": "In Progress",
  Delivered: "Delivered",
  Invoiced: "Delivered",
  Completed: "Completed",
  "Cancelled / NMF": "Cancelled",
};

const PUBLIC_TRACKING_PROGRESS: Record<PublicTrackingStage, number> = {
  Pending: 10,
  Paid: 35,
  "In Progress": 60,
  Delivered: 85,
  Completed: 100,
};

function getPublicTrackingStatus(status: string): PublicTrackingStatus {
  return isJobStatus(status) ? PUBLIC_TRACKING_STATUS_MAP[status] : "Pending";
}

function getPublicTrackingProgress(status: PublicTrackingStage) {
  return PUBLIC_TRACKING_PROGRESS[status];
}

function isPublicTrackingCancelled(status: PublicTrackingStatus) {
  return status === "Cancelled";
}

function getRemaining(sla: string | null | undefined, status: string) {
  if (!sla) return null;
  if (status === "Completed") return { label: "Completed", tone: "success" as const };
  if (status === "Cancelled") {
    return { label: "Cancelled", tone: "neutral" as const };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sla);
  const due = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(sla);
  if (isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (!isOverdueEligibleStatus(status)) {
    return { label: status, tone: "neutral" as const };
  }
  if (days < 0)
    return {
      label: `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`,
      tone: "danger" as const,
    };
  if (days === 0) return { label: "Due today", tone: "warning" as const };
  if (days === 1) return { label: "Due tomorrow", tone: "warning" as const };
  return { label: `${days} days remaining`, tone: "default" as const };
}

function statusTone(status: string) {
  if (status === "Completed" || status === "Paid") return "success";
  if (status === "Cancelled") return "danger";
  if (status === "Pending") return "warning";
  return "brand";
}

function TrackPage() {
  const { token } = Route.useParams();
  const fetchTracking = useServerFn(getClientTracking);
  const { data, isLoading, error } = useQuery({
    queryKey: ["track", token],
    queryFn: () => fetchTracking({ data: { token } }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
  });

  return (
    <div className="min-h-screen" style={{ background: "var(--gradient-hero)" }}>
      <BrandHeader />
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6 sm:pt-10">
        {isLoading && <LoadingState />}
        {error && <ErrorState errorCode="temporary_unavailable" />}
        {data && !data.ok && <ErrorState errorCode={data.errorCode} />}
        {data?.ok && <TrackContent data={data} />}
      </main>
      <footer className="mx-auto max-w-2xl px-4 pb-8 text-center text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          Secured tracking link · MyGreekTax
        </span>
      </footer>
    </div>
  );
}

function BrandHeader() {
  return (
    <header className="border-b border-border/40 bg-background/40 backdrop-blur-sm">
      <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-4">
        <div className="flex items-center gap-2.5">
          <img src={logo} alt="MyGreekTax" width={36} height={36} className="h-9 w-9 rounded-md" />
          <span className="font-serif text-lg font-semibold tracking-tight">
            <span className="text-olive">My</span>
            <span className="italic">Greek</span>
            <span className="text-brand">Tax</span>
          </span>
        </div>
        <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Job tracker
        </span>
      </div>
    </header>
  );
}

function LoadingState() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function ErrorState({ errorCode }: { errorCode: PublicTrackingErrorCode }) {
  const message =
    errorCode === "expired"
      ? "This tracking link has expired. Please contact your accountant for a new link."
      : errorCode === "revoked"
        ? "This tracking link is no longer available. Please contact your accountant for a new link."
        : errorCode === "temporary_unavailable"
          ? "This tracking page is temporarily unavailable. Please try again in a few minutes."
          : "This tracking link is invalid. Please contact your accountant for a new link.";

  return (
    <Card className="border-border/60">
      <CardContent className="py-10 text-center">
        <h1 className="text-xl font-semibold">Link not available</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">{message}</p>
      </CardContent>
    </Card>
  );
}

function TrackContent({ data }: { data: PublicTrackingData }) {
  const publicStatus = getPublicTrackingStatus(data.status);
  const isCancelled = isPublicTrackingCancelled(publicStatus);
  const publicProgress = isCancelled
    ? 0
    : getPublicTrackingProgress(publicStatus as PublicTrackingStage);
  const currentIndex = isCancelled
    ? -1
    : PUBLIC_TRACKING_STAGES.findIndex((stage) => stage === publicStatus);
  const remaining = getRemaining(data.sla, publicStatus);
  const tone = statusTone(publicStatus);

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <section className="space-y-2">
        {data.jobCode && (
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            {data.jobCode}
          </div>
        )}
        <h1 className="font-serif text-3xl font-medium tracking-tight sm:text-[2.5rem] sm:leading-[1.1]">
          Hello <span className="italic">{data.clientName}</span>
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          {data.detailsLimited ? (
            "Your secure tracking link is valid."
          ) : (
            <>
              Here is the live status of{" "}
              <span className="font-medium text-foreground">{data.serviceName}</span>.
            </>
          )}
        </p>
      </section>

      {data.detailsLimited && (
        <Alert className="border-warning/40 bg-warning/5 text-foreground">
          <AlertCircle className="h-4 w-4 text-warning" />
          <AlertTitle>Live tracking details are temporarily unavailable</AlertTitle>
          <AlertDescription>
            Your secure link is valid, but we could not load the latest job details right now.
            Please try again in a few minutes.
          </AlertDescription>
        </Alert>
      )}

      {!data.detailsLimited &&
        (isCancelled ? (
          <Card
            className="overflow-hidden border-border/60"
            style={{ boxShadow: "var(--shadow-soft)" }}
          >
            <CardContent className="space-y-4 p-5 sm:p-7">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                Current status
              </div>
              <div className="flex items-start gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-4">
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
                <div className="space-y-1">
                  <div className="font-serif text-2xl font-medium tracking-tight">
                    {publicStatus}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    This service request has been cancelled. Please contact MyGreekTax if you need
                    any help.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card
            className="overflow-hidden border-border/60"
            style={{ boxShadow: "var(--shadow-soft)" }}
          >
            <CardContent className="space-y-6 p-5 sm:p-7">
              <div className="flex items-end justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wider text-muted-foreground">
                    Current status
                  </div>
                  <div className="mt-1.5 flex items-center gap-2.5">
                    <span
                      className={cn(
                        "inline-flex h-2.5 w-2.5 rounded-full",
                        tone === "success" && "bg-success",
                        tone === "warning" && "bg-warning",
                        tone === "danger" && "bg-destructive",
                        tone === "brand" && "bg-brand",
                      )}
                    />
                    <span className="font-serif text-2xl font-medium tracking-tight">
                      {publicStatus}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-serif text-3xl font-medium tabular-nums tracking-tight">
                    {publicProgress}
                    <span className="text-base text-muted-foreground">%</span>
                  </div>
                  <div className="text-xs text-muted-foreground">complete</div>
                </div>
              </div>

              <Stepper currentIndex={currentIndex} progress={publicProgress} />
            </CardContent>
          </Card>
        ))}

      {!data.detailsLimited && (
        <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
          <CardContent className="grid grid-cols-1 divide-y divide-border/60 p-0 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <DateCell
              icon={<Calendar className="h-4 w-4" />}
              label="Started"
              value={formatDate(data.dateSent)}
            />
            <DateCell
              icon={<Clock className="h-4 w-4" />}
              label="Expected by"
              value={formatDate(data.sla)}
            />
            <DateCell
              icon={<Clock className="h-4 w-4" />}
              label="Time remaining"
              value={remaining?.label ?? "—"}
              valueClassName={cn(
                remaining?.tone === "danger" && "text-destructive",
                remaining?.tone === "neutral" && "text-muted-foreground",
                remaining?.tone === "warning" && "text-warning",
                remaining?.tone === "success" && "text-success",
              )}
            />
          </CardContent>
        </Card>
      )}

      <Card
        className="border-border/60 bg-background/85"
        style={{ boxShadow: "var(--shadow-soft)" }}
      >
        <CardContent className="flex items-start gap-3 p-4 text-sm text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <p>
            This secure link records basic access information to help MyGreekTax confirm delivery
            and protect client service records.
          </p>
        </CardContent>
      </Card>

      {/* Client-visible note only */}
      {data.clientVisibleNote && !data.detailsLimited && (
        <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-serif text-base font-medium">
              <MessageSquare className="h-4 w-4 text-brand" />
              Latest update from MyGreekTax
            </CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {data.clientVisibleNote}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function DateCell({
  icon,
  label,
  value,
  valueClassName,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="p-4 sm:p-5">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn("mt-1.5 text-sm font-medium", valueClassName)}>{value}</div>
    </div>
  );
}

function Stepper({ currentIndex, progress }: { currentIndex: number; progress: number }) {
  // Clamp the connector fill so it visually aligns with current step
  const fillPct =
    currentIndex < 0
      ? Math.min(progress, 8)
      : Math.min(100, (currentIndex / (PUBLIC_TRACKING_STAGES.length - 1)) * 100 + 6);

  return (
    <div>
      <div className="relative">
        {/* Track */}
        <div className="absolute left-3 right-3 top-3 h-0.5 -translate-y-1/2 rounded-full bg-muted" />
        {/* Fill */}
        <div
          className="absolute left-3 top-3 h-0.5 -translate-y-1/2 rounded-full bg-brand transition-all"
          style={{ width: `calc((100% - 1.5rem) * ${fillPct} / 100)` }}
        />
        <ol className="relative flex items-start justify-between gap-1">
          {PUBLIC_TRACKING_STAGES.map((s, i) => {
            const done = i < currentIndex;
            const current = i === currentIndex;
            return (
              <li key={s} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                <span
                  className={cn(
                    "relative z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold transition-all",
                    done && "border-brand bg-brand text-brand-foreground",
                    current && "border-brand bg-background text-brand ring-4 ring-brand/15",
                    !done && !current && "border-border bg-background text-muted-foreground",
                  )}
                >
                  {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
                </span>
                <span
                  className={cn(
                    "text-center text-[10px] leading-tight sm:text-xs",
                    current && "font-semibold text-foreground",
                    done && "text-foreground/80",
                    !done && !current && "text-muted-foreground",
                  )}
                >
                  {s}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
