import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * WORKERS project — D1-backed auth + route round-trip tests (Invariants:
 * /api/cases/[id] boundary auth fail-closed, IDOR, no-existence-oracle, token
 * hashing/revocation). Runs inside @cloudflare/vitest-pool-workers (workerd +
 * a real Miniflare D1), which is the only way to exercise lib/auth/session.ts
 * and the route against a live `env.DB`.
 *
 * This is a SEPARATE project from the node project on purpose: if the workers
 * pool cannot execute in a given sandbox (it needs to download/launch the
 * workerd runtime), `npm test` (the node project) is unaffected. Run it with
 * `npm run test:workers`.
 *
 * Migrations from ../migrations are applied to the test D1 in a setup file
 * (test/workers/setup.ts) via the SELF binding exposed by the pool.
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(rootDir, "migrations"));

  return {
    resolve: {
      alias: {
        // server-only is a Next build guard; harmless empty module under tests.
        "server-only": path.resolve(rootDir, "test/shims/server-only.ts"),
        "@": rootDir,
      },
    },
    test: {
      name: "workers",
      include: ["test/workers/**/*.test.ts"],
      setupFiles: ["test/workers/apply-migrations.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./test/workers/wrangler.test.toml" },
          miniflare: {
            // Surface the parsed migrations to the setup file via a binding.
            bindings: { TEST_MIGRATIONS: migrations },
            compatibilityFlags: ["nodejs_compat"],
          },
        },
      },
    },
  };
});
