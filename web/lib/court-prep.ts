/**
 * Court-day prep checklist (client value-add) — deterministic, no LLM.
 *
 * Produces PRACTICAL, PROCEDURAL "get ready for court" guidance from confirmed
 * case state: what to bring, when/where to go, what to expect, and rights-
 * preserving reminders. This is the kind of logistics help a court Help Center
 * hands out — it is NOT legal advice on the merits and never tells the tenant
 * what defense to raise or what to argue. Items are GATED on case state so the
 * list is specific to the tenant's actual situation.
 *
 * Pure functions. No I/O, no mutation, no model. The UI renders the structured
 * items; localization can map each stable `id` to translated copy later.
 */
import type { Case, Borough } from "@/lib/case";

export type PrepCategory = "bring" | "timing" | "expect" | "protect";

export interface PrepItem {
  /** Stable id for localization + keys. */
  id: string;
  category: PrepCategory;
  text: string;
  /** Why this item is shown (state-derived; for transparency, not advice). */
  reason?: string;
}

export interface CourtPrepChecklist {
  /** True only when there is a tenant-confirmed court date to prepare for. */
  hasCourtDate: boolean;
  courtDate: string | null;
  borough: Borough | null;
  items: PrepItem[];
}

const BOROUGH_LABEL: Record<Borough, string> = {
  manhattan: "Manhattan",
  bronx: "the Bronx",
  brooklyn: "Brooklyn",
  queens: "Queens",
  staten_island: "Staten Island",
};

/**
 * Build the court-day prep checklist for a case. Always returns the universal
 * items; adds state-specific items when the relevant facts are present.
 */
export function buildCourtPrepChecklist(c: Case): CourtPrepChecklist {
  const courtDate = c.court?.court_date ?? null;
  const hasCourtDate =
    !!courtDate &&
    (c.court?.court_date_verified === true ||
      c.court?.court_date_source === "tenant_entered");
  const borough = c.court?.borough ?? null;
  const items: PrepItem[] = [];

  // ---- BRING ----
  items.push({
    id: "bring_court_papers",
    category: "bring",
    text: "Bring ALL the court papers you received (the petition and any notices). Bring the originals if you have them.",
  });
  items.push({
    id: "bring_id",
    category: "bring",
    text: "Bring a photo ID if you have one.",
  });

  if (c.court?.index_number) {
    items.push({
      id: "bring_index_number",
      category: "bring",
      text: `Write down your case (index) number and keep it with you: ${c.court.index_number}.`,
      reason: "case has an index number on file",
    });
  } else {
    items.push({
      id: "find_index_number",
      category: "bring",
      text: "Find your case (index) number on your court papers — you'll need it to check in.",
    });
  }

  const evidenceCount = (c.evidence ?? []).length;
  if (evidenceCount > 0) {
    items.push({
      id: "bring_evidence",
      category: "bring",
      text: `Bring your evidence — you have ${evidenceCount} item${evidenceCount === 1 ? "" : "s"} saved (receipts, photos, letters, texts). Bring printed copies if you can.`,
      reason: "evidence items are on the case",
    });
  } else {
    items.push({
      id: "gather_evidence",
      category: "bring",
      text: "Gather any proof you have: rent receipts or money-order stubs, photos of repair problems, letters or texts with your landlord.",
    });
  }

  if (c.claimed_arrears && c.claimed_arrears.amount_cents > 0) {
    items.push({
      id: "bring_payment_proof",
      category: "bring",
      text: "Bring proof of any rent you have paid (receipts, money orders, bank or app records). The amount the landlord claims may not be right.",
      reason: "the case has a claimed arrears amount",
    });
  }

  const hasDraft = (c.answer_draft?.factual_statements?.length ?? 0) > 0;
  if (hasDraft) {
    items.push({
      id: "bring_draft_answer",
      category: "bring",
      text: "Bring your draft Answer and read it over before you go. It's a draft — have the Help Center or a lawyer review it.",
      reason: "a draft answer exists",
    });
  }

  // ---- TIMING / WHERE ----
  items.push({
    id: "arrive_early",
    category: "timing",
    text: "Plan to arrive at least 30–45 minutes early. There may be a security line, and you need time to find your courtroom.",
  });
  items.push({
    id: "address_on_papers",
    category: "timing",
    text:
      "Go to the Housing Court address printed on your court papers" +
      (borough ? ` (your case is in ${BOROUGH_LABEL[borough]})` : "") +
      ". Double-check the courtroom/part number on your notice.",
    ...(borough ? { reason: "borough is on the case" } : {}),
  });
  items.push({
    id: "never_skip",
    category: "timing",
    text: "Do NOT skip court. If you can't make it, that can lead to a default judgment against you — contact the court right away if you have an emergency.",
  });

  if ((c.language ?? "en") !== "en") {
    items.push({
      id: "request_interpreter",
      category: "timing",
      text: "You can ask for a free interpreter in your language. Ask at the clerk's window or when you check in — you do not have to bring your own.",
      reason: "case language is not English",
    });
  }

  // ---- WHAT TO EXPECT ----
  items.push({
    id: "check_in",
    category: "expect",
    text: "When you arrive, check in so the court knows you're there. Then wait for your case to be called — it can take a while.",
  });
  items.push({
    id: "ask_for_help_desk",
    category: "expect",
    text: "Ask for the Help Center and whether a free lawyer is available that day (many NYC tenants now have a right to a free lawyer).",
  });
  items.push({
    id: "may_adjourn",
    category: "expect",
    text: "Your case may be put off (adjourned) to another day. That is normal and is sometimes used to give you time to get a lawyer.",
  });

  // ---- PROTECT YOUR RIGHTS (procedural, not advice on the merits) ----
  items.push({
    id: "dont_sign_blindly",
    category: "protect",
    text: "Do NOT sign any agreement (a \"stipulation\") you don't fully understand. You can ask to speak with a lawyer first — it's free to ask.",
  });
  items.push({
    id: "free_help_anytime",
    category: "protect",
    text: "You can talk to a free housing lawyer or hotline before and on your court date. Bring this checklist and your papers.",
  });

  if (!hasCourtDate) {
    items.unshift({
      id: "confirm_court_date_first",
      category: "timing",
      text: "First, confirm your court date from your official court papers — that's the most important step before anything else.",
      reason: "no confirmed court date yet",
    });
  }

  return { hasCourtDate, courtDate, borough, items };
}

/** Group the flat item list by category, preserving order. */
export function groupPrepItems(items: PrepItem[]): Record<PrepCategory, PrepItem[]> {
  const groups: Record<PrepCategory, PrepItem[]> = {
    bring: [],
    timing: [],
    expect: [],
    protect: [],
  };
  for (const item of items) groups[item.category].push(item);
  return groups;
}

export const PREP_CATEGORY_LABEL: Record<PrepCategory, string> = {
  bring: "What to bring",
  timing: "When and where to go",
  expect: "What to expect",
  protect: "Protect yourself",
};
