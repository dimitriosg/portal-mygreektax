import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getPreviewTrackingTestLink, isWorkersPreviewOrigin } from "@/lib/tracking-links";
import { cn } from "@/lib/utils";

export function TrackingLinkPreviewNotice({
  className,
  sampleToken,
}: {
  className?: string;
  sampleToken?: string;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!isWorkersPreviewOrigin()) return;
    setPreviewUrl(getPreviewTrackingTestLink(sampleToken ?? "<token>"));
  }, [sampleToken]);

  if (!previewUrl) return null;

  return (
    <Alert className={cn("border-warning/40 bg-warning/5 text-foreground", className)}>
      <AlertTriangle className="h-4 w-4 text-warning" />
      <AlertTitle>Preview tracking links still copy production URLs</AlertTitle>
      <AlertDescription>
        Copied tracking links continue to use https://portal.mygreektax.eu for client safety. To
        test this preview deployment, open the URL below manually with a valid token.
        <span className="mt-2 block overflow-x-auto rounded-md bg-slate-950 px-3 py-2 font-mono text-xs text-slate-50 select-all">
          {previewUrl}
        </span>
      </AlertDescription>
    </Alert>
  );
}
