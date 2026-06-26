// Type shim for the workers-pool test suite (test/workers/*).
//
// Two things are needed to typecheck these files with plain `tsc` (the main
// tsconfig.json's `**/*.ts` glob pulls them in) AND inside the
// @cloudflare/vitest-pool-workers runtime:
//
//   1. The `cloudflare:test` virtual module (applyD1Migrations, env, SELF,
//      D1Migration, ...). It is only resolvable at runtime by the pool, so we
//      pull in its ambient declarations here via a triple-slash reference to the
//      installed package types. This is the same module the test files augment
//      with `declare module "cloudflare:test"`.
//
//   2. The `D1Database` worker global. `@cloudflare/workers-types` is not a
//      dependency of this project (each app module declares its own minimal
//      local `interface D1Database` instead — see lib/store.ts, lib/auth/
//      session.ts, lib/ratelimit.ts), so there is no ambient worker global. We
//      declare the minimal surface the tests actually use (prepare/bind/run/
//      first), matching the codebase's established "local minimal interface"
//      pattern. The real Miniflare D1 the pool injects is a superset, so this is
//      sound and stays in sync via the tests themselves.
//
// Nothing here weakens the auth/route invariants; it only provides types so the
// already-passing workers tests compile under the Next.js / tsc typecheck.

/// <reference types="@cloudflare/vitest-pool-workers" />

declare global {
  interface D1Result<T = Record<string, unknown>> {
    results: T[];
    success: boolean;
    meta: Record<string, unknown>;
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
    run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
  }
}

export {};
