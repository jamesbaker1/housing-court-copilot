/**
 * Provider-read redaction + handoff state machine (API-CONTRACTS §4-§5).
 *
 * A legal-aid provider may read a Case ONLY through the lens of the granting
 * consent's `data_categories` (§97): every field whose category is not consented
 * is withheld. `sensitive.*` is never returned except for the specific subset
 * whose category is consented (e.g. immigration only with `immigration_status`).
 * Raw income is never projected — the provider sees the deterministic
 * EligibilityResult, not the number (data minimization).
 *
 * Pure functions: no I/O, no mutation. The route persists state-machine results
 * server-side so the deterministic status/review writes stay non-client-writable.
 */
import type {
  Case,
  Consent,
  ConsentDataCategory,
  CaseStatus,
  StatusTransition,
  AttorneyReview,
} from "@/lib/case";

// ---------------------------------------------------------------------------
// Consent-category projection
// ---------------------------------------------------------------------------

/**
 * Top-level Case fields that are ALWAYS safe to return (structural / non-PII):
 * identifiers, the state-machine status, language, timestamps, the consents
 * themselves (so the provider can see what authorizes them), and the triage
 * review state. Everything else is category-gated below.
 */
const ALWAYS_INCLUDE = [
  "case_id",
  "schema_version",
  "case_type",
  "case_type_confirmed",
  "status",
  "status_history",
  "language",
  "created_at",
  "updated_at",
  "consents",
  "review",
] as const;

/** Which consent category gates each PII-bearing top-level Case field. */
const FIELD_CATEGORY: Partial<Record<keyof Case, ConsentDataCategory>> = {
  contact: "contact",
  parties: "case_facts",
  property: "case_facts",
  court: "case_facts",
  timeline: "case_facts",
  deadlines: "case_facts",
  defenses_checklist: "case_facts",
  answer_draft: "case_facts",
  reminders: "case_facts",
  claimed_arrears: "arrears",
  documents: "documents",
  evidence: "evidence",
  eligibility: "eligibility",
};

export interface ProviderProjection {
  /** The redacted Case-shaped object (only consented categories present). */
  case: Record<string, unknown>;
  /** Categories that were WITHHELD because the consent did not cover them. */
  redacted_categories: ConsentDataCategory[];
}

/**
 * Project a Case down to exactly what `categories` permits. Default-deny: a field
 * is included only when its category is consented. `sensitive.*` is included only
 * for the consented subset (immigration_status / benefits_enrollment); raw income
 * is never projected.
 */
export function projectCaseForProvider(
  c: Case,
  categories: Iterable<ConsentDataCategory>,
): ProviderProjection {
  const allowed = new Set(categories);
  const out: Record<string, unknown> = {};
  const src = c as unknown as Record<string, unknown>;

  for (const key of ALWAYS_INCLUDE) {
    if (src[key] !== undefined) out[key] = src[key];
  }

  const withheld = new Set<ConsentDataCategory>();
  for (const [field, category] of Object.entries(FIELD_CATEGORY) as [
    keyof Case,
    ConsentDataCategory,
  ][]) {
    if (src[field] === undefined) continue;
    if (allowed.has(category)) out[field] = src[field];
    else withheld.add(category);
  }

  // sensitive.* — only the explicitly-consented subset, never raw income.
  if (c.sensitive) {
    const sens: Record<string, unknown> = {};
    // The `immigration_status` data-category gates the sensitive.immigration field.
    if (allowed.has("immigration_status")) {
      if (c.sensitive.immigration !== undefined)
        sens.immigration = c.sensitive.immigration;
    } else if (c.sensitive.immigration !== undefined) {
      withheld.add("immigration_status");
    }
    if (allowed.has("benefits_enrollment")) {
      if (c.sensitive.benefits_enrollment !== undefined)
        sens.benefits_enrollment = c.sensitive.benefits_enrollment;
    } else if (c.sensitive.benefits_enrollment !== undefined) {
      withheld.add("benefits_enrollment");
    }
    if (Object.keys(sens).length > 0) out.sensitive = sens;
  }

  return { case: out, redacted_categories: [...withheld].sort() };
}

// ---------------------------------------------------------------------------
// Weak ETag for optimistic concurrency (If-Match)
// ---------------------------------------------------------------------------

/** A stable, dependency-free 32-bit FNV-1a hash → hex. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * A weak ETag over the case's identity + last-write time. patchCase bumps
 * `updated_at` on every write, so a stale If-Match is reliably detected.
 */
export function caseETag(c: Case): string {
  return `W/"${fnv1a(`${c.case_id}|${c.updated_at}`)}"`;
}

/** True iff the client's If-Match header satisfies the current case version. */
export function ifMatchSatisfied(
  ifMatchHeader: string | null,
  c: Case,
): boolean {
  if (!ifMatchHeader) return true; // If-Match is optional; absent → no precondition
  const tag = caseETag(c);
  // Accept the wildcard and a comma-separated list, tolerating W/ weak prefixes.
  return ifMatchHeader
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t === tag);
}

// ---------------------------------------------------------------------------
// Handoff triage state machine (§4.4): intake → prepared → referred →
// represented → resolved
// ---------------------------------------------------------------------------

export type TriageAction = "accept" | "refer" | "decline";
export const TRIAGE_ACTIONS: readonly TriageAction[] = ["accept", "refer", "decline"];

export interface TriageTransition {
  nextStatus: CaseStatus;
  nextReviewState: AttorneyReview["review_state"];
  transition: StatusTransition | null;
  /** Set when a requested transition was refused (e.g. attorney gate). */
  refused?: string;
}

/**
 * Compute the next status + review_state for a triage action. `accept` advances
 * the case ALONG the chain toward representation:
 *   intake|prepared → referred (provider takes up the intake), review in_review;
 *   referred        → represented (an ATTORNEY takes the case) — gated on
 *                     attorneyConfirmed; the advice line is attorney-only (§99).
 *   represented|resolved → no status change.
 * `refer` escalates (no regression); `decline` marks reviewed (no deletion).
 */
export function computeTriageTransition(
  current: Case,
  action: TriageAction,
  opts: { now: string; note?: string | null; attorneyConfirmed?: boolean },
): TriageTransition {
  const actor = { actor_type: "provider" as const, actor_id: null };
  const at = opts.now;
  let nextStatus: CaseStatus = current.status;
  let transition: StatusTransition | null = null;
  let refused: string | undefined;
  let nextReviewState: AttorneyReview["review_state"];

  if (action === "accept") {
    nextReviewState = "in_review";
    if (current.status === "intake" || current.status === "prepared") {
      nextStatus = "referred";
      transition = {
        from_status: current.status,
        to_status: "referred",
        at,
        actor,
        reason: opts.note ?? "Provider accepted intake for review.",
      };
    } else if (current.status === "referred") {
      // referred → represented is the attorney advice-line step (§99): only an
      // attorney principal may take the case. Without that proof, refuse the
      // status advance but still record the review as in_review.
      if (opts.attorneyConfirmed) {
        nextStatus = "represented";
        transition = {
          from_status: "referred",
          to_status: "represented",
          at,
          actor,
          reason: opts.note ?? "Attorney accepted representation.",
        };
      } else {
        refused = "represented_requires_attorney";
      }
    }
    // represented / resolved: no status change.
  } else if (action === "refer") {
    nextReviewState = "escalated";
  } else {
    nextReviewState = "reviewed";
  }

  return { nextStatus, nextReviewState, transition, refused };
}
