import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ShieldCheck } from "lucide-react";
import logo from "@/assets/mygreektax-mark.svg";

export const Route = createFileRoute("/")({
  component: Index,
  head: () => ({
    meta: [
      { title: "MyGreekTax · Partner Workspace" },
      {
        name: "description",
        content: "Dedicated partner workspace for MyGreekTax accountants and admins.",
      },
      { property: "og:title", content: "MyGreekTax · Partner Workspace" },
      {
        property: "og:description",
        content: "Dedicated partner workspace for MyGreekTax accountants and admins.",
      },
    ],
  }),
});

function Index() {
  return (
    <div className="min-h-screen" style={{ background: "var(--gradient-hero)" }}>
      <BrandHeader />
      <main className="mx-auto max-w-2xl px-4 pb-16 pt-10 sm:pt-16">
        <section className="space-y-5 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            Dedicated Partner Workspace
          </div>
          <h1 className="font-serif text-4xl font-medium tracking-tight sm:text-5xl sm:leading-[1.1]">
            Welcome to <span className="italic">MyGreekTax</span> Ops
          </h1>
          <p className="mx-auto max-w-md text-sm sm:text-base text-muted-foreground">
            Sign in to manage your jobs, clients, and deliverables.
          </p>
          <div className="flex justify-center gap-3 pt-2">
            <Button asChild>
              <Link to="/login">Partner Login</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/login">Admin Login</Link>
            </Button>
          </div>
          <p className="pt-6 text-sm text-muted-foreground">
            Are you a customer? Use the tracking link sent to you directly—no sign-in required.
          </p>
        </section>
      </main>
      <footer className="mx-auto max-w-2xl px-4 pb-8 text-center text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" />
          MyGreekTax · Partner Workspace
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
          Partner Workspace
        </span>
      </div>
    </header>
  );
}
