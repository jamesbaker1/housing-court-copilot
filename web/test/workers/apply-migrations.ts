// Workers-pool setup: apply ../../migrations to the test D1 once before the
// suites run. The parsed migrations are surfaced to the worker via the
// TEST_MIGRATIONS binding (see vitest.workers.config.ts), and `applyD1Migrations`
// (from cloudflare:test, available only inside the pool) records state in the
// d1_migrations table so re-runs are idempotent.
import { applyD1Migrations, env } from "cloudflare:test";

import { beforeAll } from "vitest";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
