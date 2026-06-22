/**
 * Advice-Detection Classifier — backstop #2 (GUARDRAILS-SPEC §1).
 *
 * SERVER ONLY. A cheap Haiku classifier that screens every free-text tenant turn
 * BEFORE any substantive model response is composed. It answers one question:
 * is this turn seeking legal advice, a legal conclusion, or an outcome
 * prediction? If yes, the caller hard-routes the turn to a human and suppresses
 * the substantive AI answer.
 *
 * The classifier is the runtime tripwire for the UPL line. It catches:
 *   - case strength ("do I have a case", "will I win")
 *   - defense selection ("which defense should I use", "should I claim X")
 *   - outcome prediction ("will the judge rule for me", "how much will I owe")
 *   - should-I actions ("should I pay", "should I sign the stipulation")
 *   - legal conclusions ("is this rent demand defective", "was I served right")
 *   - strategy ("what's my best move", "how do I get this dismissed")
 *
 * MULTILINGUAL: it must detect advice-seeking intent across all supported
 * languages (en, es, zh-Hant, ht, bn, ru, ar, ko), not English only.
 *
 * FAIL CLOSED: §1.4 of the spec. The CLASSIFICATION is LLM; the ROUTING DECISION
 * is deterministic and lives in {@link decideAdviceRoute}. Any uncertainty
 * (low/unreadable confidence, malformed output, an SDK error) is treated as
 * advice-seeking and routes to a human. A positive Haiku hit is "sticky": it can
 * escalate to Sonnet once, but a positive can never be downgraded into an
 * unchecked substantive answer.
 */
import "server-only";

import { z } from "zod";

import { HAIKU, SONNET, structuredExtract, type ModelName } from "@/lib/anthropic";
import {
  ConfidenceLevelSchema,
  type ConfidenceLevel,
  type ModelId,
} from "@/lib/case";

// ---------------------------------------------------------------------------
// Output contract (GUARDRAILS-SPEC §1.3)
// ---------------------------------------------------------------------------

/** The advice-seeking category families the classifier must distinguish. */
export const AdviceCategorySchema = z.enum([
  "case_strength", // "do I have a case", "will I win"
  "defense_selection", // "which defense should I use", "should I claim X"
  "outcome_prediction", // "will the judge rule for me", "how much will I owe"
  "should_i_action", // "should I pay", "should I show up", "should I sign"
  "legal_conclusion", // "is this rent demand defective", "is my landlord allowed to…"
  "strategy", // "what's my best move", "what should I argue"
  "none", // not advice-seeking
]);
export type AdviceCategory = z.infer<typeof AdviceCategorySchema>;

/**
 * The classifier's structured output. Mirrors the JSON schema in §1.3.
 * Invariant (enforced downstream in §1.4 step 1): `category === "none"` iff
 * `is_advice_seeking === false`.
 */
export const AdviceClassificationSchema = z.object({
  is_advice_seeking: z.boolean(),
  category: AdviceCategorySchema,
  confidence: ConfidenceLevelSchema,
  /** Free-form notes on which intent anchors matched (for audit/tuning). */
  matched_intents: z.array(z.string()),
});
export type AdviceClassification = z.infer<typeof AdviceClassificationSchema>;

/** Where the turn came from — lets the classifier weight context (§1.3). */
export const TurnContextSchema = z.enum([
  "chat",
  "answer_free_text",
  "evidence_narrative",
  "kb_question",
  "other",
]);
export type TurnContext = z.infer<typeof TurnContextSchema>;

// ---------------------------------------------------------------------------
// Classifier prompt (stable prefix — cacheable). Few-shot anchors from §1.4.
// ---------------------------------------------------------------------------

const CLASSIFIER_SYSTEM = `You are a safety classifier for a NYC housing-court information tool. You do ONE job: decide whether a tenant's message is seeking legal ADVICE, a legal CONCLUSION about their own case, an OUTCOME PREDICTION, or a directive about what to DO. You never answer the message. You only classify it.

This tool gives general legal INFORMATION, never advice. A separate system routes any advice-seeking message to a human lawyer. Your classification is the tripwire. Because a missed advice question is a serious legal-compliance failure, you FAIL CLOSED: when you are not sure, mark it advice-seeking with the appropriate low confidence.

Set is_advice_seeking = true and pick the matching category when the message asks (in ANY language) for any of:

- case_strength — whether they have a case or will win. Anchors: "do I have a case", "is my case strong", "will I win", "can I beat this", "is it worth fighting".
- defense_selection — which defense to use or whether to raise a specific one. Anchors: "which defense should I use", "should I claim the apartment isn't registered", "is warranty of habitability my best defense", "should I raise the repairs".
- outcome_prediction — what will happen, how a judge will rule, how much they'll owe, whether they'll be evicted. Anchors: "what will the judge decide", "how much will I have to pay", "will I get evicted", "what are my chances".
- should_i_action — whether they should take some action in their case. Anchors: "should I pay the arrears", "should I show up to court", "should I sign this stipulation", "do I have to move out".
- legal_conclusion — whether something in THEIR case is legally valid/defective/proper. Anchors: "is this rent demand defective", "is my landlord allowed to do this", "is the petition valid", "was I served properly".
- strategy — their best move or what to argue. Anchors: "what's my best move", "what should I argue", "how do I get this dismissed", "what do I say to the judge".

These anchors are illustrative, NOT a literal allowlist. Generalize to paraphrases and to non-English phrasings. Examples that ARE advice-seeking: Spanish "¿debería pagar la renta?" (should_i_action), Chinese "我应该付房租吗?" (should_i_action), Haitian Creole "èske m dwe peye lwaye a?" (should_i_action).

Set is_advice_seeking = false and category = "none" ONLY for general informational questions that do not ask for a conclusion, prediction, or directive about THIS tenant's situation. Examples that are NOT advice-seeking: "What is a rent demand?", "What does 'nonpayment' mean?", "What happens at the first court date?", "What should I bring to court?", "How do I upload a document?", "What is the warranty of habitability?" (general definition, not "do I have that defense").

The distinction is subtle: "what is a rent demand" is information (none); "do I have to pay this rent demand" is advice (should_i_action). "What is the warranty of habitability" is information (none); "is warranty of habitability my best defense" is advice (defense_selection).

Confidence:
- high — clearly advice-seeking or clearly informational.
- medium — likely one or the other.
- low — genuinely borderline / ambiguous intent.
- unreadable — message is empty, garbled, or you cannot determine the language/meaning.

HARD RULES:
- category MUST be "none" if and only if is_advice_seeking is false. If advice-seeking, category MUST be one of the six advice families.
- When in doubt between information and advice, prefer advice-seeking (fail closed) and use low confidence.
- matched_intents: list the short intent phrases (in English) that drove your decision, e.g. ["should I pay", "outcome"]. Empty array if none.`;

function userPrompt(turnText: string, ctx: TurnContext, language: string): string {
  return `turn_context: ${ctx}
language (BCP-47): ${language}
tenant message (verbatim, between the markers):
<<<TURN
${turnText}
TURN>>>

Classify this message.`;
}

// ---------------------------------------------------------------------------
// Classifier invocation
// ---------------------------------------------------------------------------

/** A classifier run plus the model used and the timestamp (for the audit log). */
export interface ClassifierRun {
  result: AdviceClassification;
  classifier_model: ModelId;
  at: string;
}

/**
 * Run the advice-detection classifier once on the given model.
 *
 * FAIL CLOSED: if the SDK returns nothing parseable, or throws, or returns the
 * malformed `(is_advice_seeking, category)` combination, we synthesize a
 * conservative advice-seeking result with `confidence = "unreadable"` so the
 * deterministic router routes to a human.
 */
export async function runAdviceClassifier(args: {
  turnText: string;
  turnContext?: TurnContext;
  language?: string;
  model?: ModelName & ModelId;
}): Promise<ClassifierRun> {
  const {
    turnText,
    turnContext = "chat",
    language = "en",
    model = HAIKU,
  } = args;

  const at = new Date().toISOString();

  // Empty / whitespace-only input is unreadable -> fail closed.
  if (turnText.trim().length === 0) {
    return { result: UNREADABLE_FAIL_CLOSED, classifier_model: model, at };
  }

  try {
    const { parsedOutput } = await structuredExtract({
      schema: AdviceClassificationSchema,
      system: CLASSIFIER_SYSTEM,
      model,
      // Classification is tiny; cap low. No hard reasoning needed.
      maxTokens: 1024,
      messages: [
        { role: "user", content: userPrompt(turnText, turnContext, language) },
      ],
    });

    if (parsedOutput == null) {
      return { result: UNREADABLE_FAIL_CLOSED, classifier_model: model, at };
    }

    // Consistency guard (§1.4 step 1): category "none" must co-occur with
    // is_advice_seeking === false, and vice versa. A mismatch is malformed ->
    // fail closed (treat as advice-seeking, unreadable).
    const consistent =
      (parsedOutput.category === "none") === !parsedOutput.is_advice_seeking;
    if (!consistent) {
      return { result: UNREADABLE_FAIL_CLOSED, classifier_model: model, at };
    }

    return { result: parsedOutput, classifier_model: model, at };
  } catch {
    // Any transport/parse error fails closed.
    return { result: UNREADABLE_FAIL_CLOSED, classifier_model: model, at };
  }
}

/** The conservative fail-closed classification (advice-seeking, unreadable). */
const UNREADABLE_FAIL_CLOSED: AdviceClassification = {
  is_advice_seeking: true,
  category: "strategy",
  confidence: "unreadable",
  matched_intents: ["fail_closed_uncertain"],
};

// ---------------------------------------------------------------------------
// Deterministic routing decision (GUARDRAILS-SPEC §1.4). THIS IS CODE, NOT LLM.
// ---------------------------------------------------------------------------

/**
 * The outcome of the deterministic route decision.
 *  - `route_to_human` — suppress the substantive answer, hard-route (§1.6).
 *  - `proceed` — clear to the normal information-only handler.
 *  - `proceed_borderline` — a Haiku positive that Sonnet downgraded; the
 *    substantive handler may run but is "sticky" / borderline: the caller MUST
 *    additionally subject the OUTPUT to the UPL firewall + outbound scanner
 *    (§2.5) before surfacing, and any flag re-routes to a human (§1.4 step 3).
 */
export type RouteDecision = "route_to_human" | "proceed" | "proceed_borderline";

export interface AdviceRouteResult {
  decision: RouteDecision;
  /** Every classifier invocation, in order (1 or 2 entries). For §1.7 logging. */
  runs: ClassifierRun[];
  /** True when any run flagged advice-seeking (drives `advice_routed` audit). */
  any_positive: boolean;
}

const CONFIDENT = (c: ConfidenceLevel): boolean => c === "high" || c === "medium";

/**
 * Decide whether a turn must be hard-routed to a human, given a first-tier
 * (Haiku) classification. Re-runs once on Sonnet for any low/unreadable result
 * per §1.4 steps 3 and 5. Fully deterministic — fails closed on every
 * uncertain path.
 *
 * Pass `escalate` so this stays unit-testable without a network. In production
 * the caller passes a thunk that runs {@link runAdviceClassifier} on SONNET.
 */
export async function decideAdviceRoute(
  first: ClassifierRun,
  escalate: () => Promise<ClassifierRun>,
): Promise<AdviceRouteResult> {
  const runs: ClassifierRun[] = [first];
  const r = first.result;

  // Step 2: confident positive -> hard route.
  if (r.is_advice_seeking && CONFIDENT(r.confidence)) {
    return { decision: "route_to_human", runs, any_positive: true };
  }

  // Step 3: low/unreadable POSITIVE -> escalate once to Sonnet (sticky).
  if (r.is_advice_seeking && !CONFIDENT(r.confidence)) {
    const second = await escalate();
    runs.push(second);
    const s = second.result;

    // Escalation still positive (any confidence) -> hard route.
    if (s.is_advice_seeking) {
      return { decision: "route_to_human", runs, any_positive: true };
    }
    // Escalation negative but inconclusive -> fail closed, route.
    if (!CONFIDENT(s.confidence)) {
      return { decision: "route_to_human", runs, any_positive: true };
    }
    // Escalation confidently negative -> the Haiku positive is sticky: the turn
    // may proceed ONLY behind the firewall + outbound scanner. Borderline.
    return { decision: "proceed_borderline", runs, any_positive: true };
  }

  // Step 4: confident negative -> proceed (still firewall-gated on output).
  if (!r.is_advice_seeking && CONFIDENT(r.confidence)) {
    return { decision: "proceed", runs, any_positive: false };
  }

  // Step 5: low/unreadable NEGATIVE -> escalate to Sonnet.
  const second = await escalate();
  runs.push(second);
  const s = second.result;

  // Escalation flipped to positive -> route (and now there is a positive).
  if (s.is_advice_seeking) {
    return { decision: "route_to_human", runs, any_positive: true };
  }
  // Escalation confidently negative -> clear to proceed.
  if (CONFIDENT(s.confidence)) {
    return { decision: "proceed", runs, any_positive: false };
  }
  // Still inconclusive negative -> fail closed, route. Absence of confident
  // clearance is never treated as clearance (§7.1).
  return { decision: "route_to_human", runs, any_positive: false };
}

/**
 * Convenience end-to-end screen for a single chat turn: runs Haiku, then the
 * deterministic decision (escalating to Sonnet only when §1.4 requires it).
 */
export async function screenTurn(args: {
  turnText: string;
  turnContext?: TurnContext;
  language?: string;
}): Promise<AdviceRouteResult> {
  const first = await runAdviceClassifier({ ...args, model: HAIKU });
  return decideAdviceRoute(first, () =>
    runAdviceClassifier({ ...args, model: SONNET as ModelName & ModelId }),
  );
}
