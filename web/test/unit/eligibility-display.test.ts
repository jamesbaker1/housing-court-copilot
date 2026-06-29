/**
 * Tenant-facing eligibility display (§8.7 UPL clearance).
 *
 * The load-bearing guard: `likely_eligible` is NEVER rendered to a tenant as a
 * conclusion — it reads identically to the neutral undetermined copy.
 */
import { describe, it, expect } from "vitest";

import { tenantEligibilityRows, eligibilitySummary } from "@/lib/eligibility-display";
import type { Eligibility, EligibilityResult } from "@/lib/case";

function res(determination: EligibilityResult["determination"]): EligibilityResult {
  return { program: null, determination, determined_by: "deterministic", rule_ids: [], reasons: [] };
}

describe("tenantEligibilityRows — §8.7 display rule", () => {
  it("likely_eligible reads the SAME as insufficient_data (never a conclusion)", () => {
    const likely = tenantEligibilityRows({ rtc: res("likely_eligible") } as Eligibility);
    const insufficient = tenantEligibilityRows({ rtc: res("insufficient_data") } as Eligibility);
    expect(likely[0]!.status).toBe(insufficient[0]!.status);
    // and it must NOT contain a conclusory phrase
    expect(likely[0]!.status.toLowerCase()).not.toContain("you qualify");
    expect(likely[0]!.status.toLowerCase()).not.toContain("you likely");
  });

  it("eligible is framed as provisional (lawyer confirms), not a guarantee", () => {
    const rows = tenantEligibilityRows({ rtc: res("eligible") } as Eligibility);
    expect(rows[0]!.tone).toBe("positive");
    expect(rows[0]!.status.toLowerCase()).toContain("lawyer will confirm");
  });

  it("program_unavailable shows plain unavailable status", () => {
    const rows = tenantEligibilityRows({ rental_assistance: res("program_unavailable") } as Eligibility);
    expect(rows[0]!.tone).toBe("unavailable");
  });

  it("returns one row per populated slot, labeled for tenants", () => {
    const rows = tenantEligibilityRows({
      rtc: res("eligible"),
      legal_aid: res("insufficient_data"),
    } as Eligibility);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label).toContain("Free lawyer");
  });

  it("empty when eligibility was never evaluated", () => {
    expect(tenantEligibilityRows(undefined)).toEqual([]);
  });
});

describe("eligibilitySummary", () => {
  it("is encouraging-but-honest when a slot is positive", () => {
    expect(eligibilitySummary({ rtc: res("eligible") } as Eligibility)).toContain("may qualify");
  });
  it("falls back to a neutral CTA when nothing is positive / unevaluated", () => {
    expect(eligibilitySummary(undefined)).toContain("free help");
    expect(eligibilitySummary({ rtc: res("ineligible") } as Eligibility)).toContain("free help");
  });
});
