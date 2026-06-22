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

import type { Case, CaseStatus, StatusTransition, AttorneyReview } from "@/lib/case";
import { getCase, patchCase } from "@/lib/store";
import { renderPlainTextSummary } from "@/lib/handoff";
import { hasGrantedHandoffConsent } from "@/components/provider/TriageList";

export const runtime = "nodejs";

type TriageAction = "accept" | "refer" | "decline";
const ACTIONS: readonly TriageAction[] = ["accept", "refer", "decline"];

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const found = await getCase(id);
  if (!found) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }
  if (!hasGrantedHandoffConsent(found)) {
    return NextResponse.json(
      {
        error: "consent_required",
        message:
          "No granted handoff_to_provider consent for a legal-aid provider on this case.",
      },
      { status: 403 },
    );
  }
  return NextResponse.json({ case: found, summary: renderPlainTextSummary(found) });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

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

  const { action, note } = body as { action?: unknown; note?: unknown };
  if (typeof action !== "string" || !ACTIONS.includes(action as TriageAction)) {
    return NextResponse.json(
      { error: "invalid_request", message: `action must be one of ${ACTIONS.join(", ")}.` },
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
  if (!hasGrantedHandoffConsent(current)) {
    return NextResponse.json(
      {
        error: "consent_required",
        message:
          "No granted handoff_to_provider consent for a legal-aid provider on this case.",
      },
      { status: 403 },
    );
  }

  const at = nowIso();
  const actor = { actor_type: "provider" as const, actor_id: null };

  // Compute the next review_state + (possibly) status transition.
  let nextReviewState: AttorneyReview["review_state"];
  let nextStatus: CaseStatus = current.status;
  let transition: StatusTransition | null = null;

  if (action === "accept") {
    nextReviewState = "in_review";
    // Move untransitioned cases forward to referred (the handoff is being taken
    // up). Already-referred/represented cases keep their status.
    if (current.status === "intake" || current.status === "prepared") {
      nextStatus = "referred";
      transition = {
        from_status: current.status,
        to_status: "referred",
        at,
        actor,
        reason: note ?? "Provider accepted intake for review.",
      };
    }
  } else if (action === "refer") {
    nextReviewState = "escalated";
    // Status is not regressed; a real onward re-route needs a fresh consent.
  } else {
    nextReviewState = "reviewed";
    // Decline does not delete data and does not regress status.
  }

  const review: AttorneyReview = {
    assigned_attorney_id: current.review?.assigned_attorney_id ?? null,
    advice_routed: current.review?.advice_routed ?? false,
    advice_detection_log: current.review?.advice_detection_log ?? [],
    triage_score: current.review?.triage_score ?? null,
    review_state: nextReviewState,
  };

  const patch: Partial<Case> = {
    status: nextStatus,
    status_history: transition
      ? [...current.status_history, transition]
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

  return NextResponse.json({
    case: updated,
    action,
    review_state: nextReviewState,
    status: updated.status,
  });
}
