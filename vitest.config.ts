import { defineConfig } from "vitest/config";

// Deliberately separate from vite.config.ts. That config builds the Cloudflare
// Worker through @lovable.dev/vite-tanstack-config, and loading the whole app
// pipeline to exercise a pure module would be slow and fragile. Vitest prefers
// this file when it exists, so the app config is never touched.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
