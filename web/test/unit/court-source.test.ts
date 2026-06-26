/**
 * Court-source orchestrator (resolveHit) — INVARIANT #2 regression tests.
 *
 * These guard two fixes that protect the court-date safety backstop on EVERY
 * entry point (both the polling orchestrator and the eTrack email-ingest path,
 * which calls resolveHit directly):
 *   - a non-"high"-confidence hit must never act (flip verified / overwrite);
 *   - an UNTRUSTED (non-authoritative) hit must never clobber a VERIFIED date.
 */
import { describe, it, expect } from "vitest";

import { resolveHit, type CourtSourceResult } from "@/lib/court-source/index";
import type { Court } from "@/lib/case";

type Hit = Extract<CourtSourceResult, { found: true }>;

function hit(
  source: Hit["source"],
  date: string,
  confidence: Hit["confidence"] = "high",
): Hit {
  return { found: true, date, source, confidence };
}

/** A minimal already-VERIFIED Court (authoritative source). */
const verifiedCourt = {
  court_date: "2026-07-15",
  court_date_source: "etrack",
  court_date_verified: true,
} as unknown as Court;

describe("resolveHit — INVARIANT #2 gates", () => {
  it("ignores a non-'high' confidence hit (closes the email-ingest bypass)", () => {
    const out = resolveHit({
      hit: hit("etrack-email", "2026-07-15", "medium"),
      existingCourt: undefined,
      existingDate: null,
      existingSource: null,
      existingVerified: false,
      review: undefined,
    });
    expect(out.status).toBe("not_found");
  });

  it("a low-confidence vendor hit also does nothing", () => {
    const out = resolveHit({
      hit: hit("court_data_vendor", "2026-07-15", "low"),
      existingCourt: undefined,
      existingDate: null,
      existingSource: null,
      existingVerified: false,
      review: undefined,
      vendorAuthoritative: true,
    });
    expect(out.status).toBe("not_found");
  });

  it("an UNTRUSTED vendor hit does NOT overwrite a VERIFIED date — it escalates", () => {
    const out = resolveHit({
      hit: hit("court_data_vendor", "2026-08-01", "high"),
      existingCourt: verifiedCourt,
      existingDate: "2026-07-15",
      existingSource: "etrack",
      existingVerified: true,
      review: undefined,
      vendorAuthoritative: false, // ops gate: vendor NOT trusted
    });
    expect(out.status).toBe("discrepancy");
    if (out.status === "discrepancy") {
      expect(out.discrepancy.existing_date).toBe("2026-07-15");
      expect(out.discrepancy.sourced_date).toBe("2026-08-01");
      expect(out.review.review_state).toBe("escalated");
    }
  });

  it("an UNTRUSTED vendor hit that AGREES with a verified date never downgrades it", () => {
    const out = resolveHit({
      hit: hit("court_data_vendor", "2026-07-15", "high"),
      existingCourt: verifiedCourt,
      existingDate: "2026-07-15",
      existingSource: "etrack",
      existingVerified: true,
      review: undefined,
      vendorAuthoritative: false,
    });
    expect(out.status).toBe("not_found"); // no change; stays verified
  });

  it("an AUTHORITATIVE hit still verifies (court-reschedule path unchanged)", () => {
    const out = resolveHit({
      hit: hit("etrack-email", "2026-07-20", "high"),
      existingCourt: undefined,
      existingDate: null,
      existingSource: null,
      existingVerified: false,
      review: undefined,
    });
    expect(out.status).toBe("verified");
    if (out.status === "verified") {
      expect(out.court.court_date).toBe("2026-07-20");
      expect(out.court.court_date_verified).toBe(true);
    }
  });

  it("a TRUSTED vendor hit (ops opted in) verifies", () => {
    const out = resolveHit({
      hit: hit("court_data_vendor", "2026-07-20", "high"),
      existingCourt: undefined,
      existingDate: null,
      existingSource: null,
      existingVerified: false,
      review: undefined,
      vendorAuthoritative: true,
    });
    expect(out.status).toBe("verified");
    if (out.status === "verified") {
      expect(out.court.court_date_verified).toBe(true);
    }
  });
});
