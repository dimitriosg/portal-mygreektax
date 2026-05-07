import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20 text-center">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        My Greek Tax Operations
      </h1>
      <p className="mt-4 text-muted-foreground">
        White-label partner workspace for managing tax service jobs, plus client tracking
        powered by your Airtable operations base.
      </p>
      <div className="mt-8 flex justify-center gap-3">
        <Button asChild>
          <Link to="/login">Partner sign in</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/dashboard">Open dashboard</Link>
        </Button>
      </div>
      <p className="mt-10 text-sm text-muted-foreground">
        Are you a client with a tracking link? Open the link from the email we sent you.
      </p>
    </section>
  );
}
