/**
 * Provider-read redaction + handoff state machine (API-CONTRACTS §4-§5).
 *
 * Guards: the provider read is projected to the consent's data_categories
 * (default-deny; raw income never leaves); the state machine advances along
 * intake→prepared→referred→represented with the attorney gate on
 * referred→represented; ETag/If-Match give optimistic concurrency.
 */
import { describe, it, expect } from "vitest";

import {
  projectCaseForProvider,
  computeTriageTransition,
  caseETag,
  ifMatchSatisfied,
} from "@/lib/provider-redaction";
import { makeCase } from "./fixtures";

const NOW = "2026-06-26T00:00:00Z";

describe("projectCaseForProvider — consent-category redaction", () => {
  const c = makeCase({
    contact: { full_name: "Jane Tenant", phone_e164: "+15551234567" },
    parties: { landlord: { name: "Acme LLC" } },
    claimed_arrears: { amount_cents: 100000, currency: "USD" },
    sensitive: {
      household_income_cents: 3_000_000,
      household_size: 2,
      immigration: { consent_id: "cns_aaaaaaaaaaaaaaaaaaaaaaaaaa", status_relevant_to_defense: false },
    },
  });

  it("includes only consented categories; withholds the rest", () => {
    const { case: out, redacted_categories } = projectCaseForProvider(c, ["contact"]);
    expect(out.contact).toBeDefined();
    expect(out.parties).toBeUndefined(); // case_facts not consented
    expect(out.claimed_arrears).toBeUndefined(); // arrears not consented
    expect(redacted_categories).toContain("case_facts");
    expect(redacted_categories).toContain("arrears");
  });

  it("always returns structural fields (case_id, status, consents)", () => {
    const { case: out } = projectCaseForProvider(c, []);
    expect(out.case_id).toBe(c.case_id);
    expect(out.status).toBe(c.status);
    expect(out.consents).toBeDefined();
  });

  it("NEVER projects raw income, even when eligibility is consented", () => {
    const { case: out } = projectCaseForProvider(c, ["eligibility", "immigration_status"]);
    // immigration is consented → present; income is never present.
    const sens = out.sensitive as Record<string, unknown> | undefined;
    expect(sens?.immigration).toBeDefined();
    expect(sens?.household_income_cents).toBeUndefined();
    expect(sens?.household_size).toBeUndefined();
  });

  it("withholds immigration unless immigration_status is consented", () => {
    const { case: out, redacted_categories } = projectCaseForProvider(c, ["contact"]);
    expect(out.sensitive).toBeUndefined();
    expect(redacted_categories).toContain("immigration_status");
  });
});

describe("computeTriageTransition — state machine (§4.4)", () => {
  it("accept advances intake → referred (in_review)", () => {
    const s = computeTriageTransition(makeCase({ status: "intake" }), "accept", { now: NOW });
    expect(s.nextStatus).toBe("referred");
    expect(s.nextReviewState).toBe("in_review");
    expect(s.transition?.to_status).toBe("referred");
  });

  it("accept on a referred case requires attorney proof for → represented", () => {
    const referred = makeCase({ status: "referred" });
    const refused = computeTriageTransition(referred, "accept", { now: NOW });
    expect(refused.nextStatus).toBe("referred"); // held
    expect(refused.refused).toBe("represented_requires_attorney");

    const ok = computeTriageTransition(referred, "accept", { now: NOW, attorneyConfirmed: true });
    expect(ok.nextStatus).toBe("represented");
    expect(ok.transition?.to_status).toBe("represented");
  });

  it("refer escalates, decline reviews — neither regresses status", () => {
    const prepared = makeCase({ status: "prepared" });
    expect(computeTriageTransition(prepared, "refer", { now: NOW }).nextReviewState).toBe("escalated");
    expect(computeTriageTransition(prepared, "refer", { now: NOW }).nextStatus).toBe("prepared");
    expect(computeTriageTransition(prepared, "decline", { now: NOW }).nextReviewState).toBe("reviewed");
    expect(computeTriageTransition(prepared, "decline", { now: NOW }).nextStatus).toBe("prepared");
  });
});

describe("caseETag / ifMatchSatisfied — optimistic concurrency", () => {
  it("absent If-Match imposes no precondition", () => {
    expect(ifMatchSatisfied(null, makeCase())).toBe(true);
  });

  it("matching ETag passes; a stale one fails; wildcard passes", () => {
    const c = makeCase();
    const tag = caseETag(c);
    expect(ifMatchSatisfied(tag, c)).toBe(true);
    expect(ifMatchSatisfied('W/"deadbeef"', c)).toBe(false);
    expect(ifMatchSatisfied("*", c)).toBe(true);
  });

  it("ETag changes when updated_at changes", () => {
    const a = makeCase({ updated_at: "2026-06-26T00:00:00Z" });
    const b = makeCase({ ...a, updated_at: "2026-06-26T00:00:01Z" });
    expect(caseETag(a)).not.toBe(caseETag(b));
  });
});
