import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { setTheme, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Light and dark switch for the public client pages, which render no
 * application nav and so have nowhere else to put one.
 *
 * The icon is withheld until after hydration. The server has no idea which
 * theme this visitor will land on, so rendering one immediately guarantees it
 * is wrong for somebody and produces a visible flip. An empty button of the
 * right size holds the layout still instead.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => setIsHydrated(true), []);

  return (
    <button
      type="button"
      onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground",
        "transition-colors hover:bg-accent hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {isHydrated ? (
        theme === "dark" ? (
          <Sun className="h-4 w-4" />
        ) : (
          <Moon className="h-4 w-4" />
        )
      ) : null}
    </button>
  );
}
