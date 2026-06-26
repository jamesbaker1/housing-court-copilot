/**
 * Backstop #1 (deadline half) — lib/deadlines.ts fail-SAFE math.
 *
 * The LLM never computes a deadline. An unvalidated/unpopulated config must
 * NEVER fabricate an authoritative clock: the engine emits insufficient_data /
 * provisional / uncertain instead, and every Deadline it does emit carries the
 * hard `computed_by = "deterministic"` provenance. When uncertain about risk,
 * it fails safe toward flagging (uncertain_anchor / escalate), never toward a
 * confident "you're fine".
 */
import { describe, expect, it } from "vitest";

import {
  UNVALIDATED_DEADLINE_CONFIG,
  computeAnswerDeadline,
  evaluateDefaultRisk,
  evaluateSatisfied,
  resolveAnchor,
  type DeadlineEngineConfig,
} from "@/lib/deadlines";
import type { Deadline } from "@/lib/case";

import { docWithServiceDate, extractedDate, makeCase, testId } from "./fixtures";

// A fully-populated, attorney-validated config (deep clone of the scaffold with
// every operative value filled). Used to prove the engine CAN go authoritative
// once an attorney signs off — and to isolate the fail-safe gates.
function validatedConfig(): DeadlineEngineConfig {
  const c: DeadlineEngineConfig = structuredClone(UNVALIDATED_DEADLINE_CONFIG);
  c.answer_window.attorney_validated_config = true;
  c.answer_window.rule_version = "1.0.0";
  c.answer_window.answer_window = {
    count: 10,
    unit: "calendar_days",
    counting_basis: "from_anchor_exclusive",
    weekend_holiday_rule: "none",
  };
  c.answer_window.min_anchor_confidence = "medium";

  c.default_risk.attorney_validated_config = true;
  c.default_risk.rule_version = "1.0.0";
  c.default_risk.imminent_window = { count: 3, unit: "calendar_days" };
  c.default_risk.missed_grace = { count: 0, unit: "calendar_days" };

  // Calendar coverage so calendar_days math is unblocked.
  c.court_holidays.coverage_from = "2026-01-01";
  c.court_holidays.coverage_until = "2027-12-31";
  c.court_holidays.calendar_version = "1.0.0";
  return c;
}

// ===========================================================================
// resolveAnchor (lib/deadlines.ts:319)
// ===========================================================================

describe("resolveAnchor", () => {
  const cfg = UNVALIDATED_DEADLINE_CONFIG.answer_window;

  it("returns null when no document has an anchor date", () => {
    const c = makeCase();
    expect(resolveAnchor(c, cfg)).toBeNull();
  });

  it("resolves the service_date and marks it NON-authoritative (LLM-extracted)", () => {
    const c = makeCase({
      documents: [docWithServiceDate(extractedDate("2026-06-01"))],
    });
    const a = resolveAnchor(c, cfg);
    expect(a).not.toBeNull();
    expect(a!.event).toBe("petition_served");
    expect(a!.date).toBe("2026-06-01");
    expect(a!.authoritative_source).toBe(false); // extracted dates never court-verified
    expect(a!.confidence).toBe("high");
  });

  it("prefers tenant_corrected_value over the raw extracted value", () => {
    const c = makeCase({
      documents: [
        docWithServiceDate(
          extractedDate("2026-06-01", { tenant_corrected_value: "2026-06-05" }),
        ),
      ],
    });
    expect(resolveAnchor(c, cfg)!.date).toBe("2026-06-05");
  });

  it("skips a malformed extracted date rather than crashing", () => {
    const c = makeCase({
      documents: [docWithServiceDate(extractedDate("not-a-date"))],
    });
    expect(resolveAnchor(c, cfg)).toBeNull();
  });
});

// ===========================================================================
// computeAnswerDeadline (lib/deadlines.ts:443) — fail-safe + provenance
// ===========================================================================

describe("computeAnswerDeadline", () => {
  const dlId = testId("dl");

  it("non-confirmed-nonpayment case => insufficient_data, null deadline", () => {
    const c = makeCase({ case_type: "holdover", case_type_confirmed: true });
    const r = computeAnswerDeadline(c, dlId);
    expect(r.status).toBe("insufficient_data");
    expect(r.deadline).toBeNull();
  });

  it("nonpayment but not confirmed => insufficient_data", () => {
    const c = makeCase({ case_type: "nonpayment", case_type_confirmed: false });
    expect(computeAnswerDeadline(c, dlId).status).toBe("insufficient_data");
  });

  it("no anchor => insufficient_data", () => {
    const c = makeCase({ case_type_confirmed: true });
    expect(computeAnswerDeadline(c, dlId).status).toBe("insufficient_data");
  });

  it("UNVALIDATED config (default) NEVER fabricates a number => insufficient_data", () => {
    // Anchor present, but the default config's answer_window is unpopulated, so
    // applyWindow errors out and the engine refuses a number.
    const c = makeCase({
      case_type_confirmed: true,
      documents: [docWithServiceDate(extractedDate("2026-06-01"))],
    });
    const r = computeAnswerDeadline(c, dlId); // default UNVALIDATED config
    expect(r.status).toBe("insufficient_data");
    expect(r.deadline).toBeNull();
  });

  it("validated config + shaky anchor (not tenant-confirmed) => PROVISIONAL, not authoritative", () => {
    const c = makeCase({
      case_type_confirmed: true,
      documents: [
        docWithServiceDate(
          extractedDate("2026-06-01", { confidence: "high", tenant_confirmed: false }),
        ),
      ],
    });
    const r = computeAnswerDeadline(c, dlId, validatedConfig());
    expect(r.status).toBe("provisional");
    expect(r.deadline).not.toBeNull();
    // 2026-06-01 + 10 calendar days exclusive => 2026-06-11
    expect(r.deadline!.due_date).toBe("2026-06-11");
    // Provenance hard invariant.
    expect(r.deadline!.computed_by).toBe("deterministic");
    // Not fileable: attorney_validated requires a TRUSTED anchor too.
    expect(r.deadline!.attorney_validated).toBe(false);
    expect(r.deadline!.risk.uncertain_anchor).toBe(true);
    expect(r.timeline_event!.date_is_authoritative).toBe(false);
  });

  it("emitted deadline always has computed_by = deterministic (never llm)", () => {
    const c = makeCase({
      case_type_confirmed: true,
      documents: [docWithServiceDate(extractedDate("2026-06-01"))],
    });
    const r = computeAnswerDeadline(c, dlId, validatedConfig());
    expect(r.deadline).not.toBeNull();
    expect(r.deadline!.computed_by).toBe("deterministic");
  });

  it("court_days math past unpopulated coverage fails SAFE (insufficient_data)", () => {
    const cfg = validatedConfig();
    cfg.answer_window.answer_window.unit = "court_days";
    cfg.court_holidays.coverage_until = null; // coverage missing -> guardCoverage errors
    const c = makeCase({
      case_type_confirmed: true,
      documents: [docWithServiceDate(extractedDate("2026-06-01"))],
    });
    const r = computeAnswerDeadline(c, dlId, cfg);
    expect(r.status).toBe("insufficient_data");
    expect(r.deadline).toBeNull();
  });
});

// ===========================================================================
// evaluateSatisfied (lib/deadlines.ts:594) — default not_satisfied
// ===========================================================================

describe("evaluateSatisfied", () => {
  const b = validatedConfig().default_risk;

  it("default is not_satisfied with an empty timeline", () => {
    expect(evaluateSatisfied(makeCase(), b)).toBe("not_satisfied");
  });

  it("court-sourced authoritative event clears to court_confirmed", () => {
    const cfg = validatedConfig();
    cfg.default_risk.satisfaction_signals.court_sourced_kinds = ["court_appearance"];
    const c = makeCase({
      timeline: [
        {
          event_id: testId("evt"),
          kind: "court_appearance",
          date: "2026-06-10",
          date_is_authoritative: true,
          description: "appeared",
        },
      ],
    });
    expect(evaluateSatisfied(c, cfg.default_risk)).toBe("court_confirmed");
  });

  it("a NON-authoritative event of the right kind does NOT satisfy (fail-safe)", () => {
    const cfg = validatedConfig();
    cfg.default_risk.satisfaction_signals.court_sourced_kinds = ["court_appearance"];
    const c = makeCase({
      timeline: [
        {
          event_id: testId("evt"),
          kind: "court_appearance",
          date: "2026-06-10",
          date_is_authoritative: false, // not court-sourced
          description: "tenant said they showed up",
        },
      ],
    });
    expect(evaluateSatisfied(c, cfg.default_risk)).toBe("not_satisfied");
  });

  it("tenant-attested marker (exact tag + finalized draft) clears to tenant_attested", () => {
    const cfg = validatedConfig();
    const tag = cfg.default_risk.satisfaction_signals.tenant_attested_tag;
    const c = makeCase({
      answer_draft: { status: "finalized", factual_statements: [], form_fields: [] },
      timeline: [
        {
          event_id: testId("evt"),
          kind: "other",
          date: "2026-06-10",
          date_is_authoritative: false,
          description: tag, // exact tag, as the canonical attestation binding
        },
      ],
    });
    expect(evaluateSatisfied(c, cfg.default_risk)).toBe("tenant_attested");
  });

  it("tolerates surrounding whitespace on the exact tag (description.trim())", () => {
    const cfg = validatedConfig();
    const tag = cfg.default_risk.satisfaction_signals.tenant_attested_tag;
    const c = makeCase({
      answer_draft: { status: "finalized", factual_statements: [], form_fields: [] },
      timeline: [
        {
          event_id: testId("evt"),
          kind: "other",
          date: "2026-06-10",
          date_is_authoritative: false,
          description: `  ${tag}  `,
        },
      ],
    });
    expect(evaluateSatisfied(c, cfg.default_risk)).toBe("tenant_attested");
  });

  it("free-text that merely CONTAINS the tag does NOT satisfy (no substring suppression)", () => {
    const cfg = validatedConfig();
    const tag = cfg.default_risk.satisfaction_signals.tenant_attested_tag;
    const c = makeCase({
      answer_draft: { status: "finalized", factual_statements: [], form_fields: [] },
      timeline: [
        {
          event_id: testId("evt"),
          kind: "other",
          date: "2026-06-10",
          date_is_authoritative: false,
          // tag echoed inside an unrelated note — must NOT clear risk.
          description: `note: the marker "${tag}" was discussed but nothing was filed`,
        },
      ],
    });
    expect(evaluateSatisfied(c, cfg.default_risk)).toBe("not_satisfied");
  });
});

// ===========================================================================
// evaluateDefaultRisk (lib/deadlines.ts:630) — fail-safe toward flagging
// ===========================================================================

function deadline(due: string): Deadline {
  return {
    deadline_id: testId("dl"),
    deadline_type: "answer_due",
    due_date: due,
    computed_by: "deterministic",
    tenant_confirmed: false,
    attorney_validated: false,
    risk: {
      is_imminent: false,
      is_missed: false,
      default_risk: false,
      uncertain_anchor: false,
    },
  };
}

describe("evaluateDefaultRisk", () => {
  it("malformed now/due date => insufficient_data (no crash)", () => {
    const r = evaluateDefaultRisk(makeCase(), deadline("2026-08-01"), "garbage");
    expect(r.status).toBe("insufficient_data");
  });

  it("UNVALIDATED config => uncertain, sets uncertain_anchor, does NOT escalate confidently", () => {
    const r = evaluateDefaultRisk(
      makeCase(),
      deadline("2026-08-01"),
      "2026-06-24",
    ); // default UNVALIDATED config
    expect(r.status).toBe("uncertain");
    expect(r.risk.uncertain_anchor).toBe(true);
    expect(r.should_escalate).toBe(false);
  });

  it("validated config but unpopulated imminent_window => uncertain + uncertain_anchor", () => {
    const cfg = validatedConfig();
    cfg.default_risk.imminent_window = { count: null, unit: null };
    const r = evaluateDefaultRisk(makeCase(), deadline("2026-08-01"), "2026-06-24", cfg);
    expect(r.status).toBe("uncertain");
    expect(r.risk.uncertain_anchor).toBe(true);
  });

  it("flags is_imminent within the window and escalates", () => {
    // due in 2 days, imminent window is 3 calendar days
    const r = evaluateDefaultRisk(makeCase(), deadline("2026-06-26"), "2026-06-24", validatedConfig());
    expect(r.status).toBe("evaluated");
    expect(r.risk.is_imminent).toBe(true);
    expect(r.risk.default_risk).toBe(true);
    expect(r.should_escalate).toBe(true);
  });

  it("flags is_missed once now is past due + grace, and escalates", () => {
    const r = evaluateDefaultRisk(makeCase(), deadline("2026-06-01"), "2026-06-24", validatedConfig());
    expect(r.status).toBe("evaluated");
    expect(r.risk.is_missed).toBe(true);
    expect(r.risk.default_risk).toBe(true);
    expect(r.should_escalate).toBe(true);
  });

  it("a court-confirmed satisfier clears is_missed (no default risk)", () => {
    const cfg = validatedConfig();
    cfg.default_risk.satisfaction_signals.court_sourced_kinds = ["answer_due"];
    const c = makeCase({
      timeline: [
        {
          event_id: testId("evt"),
          kind: "answer_due",
          date: "2026-06-01",
          date_is_authoritative: true,
          description: "answer filed and docketed",
        },
      ],
    });
    const r = evaluateDefaultRisk(c, deadline("2026-06-01"), "2026-06-24", cfg);
    expect(r.satisfied).toBe("court_confirmed");
    expect(r.risk.is_missed).toBe(false);
    expect(r.risk.default_risk).toBe(false);
  });
});
