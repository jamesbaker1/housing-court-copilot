/**
 * ANSWER DRAFT — Surface 5: answer-field transcription (LLM-SCHEMAS.md §6).
 *
 * This is the heart of the UPL boundary (GUARDRAILS §2.2): the LLM FAITHFULLY
 * TRANSCRIBES the tenant's OWN factual statements into clean answer-field text.
 * It does NOT select a defense, characterize facts legally, assert the tenant
 * "has a case," predict an outcome, or decide `general_denial`.
 *
 * Boundary invariants honored here (GUARDRAILS §0.3 / §2.2):
 *   - Every statement carries `transcription_only = true` (hard const).
 *   - `answer_draft.general_denial` is set by the TENANT, never by this call. It
 *     is a passthrough flag the route accepts from the tenant.
 *   - `answer_draft.form_fields[]` is populated by DETERMINISTIC placement, never
 *     here (`placed_by = "deterministic"`).
 *   - If an utterance is the tenant SEEKING ADVICE rather than stating a fact,
 *     it is flagged (`is_advice_request`) and NOT transcribed as a statement —
 *     it feeds the advice-routing path (GUARDRAILS §1).
 *
 * Output is always labeled "DRAFT — have a lawyer review before filing"
 * (DisclaimerContext.AnswerDraft) wherever it is shown.
 *
 * SERVER ONLY.
 */
import "server-only";

import { z } from "zod";

import { structuredExtract, OPUS } from "@/lib/anthropic";
import {
  type FactualStatement,
  type Provenance,
} from "@/lib/case";
import { DisclaimerContext, getDisclaimer } from "@/lib/disclaimers";

// ---------------------------------------------------------------------------
// Structured-output schema (LLM-SCHEMAS.md §6 Surface 5).
// Constraint-light per §0.5. `transcription_only` is the hard const invariant.
// ---------------------------------------------------------------------------

export const TranscribedStatementSchema = z.object({
  /**
   * Faithful transcription of ONE tenant-stated fact. Grammar/spelling fixed and
   * translated if needed, but meaning never changed and NO legal characterization
   * added. A legal label ("warranty of habitability") is dropped down to the
   * underlying fact ("the heat was off for two weeks in January").
   */
  text: z.string(),
  /** BCP-47 of the tenant's original statement, when detectable. */
  source_language: z.string().nullable(),
  /** Hard boundary invariant (GUARDRAILS §0.3): faithful transcription, not advice. */
  transcription_only: z.literal(true),
  /**
   * True if this utterance is the tenant SEEKING ADVICE (e.g. "do I have a case",
   * "should I pay") rather than stating a fact. If true, deterministic code
   * routes it to a human and it is NOT written as a factual statement.
   */
  is_advice_request: z.boolean(),
});
export type TranscribedStatement = z.infer<typeof TranscribedStatementSchema>;

export const AnswerDraftOutputSchema = z.object({
  factual_statements: z.array(TranscribedStatementSchema),
});
export type AnswerDraftOutput = z.infer<typeof AnswerDraftOutputSchema>;

// ---------------------------------------------------------------------------
// System prompt (stable, cacheable prefix — no per-case data interpolated).
// Mirrors LLM-SCHEMAS §6 verbatim in intent.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You transcribe a NYC Housing Court nonpayment tenant's OWN statements of fact into clear, first-person answer-field text. You are a faithful transcriber, not a lawyer or an advisor.

RULES (a violation is a serious safety failure):
1. Include ONLY facts the tenant stated. Do not invent, infer, or add facts the tenant did not say.
2. Add NO legal characterization, conclusion, defense label, recommendation, or opinion about what a fact "means" or "shows." Do not name a defense. Do not say a fact proves anything.
3. If a statement contains a legal conclusion (e.g. "my landlord broke the warranty of habitability"), transcribe the underlying FACT ("the heat was off for two weeks in January") and DROP the legal label.
4. Fix grammar and spelling, and translate into the tenant's preferred output language if their statement is in another language — but NEVER change the meaning.
5. Split distinct facts into separate statements. Keep each statement to a single clear fact in the tenant's own voice (first person).
6. If an utterance is the tenant ASKING FOR ADVICE rather than stating a fact (e.g. "do I have a case?", "should I pay?", "which defense should I use?", "will I win?"), set is_advice_request=true for that item and put a short neutral paraphrase of the question in "text" (do NOT answer it). Such items are NOT used as answer-field statements — a human handles them.
7. Never tell the tenant what to do, never predict an outcome, never assess their case.

Set source_language to the BCP-47 tag of the original statement when you can detect it, else null. Set transcription_only=true on every item. Output only the structured statements.`;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface DraftAnswerInput {
  /** The tenant's raw statements (typed, or transcribed from voice). */
  raw_statements: string;
  /** BCP-47 target/output language for the answer fields. Defaults to "en". */
  language?: string;
}

function buildUserTurn(input: DraftAnswerInput): string {
  const lang = input.language ?? "en";
  return [
    `Tenant's preferred answer-field language (BCP-47): ${lang}`,
    "The tenant's raw statements are below. Transcribe each distinct FACT faithfully into that language; flag any advice-seeking utterance with is_advice_request=true and do not answer it.",
    "--- TENANT STATEMENTS START ---",
    input.raw_statements,
    "--- TENANT STATEMENTS END ---",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The label that MUST accompany this draft wherever it is shown. */
export const ANSWER_DRAFT_DISCLAIMER = getDisclaimer(
  DisclaimerContext.AnswerDraft,
);

export interface DraftAnswerResult {
  /**
   * Faithfully transcribed factual statements (LLM-authored subset). Statements
   * with `is_advice_request === true` are surfaced separately and must NOT be
   * written as answer-field statements. Null if nothing parseable.
   */
  statements: TranscribedStatement[] | null;
  /** Exact model id used, for provenance/audit. */
  model: string;
  /** Stop reason, for refusal/max_tokens handling by the caller. */
  stopReason: string | null;
}

/**
 * Faithfully transcribe the tenant's own statements into answer-field text.
 *
 * Uses Opus (trust-critical, faithful transcription is the UPL boundary) with
 * hard reasoning on (LLM-SCHEMAS §6, GUARDRAILS §7.5). On a refusal or
 * unparseable result, `statements` is null — fail safe (do not fabricate).
 */
export async function draftAnswer(
  input: DraftAnswerInput,
): Promise<DraftAnswerResult> {
  const { parsedOutput, message } = await structuredExtract({
    schema: AnswerDraftOutputSchema,
    system: SYSTEM_PROMPT,
    model: OPUS,
    maxTokens: 8192,
    hardReasoning: true,
    messages: [{ role: "user", content: buildUserTurn(input) }],
  });

  const stopReason = message.stop_reason ?? null;

  if (stopReason === "refusal" || parsedOutput === null) {
    return { statements: null, model: OPUS, stopReason };
  }

  return { statements: parsedOutput.factual_statements, model: OPUS, stopReason };
}

/** Split the model output into answer-field statements vs. advice-seeking turns. */
export function partitionStatements(statements: TranscribedStatement[]): {
  factual: TranscribedStatement[];
  adviceRequests: TranscribedStatement[];
} {
  const factual: TranscribedStatement[] = [];
  const adviceRequests: TranscribedStatement[] = [];
  for (const s of statements) {
    if (s.is_advice_request) adviceRequests.push(s);
    else factual.push(s);
  }
  return { factual, adviceRequests };
}

/**
 * Wrap an LLM-transcribed statement into a full Case Object {@link FactualStatement}.
 * Deterministic/route code owns `statement_id` (a stmt_ ULID), `tenant_confirmed`,
 * the `transcription_only:true` const, and provenance (single-valued
 * `llm_generation` — GUARDRAILS §2.2 / §7.3). Advice-request items must be
 * filtered out (see {@link partitionStatements}) before calling this.
 */
export function toFactualStatement(
  statement: TranscribedStatement,
  statementId: string,
): FactualStatement {
  const provenance: Provenance = {
    // Single value — the LLM produced/rewrote the text. Never "llm_transcription".
    source: "llm_generation",
    model: OPUS,
  };
  return {
    statement_id: statementId,
    text: statement.text,
    source_language: statement.source_language,
    tenant_confirmed: false,
    // Hard invariant re-stamped deterministically.
    transcription_only: true,
    provenance,
  };
}
