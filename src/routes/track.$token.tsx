import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { getClientTracking } from "@/lib/jobs.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, Calendar, Clock, ShieldCheck, MessageSquare } from "lucide-react";
import logo from "@/assets/mygreektax-mark.svg";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";

export const Route = createFileRoute("/track/$token")({
  component: TrackPage,
  head: () => ({
    meta: [
      { title: "Track your job · MyGreekTax" },
      { name: "description", content: "Live status of your tax service with MyGreekTax." },
    ],
  }),
});

const STAGES = [
  "To Assign",
  "Pending",
  "Paid",
  "In Progress",
  "Delivered",
  "Invoiced",
  "Completed",
];

function getRemaining(sla: string | null | undefined, status: string) {
  if (!sla) return null;
  if (status === "Completed") return { label: "Completed", tone: "success" as const };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(sla);
  const due = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(sla);
  if (isNaN(due.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const days = Math.round((due.getTime() - today.getTime()) / 86400000);
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
  if (status === "Pending" || status === "To Assign") return "warning";
  return "brand";
}

function TrackPage() {
  const { token } = Route.useParams();
  const fetchTracking = useServerFn(getClientTracking);
  const { data, isLoading, error } = useQuery({
    queryKey: ["track", token],
    queryFn: () => fetchTracking({ data: { token } }),
  });

  const tracked = useRef(false);
  useEffect(() => {
    if (tracked.current || !data) return;
    tracked.current = true;
    track("tracking_link_opened", { status: data.status ?? "unknown" });
  }, [data]);

  return (
    <div className="min-h-screen" style={{ background: "var(--gradient-hero)" }}>
      <BrandHeader />
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-6 sm:pt-10">
        {isLoading && <LoadingState />}
        {error && <ErrorState />}
        {data && <TrackContent data={data} />}
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

function ErrorState() {
  return (
    <Card className="border-border/60">
      <CardContent className="py-10 text-center">
        <h1 className="text-xl font-semibold">Link not available</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          This tracking link is invalid or has expired. Please contact your accountant for a new
          link.
        </p>
      </CardContent>
    </Card>
  );
}

type TrackData = {
  clientName: string;
  jobCode: string;
  serviceName: string;
  status: string;
  progress: number;
  sla: string | null;
  dateSent: string | null;
  notes: string;
};

function TrackContent({ data }: { data: TrackData }) {
  const currentIndex = STAGES.indexOf(data.status);
  const remaining = getRemaining(data.sla, data.status);
  const tone = statusTone(data.status);

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <section className="space-y-2">
        <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          {data.jobCode}
        </div>
        <h1 className="font-serif text-3xl font-medium tracking-tight sm:text-[2.5rem] sm:leading-[1.1]">
          Hello <span className="italic">{data.clientName}</span>
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          Here is the live status of{" "}
          <span className="font-medium text-foreground">{data.serviceName}</span>.
        </p>
      </section>

      {/* Progress card */}
      <Card
        className="border-border/60 overflow-hidden"
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
                    tone === "brand" && "bg-brand",
                  )}
                />
                <span className="font-serif text-2xl font-medium tracking-tight">
                  {data.status}
                </span>
              </div>
            </div>
            <div className="text-right">
              <div className="font-serif text-3xl font-medium tabular-nums tracking-tight">
                {data.progress}
                <span className="text-base text-muted-foreground">%</span>
              </div>
              <div className="text-xs text-muted-foreground">complete</div>
            </div>
          </div>

          <Stepper currentIndex={currentIndex} progress={data.progress} />
        </CardContent>
      </Card>

      {/* Dates */}
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
              remaining?.tone === "warning" && "text-warning",
              remaining?.tone === "success" && "text-success",
            )}
          />
        </CardContent>
      </Card>

      {/* Notes */}
      {data.notes && (
        <Card className="border-border/60" style={{ boxShadow: "var(--shadow-soft)" }}>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 font-serif text-base font-medium">
              <MessageSquare className="h-4 w-4 text-brand" />
              Latest update from your accountant
            </CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {data.notes}
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
      : Math.min(100, (currentIndex / (STAGES.length - 1)) * 100 + 6);

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
          {STAGES.map((s, i) => {
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
