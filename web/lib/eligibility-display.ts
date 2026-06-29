/**
 * Tenant-facing eligibility display (LEGAL-RULES §8.7 — UPL clearance).
 *
 * The DET engine produces five determinations; this layer decides what a TENANT
 * may see. The §8.7 rule:
 *   - `likely_eligible` is INTERNAL-TRIAGE-ONLY. It MUST NOT be rendered to the
 *     tenant as a conclusion ("you likely qualify for a free lawyer" edges toward
 *     advice). To the tenant it reads as the same neutral "you may qualify — a
 *     lawyer will confirm" as an undetermined case.
 *   - `eligible` is framed as provisional: "based on what you told us; a lawyer
 *     confirms," never a guarantee.
 *   - `ineligible` / `program_unavailable` / `insufficient_data` show as plain,
 *     non-conclusory status.
 *
 * Pure, no I/O. Returns display primitives the UI renders; it never itself routes
 * or asserts a legal conclusion.
 */
import type { Eligibility, EligibilityResult, EligibilityDetermination } from "@/lib/case";

export type EligibilityTone = "positive" | "neutral" | "unavailable";

export interface EligibilityDisplayRow {
  /** Program label for the tenant (RTC → "free lawyer", etc.). */
  label: string;
  /** Tenant-safe status text (NEVER renders likely_eligible as a conclusion). */
  status: string;
  tone: EligibilityTone;
}

const PROGRAM_LABEL: Record<string, string> = {
  rtc: "Free lawyer (Right to Counsel)",
  legal_aid: "Legal aid",
  rental_assistance: "Rental assistance",
};

/**
 * Map a determination to TENANT-facing status text. `likely_eligible` is folded
 * into the same neutral copy as `insufficient_data` so it is never shown as a
 * conclusion (§8.7).
 */
function tenantStatus(d: EligibilityDetermination): { status: string; tone: EligibilityTone } {
  switch (d) {
    case "eligible":
      return {
        status: "You may qualify, based on what you told us. A lawyer will confirm.",
        tone: "positive",
      };
    case "likely_eligible":
    case "insufficient_data":
      // §8.7: likely_eligible is internal-only — to the tenant it is the SAME
      // neutral "you may qualify, a lawyer will confirm" as undetermined.
      return {
        status: "You may qualify — a lawyer can check for you. It's free to ask.",
        tone: "neutral",
      };
    case "ineligible":
      return {
        status: "Based on what you told us, this program may not apply — but a lawyer can still help.",
        tone: "neutral",
      };
    case "program_unavailable":
      return { status: "This program isn't available right now.", tone: "unavailable" };
    default:
      return {
        status: "A lawyer can check what you qualify for. It's free to ask.",
        tone: "neutral",
      };
  }
}

function toRow(program: string, r: EligibilityResult | undefined): EligibilityDisplayRow | null {
  if (!r) return null;
  const { status, tone } = tenantStatus(r.determination);
  return { label: PROGRAM_LABEL[program] ?? program, status, tone };
}

/**
 * Build the tenant-facing eligibility rows from a Case's `eligibility`. Returns
 * an empty array when eligibility was never evaluated (caller shows a CTA).
 */
export function tenantEligibilityRows(elig: Eligibility | undefined): EligibilityDisplayRow[] {
  if (!elig) return [];
  return [
    toRow("rtc", elig.rtc),
    toRow("legal_aid", elig.legal_aid),
    toRow("rental_assistance", elig.rental_assistance),
  ].filter((r): r is EligibilityDisplayRow => r !== null);
}

/** A one-line hub summary for the eligibility section. */
export function eligibilitySummary(elig: Eligibility | undefined): string {
  if (!elig) return "See what free help you may qualify for";
  const rows = tenantEligibilityRows(elig);
  if (rows.some((r) => r.tone === "positive")) {
    return "You may qualify for free help — a lawyer will confirm";
  }
  return "See what free help you may qualify for";
}
