/**
 * Outcome / impact tracking (ROADMAP #14) — deterministic, no LLM.
 *
 * Two concerns, kept separate:
 *   1. The per-case `Outcome` record (what happened, who recorded it, when).
 *   2. An ANONYMIZED aggregate record for funder/impact reporting that carries
 *      NO PII — no case_id, no names, no address, no free-text note. Just the
 *      disposition, a coarse month bucket, the borough (already coarse), and a
 *      few boolean signals. Emitted ONLY when the tenant consented_to_report.
 *
 * `deriveOutcomeSignals` SUGGESTS a disposition from case state for the provider
 * to confirm — it never auto-writes one (a misrecorded outcome is a data-quality
 * problem, and outcome is not a legal conclusion the engine should assert alone).
 *
 * Pure functions. No I/O, no mutation.
 */
import type { Case, Outcome, OutcomeDisposition, Borough } from "@/lib/case";

/** Human-readable labels for dispositions (impact dashboard / provider UI). */
export const DISPOSITION_LABEL: Record<OutcomeDisposition, string> = {
  default_avoided: "Default judgment avoided",
  answer_filed: "Answer filed",
  represented: "Represented by a lawyer",
  dismissed: "Case dismissed",
  settled_stipulation: "Settled (stipulation)",
  possession_judgment: "Judgment of possession (adverse)",
  case_closed_other: "Closed (other)",
  unknown: "Unknown",
};

/** Dispositions that count as a favorable/neutral tenant outcome (for rollups). */
const FAVORABLE: ReadonlySet<OutcomeDisposition> = new Set([
  "default_avoided",
  "answer_filed",
  "represented",
  "dismissed",
  "settled_stipulation",
]);

export function isFavorableDisposition(d: OutcomeDisposition): boolean {
  return FAVORABLE.has(d);
}

// ---------------------------------------------------------------------------
// Deterministic outcome SIGNALS (suggestions — provider confirms)
// ---------------------------------------------------------------------------

export interface OutcomeSignals {
  /** Dispositions suggested by the current case state, most-likely first. */
  suggested: OutcomeDisposition[];
  /** Structured reason codes for each suggestion (audit, not advice). */
  reasons: string[];
}

/**
 * Read the case state and SUGGEST candidate dispositions. Never asserts one — the
 * provider/operator confirms. Deterministic and conservative.
 */
export function deriveOutcomeSignals(c: Case): OutcomeSignals {
  const suggested: OutcomeDisposition[] = [];
  const reasons: string[] = [];

  if (c.status === "represented") {
    suggested.push("represented");
    reasons.push("case_status_represented");
  }

  const answerFiled =
    (c.answer_draft?.factual_statements ?? []).some((s) => s.tenant_confirmed) &&
    c.deadlines.some((d) => d.deadline_type === "answer_due" && d.tenant_confirmed);
  if (answerFiled) {
    suggested.push("answer_filed");
    reasons.push("answer_confirmed_and_deadline_confirmed");
  }

  // No missed answer deadline by its due date → default plausibly avoided.
  const missedAnswer = c.deadlines.some(
    (d) => d.deadline_type === "answer_due" && d.risk?.is_missed === true,
  );
  if (answerFiled && !missedAnswer) {
    suggested.push("default_avoided");
    reasons.push("answer_filed_no_missed_deadline");
  }

  if (c.status === "resolved" && suggested.length === 0) {
    suggested.push("case_closed_other");
    reasons.push("case_status_resolved_no_specific_signal");
  }

  if (suggested.length === 0) {
    suggested.push("unknown");
    reasons.push("insufficient_signal");
  }

  // De-dup while preserving order.
  const seen = new Set<OutcomeDisposition>();
  return {
    suggested: suggested.filter((d) => (seen.has(d) ? false : (seen.add(d), true))),
    reasons,
  };
}

// ---------------------------------------------------------------------------
// Anonymized aggregate record (funder / impact reporting)
// ---------------------------------------------------------------------------

/**
 * A PII-free, funder-reportable outcome row. Deliberately contains NO case_id,
 * names, address, index number, or free text. The month bucket (YYYY-MM) is the
 * finest time granularity exposed; borough is already coarse public geography.
 */
export interface AnonymizedOutcome {
  disposition: OutcomeDisposition;
  favorable: boolean;
  /** Coarse time bucket (YYYY-MM) derived from recorded_at — never the full ts. */
  month: string;
  borough: Borough | null;
  case_type: Case["case_type"];
  /** Whether the case reached representation (for the RTC impact story). */
  represented: boolean;
  /** Whether a human-handoff was routed at any point (advice_routed). */
  routed_to_human: boolean;
}

/** YYYY-MM from an ISO timestamp (coarsen the time axis to a month). */
function monthBucket(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * Build the anonymized aggregate record for an outcome. Returns null when the
 * tenant did NOT consent to reporting — the caller must not emit anything to the
 * metrics sink in that case (default-deny).
 */
export function buildAnonymizedOutcome(
  c: Case,
  outcome: Outcome,
): AnonymizedOutcome | null {
  if (!outcome.consented_to_report) return null;
  return {
    disposition: outcome.disposition,
    favorable: isFavorableDisposition(outcome.disposition),
    month: monthBucket(outcome.recorded_at),
    borough: c.court?.borough ?? null,
    case_type: c.case_type,
    represented:
      outcome.disposition === "represented" || c.status === "represented",
    routed_to_human: c.review?.advice_routed === true,
  };
}
