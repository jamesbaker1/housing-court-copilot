/**
 * Cloudflare Worker ENTRY (Ops-owned). This thin wrapper exists ONLY so we can
 * add a `scheduled()` (Cron Trigger) handler on top of the OpenNext-generated
 * Next.js worker, which exports `fetch` + its Durable Object classes but no
 * scheduled handler.
 *
 * WHY A WRAPPER: `.open-next/worker.js` is regenerated on every build and is
 * gitignored, so we must not edit it. Instead `wrangler.toml` points `main` at
 * THIS file; we re-export the generated worker's default `fetch` and every
 * Durable Object binding unchanged, and only ADD `scheduled`. All HTTP behavior
 * is therefore identical to stock OpenNext; the cron is purely additive.
 *
 * The `scheduled()` event runs OUTSIDE the Next.js request context, so it gets
 * the raw `env` (incl. env.DB) directly and calls the deterministic retention
 * purge (lib/retention) against the D1 binding. It must never throw out of the
 * handler (Cron retries are noisy); failures are caught and logged.
 *
 * Build note: the import path resolves after `opennextjs-cloudflare build`
 * emits `.open-next/worker.js`. The `@ts-expect-error` mirrors how the generated
 * worker imports its own build artifacts.
 */

// Typed via worker-entry.d.ts (ambient module). Wrangler resolves the real
// emitted artifact at build time; the declaration keeps typecheck deterministic
// whether or not `.open-next/` has been built yet.
import openNextWorker, * as openNextExports from "./.open-next/worker.js";

// Re-export the OpenNext Durable Object classes (queue / tag cache / cache
// purge) so the Workers runtime can still bind them. Spreading the module's
// named exports keeps this correct even if OpenNext adds/renames DO classes.
export const {
  DOQueueHandler,
  DOShardedTagCache,
  BucketCachePurge,
} = openNextExports as Record<string, unknown>;

interface CronEnv {
  DB?: unknown;
}

interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

interface ExecutionCtx {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  // HTTP: delegate verbatim to the OpenNext worker.
  fetch: (openNextWorker as { fetch: (...a: unknown[]) => Promise<Response> }).fetch,

  // Cron: deterministic PII retention purge + ephemeral-table sweep.
  async scheduled(
    controller: ScheduledController,
    env: CronEnv,
    ctx: ExecutionCtx,
  ): Promise<void> {
    const job = (async () => {
      const db = env.DB;
      if (!db) {
        console.warn("[cron] retention purge skipped: no DB binding");
        return;
      }
      try {
        const { runRetentionPurge, sweepEphemeral } = await import("./lib/retention");
        const report = await runRetentionPurge(db as never);
        await sweepEphemeral(db as never);
        // PII-free operational log line.
        console.log(
          `[cron] retention purge done cron=${controller.cron} ` +
            `scanned=${report.scanned} purged=${report.purged} held=${report.held} ` +
            `kept=${report.kept} unparseable=${report.unparseable}`,
        );
      } catch (err) {
        console.error("[cron] retention purge failed:", err);
      }
    })();
    ctx.waitUntil(job);
    await job;
  },
};
