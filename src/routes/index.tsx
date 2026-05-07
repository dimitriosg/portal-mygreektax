import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <section className="mx-auto max-w-3xl px-6 py-20 text-center">
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl" dangerouslySetInnerHTML={{ __html: "Are you a customer? <br> Open the link from the email we sent you.<br><br>Or, contact us directly for further info." }} />
      <div className="mt-8 flex justify-center gap-3">
        <Button asChild>
          <Link to="/login">Partner sign in</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/dashboard">Open dashboard</Link>
        </Button>
      </div>
    </section>
  );
}
