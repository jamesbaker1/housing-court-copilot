/**
 * Conversational Copilot (GUARDRAILS-SPEC §1, §2, §4).
 *
 * SERVER ONLY. A streaming, grounded copilot (Opus) with a strong system prompt:
 * helpful, plain-language, answers GENERAL questions ("what does X mean", "what
 * happens at court", "what should I bring"), ALWAYS frames its output as
 * information-not-advice, and NEVER gives an individualized legal conclusion,
 * defense selection, case-strength assessment, outcome prediction, or directive.
 *
 * The advice-detection classifier (advice-classifier.ts) runs in the route
 * handler BEFORE this copilot is ever invoked. If the turn is advice-seeking,
 * the handler suppresses this copilot entirely and instead surfaces
 * {@link buildNonAdviceResponse} (the §1.7 fixed response + the "talk to a
 * person / free help" CTA) and records the hard-route on the case.
 *
 * This module also owns the deterministic mutations the spec assigns to the
 * conversational advice router (§1.6): {@link applyAdviceRouted} is the SOLE
 * writer of `review.advice_routed = true`.
 */
import "server-only";

import {
  chatStream,
  OPUS,
  type MessageParam,
} from "@/lib/anthropic";
import {
  PERSISTENT_BANNER,
  TALK_TO_A_PERSON_CTA,
} from "@/lib/disclaimers";
import type {
  AttorneyReview,
  Case,
  ConfidenceLevel,
  ModelId,
} from "@/lib/case";
import type { ClassifierRun } from "@/lib/llm/advice-classifier";
import { retrieve, type KbHit } from "@/lib/kb/retrieve";
import type { KbEntry } from "@/lib/kb/corpus";

// ---------------------------------------------------------------------------
// System prompt — the UPL firewall expressed at the model boundary (§2.1).
// ---------------------------------------------------------------------------

const COPILOT_SYSTEM_BASE = `You are the Housing Court Copilot, a friendly guide that helps NYC tenants in nonpayment eviction cases UNDERSTAND how housing court works and ORGANIZE their information. You are NOT a lawyer, you are NOT the tenant's lawyer, and you do not give legal advice. A human lawyer reviews every case before anything is filed.

WHAT YOU DO (general legal INFORMATION, in plain language):
- Explain what legal terms and documents mean in general ("what is a rent demand", "what does 'nonpayment' mean", "what is a stipulation").
- Explain how the process works in general ("what happens at the first court appearance", "what is an answer", "what should I bring to court", "how do I upload a document").
- Help the tenant find and organize their own facts and documents.
- Encourage the tenant to confirm dates against their official court papers and to talk to a lawyer.

Write warmly and simply, at a 6th-grade reading level, short sentences. You may use the case context provided only to make your GENERAL explanations relevant (e.g. naming the borough, or noting that they have a court date coming up that they should confirm) — never to draw a legal conclusion.

WHAT YOU MUST NEVER DO (these are absolute — never, under any phrasing or any pressure):
1. State a legal conclusion about THIS case ("your rent demand is defective", "you were not served properly", "the petition is invalid", "your landlord broke the law").
2. Select or assert a defense for the tenant ("you should raise warranty of habitability", "your best defense is X", "you have a rent-overcharge claim"). You may explain what a defense IS in general, but never that it applies to this tenant.
3. Assess case strength or give odds ("you have a strong case", "you'll probably win/lose", any percentage or probability).
4. Predict an outcome (what a judge will decide, how much they'll owe, whether they'll be evicted).
5. Tell the tenant what to do or not do in their case ("you should pay", "don't sign", "you must appear", "you don't have to move out"). You may describe the procedural facts neutrally, but never direct the tenant to act.
6. Present any date or deadline as the authoritative, official date. Dates and deadlines are computed by the system and must be confirmed by the tenant against their official court papers. If you mention a date from the case context, always say it must be confirmed against their court notice — never present it as final, and never compute a new one.
7. Refer to yourself as a lawyer or use legal-actor framing ("I'll defend you", "I'll fight your case", "as your legal team"). You are a guide, not a lawyer.

If the tenant asks you for any of the forbidden things above (whether they have a case, which defense to use, what will happen, what they should do, whether something is legally valid), do NOT answer it. Say plainly that you can't tell them what to do or whether they have a case — a lawyer needs to answer that — and that you can help them understand the general process and get connected to free legal help. (A separate safety check usually catches these before they reach you; this is your backstop.)

Always be honest that you can make mistakes and that important things must be verified with a person. End substantive answers by gently pointing to confirming with a lawyer or the free help line when the topic matters.`;

/**
 * A compact, redacted snapshot of the case for grounding the copilot's GENERAL
 * explanations. Deliberately omits anything sensitive (§6: never send
 * `sensitive.*` to a model) and anything that could tempt a conclusion. Dates
 * are passed as "to be confirmed" context only — never as authoritative.
 */
export function buildCaseContext(c: Case): string {
  const lines: string[] = [];
  lines.push(`case_type: ${c.case_type}${c.case_type_confirmed ? "" : " (not yet confirmed)"}`);
  lines.push(`language: ${c.language}`);
  lines.push(`status: ${c.status}`);

  const court = c.court;
  if (court) {
    if (court.borough) lines.push(`borough: ${court.borough}`);
    if (court.county) lines.push(`county: ${court.county}`);
    if (court.index_number) lines.push(`index_number: ${court.index_number}`);
    if (court.court_date) {
      lines.push(
        `court_date (MUST be confirmed by the tenant against their official court papers; ` +
          `verified=${court.court_date_verified}, source=${court.court_date_source ?? "unknown"}): ${court.court_date}`,
      );
    }
  }

  // Deadlines: surface type + date as "confirm against your papers" context only.
  for (const d of c.deadlines) {
    lines.push(
      `deadline ${d.deadline_type}: ${d.due_date} (system-computed; tenant must confirm; ` +
        `tenant_confirmed=${d.tenant_confirmed})`,
    );
  }

  if (c.claimed_arrears) {
    lines.push(
      `claimed_arrears: $${(c.claimed_arrears.amount_cents / 100).toFixed(2)} ` +
        `(the amount the landlord's papers CLAIM — not verified, not a conclusion)`,
    );
  }

  // Defense checklist: titles ONLY, explicitly as general information, never as
  // "applies to you". Never include attorney_disposition.
  if (c.defenses_checklist.length > 0) {
    const codes = c.defenses_checklist.map((d) => d.defense_code).join(", ");
    lines.push(
      `defenses surfaced as GENERAL INFORMATION (these are topics tenants sometimes ` +
        `ask about — NOT defenses that apply to this tenant; only a lawyer decides that): ${codes}`,
    );
  }

  return `CASE CONTEXT (for relevance only; do NOT draw conclusions from it):\n${lines.join("\n")}`;
}

/**
 * Lightweight grounding for v1, when no persisted Case Object exists yet.
 *
 * The intake route is stateless in v1 (no DB, no minted case_id), so the chat
 * client cannot build a schema-valid Case. Instead it sends the tenant-CONFIRMED
 * fields it holds in client state. This builds the same kind of "for relevance
 * only, draw no conclusions" context block from those confirmed fields.
 *
 * Only values the tenant has explicitly confirmed are passed (the client filters
 * to confirmed fields), and every date is still framed as "must be confirmed
 * against the official court papers" — never authoritative. Nothing here weakens
 * the UPL firewall or the advice classifier (which runs on the raw turn text).
 */
export interface LightGrounding {
  case_type?: string | null;
  /** Tenant-confirmed { key, value } pairs (display strings). */
  confirmed_fields?: Array<{ key: string; value: string }> | null;
}

/** True when the object plausibly is a lightweight grounding payload. */
export function isLightGrounding(v: unknown): v is LightGrounding {
  if (v == null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  const okType = o.case_type == null || typeof o.case_type === "string";
  const okFields =
    o.confirmed_fields == null || Array.isArray(o.confirmed_fields);
  return okType && okFields;
}

const LIGHT_FIELD_LABELS: Record<string, string> = {
  court_date: "court_date (MUST be confirmed against the official court papers)",
  index_number: "index_number",
  borough: "borough",
  claimed_arrears:
    "claimed_arrears (the amount the landlord's papers CLAIM — not verified, not a conclusion)",
  monthly_rent: "monthly_rent",
  landlord_name: "landlord_name",
  petitioner_name: "petitioner_name",
  respondent_name: "respondent_name",
  premises_address: "premises_address",
  apartment_unit: "apartment_unit",
  rent_demand_date: "rent_demand_date (confirm against the papers)",
  petition_filed_date: "petition_filed_date (confirm against the papers)",
  service_date: "service_date (confirm against the papers)",
};

export function buildLightContext(g: LightGrounding): string {
  const lines: string[] = [];
  if (g.case_type) lines.push(`case_type: ${g.case_type}`);
  for (const f of g.confirmed_fields ?? []) {
    if (!f || typeof f.key !== "string" || typeof f.value !== "string") continue;
    const label = LIGHT_FIELD_LABELS[f.key] ?? f.key;
    lines.push(`${label}: ${f.value}`);
  }
  if (lines.length === 0) return "";
  return (
    `CASE CONTEXT (tenant-confirmed details, for relevance only; do NOT draw ` +
    `conclusions from it; dates are NOT authoritative and must be confirmed ` +
    `against the official court papers):\n${lines.join("\n")}`
  );
}

// ---------------------------------------------------------------------------
// Citation-grounded knowledge base (RAG) — the accuracy moat.
//
// Before building the system prompt we retrieve the most relevant entries from a
// CURATED, citable corpus (lib/kb/*) and inject them as the ONLY allowed source
// of legal/procedural facts. This replaces hallucination with grounded,
// attributable information. The advice firewall (COPILOT_SYSTEM_BASE) still
// applies on top: grounding makes GENERAL answers accurate; it never licenses an
// individualized conclusion, defense selection, prediction, or directive.
// ---------------------------------------------------------------------------

/** A source the copilot was given for a turn (for the UI's citations panel). */
export interface KbSource {
  id: string;
  topic: string;
  source_name: string;
  source_url: string;
}

/** Reduce a corpus entry to the citation fields the UI surfaces. */
export function toKbSource(e: KbEntry): KbSource {
  return {
    id: e.id,
    topic: e.topic,
    source_name: e.source_name,
    source_url: e.source_url,
  };
}

/** Extract the latest user turn's text from a message list (what to retrieve on). */
export function latestUserText(messages: MessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join(" ")
        .trim();
    }
  }
  return "";
}

/** How many vetted entries to inject as grounding per turn. */
const KB_TOP_K = 4;

/** Retrieve the vetted KB entries relevant to the latest user turn. */
export function retrieveKbForMessages(
  messages: MessageParam[],
  k: number = KB_TOP_K,
): KbHit[] {
  const q = latestUserText(messages);
  if (!q) return [];
  return retrieve(q, k);
}

/**
 * Render retrieved entries into a grounding block for the system prompt. The
 * instruction is strict: use ONLY these vetted sources for legal/procedural
 * facts; if the answer isn't here, say you're not sure and route to a person;
 * cite the source_name. When nothing was retrieved, we still tell the model it
 * has no vetted source for this question (so it defers rather than invents).
 */
export function buildKbGrounding(hits: KbHit[]): string {
  const header =
    `VETTED SOURCES (the ONLY source you may use for legal or procedural facts):\n` +
    `These are curated, public, GENERAL-information entries. Rules for using them:\n` +
    `- Base any explanation of how the process works or what a term means ONLY on ` +
    `the entries below. Do NOT add legal or procedural facts that are not here, and ` +
    `do NOT rely on outside knowledge for such facts.\n` +
    `- When you use an entry, cite its source by name in plain language (for ` +
    `example: "according to NY CourtHelp, ...").\n` +
    `- If the tenant's question is not covered by the entries below, do NOT guess. ` +
    `Say plainly that you are not sure and that a person (the legal team or a free ` +
    `help line) should answer it, and offer to help with the general process instead.\n` +
    `- These sources are GENERAL information only. They never tell THIS tenant what ` +
    `to do, whether they have a case, which defense applies, or what will happen — ` +
    `your firewall rules above still control.`;

  if (hits.length === 0) {
    return (
      `${header}\n\n` +
      `(No vetted entry matched this question. You have NO approved source for the ` +
      `specific facts being asked about — do not invent any; say you are not sure ` +
      `and point the tenant to a person / free legal help.)`
    );
  }

  const blocks = hits.map((h, i) => {
    const e = h.entry;
    return (
      `[Source ${i + 1}] ${e.source_name} — ${e.topic}\n` +
      `Q: ${e.question}\n` +
      `A: ${e.plain_english_answer}\n` +
      `Cite as: ${e.source_name} (${e.source_url})`
    );
  });

  return `${header}\n\n${blocks.join("\n\n")}`;
}

/**
 * Build the full system prompt. Layers (in order): the advice firewall base, the
 * vetted KB grounding (RAG), and any case/lightweight grounding for relevance.
 * Pass the retrieved KB hits so the same set can be surfaced to the UI as
 * citations (see {@link streamCopilot}).
 */
export function buildCopilotSystem(
  c: Case | null,
  light?: LightGrounding | null,
  kbHits?: KbHit[] | null,
): string {
  const parts: string[] = [COPILOT_SYSTEM_BASE];

  // KB grounding always present (even "no source matched" is a useful instruction).
  parts.push(buildKbGrounding(kbHits ?? []));

  if (c != null) {
    parts.push(buildCaseContext(c));
  } else if (light != null) {
    const ctx = buildLightContext(light);
    if (ctx) parts.push(ctx);
  }

  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// The streaming copilot
// ---------------------------------------------------------------------------

export interface CopilotStreamOptions {
  /** Prior turns + the current user turn (already advice-screened by the caller). */
  messages: MessageParam[];
  /** The case, for grounding. Pass null if not yet available. */
  caseObject: Case | null;
  /** v1 fallback grounding when no persisted Case exists (tenant-confirmed fields). */
  lightGrounding?: LightGrounding | null;
}

/**
 * Start a streaming copilot turn. Returns the raw SDK stream so the route
 * handler can pipe text deltas into an HTTP streaming response. The caller MUST
 * have already run the advice classifier and confirmed the turn is allowed to
 * proceed (decision "proceed" or "proceed_borderline").
 *
 * Before building the system prompt this retrieves the relevant vetted KB
 * entries for the latest user turn and injects them as the ONLY allowed source
 * of legal/procedural facts (citation-grounded RAG). To also surface WHICH
 * sources grounded the turn (so the UI can render citations), call
 * {@link copilotSourcesForTurn} with the same messages, or use
 * {@link streamCopilotWithSources}.
 */
export function streamCopilot(opts: CopilotStreamOptions) {
  const kbHits = retrieveKbForMessages(opts.messages);
  return chatStream({
    model: OPUS,
    system: buildCopilotSystem(
      opts.caseObject,
      opts.lightGrounding ?? null,
      kbHits,
    ),
    messages: opts.messages,
    maxTokens: 64000,
  });
}

/**
 * The vetted sources that WOULD ground a copilot turn for the given messages
 * (the same retrieval {@link streamCopilot} performs). Surface these to the UI
 * as citations alongside the streamed answer.
 */
export function copilotSourcesForTurn(messages: MessageParam[]): KbSource[] {
  return retrieveKbForMessages(messages).map((h) => toKbSource(h.entry));
}

/**
 * Convenience: start the stream AND return the sources used to ground it, so a
 * caller can emit a citations event and then pipe the stream — without running
 * retrieval twice.
 */
export function streamCopilotWithSources(opts: CopilotStreamOptions): {
  stream: ReturnType<typeof chatStream>;
  sources: KbSource[];
} {
  const kbHits = retrieveKbForMessages(opts.messages);
  const stream = chatStream({
    model: OPUS,
    system: buildCopilotSystem(
      opts.caseObject,
      opts.lightGrounding ?? null,
      kbHits,
    ),
    messages: opts.messages,
    maxTokens: 64000,
  });
  return { stream, sources: kbHits.map((h) => toKbSource(h.entry)) };
}

// ---------------------------------------------------------------------------
// The fixed non-advice response (GUARDRAILS-SPEC §1.7)
// ---------------------------------------------------------------------------

/** Shape of the fixed response shown when a turn is hard-routed to a human. */
export interface NonAdviceResponse {
  /** True — this is the suppressed-answer path. */
  routed: true;
  /** Body copy. Acknowledges the question, states the AI can't answer it. */
  message: string;
  /** The "talk to a person / free help" CTA from @/lib/disclaimers. */
  cta: typeof TALK_TO_A_PERSON_CTA;
  /** The full persistent disclaimer (§4 requires the full form here). */
  disclaimer: string;
}

/**
 * The §1.7 fixed, non-individualized message surfaced when a turn is
 * hard-routed. It does NOT restate the tenant's question in a way that implies
 * an answer, contains no defense/probability/"you should"/"you have a case"
 * construction, and carries the full persistent disclaimer.
 */
export function buildNonAdviceResponse(): NonAdviceResponse {
  return {
    routed: true,
    message:
      "That's an important question — and it's exactly the kind a real person should answer, " +
      "not me. I can't tell you what to do or whether you have a case; a lawyer needs to look " +
      "at your specific situation for that. I've flagged your question for the legal team, and " +
      "free help is available right now.",
    cta: TALK_TO_A_PERSON_CTA,
    disclaimer: PERSISTENT_BANNER,
  };
}

// ---------------------------------------------------------------------------
// Deterministic advice-routing mutation (GUARDRAILS-SPEC §1.6, §1.8).
// This module is the SOLE writer of review.advice_routed = true.
// ---------------------------------------------------------------------------

/** An audit event to append for the advice-routed mutation. */
export interface AdviceRoutedAudit {
  at: string;
  actor: { actor_type: "deterministic_engine"; actor_id: null };
  action: "advice_routed";
  field_path: "/review/advice_routed";
  model: ModelId;
}

/** Result of applying the advice-routed transition: the new review subtree + audit. */
export interface ApplyAdviceRoutedResult {
  review: AttorneyReview;
  audit_event: AdviceRoutedAudit;
}

/**
 * Apply the hard-route-to-human transition (§1.6). DETERMINISTIC — the decision
 * is code even though the detection was LLM. Pure: returns the new `review`
 * subtree and the audit event for the caller to persist; does not mutate input.
 *
 *  1. Sets `review.advice_routed = true`.
 *  2. Appends every classifier run to `review.advice_detection_log[]` (§1.7,
 *     AT-1.7) — this guarantees a matching log entry exists (single-writer
 *     invariant AT-1.8).
 *  3. Transitions `review_state`: unassigned/queued -> queued, OR -> escalated
 *     when a deadline risk is imminent / default-risk (advice near a deadline is
 *     urgent). Already-escalated stays escalated.
 *
 * `advice_routed` is sticky for the turn: once true it is not reset here. Only an
 * attorney clears it (an attorney_entered mutation, out of this module's scope).
 */
export function applyAdviceRouted(args: {
  caseObject: Case;
  runs: ClassifierRun[];
}): ApplyAdviceRoutedResult {
  const { caseObject, runs } = args;
  const prev: AttorneyReview = caseObject.review ?? {
    review_state: "unassigned",
    advice_routed: false,
    advice_detection_log: [],
  };

  // §1.6 step 2: escalate when any deadline carries imminent / default risk.
  const deadlineUrgent = caseObject.deadlines.some(
    (d) => d.risk.is_imminent || d.risk.default_risk,
  );

  const nextState: AttorneyReview["review_state"] =
    prev.review_state === "escalated" || deadlineUrgent
      ? "escalated"
      : "queued";

  const appendedLog = [
    ...prev.advice_detection_log,
    ...runs.map((r) => ({
      at: r.at,
      classifier_model: r.classifier_model,
      is_advice_seeking: r.result.is_advice_seeking,
      confidence: r.result.confidence as ConfidenceLevel,
    })),
  ];

  const review: AttorneyReview = {
    ...prev,
    advice_routed: true,
    review_state: nextState,
    advice_detection_log: appendedLog,
  };

  // §1.6 step 4: audit the route. Attribute the triggering classifier model
  // (prefer the last run that flagged advice-seeking).
  const triggering =
    [...runs].reverse().find((r) => r.result.is_advice_seeking) ??
    runs[runs.length - 1];

  const audit_event: AdviceRoutedAudit = {
    at: new Date().toISOString(),
    actor: { actor_type: "deterministic_engine", actor_id: null },
    action: "advice_routed",
    field_path: "/review/advice_routed",
    model: (triggering?.classifier_model ?? "claude-haiku-4-5") as ModelId,
  };

  return { review, audit_event };
}

/**
 * For a "proceed"/"proceed_borderline" turn we still log the classifier run(s)
 * to `advice_detection_log[]` (AT-1.7: exactly one entry per invocation) WITHOUT
 * setting `advice_routed`. Returns the new review subtree (pure).
 */
export function appendDetectionLog(args: {
  caseObject: Case;
  runs: ClassifierRun[];
}): AttorneyReview {
  const { caseObject, runs } = args;
  const prev: AttorneyReview = caseObject.review ?? {
    review_state: "unassigned",
    advice_routed: false,
    advice_detection_log: [],
  };
  return {
    ...prev,
    advice_detection_log: [
      ...prev.advice_detection_log,
      ...runs.map((r) => ({
        at: r.at,
        classifier_model: r.classifier_model,
        is_advice_seeking: r.result.is_advice_seeking,
        confidence: r.result.confidence as ConfidenceLevel,
      })),
    ],
  };
}
