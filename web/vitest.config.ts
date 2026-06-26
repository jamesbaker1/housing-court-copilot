import { fileURLToPath } from "node:url";
import path from "node:path";

import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * NODE project — pure modules + server-only libraries that have no live
 * Cloudflare binding. This MUST run and pass under `npm test`.
 *
 * `server-only` is aliased to a harmless empty module (test/shims/server-only)
 * because there is no client/server split under Vitest; this matches what
 * Next.js itself does on the server side.
 */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": path.resolve(rootDir, "test/shims/server-only.ts"),
      // next/link is only pulled in transitively (lib/store -> TriageList) for a
      // pure helper; stub the React/Next surface so the import stays cheap.
      "next/link": path.resolve(rootDir, "test/shims/next-link.ts"),
      "@": rootDir,
    },
  },
  test: {
    name: "node",
    environment: "node",
    globals: true,
    include: ["test/unit/**/*.test.ts"],
    // Each suite manages its own env/cwd; keep them isolated.
    isolate: true,
    // A cold first-import transforms a whole lib graph (e.g. lib/store); on a
    // loaded box that can exceed the 10s default. Headroom avoids flaky hook
    // timeouts without masking real hangs.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
