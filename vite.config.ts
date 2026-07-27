// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  // `cloudflare:workers` is a runtime-provided virtual module (waitUntil), not a
  // bundleable dependency. Mark it external so Rollup leaves the import intact
  // for the Workers runtime to resolve, instead of failing the build trying to
  // resolve it. The Cloudflare runtime provides it at execution time.
  vite: {
    build: {
      rollupOptions: {
        external: ["cloudflare:workers"],
      },
    },
  },
});
