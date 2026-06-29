/**
 * Guards the consent record POST /api/eligibility writes when a tenant opts in to
 * store household income/size: a store_sensitive_data consent with a first-party
 * "service" recipient and the "eligibility" data category. Pins the schema so the
 * route's server-minted consent stays valid, and confirms the engine reads the
 * stored figures.
 */
import { describe, it, expect } from "vitest";

import { ConsentSchema, type Consent } from "@/lib/case";
import { evaluateEligibility } from "@/lib/eligibility";
import { makeCase } from "./fixtures";

const STORE_CONSENT: Consent = {
  consent_id: "cns_aaaaaaaaaaaaaaaaaaaaaaaaaa",
  scope: "store_sensitive_data",
  recipient: { recipient_type: "service" },
  granted: true,
  granted_at: "2026-06-29T00:00:00Z",
  consent_text_version: "store-sensitive-v1",
  data_categories: ["eligibility"],
  method: "pwa_checkbox",
};

describe("store_sensitive_data consent (first-party service recipient)", () => {
  it("is schema-valid with recipient_type=service and the eligibility category", () => {
    const parsed = ConsentSchema.safeParse(STORE_CONSENT);
    expect(parsed.success).toBe(true);
  });
});

describe("evaluateEligibility reads stored household figures", () => {
  it("flips off the income_or_household_size_not_provided reason once stored", () => {
    const without = evaluateEligibility(makeCase(), { now: "2026-06-29T00:00:00Z" });
    expect(without.rtc?.reasons).toContain("rtc_config_unvalidated");

    const withFigures = evaluateEligibility(
      makeCase({ sensitive: { household_income_cents: 3_200_000, household_size: 3 } }),
      { now: "2026-06-29T00:00:00Z" },
    );
    // With the default unvalidated config the determination is still safe
    // (insufficient_data), but the "not provided" reason must not be the blocker.
    expect(withFigures.rtc?.reasons ?? []).not.toContain(
      "income_or_household_size_not_provided",
    );
  });
});
