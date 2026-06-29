/**
 * GET  /api/provider/cases/[id] — full intake for triage (consent-gated).
 * POST /api/provider/cases/[id] — triage action: accept | refer | decline.
 *
 * GET returns the Case only when a granted handoff_to_provider consent exists;
 * otherwise 403 (consent_required) / 404 (no such case). In v1 this is the ONLY
 * gate — there is no provider authn yet (see SECURITY TODO below).
 *
 * POST applies a triage action to the case per the state machine
 * (API-CONTRACTS §4.4-§4.6 / §6.1, simplified for v1):
 *   - accept  : move intake/prepared → referred; review_state = "in_review";
 *               append a status_history transition. (No-op transition if the
 *               case is already referred/represented — review_state still set.)
 *   - refer   : review_state = "escalated"; status unchanged (re-route onward
 *               needs a fresh per-recipient consent in the real flow).
 *   - decline : review_state = "reviewed"; status unchanged (data not deleted).
 * The `note` is recorded on the status transition / audit reason.
 *
 * The LLM never sets `status` or `review_state` here — these are deterministic,
 * human-actor-driven writes. The actor is recorded as `provider`.
 *
 * Next 15: a dynamic segment's `params` is a Promise and MUST be awaited.
 *
 * SECURITY TODO (v1 BLOCKER): no authentication / authorization. A real provider
 * surface MUST verify a `provider_*` principal, scope to consent.recipient_id ==
 * prv, require `provider_attorney` for the accept→represented advice-line step,
 * and redact fields outside the consented data_categories. See API-CONTRACTS §4.
 */

import { NextResponse } from "next/server";

import type { Case, Consent, AttorneyReview } from "@/lib/case";
import { getCase, patchCase } from "@/lib/store";
import { renderPlainTextSummary } from "@/lib/handoff";
import {
  projectCaseForProvider,
  caseETag,
  ifMatchSatisfied,
  computeTriageTransition,
  TRIAGE_ACTIONS,
  type TriageAction,
} from "@/lib/provider-redaction";
import {
  readProviderPrincipal,
  consentVisibleToPrv,
  attorneyAdvanceAllowed,
  type ProviderPrincipal,
} from "@/lib/auth/provider-principal";

export const runtime = "nodejs";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The granting handoff_to_provider consent VISIBLE to this provider (for its
 * data_categories), or null. Applies per-provider scoping: a consent addressed
 * to a DIFFERENT prv is not visible (§2.2). prv = null ⇒ no scoping (dev/single).
 */
function grantedHandoffConsent(
  c: Case,
  asOf: string,
  prv: string | null,
): Consent | null {
  const now = Date.parse(asOf);
  return (
    (c.consents ?? []).find(
      (cn) =>
        cn.scope === "handoff_to_provider" &&
        cn.recipient.recipient_type === "legal_aid_provider" &&
        cn.granted &&
        !(cn.revoked_at && Date.parse(cn.revoked_at) <= now) &&
        !(cn.expires_at && Date.parse(cn.expires_at) <= now) &&
        consentVisibleToPrv(cn, prv),
    ) ?? null
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const { prv } = readProviderPrincipal(req);
  const found = await getCase(id);
  if (!found) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }
  const consent = grantedHandoffConsent(found, nowIso(), prv);
  if (!consent) {
    return NextResponse.json(
      {
        error: "consent_required",
        message:
          "No granted handoff_to_provider consent for a legal-aid provider on this case.",
      },
      { status: 403 },
    );
  }

  // REDACTION (§97): project the Case down to the consent's data_categories.
  // Fields outside the consented categories are withheld; the case-facts summary
  // is included only when case_facts is consented.
  const { case: redacted, redacted_categories } = projectCaseForProvider(
    found,
    consent.data_categories,
  );
  const summary = consent.data_categories.includes("case_facts")
    ? renderPlainTextSummary(found)
    : null;

  return NextResponse.json(
    {
      case: redacted,
      summary,
      consent_id: consent.consent_id,
      data_categories: consent.data_categories,
      redacted_categories,
    },
    { headers: { ETag: caseETag(found) } },
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const principal: ProviderPrincipal = readProviderPrincipal(req);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "invalid_request", message: "Body must be an object." },
      { status: 400 },
    );
  }

  const { action, note, attorney_confirmed } = body as {
    action?: unknown;
    note?: unknown;
    attorney_confirmed?: unknown;
  };
  if (typeof action !== "string" || !TRIAGE_ACTIONS.includes(action as TriageAction)) {
    return NextResponse.json(
      { error: "invalid_request", message: `action must be one of ${TRIAGE_ACTIONS.join(", ")}.` },
      { status: 400 },
    );
  }
  if (note != null && typeof note !== "string") {
    return NextResponse.json(
      { error: "invalid_request", message: "note must be a string." },
      { status: 400 },
    );
  }

  const current = await getCase(id);
  if (!current) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }
  // PER-PROVIDER SCOPING (§2.2): the consent must be addressed to this provider
  // (or unscoped). A consent for a DIFFERENT prv is invisible — uniform 403.
  if (!grantedHandoffConsent(current, nowIso(), principal.prv)) {
    return NextResponse.json(
      {
        error: "consent_required",
        message:
          "No granted handoff_to_provider consent for a legal-aid provider on this case.",
      },
      { status: 403 },
    );
  }

  // ATTORNEY-ONLY ADVICE LINE (§2.2 / §99): advancing referred → represented is
  // attorney-only. The gate fires ONLY when the caller actually ATTEMPTS the
  // advance (attorney_confirmed=true) but lacks the role — a non-attorney may
  // still accept a referred case to keep it in review (it just won't advance).
  // In a verified Access context the provider_attorney role is REQUIRED; the
  // client's attorney_confirmed flag alone is not trusted in prod.
  const attemptingRepresent =
    action === "accept" && current.status === "referred" && attorney_confirmed === true;
  if (attemptingRepresent && !attorneyAdvanceAllowed(principal, true)) {
    return NextResponse.json(
      {
        error: "attorney_role_required",
        message:
          "Advancing a referred case to represented requires the provider_attorney role.",
      },
      { status: 403 },
    );
  }

  // OPTIMISTIC CONCURRENCY (§3.3): if the client sent If-Match, it must match the
  // current case version or the write is rejected (412) — prevents a triage
  // action from clobbering a concurrent update it never saw.
  if (!ifMatchSatisfied(req.headers.get("if-match"), current)) {
    return NextResponse.json(
      {
        error: "precondition_failed",
        message: "The case changed since you last read it. Re-fetch and retry.",
        etag: caseETag(current),
      },
      { status: 412 },
    );
  }

  const at = nowIso();

  // State machine (§4.4): accept advances intake/prepared → referred and
  // referred → represented (attorney-gated); refer escalates; decline reviews.
  const step = computeTriageTransition(current, action as TriageAction, {
    now: at,
    note: typeof note === "string" ? note : null,
    // Server-decided: the advance happens only with both represent-intent AND
    // attorney permission (role in prod / confirmed intent in dev).
    attorneyConfirmed: attorneyAdvanceAllowed(principal, attorney_confirmed === true),
  });

  const review: AttorneyReview = {
    assigned_attorney_id: current.review?.assigned_attorney_id ?? null,
    advice_routed: current.review?.advice_routed ?? false,
    advice_detection_log: current.review?.advice_detection_log ?? [],
    triage_score: current.review?.triage_score ?? null,
    review_state: step.nextReviewState,
  };

  const patch: Partial<Case> = {
    status: step.nextStatus,
    status_history: step.transition
      ? [...current.status_history, step.transition]
      : current.status_history,
    review,
  };

  let updated: Case | null;
  try {
    updated = await patchCase(id, patch);
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: err instanceof Error ? err.message : "Patch did not produce a valid Case.",
      },
      { status: 400 },
    );
  }
  if (!updated) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  return NextResponse.json(
    {
      case: updated,
      action,
      review_state: step.nextReviewState,
      status: updated.status,
      // Surfaced when an attorney-only advance (referred → represented) was asked
      // for without attorney proof: the review was recorded but status held.
      refused: step.refused ?? null,
    },
    { headers: { ETag: caseETag(updated) } },
  );
}
