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

/** Minimal R2 surface the cron uses to purge a deleted case's evidence prefix. */
interface CronR2Bucket {
  list(opts?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
  delete(key: string | string[]): Promise<void>;
}

interface CronEnv {
  DB?: unknown;
  /** Evidence blob store — purged in lockstep with the D1 retention purge. */
  EVIDENCE_BUCKET?: CronR2Bucket;
  /** Ops/attorney gate forwarded to the court-source connector (see wrangler.toml). */
  COURT_DATA_VENDOR_AUTHORITATIVE?: string;
  /**
   * Dead-man-switch endpoint for the retention purge (healthchecks.io-style).
   * On a SUCCESSFUL purge run we GET this URL as a heartbeat; on a FAILED run we
   * GET `<url>/fail`. When the monitor stops receiving heartbeats it alerts ops
   * — so a silently broken or non-running cron is caught, not just a loud throw.
   * Unset => no ping (safe no-op for envs without a monitor configured).
   */
  HEALTHCHECK_PURGE_URL?: string;
}

interface ScheduledController {
  cron: string;
  scheduledTime: number;
}

interface ExecutionCtx {
  waitUntil(p: Promise<unknown>): void;
}

/**
 * Minimal shape of a Cloudflare Email Workers inbound message (avoids a hard dep
 * on @cloudflare/workers-types here). `raw` is the full RFC-822 message stream;
 * `setReject` bounces the message back to the sender with a reason.
 */
interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/** Read the raw RFC-822 stream into a string (bounded by rawSize). */
async function readRawEmail(message: EmailMessage): Promise<string> {
  const reader = message.raw.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8").decode(merged);
}

/**
 * Fire a dead-man-switch heartbeat for the retention purge. `ok=false` pings the
 * healthchecks.io-style `/fail` sub-path so the monitor records an explicit
 * failure. No-op (resolves) when no URL is configured. Best-effort: a ping that
 * fails (network/monitor down) is logged but never propagated — the purge result
 * is the source of truth, the ping is only observability.
 */
async function pingPurgeHealthcheck(
  url: string | undefined,
  ok: boolean,
): Promise<void> {
  if (!url) return; // monitor not configured — silent no-op.
  const target = ok ? url : `${url.replace(/\/$/, "")}/fail`;
  try {
    await fetch(target, { method: "GET" });
  } catch (err) {
    console.error("[cron] purge healthcheck ping failed:", err);
  }
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
        // No DB binding to purge against — this is a misconfigured run, not a
        // healthy one; signal failure so the monitor does not record a success.
        console.error("[cron] retention purge skipped: no DB binding");
        ctx.waitUntil(pingPurgeHealthcheck(env.HEALTHCHECK_PURGE_URL, false));
        return;
      }
      try {
        const { runRetentionPurge, sweepEphemeral } = await import("./lib/retention");
        const report = await runRetentionPurge(db as never);
        await sweepEphemeral(db as never);
        // The purge distinguishes a scan failure from an empty run: report.error
        // means the top-level scan SELECT failed and the run did NOT actually
        // purge. Do NOT send a success heartbeat in that case.
        if (report.error) {
          console.error(
            `[cron] retention purge errored cron=${controller.cron} ` +
              `error=${report.error}`,
          );
          ctx.waitUntil(pingPurgeHealthcheck(env.HEALTHCHECK_PURGE_URL, false));
          return;
        }
        // Purge the R2 evidence blobs for every case that was just deleted, so
        // tenant PII bytes don't outlive the case row. Raw binding (this handler
        // is outside the Next request context, so the server-only lib can't be
        // used here); content-addressed keys live under evidence/<case_id>/.
        // Best-effort: a per-case failure is logged, never thrown.
        if (env.EVIDENCE_BUCKET && report.purgedCaseIds.length > 0) {
          ctx.waitUntil(
            (async () => {
              let blobs = 0;
              for (const caseId of report.purgedCaseIds) {
                try {
                  const { objects } = await env.EVIDENCE_BUCKET!.list({
                    prefix: `evidence/${caseId}/`,
                  });
                  const keys = objects.map((o) => o.key);
                  if (keys.length > 0) {
                    await env.EVIDENCE_BUCKET!.delete(keys);
                    blobs += keys.length;
                  }
                } catch (err) {
                  console.error(`[cron] evidence purge failed for a case:`, err);
                }
              }
              if (blobs > 0) console.log(`[cron] evidence blobs purged=${blobs}`);
            })(),
          );
        }
        // PII-free operational log line.
        console.log(
          `[cron] retention purge done cron=${controller.cron} ` +
            `scanned=${report.scanned} purged=${report.purged} held=${report.held} ` +
            `kept=${report.kept} unparseable=${report.unparseable}`,
        );
        // Positive success heartbeat: the dead-man-switch only stays "up" while
        // these arrive, so a cron that stops running (or fails) is detected.
        ctx.waitUntil(pingPurgeHealthcheck(env.HEALTHCHECK_PURGE_URL, true));
      } catch (err) {
        console.error("[cron] retention purge failed:", err);
        ctx.waitUntil(pingPurgeHealthcheck(env.HEALTHCHECK_PURGE_URL, false));
      }
    })();
    ctx.waitUntil(job);
    await job;
  },

  // -------------------------------------------------------------------------
  // Email: inbound eTrack appointment-REMINDER ingest (ROADMAP Tier-2 #6).
  //
  // LEGITIMATE CHANNEL ONLY. eTrack EMAILS the registrant when a case they
  // registered has an appearance; the operator routes those reminder emails to
  // this Worker via Cloudflare Email Routing (see wrangler.toml). We parse the
  // sanctioned email — we do NOT scrape the eTrack/eCourts web portal.
  //
  // Flow: guard sender domain -> hand the raw email to the eTrack adapter parser
  // (Adapters phase) -> the connector finds the matching case by index # and
  // routes the date through lib/court-date.setCourtDate (INVARIANT #2: only that
  // sink may set court_date_verified; a discrepancy escalates, never overwrites).
  //
  // Never throws out of the handler. On an unrecognized/unauthorized sender we
  // reject (bounce) so misrouted mail does not silently disappear.
  // -------------------------------------------------------------------------
  async email(
    message: EmailMessage,
    env: CronEnv,
    ctx: ExecutionCtx,
  ): Promise<void> {
    const job = (async () => {
      try {
        // Load the eTrack adapter (Adapters phase owns the file under
        // ./lib/court-source/adapters/). The specifier is built indirectly so
        // typecheck does not require the not-yet-created file to resolve
        // statically; at runtime Wrangler bundles the real adapter. If it is
        // absent, degrade to no-op.
        let adapter: import("./lib/court-source").EtrackEmailAdapterModule | null =
          null;
        try {
          const adapterPath = "./lib/court-source/adapters/etrack-email";
          const mod = (await import(/* @vite-ignore */ adapterPath)) as unknown;
          adapter = mod as import("./lib/court-source").EtrackEmailAdapterModule;
        } catch {
          console.warn(
            "[email] eTrack adapter not wired yet (Adapters phase); dropping message",
          );
          return;
        }

        // Sender-domain guard: only process mail from the expected eTrack sender.
        if (!adapter.isAllowedEtrackSender(message.from)) {
          console.warn("[email] rejected: sender not an allowed eTrack domain");
          message.setReject("Sender not recognized as NY Courts eTrack.");
          return;
        }

        const raw = await readRawEmail(message);
        const subject = message.headers.get("subject");
        const parsed = adapter.parseEtrackEmail({
          from: message.from,
          raw,
          subject,
        });
        if (!parsed.parsed) {
          console.warn(`[email] not a recognizable eTrack reminder: ${parsed.reason}`);
          return;
        }

        const { ingestSourcedCourtDate } = await import("./lib/court-source");
        const result = await ingestSourcedCourtDate({
          index_number: parsed.index_number,
          hit: {
            found: true,
            date: parsed.court_date,
            source: "etrack-email",
            part: parsed.part ?? null,
            index_number: parsed.index_number,
            confidence: parsed.confidence,
          },
          vendorAuthoritative: env.COURT_DATA_VENDOR_AUTHORITATIVE === "true",
        });

        // PII-free operational log (no names, no addresses, no index number).
        if (!result.matched) {
          console.log(`[email] eTrack ingest: ${result.note}`);
        } else {
          console.log(
            `[email] eTrack ingest done case=${result.case_id} ` +
              `outcome=${result.outcome.status}`,
          );
        }
      } catch (err) {
        // NEVER throw out of the email handler.
        console.error("[email] eTrack ingest failed:", err);
      }
    })();
    ctx.waitUntil(job);
    await job;
  },
};
