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
}

// ---------------------------------------------------------------------------
// Outbound content scanner (GUARDRAILS-SPEC §2.5) — minimal, defense-in-depth.
//
// Deterministic net over LLM-authored text. For the BORDERLINE path it runs
// before anything is surfaced; any flag re-routes to a human. This is a backstop
// for the system-prompt firewall, not the primary control. The canonical
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
       * Instructs the client/persistence layer to apply a review mutation. The
       * route handler is the conversational advice router (the SOLE writer of
       * advice_routed); we emit the computed subtree + audit event rather than
       * persisting directly, since persistence is owned elsewhere.
       */
      type: "review_update";
      review: unknown;
      audit_event?: unknown;
    }
  | { type: "error"; message: string };

function enc(ev: ChatEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(ev) + "\n");
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
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (message.trim().length === 0) {
    return Response.json({ error: "message is required" }, { status: 400 });
  }

  const turnContext: TurnContext = body.turnContext ?? "chat";
  const history = Array.isArray(body.history) ? body.history : [];

  // Parse the case if provided. A malformed case is non-fatal: we fall back to
  // an ungrounded copilot, but we cannot then apply the review mutation, so on a
  // routed turn we still emit the non-advice response (fail closed on safety).
  //
  // v1: the intake route is stateless, so the chat client sends tenant-CONFIRMED
  // fields (a LightGrounding) rather than a schema-valid Case. We accept that as
  // copilot grounding while still requiring a full Case to compute the review
  // mutation (the safety-critical write path stays strict).
  let caseObject: Case | null = null;
  let lightGrounding: LightGrounding | null = null;
  if (body.caseObject != null) {
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
  if (route.decision === "route_to_human") {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc({ type: "routed", payload: buildNonAdviceResponse() }));
        // Emit the review mutation when we have a case to compute it against.
        if (caseObject != null) {
          const { review, audit_event } = applyAdviceRouted({
            caseObject,
            runs: route.runs,
          });
          controller.enqueue(enc({ type: "review_update", review, audit_event }));
        }
        controller.enqueue(enc({ type: "done" }));
        controller.close();
      },
    });
    return ndjsonResponse(stream);
  }

  // 3. Allowed to proceed. Log the classifier run(s) without setting advice_routed.
  const reviewLogUpdate =
    caseObject != null
      ? appendDetectionLog({ caseObject, runs: route.runs })
      : null;

  const borderline = route.decision === "proceed_borderline";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const sdkStream = streamCopilot({ messages, caseObject, lightGrounding });

        if (borderline) {
          // §1.4 step 3 + §2.5: buffer, scan, then surface (or re-route).
          const final = await sdkStream.finalMessage();
          const text = final.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("");

          const flagged = scanOutbound(text);
          if (flagged) {
            // Re-route to human; do NOT surface the substantive output.
            controller.enqueue(enc({ type: "routed", payload: buildNonAdviceResponse() }));
            if (caseObject != null) {
              const { review, audit_event } = applyAdviceRouted({
                caseObject,
                runs: route.runs,
              });
              controller.enqueue(enc({ type: "review_update", review, audit_event }));
            }
            controller.enqueue(enc({ type: "done" }));
            controller.close();
            return;
          }

          // Clean: surface the buffered text as one delta, then the detection log.
          controller.enqueue(enc({ type: "text", delta: text }));
          if (reviewLogUpdate != null) {
            controller.enqueue(enc({ type: "review_update", review: reviewLogUpdate }));
          }
          controller.enqueue(enc({ type: "done" }));
          controller.close();
          return;
        }

        // Normal cleared path: stream deltas live.
        sdkStream.on("text", (delta: string) => {
          controller.enqueue(enc({ type: "text", delta }));
        });
        await sdkStream.finalMessage();

        if (reviewLogUpdate != null) {
          controller.enqueue(enc({ type: "review_update", review: reviewLogUpdate }));
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
