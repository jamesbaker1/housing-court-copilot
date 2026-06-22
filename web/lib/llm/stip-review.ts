/**
 * Stipulation / Settlement reviewer (INFORMATION ONLY).
 *
 * SERVER ONLY. Given an uploaded proposed stipulation of settlement (image or
 * PDF, base64 + media type), this module produces a plain-English, term-by-term
 * explanation of WHAT THE DOCUMENT SAYS — never a recommendation to sign or not
 * sign, never a legal conclusion, never a prediction.
 *
 * A stipulation is a binding agreement, so the highest-value safe thing we can
 * do is help the tenant *understand the words on the page* and give them a list
 * of things to ASK A LAWYER ABOUT before they sign. The product never tells the
 * tenant whether the deal is good or bad, fair or unfair, or what they should
 * do — those are the advice line (UPL / S7263), routed to a human.
 *
 * Guardrails honored (GUARDRAILS-SPEC.md):
 *   - §2.1 The LLM MUST NOT output a legal conclusion, a should/shouldn't
 *     directive, a case-strength assessment, or an outcome prediction. The
 *     structured-output schema below has NO field capable of carrying a
 *     sign/don't-sign recommendation; the model emits only neutral descriptions
 *     and "ask a lawyer about this" flags.
 *   - §1 / §5 Anything that reads as needing legal judgment sets a
 *     `needs_legal_review` signal so the route can hard-route to a human
 *     (`review.review_state = "escalated"`); this is information surfacing, NOT
 *     the conversational advice router, so it never writes `review.advice_routed`
 *     (§1.8 single-writer invariant).
 *   - §4 Strong, persistent disclaimer; never "AI lawyer". We explicitly tell the
 *     tenant a stipulation is binding and to have it reviewed before signing.
 *
 * Constraint-light LLM schema (house style): the zod schema carries no
 * min/max/length/pattern; it just shapes the neutral description output.
 */
import "server-only";

import { z } from "zod";

import {
  OPUS,
  imageMessage,
  pdfMessage,
  structuredExtract,
  type ImageMediaType,
  type MessageParam,
} from "@/lib/anthropic";
import { DISCLAIMERS, DisclaimerContext } from "@/lib/disclaimers";

// ---------------------------------------------------------------------------
// Supported intake media types (same set as document intake).
// ---------------------------------------------------------------------------

/** Media types the stip reviewer accepts. HEIC must be converted upstream. */
export type StipMediaType = "application/pdf" | ImageMediaType;

const STIP_IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export function isStipMediaType(value: string): value is StipMediaType {
  return (
    value === "application/pdf" ||
    STIP_IMAGE_MEDIA_TYPES.includes(value as ImageMediaType)
  );
}

// ---------------------------------------------------------------------------
// Structured output schema (constraint-light, neutral-description only).
//
// IMPORTANT: there is intentionally NO field that can carry a "you should sign"
// / "this is a good deal" / "you have a case" value. The model can ONLY:
//   - name a term category,
//   - quote/paraphrase what the document literally says about it (plain English),
//   - explain in general what that KIND of term usually means (information),
//   - and flag that a tenant should ask a lawyer about it.
// ---------------------------------------------------------------------------

/** The categories of stipulation terms we surface, neutrally. */
export const StipTermCategorySchema = z.enum([
  "payment_amount", // how much the tenant agrees to pay
  "payment_schedule", // when / in what installments
  "move_out", // any agreement to vacate / surrender possession
  "probationary", // "if you miss a payment, a warrant issues" type clauses
  "jurisdiction_waiver", // waiving defenses / jurisdiction / right to a trial
  "repairs_or_conditions", // landlord obligations re: repairs / HP work
  "attorney_fees_or_costs", // fees, costs, added charges
  "judgment_or_warrant", // entry of judgment, issuance/stay of warrant of eviction
  "confession_or_admission", // admissions of liability / amount owed
  "other", // anything else material that doesn't fit above
]);
export type StipTermCategory = z.infer<typeof StipTermCategorySchema>;

/** One plain-English, NEUTRAL explanation of a single term in the document. */
export const StipTermSchema = z.object({
  /** Which kind of term this is. */
  category: StipTermCategorySchema,
  /** A short neutral label for this term (e.g. "Payment amount"). */
  heading: z.string(),
  /**
   * Plain-English description of WHAT THE DOCUMENT SAYS about this term. Neutral,
   * descriptive, no recommendation. Quote the document where helpful.
   */
  what_it_says: z.string(),
  /**
   * General, non-individualized information about what this KIND of term usually
   * means in a NYC housing-court stipulation. Information, not advice; never a
   * conclusion about THIS tenant's case.
   */
  what_it_generally_means: z.string(),
  /**
   * True when this term commonly carries serious consequences a tenant should
   * have a lawyer look at before signing (e.g. move-out, waiver of defenses,
   * confession of judgment, probationary stay). Used to build the lawyer-flag
   * list and to decide whether to route the case to a human.
   */
  ask_a_lawyer: z.boolean(),
  /**
   * If `ask_a_lawyer` is true, a neutral phrasing of WHAT to ask a lawyer about
   * — framed as a question to raise, never as advice or a conclusion. Null
   * otherwise.
   */
  ask_a_lawyer_about: z.string().nullable(),
});
export type StipTerm = z.infer<typeof StipTermSchema>;

/** The full structured review output. */
export const StipReviewSchema = z.object({
  /**
   * True if the uploaded document does not look like a proposed stipulation /
   * settlement agreement at all (wrong document). The route surfaces a re-upload
   * prompt rather than treating the parse as a review.
   */
  is_stipulation: z.boolean(),
  /** A one-line neutral description of the document, plain English. */
  document_overview: z.string(),
  /** The term-by-term neutral breakdown. */
  terms: z.array(StipTermSchema),
  /**
   * True when ANYTHING in the document reads as needing legal judgment to
   * understand the consequences of signing (any `ask_a_lawyer` term, anything
   * ambiguous, or anything the model is unsure about). Conservative / fail-safe:
   * when in doubt, set true. The route uses this to hard-route to a human.
   */
  needs_legal_review: z.boolean(),
});
export type StipReviewOutput = z.infer<typeof StipReviewSchema>;

// ---------------------------------------------------------------------------
// System prompt (frozen, cacheable prefix — no per-case data interpolated).
// ---------------------------------------------------------------------------

const STIP_SYSTEM = [
  "You help a NYC tenant UNDERSTAND a proposed stipulation of settlement (a 'stip') they were handed in",
  "Housing Court. You explain, in warm plain English at about an 8th-grade reading level, what the",
  "document SAYS, term by term. You are NOT a lawyer and you do NOT give legal advice.",
  "",
  "A stipulation is a BINDING agreement. Once a tenant signs it, a court can enforce it. So your only job",
  "is to help the tenant read and understand the words, and to point out the kinds of terms that a tenant",
  "should have a lawyer look at before signing. You never tell the tenant whether to sign.",
  "",
  "For each material term in the document, produce one entry with:",
  "- category: which kind of term it is (payment amount/schedule, move-out, probationary stay, waiver of",
  "  defenses or jurisdiction, repairs/conditions, attorney fees or costs, judgment/warrant, confession or",
  "  admission, or other).",
  "- heading: a short neutral label.",
  "- what_it_says: a plain-English description of what THIS document says about that term. Quote it where",
  "  helpful. Describe only; do not characterize whether it is good, bad, fair, or unfair.",
  "- what_it_generally_means: general, non-individualized information about what that KIND of term usually",
  "  means in a NYC housing stipulation. This is general information, never a statement about whether it",
  "  applies well or badly to THIS tenant.",
  "- ask_a_lawyer: true if this kind of term commonly has serious consequences a tenant should have a",
  "  lawyer review before signing (move-out / surrender, waiving defenses or a trial, confession of",
  "  judgment, a probationary clause where missing a payment triggers a warrant, large fees). When unsure,",
  "  set true.",
  "- ask_a_lawyer_about: if ask_a_lawyer is true, a neutral QUESTION the tenant could raise with a lawyer",
  "  (e.g. 'Ask a lawyer what happens if you miss one of these payments.'). Never phrase it as advice.",
  "",
  "ABSOLUTE RULES — never break these:",
  "- This is information, not legal advice. NEVER recommend signing or not signing.",
  "- NEVER say the deal is good, bad, fair, unfair, generous, or risky as a conclusion. Do not editorialize.",
  '- NEVER say whether the tenant "has a case", will win or lose, or predict what a judge will do.',
  "- NEVER tell the tenant what they should do. No 'you should', 'you should not', 'I recommend'.",
  "- NEVER state or compute a deadline or court-date countdown as a fact.",
  "- Do not invent terms. Describe only what is actually in the document.",
  "- Set document_overview to one neutral sentence describing the document.",
  "- Set is_stipulation false if this is clearly not a settlement/stipulation document.",
  "- Set needs_legal_review true if ANY term should be reviewed by a lawyer, if anything is ambiguous, or",
  "  if you are unsure about the consequences of any term. When in doubt, set it true (fail safe).",
].join("\n");

const STIP_USER_TEXT =
  "Read this proposed stipulation / settlement agreement and explain, term by term, what it SAYS in plain " +
  "English. List the terms a tenant should ask a lawyer about before signing. Do not recommend signing or " +
  "not signing, and do not say whether it is a good or bad deal.";

// ---------------------------------------------------------------------------
// Message builder (vision/PDF block before the text block).
// ---------------------------------------------------------------------------

function buildUserMessage(
  base64Data: string,
  mediaType: StipMediaType,
  text: string,
): MessageParam {
  if (mediaType === "application/pdf") {
    return pdfMessage(base64Data, text);
  }
  return imageMessage(base64Data, mediaType, text);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

export interface StipReviewInput {
  /** Base64-encoded file bytes (no data: URI prefix). */
  base64Data: string;
  /** Media type of the uploaded file. */
  mediaType: StipMediaType;
}

export interface StipReviewResult {
  /** Structured review output, or null on a refusal / empty parse. */
  review: StipReviewOutput | null;
  /**
   * True if the model refused, returned nothing parseable, or the document did
   * not look like a stipulation — the route should route to a human and/or
   * prompt a re-upload rather than treating empty content as data.
   */
  routeToReview: boolean;
  /**
   * True when the reviewer determined anything needs legal judgment (any
   * ask_a_lawyer term, ambiguity, or a refusal). The route uses this to set
   * `review.review_state = "escalated"`. ALWAYS true on a refusal (fail closed).
   */
  needsLegalReview: boolean;
  /** The contextual disclaimer to render WITH the review (a trust feature). */
  disclaimer: { label: string; body: string };
  /**
   * The standing "a stipulation is binding — have a lawyer review it before you
   * sign" message. Always present; never softened.
   */
  bindingNotice: string;
  /** Exact model id used, for provenance/audit. */
  model: typeof OPUS;
}

/**
 * Standing notice surfaced on every stip review. Not LLM-authored (it is fixed
 * product copy), so it carries no advice and never changes.
 */
export const STIP_BINDING_NOTICE =
  "A stipulation is a binding agreement. Once you sign it, the court can hold you " +
  "to it. This tool only helps you understand what the document says — it cannot " +
  "tell you whether to sign it or whether it is a good deal. Have a lawyer review " +
  "it before you sign. Free help is available.";

/**
 * Run the stipulation reviewer on one uploaded document.
 *
 * Output is ALWAYS information-only: neutral term descriptions + "ask a lawyer"
 * flags. There is no field, and no code path, that emits a sign/don't-sign
 * recommendation. On any refusal/empty parse the result fails closed
 * (`routeToReview` and `needsLegalReview` true).
 */
export async function reviewStipulation(
  input: StipReviewInput,
): Promise<StipReviewResult> {
  const { base64Data, mediaType } = input;
  const disclaimer = DISCLAIMERS[DisclaimerContext.AnswerDraft];

  let parsed: StipReviewOutput | null = null;
  let refused = false;

  try {
    const result = await structuredExtract({
      schema: StipReviewSchema,
      system: STIP_SYSTEM,
      model: OPUS,
      maxTokens: 8192,
      hardReasoning: true,
      messages: [buildUserMessage(base64Data, mediaType, STIP_USER_TEXT)],
    });
    parsed = result.parsedOutput;
    refused = result.message.stop_reason === "refusal";
  } catch {
    // Treat a thrown error as a refusal for fail-closed purposes; the route maps
    // this to a 502 separately, but we keep the contract consistent.
    refused = true;
    parsed = null;
  }

  // Fail closed: a refusal, an empty parse, or a not-a-stipulation result all
  // route to a human / re-upload and are treated as needing legal review.
  const notAStip = parsed !== null && parsed.is_stipulation === false;
  const routeToReview = parsed === null || refused || notAStip;

  // needs_legal_review is conservative: model signal OR any flagged term OR any
  // failure. We never DOWNGRADE the model's signal here.
  const needsLegalReview =
    routeToReview ||
    (parsed?.needs_legal_review ?? true) ||
    (parsed?.terms.some((t) => t.ask_a_lawyer) ?? true);

  return {
    review: parsed,
    routeToReview,
    needsLegalReview,
    disclaimer,
    bindingNotice: STIP_BINDING_NOTICE,
    model: OPUS,
  };
}
