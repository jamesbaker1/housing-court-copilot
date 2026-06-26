/**
 * PII retention + purge policy (Ops / data-lifecycle). Server-only.
 *
 * REVIEW fix #5: D1 holds a standing trove of tenant PII (names, phones,
 * addresses, arrears, consents, advice-detection logs) that is directly
 * responsive to landlord discovery and — per the SHIELD / immigration-subpoena
 * threat model — to government subpoenas. The mitigation is to NOT keep that
 * data one minute longer than the product needs it. This module is the
 * deterministic purge that a Cloudflare Cron Trigger runs on a schedule.
 *
 * It operates DIRECTLY on the D1 binding (the `scheduled()` Workers event does
 * not run inside the Next.js request context, so getCloudflareContext()/the
 * store's dual-mode dispatch are not available there). The same logic is reused
 * by the owner-initiated tenant delete path, which goes through lib/store
 * deleteCase().
 *
 * HARD RULES (fail-closed toward KEEPING data only when a legal hold says so;
 * fail-closed toward NOT purging when we cannot positively establish a doc is
 * eligible):
 *   1. NEVER purge a case with audit.legal_hold === true. A legal hold beats
 *      every retention window — even an indefinitely old one.
 *   2. Only purge when we can parse the doc AND positively confirm it is past
 *      its retention window. A corrupt/unparseable doc is LEFT IN PLACE (it is
 *      surfaced for human review rather than silently destroyed or silently
 *      kept-forever; deletion of unparseable PII is a separate, audited op).
 *   3. The retention window is selected by audit.data_retention_class so the
 *      "sensitive" class (e.g. immigration-relevant) is held the SHORTEST time.
 *
 * NOTE ON CRYPTO-SHRED: when field-level encryption is enabled (see
 * lib/crypto-field.ts), the strongest "delete" is to destroy the data key so the
 * ciphertext is unrecoverable. v1 ships row deletion (DELETE FROM cases) which
 * is a true delete on D1; the crypto-shred hook is documented in
 * DATA-SECURITY.md and wired through lib/crypto-field for the day a shared key
 * is rotated/destroyed.
 */
// NOTE: intentionally NO `import "server-only"` here. This module is imported by
// the raw Cloudflare `scheduled()` worker entry (worker-entry.ts), bundled by
// esbuild OUTSIDE the Next.js toolchain where the `server-only` shim does not
// resolve. It is server-only by construction (pure D1 access; no React; not on
// any client import path) and is imported only by the worker entry + server code.

// ===========================================================================
// RETENTION CONFIG — the single, clearly-marked place to tune the policy.
// Windows are measured from a case's last activity (updated_at). A case is a
// purge candidate once it is BOTH (a) terminal/inactive and (b) older than the
// window for its data_retention_class.
// ===========================================================================

export const RETENTION_CONFIG = {
  /**
   * Days of inactivity after which a case in each retention class becomes a
   * purge candidate. "sensitive" (immigration-relevant / opt-in sensitive data)
   * is held the SHORTEST time; "standard" the default; an unset class uses
   * `standard`. Tune here and nowhere else.
   */
  windowDaysByClass: {
    sensitive: 90, // ~3 months — minimize exposure of the riskiest data
    standard: 365, // 1 year after last activity
    minimized: 365, // minimized cases follow the standard window
  } as const,

  /**
   * A safety floor: regardless of status, an ABANDONED intake (never advanced,
   * no activity) is purged after this many days. Catches the long tail of
   * half-started intakes that never reach a terminal status but still hold
   * whatever PII the tenant entered.
   */
  abandonedIntakeDays: 180,

  /**
   * Statuses considered "terminal/inactive" for retention. `resolved` is the
   * canonical end state. Other statuses are only purged via the abandoned-intake
   * floor above.
   */
  terminalStatuses: ["resolved"] as const,

  /**
   * Max rows to scan per cron run. Keeps each invocation bounded well under the
   * Workers subrequest/CPU ceilings; the cron runs daily so the backlog drains.
   */
  maxScanPerRun: 500,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// --- D1 binding shim (same minimal shape as lib/store.ts) -------------------

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
export interface RetentionD1 {
  prepare(query: string): D1PreparedStatement;
}

const CASE_ID_RE = /^case_[0-9a-hjkmnp-tv-z]{26}$/;

/** The retention-relevant subset of a Case doc (we parse ONLY this, defensively). */
interface RetentionView {
  status?: string;
  updated_at?: string;
  audit?: {
    legal_hold?: boolean;
    data_retention_class?: "standard" | "minimized" | "sensitive" | null;
  };
}

export interface PurgeDecision {
  eligible: boolean;
  /** Human/audit-readable reason (never includes PII). */
  reason: string;
}

/**
 * Pure decision function: given a case's retention view and "now", decide
 * whether it is past its retention window. PII-free and deterministic so it is
 * unit-testable and auditable. NEVER returns eligible for a legal-held case.
 */
export function decidePurge(view: RetentionView, nowMs: number): PurgeDecision {
  // RULE 1 — legal hold always wins.
  if (view.audit?.legal_hold === true) {
    return { eligible: false, reason: "legal_hold" };
  }

  const updatedAt = view.updated_at ? Date.parse(view.updated_at) : NaN;
  if (!Number.isFinite(updatedAt)) {
    // RULE 2 — cannot establish age ⇒ do not purge.
    return { eligible: false, reason: "no_valid_updated_at" };
  }
  const ageDays = (nowMs - updatedAt) / DAY_MS;

  const cls = view.audit?.data_retention_class ?? "standard";
  const windowDays =
    RETENTION_CONFIG.windowDaysByClass[cls] ??
    RETENTION_CONFIG.windowDaysByClass.standard;

  const isTerminal = (RETENTION_CONFIG.terminalStatuses as readonly string[]).includes(
    view.status ?? "",
  );

  if (isTerminal && ageDays >= windowDays) {
    return {
      eligible: true,
      reason: `terminal_${view.status}_past_${cls}_window_${windowDays}d`,
    };
  }

  // Abandoned-intake floor: any non-terminal case untouched for a long time.
  if (!isTerminal && ageDays >= RETENTION_CONFIG.abandonedIntakeDays) {
    return {
      eligible: true,
      reason: `abandoned_${view.status}_past_${RETENTION_CONFIG.abandonedIntakeDays}d`,
    };
  }

  return { eligible: false, reason: "within_retention_window" };
}

export interface PurgeReport {
  scanned: number;
  purged: number;
  held: number; // skipped due to legal_hold
  kept: number; // within window
  unparseable: number; // left in place for human review
  purgedCaseIds: string[];
  startedAt: string;
  finishedAt: string;
  /**
   * Set when the top-level scan SELECT itself failed (D1/limiter down). An
   * errored run did NOT scan the table, so its all-zero counts must NOT be read
   * as "nothing to purge" — callers (the cron heartbeat) MUST treat this as a
   * failed run. `undefined`/absent means the scan ran cleanly.
   */
  error?: string;
}

/**
 * Scan the oldest-touched cases and purge those past their retention window.
 * Operates directly on a D1 binding (usable from the raw `scheduled()` Workers
 * event). Cascades the per-case auth/link rows so a purge leaves no danling PII
 * pointer: case_tokens + case_owners for the purged case_id are removed too.
 *
 * Idempotent and bounded (RETENTION_CONFIG.maxScanPerRun). Never throws to the
 * caller; per-row failures are counted, not fatal. A failure of the top-level
 * scan SELECT is reported (logged at error level + `report.error` set) rather
 * than masked as an all-zero "nothing to purge" run, so the cron heartbeat does
 * not signal success on a broken purge.
 */
export async function runRetentionPurge(
  db: RetentionD1,
  nowMs: number = Date.now(),
): Promise<PurgeReport> {
  const startedAt = new Date(nowMs).toISOString();
  const report: PurgeReport = {
    scanned: 0,
    purged: 0,
    held: 0,
    kept: 0,
    unparseable: 0,
    purgedCaseIds: [],
    startedAt,
    finishedAt: startedAt,
  };

  let rows: { case_id: string; doc: string }[];
  try {
    const res = await db
      .prepare(
        `SELECT case_id, doc FROM cases ORDER BY updated_at ASC LIMIT ?1`,
      )
      .bind(RETENTION_CONFIG.maxScanPerRun)
      .all<{ case_id: string; doc: string }>();
    rows = res.results ?? [];
  } catch (err) {
    // Top-level scan SELECT failed (D1/limiter down) — fail closed toward NOT
    // purging. CRITICAL: do NOT return a silent all-zero report; that is
    // indistinguishable from a healthy "nothing to purge" run and would let the
    // cron heartbeat report success while the purge is actually broken. Log at
    // ERROR level and stamp report.error so the caller can detect the failure.
    console.error("[retention] purge scan SELECT failed:", err);
    report.error =
      err instanceof Error ? err.message : "retention scan SELECT failed";
    report.finishedAt = new Date().toISOString();
    return report;
  }

  for (const r of rows) {
    report.scanned++;
    if (!CASE_ID_RE.test(r.case_id)) {
      report.unparseable++;
      continue;
    }
    let view: RetentionView;
    try {
      view = JSON.parse(r.doc) as RetentionView;
    } catch {
      report.unparseable++;
      continue;
    }

    const decision = decidePurge(view, nowMs);
    if (!decision.eligible) {
      if (decision.reason === "legal_hold") report.held++;
      else if (decision.reason === "no_valid_updated_at") report.unparseable++;
      else report.kept++;
      continue;
    }

    try {
      await db.prepare(`DELETE FROM cases WHERE case_id = ?1`).bind(r.case_id).run();
      // Cascade: remove auth/link rows so no stale pointer to purged PII remains.
      await db.prepare(`DELETE FROM case_tokens WHERE case_id = ?1`).bind(r.case_id).run();
      await db.prepare(`DELETE FROM case_owners WHERE case_id = ?1`).bind(r.case_id).run();
      report.purged++;
      report.purgedCaseIds.push(r.case_id);
    } catch {
      // Per-row failure: leave it for the next run.
      report.kept++;
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/**
 * Opportunistically sweep expired rate-limit + expired/revoked auth rows so the
 * security tables don't grow unbounded. Best-effort; never throws.
 */
export async function sweepEphemeral(
  db: RetentionD1,
  nowMs: number = Date.now(),
): Promise<void> {
  const nowIso = new Date(nowMs).toISOString();
  // Rate-limit windows older than ~1 day (window index is floor(ms/window_ms);
  // we just drop rows last touched > 1 day ago).
  const cutoffIso = new Date(nowMs - DAY_MS).toISOString();
  try {
    await db
      .prepare(`DELETE FROM rate_limits WHERE updated_at < ?1`)
      .bind(cutoffIso)
      .run();
  } catch {
    /* table may not exist in older envs; ignore */
  }
  try {
    await db
      .prepare(`DELETE FROM case_tokens WHERE expires_at IS NOT NULL AND expires_at < ?1`)
      .bind(nowIso)
      .run();
  } catch {
    /* ignore */
  }
  try {
    await db
      .prepare(`DELETE FROM owner_sessions WHERE expires_at < ?1`)
      .bind(nowIso)
      .run();
  } catch {
    /* ignore */
  }
  try {
    await db.prepare(`DELETE FROM otp_codes WHERE expires_at < ?1`).bind(nowIso).run();
  } catch {
    /* ignore */
  }
}
