/**
 * Plain-English intake explainer.
 *
 * SERVER ONLY. Given the confirmed (or freshly extracted) document fields,
 * produce a warm, plain-English summary of: what the document is, who is suing,
 * the amount claimed, and what GENERALLY happens next in a NYC nonpayment case.
 *
 * This is information, NOT advice. It is wrapped with a disclaimer constant from
 * @/lib/disclaimers (the General "guide, not a lawyer" framing). Hard rails baked
 * into the system prompt:
 *   - Describe only what the document literally says + the general process.
 *   - NEVER predict an outcome, say whether the tenant "has a case", recommend a
 *     defense, or tell the tenant what to do (those are the advice line — routed
 *     to a human elsewhere).
 *   - NEVER state or compute an answer deadline / court-date countdown as a fact.
 *     The court date / countdown is a code-backed, tenant-confirmed backstop; the
 *     explainer may say "your papers list a court date — confirm it in the app",
 *     but it does not assert the date or the days remaining.
 *
 * Output language follows `language` (BCP-47), defaulting to English.
 *
 * Provenance note: any persisted explainer text is `provenance.source =
 * "llm_generation"` (the LLM produced the prose). This module returns transient
 * text for display; the route does not persist it as a Case Object field.
 */
import "server-only";

import {
  OPUS,
  streamChat,
  type MessageParam,
} from "@/lib/anthropic";
import {
  DISCLAIMERS,
  DisclaimerContext,
} from "@/lib/disclaimers";
import type { Borough, CaseType, Money } from "@/lib/case";

// ---------------------------------------------------------------------------
// Input — the confirmed/extracted facts the explainer is allowed to reference.
// ---------------------------------------------------------------------------

/**
 * Confirmed (or extracted-but-unconfirmed) facts handed to the explainer. These
 * are plain primitives, not ConfirmableValues — the route unwraps the confirmed
 * value (or the extracted value) before calling. Anything unknown is omitted.
 *
 * NOTE: court_date is included ONLY so the explainer can acknowledge "your
 * papers list a court date" — it must not compute a countdown or treat the date
 * as authoritative. The explainer is told not to assert the date.
 */
export interface ExplainFacts {
  case_type?: CaseType | null;
  document_type?: string | null;
  landlord_name?: string | null;
  petitioner_name?: string | null;
  respondent_name?: string | null;
  premises_address?: string | null;
  apartment_unit?: string | null;
  borough?: Borough | null;
  claimed_arrears?: Money | null;
  monthly_rent?: Money | null;
  rent_demand_date?: string | null;
  petition_filed_date?: string | null;
  service_date?: string | null;
  court_date?: string | null;
}

export interface ExplainInput {
  facts: ExplainFacts;
  /** BCP-47 output language. Defaults to "en". */
  language?: string;
  /** Streamed text-delta callback (for SSE / progressive rendering). */
  onText?: (delta: string) => void;
}

export interface ExplainResult {
  /** The generated plain-English summary. Empty string if the model refused. */
  summary: string;
  /** True if the model refused — caller should fall back to a neutral message. */
  refused: boolean;
  /** Contextual disclaimer to render WITH the summary (a trust feature). */
  disclaimer: { label: string; body: string };
  /** Exact generation model id, for provenance/audit if persisted. */
  model: typeof OPUS;
}

// ---------------------------------------------------------------------------
// System prompt (frozen, cacheable; no per-case data interpolated).
// ---------------------------------------------------------------------------

const EXPLAIN_SYSTEM = [
  "You are a warm, plain-spoken guide helping a NYC tenant understand a court document they received.",
  "You explain things at about an 8th-grade reading level, calmly and supportively. You are NOT a lawyer.",
  "",
  "Using ONLY the facts provided, write a short summary that covers, in this order:",
  "1. What this document is, in plain words (e.g. a nonpayment case in NYC Housing Court).",
  "2. Who is bringing the case against the tenant (the landlord / petitioner), if known.",
  "3. The amount of money the document says is owed, if known.",
  "4. What GENERALLY happens next in a NYC nonpayment case, described as a typical process",
  "   (for example: the tenant can respond by filing an Answer at the court clerk, and there is",
  "   usually a court date). Describe the general process only.",
  "",
  "Hard rules — do NOT break these:",
  "- This is information, not legal advice. Do not give advice.",
  '- Do NOT predict what will happen, do NOT say whether the tenant "has a case" or will win or lose.',
  "- Do NOT recommend a specific defense or tell the tenant what they should do.",
  "- Do NOT state, calculate, or count down to a deadline or court date. If a court date appears in the",
  "  facts, you may say the papers list a court date and that they should confirm it in the app and on",
  "  their official court notice — but never assert the date itself or how many days are left.",
  "- Do not invent facts. If something (like the amount or the landlord's name) is not provided, simply",
  "  don't mention it; do not guess.",
  "- Gently encourage the tenant to double-check important things and to talk to a free lawyer when they can.",
  "- Keep it concise (a few short paragraphs). Be reassuring without minimizing the situation.",
].join("\n");

// ---------------------------------------------------------------------------
// Fact formatting.
// ---------------------------------------------------------------------------

function formatMoney(money: Money | null | undefined): string | null {
  if (!money) return null;
  const dollars = (money.amount_cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: money.currency,
  });
  return dollars;
}

const BOROUGH_LABELS: Record<Borough, string> = {
  manhattan: "Manhattan",
  bronx: "the Bronx",
  brooklyn: "Brooklyn",
  queens: "Queens",
  staten_island: "Staten Island",
};

/** Render the facts as a compact, labeled block for the user turn. */
function formatFacts(facts: ExplainFacts): string {
  const lines: string[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") {
      lines.push(`- ${label}: ${value}`);
    }
  };

  add("Case type", facts.case_type ?? null);
  add("Document type", facts.document_type ?? null);
  add("Landlord", facts.landlord_name ?? null);
  add("Petitioner (who is suing)", facts.petitioner_name ?? null);
  add("Respondent (the tenant)", facts.respondent_name ?? null);
  add("Premises address", facts.premises_address ?? null);
  add("Apartment / unit", facts.apartment_unit ?? null);
  add("Borough", facts.borough ? BOROUGH_LABELS[facts.borough] : null);
  add("Amount claimed owed", formatMoney(facts.claimed_arrears));
  add("Monthly rent", formatMoney(facts.monthly_rent));
  add("Rent demand date", facts.rent_demand_date ?? null);
  add("Petition filed date", facts.petition_filed_date ?? null);
  add("Service date", facts.service_date ?? null);
  add(
    "Court date listed on the papers (DO NOT assert or count down — tell the tenant to confirm it)",
    facts.court_date ?? null,
  );

  if (lines.length === 0) {
    return "(No fields were available to summarize.)";
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Generate the plain-English intake summary. Streams text deltas through
 * `onText` when provided, and resolves with the full summary + the disclaimer to
 * render alongside it.
 */
export async function explainDocument(
  input: ExplainInput,
): Promise<ExplainResult> {
  const { facts, language = "en", onText } = input;
  const disclaimer = DISCLAIMERS[DisclaimerContext.General];

  const userText = [
    `Write the summary in this language (BCP-47): ${language}.`,
    "",
    "Here are the known facts about the tenant's document:",
    formatFacts(facts),
  ].join("\n");

  const messages: MessageParam[] = [{ role: "user", content: userText }];

  const finalMessage = await streamChat({
    messages,
    system: EXPLAIN_SYSTEM,
    model: OPUS,
    maxTokens: 2048,
    ...(onText ? { onText } : {}),
  });

  if (finalMessage.stop_reason === "refusal") {
    return { summary: "", refused: true, disclaimer, model: OPUS };
  }

  const summary = finalMessage.content
    .filter(
      (block): block is Extract<typeof block, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("")
    .trim();

  return { summary, refused: false, disclaimer, model: OPUS };
}
