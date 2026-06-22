/**
 * Surface 6 — Evidence tagging (LLM-SCHEMAS.md §7).
 *
 * SERVER ONLY. Given a piece of evidence (a document's OCR text for uploaded
 * docs, or the tenant's free-text description for `tenant_stated` items) this
 * proposes an `evidence_type`, plain-English `tags`, a one-line `summary`, and a
 * set of CANDIDATE `supports_defense_codes`.
 *
 * Model: claude-sonnet-4-6 (middle tier — volume + quality balance).
 *
 * Boundary (LLM-SCHEMAS.md §7):
 *   - Tagging + defense-code mapping is INFORMATION, not advice, surfaced for a
 *     human attorney to review. The model may map evidence to *candidate*
 *     defense codes; it NEVER asserts a defense applies or that the tenant "has a
 *     case" — that is `defenses_checklist[].attorney_disposition`, attorney-only.
 *   - Deterministic code (see `@/lib/evidence`) owns `evidence_id` and `origin`.
 *     This call proposes only the four LLM-writable fields.
 *   - For `origin="open_data"` items, the `OpenDataAssertion` (disclaimer +
 *     verify gate) is attached by the open-data ingest/evidence layer, NOT here.
 *
 * Constraint-light schema (LLM-SCHEMAS.md §0.5): the zod schema below carries no
 * min/length/pattern; `@/lib/case` (`EvidenceItemSchema` via `applyTags`) is the
 * validator of record downstream.
 */
import "server-only";

import { z } from "zod";

import { SONNET, structuredExtract, type MessageParam } from "@/lib/anthropic";
import {
  DefenseCodeSchema,
  EvidenceTypeSchema,
  type DefenseCode,
  type EvidenceType,
  type Provenance,
} from "@/lib/case";

// ---------------------------------------------------------------------------
// Structured-output schema (Surface 6)
// ---------------------------------------------------------------------------

/** Raw model output. Validated structurally; values re-validated by @/lib/case. */
export const EvidenceTagsSchema = z.object({
  evidence_type: EvidenceTypeSchema,
  tags: z.array(z.string()),
  summary: z.string().nullable(),
  /**
   * Candidate defenses this evidence COULD relate to — information for human
   * review, NOT an assertion that any defense applies.
   */
  supports_defense_codes: z.array(DefenseCodeSchema),
});
export type EvidenceTags = z.infer<typeof EvidenceTagsSchema>;

// ---------------------------------------------------------------------------
// System prompt (stable, cacheable prefix — no per-case data interpolated)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT =
  "Categorize and summarize a single piece of evidence for a NYC nonpayment " +
  "eviction case. Output: a single best evidence_type from the allowed set; a " +
  "short list of plain-English tags; a one-line plain-English summary; and any " +
  "defense codes this evidence COULD be relevant to, for a human attorney to " +
  "review.\n\n" +
  "Hard rules:\n" +
  "- Do NOT conclude the tenant has a case, or that any defense applies. The " +
  "defense codes are CANDIDATES for a human to review, never assertions.\n" +
  "- Do NOT give legal advice, predict an outcome, or recommend a strategy.\n" +
  "- Summarize only what the evidence shows. If it is unclear, say so plainly " +
  "and keep supports_defense_codes conservative (prefer fewer, or none).\n" +
  "- Keep tags concrete and useful for organizing a case folder (e.g. " +
  '"rent payment", "money order", "june 2025", "mold", "no heat").';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TagEvidenceInput {
  /**
   * The evidence content to tag: a document's OCR text (uploaded docs) or the
   * tenant's free-text description (`tenant_stated`).
   */
  content: string;
  /** Where the evidence came from — given to the model as context. */
  origin: "tenant_uploaded" | "open_data" | "tenant_stated";
  /** A known/declared evidence_type, if any (the model may refine it). */
  evidence_type_hint?: EvidenceType | null;
}

export interface TagEvidenceResult {
  /** Parsed tags, or null if the model returned nothing parseable (refusal/cutoff). */
  tags: EvidenceTags | null;
  /** Provenance to stamp on the written fields (`source: "llm_generation"`). */
  provenance: Provenance;
  /** Raw final message, for audit/usage. */
  raw: Awaited<ReturnType<typeof structuredExtract>>["message"];
}

/**
 * Build the user turn for the tagging call — the evidence content plus its
 * origin and any declared type, per LLM-SCHEMAS §7.
 */
function buildUserMessage(input: TagEvidenceInput): MessageParam {
  const header =
    `origin: ${input.origin}\n` +
    (input.evidence_type_hint
      ? `declared_evidence_type: ${input.evidence_type_hint}\n`
      : "") +
    "\nEvidence content:\n";
  return {
    role: "user",
    content: [{ type: "text", text: header + input.content }],
  };
}

/**
 * Run Surface 6 evidence tagging. Returns the proposed tags (null-guarded) plus
 * the provenance to stamp. The caller applies these with
 * `@/lib/evidence#applyTags`, which re-validates against the canonical schema.
 *
 * `max_tokens` is small (1024) per the spec — this is a cheap, low-effort pass.
 */
export async function tagEvidence(
  input: TagEvidenceInput,
): Promise<TagEvidenceResult> {
  const { parsedOutput, message } = await structuredExtract({
    schema: EvidenceTagsSchema,
    system: SYSTEM_PROMPT,
    model: SONNET,
    maxTokens: 1024,
    messages: [buildUserMessage(input)],
  });

  const provenance: Provenance = {
    source: "llm_generation",
    model: SONNET,
    extracted_at: new Date().toISOString(),
  };

  return { tags: parsedOutput, provenance, raw: message };
}

/**
 * Map the model's `supports_defense_codes` to a de-duplicated, schema-valid set.
 * Convenience for callers that want just the candidate codes. Returns [] on null.
 */
export function candidateDefenseCodes(tags: EvidenceTags | null): DefenseCode[] {
  if (!tags) return [];
  return Array.from(new Set(tags.supports_defense_codes));
}
