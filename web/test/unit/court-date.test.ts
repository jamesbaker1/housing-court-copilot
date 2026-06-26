/**
 * Invariant #2 (provenance half) — lib/court-date.ts.
 *
 * court_date_verified must be TRUE only for authoritative court-system sources
 * (eTrack / NYSCEF, or a vendor the operator has opted into), and can NEVER be
 * set true by a document-extracted or tenant-entered date. This module is the
 * sole writer of the verified flag via setCourtDate.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUTHORITATIVE_COURT_DATE_SOURCES,
  confirmCourtDateFromTenant,
  isAuthoritativeSource,
  isCourtDateAuthoritative,
  isVendorTreatedAsAuthoritative,
  setCourtDate,
  setExtractedCourtDateUnverified,
  sourceCourtDateFromCourtSystem,
  validateCourtDateString,
} from "@/lib/court-date";
import type { Court } from "@/lib/case";

const GOOD = "2026-08-15";

describe("validateCourtDateString", () => {
  it("accepts a well-formed real calendar date", () => {
    expect(validateCourtDateString(GOOD)).toEqual({ ok: true, date: GOOD });
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validateCourtDateString("  2026-08-15 ")).toEqual({
      ok: true,
      date: GOOD,
    });
  });

  it("rejects a non-date string", () => {
    expect(validateCourtDateString("next tuesday").ok).toBe(false);
  });

  it("rejects a date with a time component (no bare-calendar shape)", () => {
    expect(validateCourtDateString("2026-08-15T00:00:00Z").ok).toBe(false);
  });

  it("rejects an overflow date the regex alone would pass (Feb 30)", () => {
    const r = validateCourtDateString("2026-02-30");
    expect(r.ok).toBe(false);
  });

  it("rejects month 13", () => {
    expect(validateCourtDateString("2026-13-01").ok).toBe(false);
  });
});

describe("isAuthoritativeSource / AUTHORITATIVE_COURT_DATE_SOURCES", () => {
  it("treats etrack, nyscef, court_data_vendor as authoritative", () => {
    expect(isAuthoritativeSource("etrack")).toBe(true);
    expect(isAuthoritativeSource("nyscef")).toBe(true);
    expect(isAuthoritativeSource("court_data_vendor")).toBe(true);
  });

  it("does NOT treat document_extracted_unverified or tenant_entered as authoritative", () => {
    expect(isAuthoritativeSource("document_extracted_unverified")).toBe(false);
    expect(isAuthoritativeSource("tenant_entered")).toBe(false);
  });

  it("the authoritative-source allowlist is exactly the three court/vendor sources", () => {
    expect([...AUTHORITATIVE_COURT_DATE_SOURCES].sort()).toEqual(
      ["court_data_vendor", "etrack", "nyscef"].sort(),
    );
  });
});

describe("setCourtDate — verified flag is sourced, never asserted", () => {
  it("etrack source => court_date_verified = true", () => {
    const r = setCourtDate(undefined, { court_date: GOOD, source: "etrack" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.court.court_date).toBe(GOOD);
    expect(r.court.court_date_source).toBe("etrack");
    expect(r.court.court_date_verified).toBe(true);
  });

  it("nyscef source => court_date_verified = true", () => {
    const r = setCourtDate(undefined, { court_date: GOOD, source: "nyscef" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.court.court_date_verified).toBe(true);
  });

  it("document_extracted_unverified => court_date_verified = false", () => {
    const r = setCourtDate(undefined, {
      court_date: GOOD,
      source: "document_extracted_unverified",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.court.court_date_verified).toBe(false);
  });

  it("tenant_entered => court_date_verified = false", () => {
    const r = setCourtDate(undefined, {
      court_date: GOOD,
      source: "tenant_entered",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.court.court_date_verified).toBe(false);
  });

  it("OVERRIDES a pre-existing verified=true when re-set from a NON-authoritative source", () => {
    // A court object that was previously verified by etrack...
    const prior: Court = {
      court_date: "2026-01-01",
      court_date_source: "etrack",
      court_date_verified: true,
    };
    // ...re-set from a tenant-entered correction must DROP the verified flag.
    const r = setCourtDate(prior, {
      court_date: GOOD,
      source: "tenant_entered",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.court.court_date).toBe(GOOD);
    expect(r.court.court_date_source).toBe("tenant_entered");
    expect(r.court.court_date_verified).toBe(false);
  });

  it("does not mutate the input court object (pure)", () => {
    const prior: Court = {
      court_date: "2026-01-01",
      court_date_source: "tenant_entered",
      court_date_verified: false,
    };
    setCourtDate(prior, { court_date: GOOD, source: "etrack" });
    expect(prior).toEqual({
      court_date: "2026-01-01",
      court_date_source: "tenant_entered",
      court_date_verified: false,
    });
  });

  it("rejects a malformed candidate date without touching verified state", () => {
    const r = setCourtDate(undefined, {
      court_date: "2026-02-30",
      source: "etrack",
    });
    expect(r.ok).toBe(false);
  });
});

describe("named entry points keep the provenance contract", () => {
  it("confirmCourtDateFromTenant is tenant_entered + unverified", () => {
    const r = confirmCourtDateFromTenant(undefined, GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.court.court_date_source).toBe("tenant_entered");
    expect(r.court.court_date_verified).toBe(false);
  });

  it("setExtractedCourtDateUnverified is document_extracted_unverified + unverified", () => {
    const r = setExtractedCourtDateUnverified(undefined, GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.court.court_date_source).toBe("document_extracted_unverified");
    expect(r.court.court_date_verified).toBe(false);
  });

  it("sourceCourtDateFromCourtSystem(etrack) verifies", () => {
    const r = sourceCourtDateFromCourtSystem(undefined, GOOD, "etrack");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.court.court_date_verified).toBe(true);
  });
});

describe("isCourtDateAuthoritative", () => {
  it("true only for a present, verified, authoritatively-sourced, valid date", () => {
    const r = setCourtDate(undefined, { court_date: GOOD, source: "nyscef" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isCourtDateAuthoritative(r.court)).toBe(true);
  });

  it("false for an unverified (tenant-entered) date", () => {
    const r = confirmCourtDateFromTenant(undefined, GOOD);
    if (!r.ok) throw new Error("setup");
    expect(isCourtDateAuthoritative(r.court)).toBe(false);
  });

  it("false when court is undefined or has no date", () => {
    expect(isCourtDateAuthoritative(undefined)).toBe(false);
    expect(isCourtDateAuthoritative({ court_date_verified: false })).toBe(false);
  });

  it("false for a hand-forged verified=true without an authoritative source", () => {
    // Bypassing setCourtDate (simulating a tampered object): the guard must
    // still refuse to treat it as authoritative because the source is wrong.
    const forged = {
      court_date: GOOD,
      court_date_source: "tenant_entered",
      court_date_verified: true,
    } as Court;
    expect(isCourtDateAuthoritative(forged)).toBe(false);
  });
});

describe("isVendorTreatedAsAuthoritative — default-deny ops gate", () => {
  const ORIGINAL = process.env.COURT_DATA_VENDOR_AUTHORITATIVE;
  beforeEach(() => {
    delete process.env.COURT_DATA_VENDOR_AUTHORITATIVE;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.COURT_DATA_VENDOR_AUTHORITATIVE;
    else process.env.COURT_DATA_VENDOR_AUTHORITATIVE = ORIGINAL;
  });

  it("defaults to false when nothing is configured", () => {
    expect(isVendorTreatedAsAuthoritative()).toBe(false);
  });

  it("explicit config wins over env", () => {
    process.env.COURT_DATA_VENDOR_AUTHORITATIVE = "true";
    expect(isVendorTreatedAsAuthoritative({ vendorAuthoritative: false })).toBe(
      false,
    );
  });

  it("env 'true'/'1' opts in", () => {
    process.env.COURT_DATA_VENDOR_AUTHORITATIVE = "true";
    expect(isVendorTreatedAsAuthoritative()).toBe(true);
    process.env.COURT_DATA_VENDOR_AUTHORITATIVE = "1";
    expect(isVendorTreatedAsAuthoritative()).toBe(true);
  });

  it("any other env value stays default-deny", () => {
    process.env.COURT_DATA_VENDOR_AUTHORITATIVE = "yes";
    expect(isVendorTreatedAsAuthoritative()).toBe(false);
  });
});
