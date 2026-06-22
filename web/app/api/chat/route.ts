/**
 * POST /api/chat — the conversational copilot endpoint (GUARDRAILS-SPEC §1).
 *
 * Wiring (deterministic, fail-closed):
 *   1. Screen the current tenant turn with the advice-detection classifier
 *      (Haiku, escalating to Sonnet only where §1.4 requires).
 *   2. If the decision is `route_to_human` (a confident positive, or any
 *      fail-closed path): suppress the substantive answer, emit the fixed
 *      non-advice response + "talk to a person" CTA, and instruct the client to
 *      apply the advice-routed mutation (review.advice_routed=true,
 *      review_state escalated/queued) per §1.6 / §1.8. We DO NOT stream the model.
 *   3. If `proceed` / `proceed_borderline`: stream the grounded Opus copilot.
 *      For `proceed_borderline`, the substantive output is buffered and run
 *      through the outbound content scanner (§2.5) BEFORE anything is surfaced;
 *      any flag re-routes to a human and nothing substantive is sent.
 *
 * Runtime: Node (the Anthropic SDK is a server external package and streaming
 * works on Node). The response is newline-delimited JSON (NDJSON) events so the
 * client can render text deltas, the routing outcome, and the review-mutation
 * instruction.
 */
import { NextRequest } from "next/server";

import { CaseSchema, type Case } from "@/lib/case";
import {
  screenTurn,
  type TurnContext,
} from "@/lib/llm/advice-classifier";
import {
  appendDetectionLog,
  applyAdviceRouted,
  buildNonAdviceResponse,
  isLightGrounding,
  streamCopilot,
  type LightGrounding,
} from "@/lib/llm/copilot";
import type { MessageParam } from "@/lib/anthropic";
import { getCase, patchCase } from "@/lib/store";
import { limitPublicApi } from "@/lib/ratelimit";
import { verifyTurnstile, extractTurnstileToken } from "@/lib/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

interface ChatRequestBody {
  /** The verbatim current tenant message. */
  message: string;
  /** Prior conversation turns (user/assistant), excluding the current message. */
  history?: MessageParam[];
  /** Where the turn came from. Defaults to "chat". */
  turnContext?: TurnContext;
  /** The full Case Object, for grounding + the advice-routed mutation. Optional. */
  caseObject?: unknown;
  /**
   * The persisted case_id. When present, the SERVER loads the authoritative Case
   * and persists the advice-routed review subtree + audit event itself (the
   * single-writer invariant); the client never has to PATCH it back.
   */
  caseId?: unknown;
  /** Cloudflare Turnstile token (bot protection). */
  turnstileToken?: unknown;
}

// ---------------------------------------------------------------------------
// Outbound content scanner (GUARDRAILS-SPEC §2.5) — minimal, defense-in-depth.
//
// Deterministic net over LLM-authored text. It now runs over ALL copilot output
// (both the borderline buffered path AND the normal "proceed" path), so a
// confidently-misclassified turn that nonetheless elicits a forbidden
// construction is caught and re-routed before it reaches the tenant. Any flag
// re-routes to a human and nothing substantive is surfaced.
//
// LANGUAGE SCOPE: this regex net is ENGLISH-ONLY. It is a backstop, not the
// primary control. The MULTILINGUAL control is the system-prompt firewall in the
// copilot (which is instructed to never author advice in any language); this
// scanner only adds a deterministic English safety net on top. The canonical
// scanner is owned by the firewall module; this inline copy covers the §2.1
// constructions relevant to chat so this endpoint is safe on its own.
// ---------------------------------------------------------------------------

const SCANNER_PATTERNS: RegExp[] = [
  // "you have / you don't have a case", case-strength
  /\byou\s+(do not|don't|do)\s+have\s+a\s+(strong\s+)?case\b/i,
  /\byou\s+have\s+a\s+(strong|good|weak)\s+case\b/i,
  // "you should / shouldn't / must / don't have to" + legal action
  /\byou\s+(should|shouldn't|should not|must|need to|have to|don't have to|do not have to)\s+\w+/i,
  // probability / odds language
  /\b(\d{1,3}\s*%|percent|odds|chances are|likely to (win|lose)|probably (win|lose)|you('| wi)ll (win|lose))\b/i,
  // outcome prediction
  /\b(the judge will|you will be evicted|you'll be evicted|you will owe|you'll owe)\b/i,
  // defense assertion / selection
  /\byour\s+(best\s+)?defense\s+is\b/i,
  /\byou\s+(can|should)\s+raise\s+(the\s+)?\w+\s+defense\b/i,
  // legal conclusion about this case
  /\byour\s+(rent demand|petition|service|notice)\s+(is|was)\s+(defective|invalid|improper|not valid)\b/i,
];

/** Returns the first matched pattern source, or null if the text is clean. */
function scanOutbound(text: string): string | null {
  for (const re of SCANNER_PATTERNS) {
    if (re.test(text)) return re.source;
  }
  return null;
}

// ---------------------------------------------------------------------------
// NDJSON streaming helpers
// ---------------------------------------------------------------------------

type ChatEvent =
  | { type: "routed"; payload: ReturnType<typeof buildNonAdviceResponse> }
  | { type: "text"; delta: string }
  | { type: "done" }
  | {
      /**
       * Advisory UI hint ONLY. The route handler is the conversational advice
       * router (the SOLE writer of advice_routed) and now PERSISTS the review
       * subtree + audit event server-side (see persistAdviceRouted). We still
       * emit this event so the client can update its local view, but durability
       * + integrity no longer ride on a client PATCH.
       */
      type: "review_update";
      review: unknown;
      audit_event?: unknown;
    }
  | { type: "error"; message: string };

function enc(ev: ChatEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(ev) + "\n");
}

/**
 * Persist the advice-routed transition SERVER-SIDE (single-writer invariant #4).
 * Loads the AUTHORITATIVE Case by id, computes the review subtree + audit event
 * with applyAdviceRouted, and writes both via patchCase. Returns the computed
 * subtree (for the advisory UI event) or null when there is no schema-valid
 * persisted Case to write against. Best-effort: a persist failure never breaks
 * the tenant-facing fail-closed response (the model is already suppressed).
 */
async function persistAdviceRouted(
  caseId: string | null,
  runs: Parameters<typeof applyAdviceRouted>[0]["runs"],
): Promise<{ review: unknown; audit_event: unknown } | null> {
  if (!caseId) return null;
  try {
    const current = await getCase(caseId);
    if (!current) return null;
    const { review, audit_event } = applyAdviceRouted({ caseObject: current, runs });
    const audit = {
      ...current.audit,
      events: [...(current.audit.events ?? []), audit_event],
    };
    await patchCase(caseId, { review, audit });
    return { review, audit_event };
  } catch {
    return null;
  }
}

/**
 * Persist the detection-log-only update server-side for a cleared turn (logs the
 * classifier run without setting advice_routed). Best-effort.
 */
async function persistDetectionLog(
  caseId: string | null,
  runs: Parameters<typeof appendDetectionLog>[0]["runs"],
): Promise<unknown | null> {
  if (!caseId) return null;
  try {
    const current = await getCase(caseId);
    if (!current) return null;
    const review = appendDetectionLog({ caseObject: current, runs });
    await patchCase(caseId, { review });
    return review;
  } catch {
    return null;
  }
}

function ndjsonResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<Response> {
  // Rate limit (cost-DoS protection) — cheap, before any LLM work or body parse.
  const limit = await limitPublicApi(req, "chat");
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Bot protection. Fails closed in production; open in dev when unconfigured.
  const turnstile = await verifyTurnstile(
    extractTurnstileToken(req, body),
    req.headers.get("cf-connecting-ip"),
  );
  if (!turnstile.ok) {
    return Response.json(
      { error: "challenge_failed", message: "Please complete the verification and try again." },
      { status: 403 },
    );
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (message.trim().length === 0) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  const turnContext: TurnContext = body.turnContext ?? "chat";
  const history = Array.isArray(body.history) ? body.history : [];
  const caseId =
    typeof body.caseId === "string" && /^case_[0-9a-hjkmnp-tv-z]{26}$/.test(body.caseId)
      ? body.caseId
      : null;

  // Resolve the case for grounding. We prefer the AUTHORITATIVE persisted Case
  // (loaded server-side by caseId) over the client-supplied caseObject, since the
  // server is the single writer of the safety-critical review subtree. The client
  // caseObject (or a LightGrounding) is a fallback for grounding only.
  let caseObject: Case | null = null;
  let lightGrounding: LightGrounding | null = null;
  if (caseId) {
    caseObject = await getCase(caseId);
  }
  if (caseObject == null && body.caseObject != null) {
    const parsed = CaseSchema.safeParse(body.caseObject);
    if (parsed.success) {
      caseObject = parsed.data;
    } else if (isLightGrounding(body.caseObject)) {
      lightGrounding = body.caseObject;
    }
  }

  // Build the message list for the copilot (history + current turn).
  const messages: MessageParam[] = [
    ...history,
    { role: "user", content: message },
  ];

  // 1. Screen the turn (fail-closed deterministic decision).
  let route;
  try {
    route = await screenTurn({
      turnText: message,
      turnContext,
      language: caseObject?.language ?? "en",
    });
  } catch {
    // Even the screen failing routes to a human (fail closed, §7.1).
    route = {
      decision: "route_to_human" as const,
      runs: [],
      any_positive: true,
    };
  }

  // 2. Hard-route path: suppress the model, surface the fixed non-advice response.
  //    The SERVER persists advice_routed + the audit event (single-writer #4).
  if (route.decision === "route_to_human") {
    const persisted = await persistAdviceRouted(caseId, route.runs);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc({ type: "routed", payload: buildNonAdviceResponse() }));
        if (persisted != null) {
          controller.enqueue(
            enc({
              type: "review_update",
              review: persisted.review,
              audit_event: persisted.audit_event,
            }),
          );
        }
        controller.enqueue(enc({ type: "done" }));
        controller.close();
      },
    });
    return ndjsonResponse(stream);
  }

  // Both `proceed` and `proceed_borderline` now take the same path: the copilot
  // output is buffered, scanned, and only then surfaced (§2.5 applied to ALL
  // output, not just borderline). The borderline distinction no longer changes
  // surfacing — the deterministic English scanner runs uniformly.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const sdkStream = streamCopilot({ messages, caseObject, lightGrounding });

        // §2.5: buffer + scan ALL copilot output (not just borderline) before
        // surfacing. A confidently-misclassified turn that elicits a forbidden
        // construction is caught here and re-routed to a human, server-side.
        const final = await sdkStream.finalMessage();
        const text = final.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");

        const flagged = scanOutbound(text);
        if (flagged) {
          // Re-route to human; do NOT surface the substantive output. Persist
          // the advice-routed transition server-side (single-writer #4).
          const persisted = await persistAdviceRouted(caseId, route.runs);
          controller.enqueue(enc({ type: "routed", payload: buildNonAdviceResponse() }));
          if (persisted != null) {
            controller.enqueue(
              enc({
                type: "review_update",
                review: persisted.review,
                audit_event: persisted.audit_event,
              }),
            );
          }
          controller.enqueue(enc({ type: "done" }));
          controller.close();
          return;
        }

        // Clean: surface the buffered text, then persist the detection-log-only
        // update server-side (logs the classifier run; advice_routed stays false).
        controller.enqueue(enc({ type: "text", delta: text }));
        const reviewLog = await persistDetectionLog(caseId, route.runs);
        if (reviewLog != null) {
          controller.enqueue(enc({ type: "review_update", review: reviewLog }));
        }
        controller.enqueue(enc({ type: "done" }));
        controller.close();
      } catch (err) {
        controller.enqueue(
          enc({
            type: "error",
            message:
              err instanceof Error ? err.message : "copilot stream failed",
          }),
        );
        controller.close();
      }
    },
  });

  return ndjsonResponse(stream);
}
