/**
 * POST /api/stipulation — proposed-stipulation reviewer (INFORMATION ONLY).
 *
 * Node runtime (the Anthropic SDK + base64 decoding need Node, not Edge).
 *
 * Accepts an uploaded proposed stipulation/settlement (base64 + media type) and
 * an optional case_id. Runs the reviewer (lib/llm/stip-review) and returns the
 * term-by-term plain-English breakdown + the "ask a lawyer about this" flags +
 * the binding notice + a "talk to a person before signing" CTA + a disclaimer.
 *
 * Boundary (GUARDRAILS-SPEC.md):
 *   - The response NEVER recommends signing/not-signing and carries no legal
 *     conclusion — the reviewer's schema is structurally incapable of one.
 *   - If anything reads as needing legal judgment, the route sets
 *     route_to_human = true and, when a case_id is supplied, escalates the Case
 *     via an ENGINE escalation: it sets review.review_state = "escalated" and
 *     appends an audit event. It NEVER sets review.advice_routed (§1.8: that
 *     field is owned solely by the conversational advice router).
 *   - A note is optionally PATCHed onto the Case as an audit.events[] entry
 *     (action "stipulation_reviewed"). No filing-bound field is written.
 */
import { NextResponse } from "next/server";

import {
  reviewStipulation,
  isStipMediaType,
  type StipMediaType,
  type StipReviewOutput,
} from "@/lib/llm/stip-review";
import { TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";
import { getCase, patchCase } from "@/lib/store";
import { OPUS } from "@/lib/anthropic";
import type { Audit, AttorneyReview, Case } from "@/lib/case";
import { limitPublicApi } from "@/lib/ratelimit";
import { verifyTurnstile, extractTurnstileToken } from "@/lib/turnstile";

export const runtime = "nodejs";
/** Vision + reasoning over the document can take a while; allow a budget. */
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Request body.
// ---------------------------------------------------------------------------

interface StipRequestBody {
  /** Base64-encoded file bytes. A `data:` URI prefix is tolerated and stripped. */
  base64Data?: unknown;
  /** Media type of the uploaded file (e.g. "application/pdf", "image/jpeg"). */
  mediaType?: unknown;
  /** Optional case_id to attach an audit note / escalation to. */
  case_id?: unknown;
}

/** Strip a leading `data:<mime>;base64,` prefix if the client sent a data URI. */
function normalizeBase64(input: string): string {
  const match = input.match(/^data:[^;]+;base64,(.*)$/s);
  return match ? (match[1] ?? input) : input;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Case note / escalation (best-effort; never fails the response).
//
// Engine-style escalation: sets review.review_state = "escalated" when the
// review needs legal judgment, and always appends an audit event. NEVER writes
// review.advice_routed (single-writer invariant, §1.8).
// ---------------------------------------------------------------------------

async function attachNote(
  caseId: string,
  needsLegalReview: boolean,
  model: typeof OPUS,
): Promise<void> {
  const current: Case | null = await getCase(caseId);
  if (!current) return;

  const existing: Audit = current.audit;
  const event = {
    at: nowIso(),
    actor: { actor_type: "deterministic_engine" as const },
    action: "stipulation_reviewed",
    field_path: needsLegalReview ? "/review/review_state" : null,
    model,
  };
  const audit: Audit = {
    ...existing,
    events: [...(existing.events ?? []), event],
  };

  const patch: Partial<Case> = { audit };

  // Engine escalation (NOT advice_routed): a stipulation needing legal judgment
  // is real urgency for the human queue. Preserve any existing advice_routed.
  if (needsLegalReview) {
    const review: AttorneyReview = {
      ...(current.review ?? {
        review_state: "unassigned",
        advice_routed: false,
        advice_detection_log: [],
      }),
      review_state: "escalated",
    };
    patch.review = review;
  }

  try {
    await patchCase(caseId, patch);
  } catch {
    // Best-effort: a failed note must not break the tenant-facing review.
  }
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  // Rate limit (cost-DoS protection).
  const limit = await limitPublicApi(request, "stipulation");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: StipRequestBody;
  try {
    body = (await request.json()) as StipRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Bot protection. Fails closed in production; open in dev when unconfigured.
  const turnstile = await verifyTurnstile(
    extractTurnstileToken(request, body),
    request.headers.get("cf-connecting-ip"),
  );
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "challenge_failed", message: "Please complete the verification and try again." },
      { status: 403 },
    );
  }

  if (typeof body.base64Data !== "string" || body.base64Data.length === 0) {
    return NextResponse.json(
      { error: "Missing or invalid `base64Data` (expected a non-empty string)." },
      { status: 400 },
    );
  }

  if (typeof body.mediaType !== "string" || !isStipMediaType(body.mediaType)) {
    return NextResponse.json(
      {
        error:
          "Missing or unsupported `mediaType`. Supported: application/pdf, image/jpeg, image/png, image/gif, image/webp. Convert HEIC to JPEG/PNG before upload.",
      },
      { status: 400 },
    );
  }

  const base64Data = normalizeBase64(body.base64Data);
  const mediaType = body.mediaType as StipMediaType;
  const caseId = typeof body.case_id === "string" ? body.case_id : undefined;

  let result;
  try {
    result = await reviewStipulation({ base64Data, mediaType });
  } catch (err) {
    console.error("[stipulation] review failed:", err);
    return NextResponse.json(
      {
        error:
          "We couldn't read that document. Please try uploading it again, or use a clearer photo or PDF.",
      },
      { status: 502 },
    );
  }

  // The "talk to a person before signing" CTA is always returned — this is the
  // safe action for a binding agreement.
  const talkToAPerson = {
    heading: TALK_TO_A_PERSON_CTA.heading,
    body:
      "A stipulation is binding. Before you sign anything, have a lawyer review it. " +
      TALK_TO_A_PERSON_CTA.body,
    action: TALK_TO_A_PERSON_CTA.action,
    hotlineName: TALK_TO_A_PERSON_CTA.hotlineName,
    hotlinePhone: TALK_TO_A_PERSON_CTA.hotlinePhone,
    hotlineNote: TALK_TO_A_PERSON_CTA.hotlineNote,
  };

  // Best-effort: attach an audit note + engine escalation to the Case.
  if (caseId) {
    await attachNote(caseId, result.needsLegalReview, result.model);
  }

  // Refusal / empty parse / not-a-stipulation: route to a human + prompt a
  // re-upload, rather than returning empty content as if it were a review.
  if (result.routeToReview || result.review === null) {
    return NextResponse.json(
      {
        route_to_human: true,
        is_stipulation: result.review?.is_stipulation ?? null,
        review: null,
        flags: [],
        binding_notice: result.bindingNotice,
        talk_to_a_person: talkToAPerson,
        disclaimer: result.disclaimer,
        message:
          "We couldn't clearly review this as a stipulation. A person can help — and you can try re-uploading a clearer photo or PDF. Do not sign anything before a lawyer reviews it.",
        model: result.model,
      },
      { status: 200 },
    );
  }

  const review: StipReviewOutput = result.review;

  // Build the "ask a lawyer about this" flag list from the flagged terms.
  const flags = review.terms
    .filter((t) => t.ask_a_lawyer)
    .map((t) => ({
      category: t.category,
      heading: t.heading,
      ask_a_lawyer_about: t.ask_a_lawyer_about,
    }));

  return NextResponse.json(
    {
      route_to_human: result.needsLegalReview,
      is_stipulation: review.is_stipulation,
      review: {
        document_overview: review.document_overview,
        terms: review.terms,
        needs_legal_review: review.needs_legal_review,
      },
      flags,
      binding_notice: result.bindingNotice,
      talk_to_a_person: talkToAPerson,
      disclaimer: result.disclaimer,
      model: result.model,
    },
    { status: 200 },
  );
}
