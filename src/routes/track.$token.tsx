import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getClientTracking } from "@/lib/jobs.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export const Route = createFileRoute("/track/$token")({ component: TrackPage });

const STAGES = ["Sent", "In Progress", "Delivered", "Invoiced", "Paid", "Completed"];

function TrackPage() {
  const { token } = Route.useParams();
  const fetchTracking = useServerFn(getClientTracking);
  const { data, isLoading, error } = useQuery({
    queryKey: ["track", token],
    queryFn: () => fetchTracking({ data: { token } }),
  });

  if (isLoading) return <p className="mx-auto max-w-2xl px-4 py-12 text-sm text-muted-foreground">Loading…</p>;
  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-12">
        <h1 className="text-xl font-semibold">Link not available</h1>
        <p className="mt-2 text-sm text-muted-foreground">{(error as Error).message}</p>
      </div>
    );
  }
  if (!data) return null;

  const currentIndex = STAGES.indexOf(data.status);

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 space-y-6">
      <div>
        <p className="text-sm text-muted-foreground">My Greek Tax · Job tracker</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Hello {data.clientName}</h1>
        <p className="mt-1 text-muted-foreground">
          Here is the live status of <span className="font-medium text-foreground">{data.serviceName}</span>{" "}
          ({data.jobCode}).
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Progress</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="mb-2 flex items-baseline justify-between text-sm">
              <span className="font-medium">{data.status}</span>
              <span className="text-muted-foreground">{data.progress}%</span>
            </div>
            <Progress value={data.progress} />
          </div>
          <ol className="space-y-2 text-sm">
            {STAGES.map((s, i) => (
              <li key={s} className="flex items-center gap-2">
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    i <= currentIndex && currentIndex >= 0 ? "bg-primary" : "bg-muted"
                  }`}
                />
                <span className={i <= currentIndex && currentIndex >= 0 ? "" : "text-muted-foreground"}>
                  {s}
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 py-4 text-sm">
          <div><div className="text-muted-foreground">Started</div><div>{data.dateSent ?? "—"}</div></div>
          <div><div className="text-muted-foreground">Expected by</div><div>{data.sla ?? "—"}</div></div>
        </CardContent>
      </Card>

      {data.notes && (
        <Card>
          <CardHeader><CardTitle className="text-base">Latest update</CardTitle></CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm">{data.notes}</CardContent>
        </Card>
      )}
    </div>
  );
}