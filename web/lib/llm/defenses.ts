/**
 * DEFENSE-SPOTTING — Surface 12 (LLM-SCHEMAS.md §13).
 *
 * Given the case's confirmed facts + the tenant's narrative, surface a checklist
 * of POSSIBLE defenses worth discussing with a lawyer. This is the most
 * advice-adjacent generation surface, so the boundary is strict:
 *
 *   - It surfaces *possibilities only* — "things worth asking a lawyer about."
 *   - It NEVER asserts the tenant has a defense, picks "the" defense, predicts an
 *     outcome, or says "you have a case." (GUARDRAILS-SPEC §2.1 / §2.3 / §5.)
 *   - Every item carries `surfaced_as = "information_not_advice"` (hard const,
 *     one of the five boundary invariants — GUARDRAILS §0.3).
 *   - `relevance_signal` is a NEUTRAL fact/evidence signal, never a recommendation.
 *   - `attorney_disposition` is attorney-only and is NEVER set here.
 *   - `attorney_reviewed` defaults false.
 *
 * The LLM produces only `explanation` + `relevance_signal` + the candidate code +
 * supporting evidence ids. Deterministic code (the route handler) stamps the
 * `surfaced_as` const, `attorney_reviewed:false`, provenance, and audit — see
 * GUARDRAILS §14 implementation checklist.
 *
 * SERVER ONLY (imports the server-only Anthropic client).
 */
import "server-only";

import { z } from "zod";

import { structuredExtract, SONNET } from "@/lib/anthropic";
import {
  DefenseCodeSchema,
  EvidenceIdSchema,
  type DefenseChecklistItem,
  type DefenseCode,
} from "@/lib/case";

// ---------------------------------------------------------------------------
// Structured-output schema (LLM-SCHEMAS.md §13 Surface 12).
//
// Constraint-light per LLM-SCHEMAS §0.5: the API/SDK rejects min/max/length
// keywords, so we keep raw enums + const only. The `relevance_signal` enum is
// the *only* vocabulary the LLM may use for relevance — it cannot emit a
// recommendation. `surfaced_as` is a literal const = the boundary invariant.
// ---------------------------------------------------------------------------

export const RelevanceSignalSchema = z.enum([
  "possible",
  "evidence_present",
  "not_indicated",
]);
export type RelevanceSignal = z.infer<typeof RelevanceSignalSchema>;

/** One LLM-surfaced possible-defense item (the LLM-authored subset of fields). */
export const DefenseSpotItemSchema = z.object({
  defense_code: DefenseCodeSchema,
  /**
   * Hard boundary invariant (GUARDRAILS §0.3). The model is constrained to this
   * single value; the route also re-stamps it before persistence.
   */
  surfaced_as: z.literal("information_not_advice"),
  /**
   * Neutral signal derived ONLY from whether supporting facts/evidence are
   * present. NOT a recommendation, NOT a conclusion that the defense applies.
   * `possible` for an unverified open-data-derived signal until verified
   * (LLM-SCHEMAS §7 / GUARDRAILS §3.8).
   */
  relevance_signal: RelevanceSignalSchema.nullable(),
  /**
   * GENERAL plain-English description of what this defense is, in nonpayment
   * cases generally — never "this applies to you," never a legal conclusion
   * about this tenant's case.
   */
  explanation: z.string().nullable(),
  /** ev_ ULID FKs to evidence items that COULD relate (information, not proof). */
  supporting_evidence_ids: z.array(EvidenceIdSchema),
});
export type DefenseSpotItem = z.infer<typeof DefenseSpotItemSchema>;

export const DefenseSpotOutputSchema = z.object({
  items: z.array(DefenseSpotItemSchema),
});
export type DefenseSpotOutput = z.infer<typeof DefenseSpotOutputSchema>;

// ---------------------------------------------------------------------------
// System prompt (stable, cacheable prefix — no per-case data interpolated).
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You help a NYC Housing Court nonpayment tenant understand which defenses are GENERALLY worth asking a lawyer about. You produce neutral, educational information — never advice.

ABSOLUTE RULES (a violation is a serious safety failure):
- You surface POSSIBILITIES only: defenses some tenants raise in cases like this. Seeing a defense here does NOT mean it applies to this tenant or that they "have a case."
- NEVER assert a defense applies, NEVER pick "the" defense or rank them, NEVER say the tenant has a case or is likely to win/lose, NEVER predict what a judge will do, NEVER tell the tenant what to do or what to argue.
- For each defense, "explanation" is a GENERAL description of what that defense means in NYC nonpayment cases — not a statement about THIS tenant. Do not write "this means your landlord broke the law" or "this applies to you."
- "relevance_signal" is a neutral fact/evidence signal, NOT a recommendation:
  * "evidence_present": the tenant has produced supporting facts/evidence for this topic.
  * "possible": facts hint at it, OR the support is an UNVERIFIED public-data signal (HPD violations/complaints/registration not yet tenant-verified) — use "possible" for those until verified.
  * "not_indicated": nothing in the facts points to it. (You may still include it as general information; set the signal honestly.)
  * null: you genuinely cannot tell.
- Only use the provided defense_code enum values. Map evidence by its ev_ id only when it plausibly relates; an empty list is fine.
- You do NOT decide attorney_disposition or whether a defense is "applicable" — that is a lawyer's job and is not your output.
- Be inclusive but honest: it is better to surface a possibility neutrally than to hide it, and better to mark "not_indicated"/"possible" than to overstate. When unsure, lean toward "possible"/null, never toward asserting applicability.

Write explanations in plain 8th-grade English. Output only the structured items.`;

// ---------------------------------------------------------------------------
// Input shape (what the caller passes; assembled into the user turn).
// ---------------------------------------------------------------------------

/** A confirmed/known fact about the case, neutrally described for the model. */
export interface DefenseSpotEvidenceContext {
  evidence_id: string;
  evidence_type?: string;
  summary?: string | null;
  /** For open-data-derived items: is the backing assertion tenant-verified yet? */
  open_data_verified?: boolean;
}

export interface DefenseSpotInput {
  /** The tenant's free-text narrative of their situation. */
  narrative?: string | null;
  /**
   * Confirmed facts from the Case Object, neutrally serialized. Caller decides
   * what to include (e.g. claimed_arrears, monthly_rent, dates, parties). Keep
   * it factual — this drives the relevance signal, not a conclusion.
   */
  confirmed_facts?: Record<string, unknown>;
  /** Candidate defense codes (e.g. from evidence[].supports_defense_codes). */
  candidate_defense_codes?: DefenseCode[];
  /** Evidence items that exist on the case, with verify-gate state. */
  evidence?: DefenseSpotEvidenceContext[];
  /** BCP-47 output language. Defaults to "en". */
  language?: string;
}

function buildUserTurn(input: DefenseSpotInput): string {
  const lang = input.language ?? "en";
  const parts: string[] = [];
  parts.push(`Output language (BCP-47): ${lang}`);

  if (input.candidate_defense_codes && input.candidate_defense_codes.length > 0) {
    parts.push(
      `Candidate defense codes surfaced upstream (consider these, plus any other enum value the facts hint at):\n${JSON.stringify(
        input.candidate_defense_codes,
      )}`,
    );
  } else {
    parts.push(
      "No upstream candidate codes were provided. Consider the full defense_code enum and surface the ones the facts/narrative plausibly relate to.",
    );
  }

  parts.push(
    `Confirmed case facts (neutral; use ONLY to set relevance_signal, never to conclude):\n${JSON.stringify(
      input.confirmed_facts ?? {},
      null,
      2,
    )}`,
  );

  if (input.evidence && input.evidence.length > 0) {
    parts.push(
      `Evidence on file (map by ev_ id when plausibly related; open_data_verified=false means an UNVERIFIED public-data signal → use "possible"):\n${JSON.stringify(
        input.evidence,
        null,
        2,
      )}`,
    );
  } else {
    parts.push("No evidence items are on file yet.");
  }

  parts.push(
    `Tenant's narrative (their own words):\n${
      input.narrative && input.narrative.trim().length > 0
        ? input.narrative
        : "(none provided)"
    }`,
  );

  parts.push(
    "For each defense worth surfacing, return: defense_code, surfaced_as=\"information_not_advice\", a neutral relevance_signal, a GENERAL explanation, and supporting_evidence_ids (ev_ ids only, may be empty). Do not assert applicability or pick a defense.",
  );

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SpotDefensesResult {
  /** LLM-surfaced possibilities (subset of fields). Null if nothing parseable. */
  items: DefenseSpotItem[] | null;
  /** Exact model id used, for provenance/audit. */
  model: string;
  /** Stop reason, for refusal/max_tokens handling by the caller. */
  stopReason: string | null;
}

/**
 * Surface possible defenses to discuss with a lawyer. Returns the LLM-authored
 * subset; the route handler wraps each into a full {@link DefenseChecklistItem}
 * (stamping the const, provenance, attorney_reviewed:false, audit).
 *
 * On a refusal or unparseable result, `items` is null — the caller should route
 * the case to human review rather than fabricate a checklist (fail safe).
 */
export async function spotDefenses(
  input: DefenseSpotInput,
): Promise<SpotDefensesResult> {
  // Surface 12 uses Sonnet (volume + quality balance) with hard reasoning on —
  // defense-spotting is reasoning-heavy (LLM-SCHEMAS §13, GUARDRAILS §7.5).
  const { parsedOutput, message } = await structuredExtract({
    schema: DefenseSpotOutputSchema,
    system: SYSTEM_PROMPT,
    model: SONNET,
    maxTokens: 8000,
    hardReasoning: true,
    messages: [{ role: "user", content: buildUserTurn(input) }],
  });

  const stopReason = message.stop_reason ?? null;

  // Fail closed: a refusal or non-parseable output yields no checklist.
  if (stopReason === "refusal" || parsedOutput === null) {
    return { items: null, model: SONNET, stopReason };
  }

  return { items: parsedOutput.items, model: SONNET, stopReason };
}

/**
 * Convert an LLM-surfaced item into a full Case Object {@link DefenseChecklistItem}.
 * Deterministic code owns the const stamp, the attorney-only fields, and review
 * defaults — the LLM never authors them.
 */
export function toChecklistItem(item: DefenseSpotItem): DefenseChecklistItem {
  return {
    defense_code: item.defense_code,
    // Hard invariant re-stamped deterministically (never trusted from the model).
    surfaced_as: "information_not_advice",
    relevance_signal: item.relevance_signal,
    supporting_evidence_ids: item.supporting_evidence_ids,
    explanation: item.explanation,
    attorney_reviewed: false,
    // attorney_disposition is attorney-only — left unset (GUARDRAILS §2.3).
    attorney_disposition: null,
  };
}
