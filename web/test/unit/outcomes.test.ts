/**
 * Outcome / impact tracking (ROADMAP #14).
 *
 * Guards: signals SUGGEST but never assert; the anonymized aggregate is emitted
 * ONLY with consent and carries NO PII (no case_id / names / address / note).
 */
import { describe, it, expect } from "vitest";

import {
  deriveOutcomeSignals,
  buildAnonymizedOutcome,
  isFavorableDisposition,
  DISPOSITION_LABEL,
} from "@/lib/outcomes";
import type { Case, Outcome, Deadline } from "@/lib/case";
import { makeCase } from "./fixtures";

const NOW = "2026-06-29T12:00:00Z";

function answerDeadline(opts: { confirmed?: boolean; missed?: boolean } = {}): Deadline {
  return {
    deadline_id: "dl_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    deadline_type: "answer_due",
    due_date: "2026-07-01",
    computed_by: "deterministic",
    tenant_confirmed: opts.confirmed ?? false,
    attorney_validated: false,
    risk: { is_imminent: false, is_missed: opts.missed ?? false, default_risk: false, uncertain_anchor: false },
  } as Deadline;
}

describe("deriveOutcomeSignals — suggests, never asserts", () => {
  it("suggests represented when status is represented", () => {
    const s = deriveOutcomeSignals(makeCase({ status: "represented" }));
    expect(s.suggested).toContain("represented");
  });

  it("suggests answer_filed + default_avoided when answer is filed and not missed", () => {
    const c = makeCase({
      deadlines: [answerDeadline({ confirmed: true })],
      answer_draft: {
        status: "finalized",
        factual_statements: [
          {
            statement_id: "stmt_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            text: "I paid rent in May.",
            transcription_only: true,
            tenant_confirmed: true,
          },
        ],
        form_fields: [],
      },
    });
    const s = deriveOutcomeSignals(c);
    expect(s.suggested).toContain("answer_filed");
    expect(s.suggested).toContain("default_avoided");
  });

  it("does NOT suggest default_avoided when the answer deadline was missed", () => {
    const c = makeCase({
      deadlines: [answerDeadline({ confirmed: true, missed: true })],
      answer_draft: {
        status: "finalized",
        factual_statements: [
          {
            statement_id: "stmt_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            text: "x",
            transcription_only: true,
            tenant_confirmed: true,
          },
        ],
        form_fields: [],
      },
    });
    expect(deriveOutcomeSignals(c).suggested).not.toContain("default_avoided");
  });

  it("falls back to unknown when there is no signal", () => {
    expect(deriveOutcomeSignals(makeCase()).suggested).toEqual(["unknown"]);
  });
});

describe("buildAnonymizedOutcome — PII-free, consent-gated", () => {
  const base: Outcome = {
    disposition: "default_avoided",
    recorded_by: { actor_type: "provider", actor_id: null },
    recorded_at: NOW,
    note: "Tenant Jane Doe at 123 Main St — sensitive note",
    consented_to_report: true,
  };

  it("returns null without consent (default-deny)", () => {
    expect(buildAnonymizedOutcome(makeCase(), { ...base, consented_to_report: false })).toBeNull();
  });

  it("emits a PII-free row with consent (no case_id / names / note)", () => {
    const c = makeCase({ court: { borough: "bronx", county: "Bronx", court_date_verified: false } });
    const row = buildAnonymizedOutcome(c, base)!;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(c.case_id);
    expect(serialized).not.toContain("Jane Doe");
    expect(serialized).not.toContain("123 Main");
    expect(serialized).not.toContain("sensitive note");
    expect(row.disposition).toBe("default_avoided");
    expect(row.favorable).toBe(true);
    expect(row.month).toBe("2026-06"); // coarsened from the full timestamp
    expect(row.borough).toBe("bronx");
  });

  it("favorable flag matches the disposition", () => {
    expect(isFavorableDisposition("possession_judgment")).toBe(false);
    expect(isFavorableDisposition("dismissed")).toBe(true);
  });

  it("every disposition has a human label", () => {
    for (const d of Object.keys(DISPOSITION_LABEL)) {
      expect(DISPOSITION_LABEL[d as keyof typeof DISPOSITION_LABEL].length).toBeGreaterThan(0);
    }
  });
});
