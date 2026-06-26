/**
 * Eligibility engine (LEGAL-RULES §8) — fail-safe + populated-config behavior.
 *
 * Guards the UPL/safety contract: every result is `determined_by =
 * "deterministic"`; an UNVALIDATED config never emits a "you qualify" — it fails
 * safe to insufficient_data; ERAP is always program_unavailable (closed) and
 * CityFHEPS is program_unavailable while litigation-disabled.
 */
import { describe, it, expect } from "vitest";

import {
  evaluateEligibility,
  evaluateRtc,
  UNVALIDATED_ELIGIBILITY_CONFIG,
  type EligibilityEngineConfig,
} from "@/lib/eligibility";
import { makeCase } from "./fixtures";

const NOW = "2026-06-26T00:00:00Z";

describe("evaluateEligibility — fail-safe (unvalidated config)", () => {
  const out = evaluateEligibility(
    makeCase({ sensitive: { household_income_cents: 1_000_000, household_size: 2 } }),
    { now: NOW },
  );

  it("every result is determined_by deterministic", () => {
    for (const r of [out.rtc!, out.legal_aid!, out.rental_assistance!, ...out.rental_assistance_programs]) {
      expect(r.determined_by).toBe("deterministic");
    }
  });

  it("RTC + legal_aid fail safe to insufficient_data when config is unvalidated", () => {
    expect(out.rtc!.determination).toBe("insufficient_data");
    expect(out.rtc!.reasons).toContain("rtc_config_unvalidated");
    expect(out.legal_aid!.determination).toBe("insufficient_data");
  });

  it("ERAP is always program_unavailable (closed); CityFHEPS unavailable while disabled", () => {
    const erap = out.rental_assistance_programs.find((r) => r.program === "erap");
    const fheps = out.rental_assistance_programs.find((r) => r.program === "cityfheps");
    expect(erap!.determination).toBe("program_unavailable");
    expect(fheps!.determination).toBe("program_unavailable");
    expect(fheps!.config_toggle_state).toBe("disabled");
  });

  it("stamps config_version + evaluated_at", () => {
    expect(out.config_version).toBe("0.0.0-UNVALIDATED");
    expect(out.evaluated_at).toBe(NOW);
  });

  it("never writes sibling eligibility.erap / eligibility.cityfheps keys", () => {
    expect(Object.keys(out)).not.toContain("erap");
    expect(Object.keys(out)).not.toContain("cityfheps");
  });
});

describe("evaluateRtc — populated config (attorney-validated)", () => {
  // A populated RTC config: ≤200% FPL, citywide, FPL(2) = $20,000/yr.
  const cfg: EligibilityEngineConfig["rtc"] = {
    rule_id: "rtc_eligibility",
    rule_version: "1.0.0",
    attorney_validated_config: true,
    monitored: true,
    review_by: "2027-01-01",
    income: {
      fpl_multiplier_pct: 200,
      fpl_table_version: "fpl-2026",
      fpl_table_annual_cents: { "1": 1_500_000, "2": 2_000_000, "3": 2_500_000 },
    },
    geography: { mode: "citywide", covered_zips: [], covered_boroughs: [] },
  };

  it("eligible when income ≤ 200% FPL and geography covered", () => {
    const c = makeCase({ sensitive: { household_income_cents: 3_000_000, household_size: 2 } });
    // threshold = 200% * $20,000 = $40,000 = 4,000,000 cents; income 3,000,000 ≤ → eligible
    const r = evaluateRtc(c, cfg);
    expect(r.determination).toBe("eligible");
    expect(r.data_source).toBe("internal_rules");
  });

  it("ineligible when income exceeds the threshold", () => {
    const c = makeCase({ sensitive: { household_income_cents: 5_000_000, household_size: 2 } });
    expect(evaluateRtc(c, cfg).determination).toBe("ineligible");
  });

  it("insufficient_data when the tenant did not provide income/size", () => {
    expect(evaluateRtc(makeCase(), cfg).determination).toBe("insufficient_data");
  });

  it("ineligible when outside a zip-gated coverage area", () => {
    const zipCfg: EligibilityEngineConfig["rtc"] = {
      ...cfg,
      geography: { mode: "zip_list", covered_zips: ["10458"], covered_boroughs: [] },
    };
    const c = makeCase({
      sensitive: { household_income_cents: 1_000_000, household_size: 2 },
      property: { address: { line1: "1 X St", postal_code: "11201" } },
    });
    expect(evaluateRtc(c, zipCfg).determination).toBe("ineligible");
    expect(evaluateRtc(c, zipCfg).reasons).toContain("outside_rtc_coverage_area");
  });
});

describe("UNVALIDATED_ELIGIBILITY_CONFIG", () => {
  it("ships with no production values (fails safe by construction)", () => {
    expect(UNVALIDATED_ELIGIBILITY_CONFIG.rtc.attorney_validated_config).toBe(false);
    expect(UNVALIDATED_ELIGIBILITY_CONFIG.rtc.income.fpl_multiplier_pct).toBeNull();
    expect(UNVALIDATED_ELIGIBILITY_CONFIG.cityfheps.config_toggle_state).toBe("disabled");
  });
});
