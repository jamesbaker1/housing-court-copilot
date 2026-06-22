/**
 * Shared disclaimer copy + contexts.
 *
 * Product direction: disclaimers are a TRUST FEATURE, not a footer. Wherever
 * LLM output is shown, wrap it in a clear, contextual "verify this / not legal
 * advice / check with a lawyer" affordance. We never market this product as an
 * "AI lawyer" — the persistent framing is "a guide, not a lawyer."
 *
 * Two non-negotiable backstops live elsewhere (code, not copy):
 *   1) The court DATE / countdown is code-backed and tenant-confirmed.
 *   2) Advice-seeking turns are detected and hard-routed to a human.
 * This file supplies the human-readable copy that surfaces those backstops.
 */

/**
 * The context in which a disclaimer is shown. Each LLM-touching surface should
 * pick the most specific context so the copy is contextual, not generic.
 */
export enum DisclaimerContext {
  /** The persistent "guide, not a lawyer" framing shown app-wide. */
  General = "general",
  /** Shown on any LLM-drafted answer / court-form transcription. */
  AnswerDraft = "answer_draft",
  /** Shown on surfaced possible defenses (information, not advice). */
  Defense = "defense",
  /** Shown in the conversational copilot / chat surface. */
  Chat = "chat",
  /** Shown next to deadlines and the court-date countdown. */
  Deadline = "deadline",
  /** Shown next to eligibility (RTC / legal aid / rental assistance) results. */
  Eligibility = "eligibility",
}

/** Stable string-literal union mirroring {@link DisclaimerContext}. */
export type DisclaimerContextValue = `${DisclaimerContext}`;

/**
 * Persistent, app-wide framing. Surfaced in the layout banner. This is the line
 * that must always be visible: we are a guide, not a lawyer.
 */
export const PERSISTENT_BANNER =
  "This is a guide, not a lawyer. It gives you information to help you understand " +
  "your case — not legal advice. Always double-check anything important and, when " +
  "you can, talk to a lawyer.";

/** Short version of the persistent banner for tight spaces (mobile chips, etc.). */
export const PERSISTENT_BANNER_SHORT =
  "A guide, not a lawyer — information, not legal advice.";

/**
 * The "talk to a person / free help" call to action. Advice-seeking turns are
 * hard-routed here; this copy also appears wherever a human handoff is offered.
 */
export const TALK_TO_A_PERSON_CTA = {
  /** Headline shown when routing a tenant to a human. */
  heading: "Talk to a person",
  /** Body copy explaining why we route, framed supportively. */
  body:
    "Questions like “do I have a case?”, “which defense should I use?”, or “what " +
    "will happen?” need a real person who can look at your specific situation. " +
    "We don't answer those here — and that's on purpose. Free help is available.",
  /** Label for the primary action button. */
  action: "Get free legal help",
  /**
   * NYC's free tenant-help line (City-funded eviction help / Right to Counsel
   * intake). Confirm the live number against the current Office of Civil Justice
   * listing before launch; this is the canonical free-help entry point.
   */
  hotlineName: "NYC tenant help line (free)",
  hotlinePhone: "311",
  hotlineNote:
    "Call 311 and ask for tenant / eviction help, or Right to Counsel. It's free.",
} as const;

/**
 * Contextual disclaimer copy keyed by {@link DisclaimerContext}. Each entry has
 * a short `label` (for chips/badges) and a fuller `body` (for inline panels).
 */
export const DISCLAIMERS: Record<
  DisclaimerContext,
  { label: string; body: string }
> = {
  [DisclaimerContext.General]: {
    label: "A guide, not a lawyer",
    body: PERSISTENT_BANNER,
  },
  [DisclaimerContext.AnswerDraft]: {
    label: "Draft — check every word before you file",
    body:
      "This draft was put together from what you told us and the documents you " +
      "uploaded. It is a starting point, not a finished legal filing. Read every " +
      "line, fix anything that's wrong, and have a lawyer review it before you " +
      "submit it to the court. You are the one filing it.",
  },
  [DisclaimerContext.Defense]: {
    label: "Possible issues to ask about — not advice",
    body:
      "These are possible issues some tenants raise in cases like yours, shown so " +
      "you know what to ask about. Seeing one here does NOT mean it applies to you " +
      "or that you “have a case.” Only a lawyer can tell you which, if any, fit " +
      "your situation. This is information, not advice.",
  },
  [DisclaimerContext.Chat]: {
    label: "Helpful info — double-check it",
    body:
      "This assistant can explain how housing court works and help you organize " +
      "your case, but it can make mistakes and it is not your lawyer. Don't rely " +
      "on it for decisions about your case — verify important things and talk to a " +
      "person when it matters.",
  },
  [DisclaimerContext.Deadline]: {
    label: "Confirm this date — missing it can cause a default",
    body:
      "Court dates and deadlines are calculated by our system and must be " +
      "confirmed by you against your official court papers. A wrong or missed date " +
      "can lead to a default judgment (you can lose automatically). Always trust " +
      "your official court notice and confirm with the court if you're unsure.",
  },
  [DisclaimerContext.Eligibility]: {
    label: "An estimate — programs change",
    body:
      "This is an estimate based on the information you gave us and current program " +
      "rules, which change often (and some programs may be closed or in flux). It " +
      "is not a decision or a guarantee. Confirm with the program or a legal-aid " +
      "provider before relying on it.",
  },
};

/** Convenience accessor that tolerates the string-literal union form. */
export function getDisclaimer(
  context: DisclaimerContext | DisclaimerContextValue,
): { label: string; body: string } {
  return DISCLAIMERS[context as DisclaimerContext];
}
