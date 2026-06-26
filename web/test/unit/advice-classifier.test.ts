/**
 * Invariant #1 (classifier half) — lib/llm/advice-classifier.ts.
 *
 * The advice classifier is the UPL tripwire that runs fail-closed BEFORE any
 * authoring LLM. Two surfaces are tested:
 *
 *   - runAdviceClassifier: the LLM CLASSIFICATION wrapper. Any uncertain path
 *     (empty input, null parse, malformed (advice,category) combo, SDK throw)
 *     must collapse to the conservative UNREADABLE_FAIL_CLOSED result so the
 *     deterministic router routes to a human. We mock @/lib/anthropic so this is
 *     a pure unit test with no network.
 *
 *   - decideAdviceRoute: the DETERMINISTIC ROUTING DECISION (this is code, not
 *     LLM). It is exercised as a full table over the spec's steps 2-5 with an
 *     injectable `escalate` thunk (no network). The load-bearing property: a
 *     positive Haiku hit is "sticky" and can never be downgraded into an
 *     unchecked substantive answer; absence of confident clearance is never
 *     treated as clearance.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic surface BEFORE importing the classifier so runAdviceClassifier
// uses the mock instead of hitting the SDK. HAIKU/SONNET are real model-id
// constants the classifier imports; keep them stable strings. `vi.mock` is
// hoisted above the file, so the mock fn must be created via vi.hoisted() or it
// would be referenced before its `const` initializes.
const { structuredExtractMock } = vi.hoisted(() => ({
  structuredExtractMock: vi.fn(),
}));
vi.mock("@/lib/anthropic", () => ({
  HAIKU: "claude-haiku-4-5",
  SONNET: "claude-sonnet-4-6",
  OPUS: "claude-opus-4-8",
  structuredExtract: structuredExtractMock,
}));

import {
  decideAdviceRoute,
  runAdviceClassifier,
  type AdviceClassification,
  type ClassifierRun,
} from "@/lib/llm/advice-classifier";
import type { ConfidenceLevel } from "@/lib/case";

// --- helpers ----------------------------------------------------------------

function run(
  is_advice_seeking: boolean,
  confidence: ConfidenceLevel,
  category: AdviceClassification["category"] = is_advice_seeking
    ? "strategy"
    : "none",
): ClassifierRun {
  return {
    result: { is_advice_seeking, category, confidence, matched_intents: [] },
    classifier_model: "claude-haiku-4-5",
    at: "2026-06-24T00:00:00Z",
  };
}

/** An escalate thunk that must never be called (asserts no escalation happened). */
function noEscalate(): Promise<ClassifierRun> {
  return Promise.reject(new Error("escalate should not have been called"));
}

const UNREADABLE_FAIL_CLOSED: AdviceClassification = {
  is_advice_seeking: true,
  category: "strategy",
  confidence: "unreadable",
  matched_intents: ["fail_closed_uncertain"],
};

// ===========================================================================
// runAdviceClassifier — FAIL CLOSED on every uncertain path
// ===========================================================================

describe("runAdviceClassifier — fail closed", () => {
  beforeEach(() => {
    structuredExtractMock.mockReset();
  });

  it("empty / whitespace input is unreadable fail-closed (no SDK call)", async () => {
    const r = await runAdviceClassifier({ turnText: "   \n\t " });
    expect(r.result).toEqual(UNREADABLE_FAIL_CLOSED);
    expect(structuredExtractMock).not.toHaveBeenCalled();
  });

  it("null parsedOutput -> fail closed", async () => {
    structuredExtractMock.mockResolvedValue({ parsedOutput: null, message: {} });
    const r = await runAdviceClassifier({ turnText: "do I have a case?" });
    expect(r.result).toEqual(UNREADABLE_FAIL_CLOSED);
  });

  it("SDK throw -> fail closed", async () => {
    structuredExtractMock.mockRejectedValue(new Error("boom"));
    const r = await runAdviceClassifier({ turnText: "will I win?" });
    expect(r.result).toEqual(UNREADABLE_FAIL_CLOSED);
  });

  it("malformed combo (advice-seeking but category=none) -> fail closed", async () => {
    structuredExtractMock.mockResolvedValue({
      parsedOutput: {
        is_advice_seeking: true,
        category: "none",
        confidence: "high",
        matched_intents: [],
      },
      message: {},
    });
    const r = await runAdviceClassifier({ turnText: "should I pay?" });
    expect(r.result).toEqual(UNREADABLE_FAIL_CLOSED);
  });

  it("malformed combo (not advice-seeking but category!=none) -> fail closed", async () => {
    structuredExtractMock.mockResolvedValue({
      parsedOutput: {
        is_advice_seeking: false,
        category: "strategy",
        confidence: "high",
        matched_intents: [],
      },
      message: {},
    });
    const r = await runAdviceClassifier({ turnText: "what is a rent demand?" });
    expect(r.result).toEqual(UNREADABLE_FAIL_CLOSED);
  });

  it("passes through a consistent advice-seeking classification", async () => {
    const good: AdviceClassification = {
      is_advice_seeking: true,
      category: "should_i_action",
      confidence: "high",
      matched_intents: ["should I pay"],
    };
    structuredExtractMock.mockResolvedValue({
      parsedOutput: good,
      message: {},
    });
    const r = await runAdviceClassifier({ turnText: "should I pay the arrears?" });
    expect(r.result).toEqual(good);
    expect(r.classifier_model).toBe("claude-haiku-4-5");
  });

  it("passes through a consistent informational (none) classification", async () => {
    const good: AdviceClassification = {
      is_advice_seeking: false,
      category: "none",
      confidence: "high",
      matched_intents: [],
    };
    structuredExtractMock.mockResolvedValue({ parsedOutput: good, message: {} });
    const r = await runAdviceClassifier({ turnText: "what is a rent demand?" });
    expect(r.result).toEqual(good);
  });
});

// ===========================================================================
// decideAdviceRoute — deterministic routing table (GUARDRAILS-SPEC §1.4)
// ===========================================================================

describe("decideAdviceRoute — step 2: confident positive", () => {
  it("high-confidence advice -> route_to_human, no escalation", async () => {
    const out = await decideAdviceRoute(run(true, "high"), noEscalate);
    expect(out.decision).toBe("route_to_human");
    expect(out.any_positive).toBe(true);
    expect(out.runs).toHaveLength(1);
  });

  it("medium-confidence advice -> route_to_human, no escalation", async () => {
    const out = await decideAdviceRoute(run(true, "medium"), noEscalate);
    expect(out.decision).toBe("route_to_human");
    expect(out.runs).toHaveLength(1);
  });
});

describe("decideAdviceRoute — step 3: low/unreadable POSITIVE escalates (sticky)", () => {
  it("low positive + escalation still positive -> route_to_human", async () => {
    const escalate = vi.fn().mockResolvedValue(run(true, "low"));
    const out = await decideAdviceRoute(run(true, "low"), escalate);
    expect(escalate).toHaveBeenCalledOnce();
    expect(out.decision).toBe("route_to_human");
    expect(out.any_positive).toBe(true);
    expect(out.runs).toHaveLength(2);
  });

  it("unreadable positive + escalation inconclusive negative -> route_to_human (fail closed)", async () => {
    const escalate = vi.fn().mockResolvedValue(run(false, "low"));
    const out = await decideAdviceRoute(run(true, "unreadable"), escalate);
    expect(out.decision).toBe("route_to_human");
    expect(out.any_positive).toBe(true);
  });

  it("low positive + escalation CONFIDENTLY negative -> proceed_borderline (sticky, never plain proceed)", async () => {
    const escalate = vi.fn().mockResolvedValue(run(false, "high"));
    const out = await decideAdviceRoute(run(true, "low"), escalate);
    expect(out.decision).toBe("proceed_borderline");
    expect(out.any_positive).toBe(true); // the Haiku positive stays sticky
    expect(out.runs).toHaveLength(2);
  });
});

describe("decideAdviceRoute — step 4: confident negative proceeds", () => {
  it("high-confidence negative -> proceed, no escalation", async () => {
    const out = await decideAdviceRoute(run(false, "high"), noEscalate);
    expect(out.decision).toBe("proceed");
    expect(out.any_positive).toBe(false);
    expect(out.runs).toHaveLength(1);
  });

  it("medium-confidence negative -> proceed", async () => {
    const out = await decideAdviceRoute(run(false, "medium"), noEscalate);
    expect(out.decision).toBe("proceed");
  });
});

describe("decideAdviceRoute — step 5: low/unreadable NEGATIVE escalates", () => {
  it("low negative + escalation flips positive -> route_to_human (now positive)", async () => {
    const escalate = vi.fn().mockResolvedValue(run(true, "high"));
    const out = await decideAdviceRoute(run(false, "low"), escalate);
    expect(out.decision).toBe("route_to_human");
    expect(out.any_positive).toBe(true);
    expect(out.runs).toHaveLength(2);
  });

  it("low negative + escalation confidently negative -> proceed", async () => {
    const escalate = vi.fn().mockResolvedValue(run(false, "high"));
    const out = await decideAdviceRoute(run(false, "low"), escalate);
    expect(out.decision).toBe("proceed");
    expect(out.any_positive).toBe(false);
  });

  it("unreadable negative + escalation STILL inconclusive negative -> route_to_human (fail closed)", async () => {
    const escalate = vi.fn().mockResolvedValue(run(false, "low"));
    const out = await decideAdviceRoute(run(false, "unreadable"), escalate);
    expect(out.decision).toBe("route_to_human");
    // No confident clearance was ever obtained; absence of clearance != clearance.
    expect(out.any_positive).toBe(false);
  });

  it("unreadable negative + escalation unreadable negative -> route_to_human", async () => {
    const escalate = vi.fn().mockResolvedValue(run(false, "unreadable"));
    const out = await decideAdviceRoute(run(false, "unreadable"), escalate);
    expect(out.decision).toBe("route_to_human");
  });
});
