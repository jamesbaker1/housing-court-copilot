/**
 * Boundary protections in lib/case.ts:
 *
 *  - stripSafetyOwnedFields (the PATCH boundary scrub): the deterministic engine
 *    is the SOLE writer of the four safety invariants. A tenant PATCH that
 *    supplies any safety-owned field — even a VALID literal — must have it
 *    removed before merge. (Invariants #2/#4: court_date_verified/source,
 *    review.advice_routed, deadlines[].computed_by, eligibility.*.determined_by,
 *    answer_draft.form_fields[].placed_by.)
 *
 *  - CourtSchema.superRefine (Invariant #2 at the schema floor): a Court can be
 *    court_date_verified=true ONLY when its source is an authoritative court
 *    system (etrack/nyscef/court_data_vendor). A forged verified=true with a
 *    tenant_entered/extracted source is rejected by parse.
 */
import { describe, expect, it } from "vitest";

import { CourtSchema, stripSafetyOwnedFields } from "@/lib/case";

// ===========================================================================
// stripSafetyOwnedFields (lib/case.ts:947)
// ===========================================================================

describe("stripSafetyOwnedFields", () => {
  it("removes court.court_date_verified and court.court_date_source", () => {
    const out = stripSafetyOwnedFields({
      court: {
        court_date: "2026-08-01",
        court_date_source: "etrack",
        court_date_verified: true,
        county: "Kings",
      },
    });
    const court = out.court as Record<string, unknown>;
    expect(court).not.toHaveProperty("court_date_verified");
    expect(court).not.toHaveProperty("court_date_source");
    // Non-safety fields pass through untouched.
    expect(court.court_date).toBe("2026-08-01");
    expect(court.county).toBe("Kings");
  });

  it("removes review.advice_routed and review.advice_detection_log", () => {
    const out = stripSafetyOwnedFields({
      review: {
        advice_routed: true,
        advice_detection_log: [{ x: 1 }],
        review_state: "pending",
      },
    });
    const review = out.review as Record<string, unknown>;
    expect(review).not.toHaveProperty("advice_routed");
    expect(review).not.toHaveProperty("advice_detection_log");
    expect(review.review_state).toBe("pending");
  });

  it("removes deadlines[].computed_by from every element", () => {
    const out = stripSafetyOwnedFields({
      deadlines: [
        { deadline_id: "dl_1", computed_by: "llm", due_date: "2026-08-01" },
        { deadline_id: "dl_2", computed_by: "deterministic" },
      ],
    });
    for (const d of out.deadlines as Record<string, unknown>[]) {
      expect(d).not.toHaveProperty("computed_by");
    }
    expect((out.deadlines as Record<string, unknown>[])[0]!.due_date).toBe(
      "2026-08-01",
    );
  });

  it("removes eligibility.{rtc,legal_aid,rental_assistance}.determined_by and program determined_by", () => {
    const out = stripSafetyOwnedFields({
      eligibility: {
        rtc: { determined_by: "llm", eligible: true },
        legal_aid: { determined_by: "llm" },
        rental_assistance: { determined_by: "deterministic" },
        rental_assistance_programs: [
          { determined_by: "llm", name: "OneShot" },
        ],
      },
    });
    const e = out.eligibility as Record<string, unknown>;
    expect(e.rtc).not.toHaveProperty("determined_by");
    expect((e.rtc as Record<string, unknown>).eligible).toBe(true);
    expect(e.legal_aid).not.toHaveProperty("determined_by");
    expect(e.rental_assistance).not.toHaveProperty("determined_by");
    expect(
      (e.rental_assistance_programs as Record<string, unknown>[])[0],
    ).not.toHaveProperty("determined_by");
  });

  it("removes answer_draft.form_fields[].placed_by", () => {
    const out = stripSafetyOwnedFields({
      answer_draft: {
        status: "draft",
        form_fields: [
          { form_field_id: "f1", placed_by: "llm", value: "x" },
          { form_field_id: "f2", placed_by: "deterministic" },
        ],
      },
    });
    const ad = out.answer_draft as Record<string, unknown>;
    for (const f of ad.form_fields as Record<string, unknown>[]) {
      expect(f).not.toHaveProperty("placed_by");
    }
    expect(ad.status).toBe("draft");
  });

  it("is pure — does not mutate the input patch", () => {
    const input = {
      court: { court_date_verified: true, court_date_source: "etrack" },
      deadlines: [{ deadline_id: "dl_1", computed_by: "llm" }],
    };
    const snapshot = structuredClone(input);
    stripSafetyOwnedFields(input);
    expect(input).toEqual(snapshot);
  });

  it("passes unrelated top-level keys through untouched", () => {
    const out = stripSafetyOwnedFields({
      language: "es",
      status: "intake",
      contact: { phone: "x" },
    });
    expect(out.language).toBe("es");
    expect(out.status).toBe("intake");
    expect(out.contact).toEqual({ phone: "x" });
  });

  it("tolerates non-object safety subtrees without throwing", () => {
    const out = stripSafetyOwnedFields({
      court: null,
      review: "nope",
      deadlines: "not-an-array",
      eligibility: 42,
      answer_draft: undefined,
    });
    // Pass-through, no crash.
    expect(out.court).toBeNull();
    expect(out.review).toBe("nope");
  });
});

// ===========================================================================
// CourtSchema.superRefine (lib/case.ts:529) — Invariant #2 schema floor
// ===========================================================================

describe("CourtSchema.superRefine", () => {
  it("accepts verified=true with an etrack source", () => {
    const r = CourtSchema.safeParse({
      court_date: "2026-08-01",
      court_date_source: "etrack",
      court_date_verified: true,
    });
    expect(r.success).toBe(true);
  });

  it("accepts verified=true with a nyscef source", () => {
    const r = CourtSchema.safeParse({
      court_date_source: "nyscef",
      court_date_verified: true,
    });
    expect(r.success).toBe(true);
  });

  it("accepts verified=true with a court_data_vendor source (schema floor)", () => {
    const r = CourtSchema.safeParse({
      court_date_source: "court_data_vendor",
      court_date_verified: true,
    });
    expect(r.success).toBe(true);
  });

  it("REJECTS verified=true with a tenant_entered source", () => {
    const r = CourtSchema.safeParse({
      court_date: "2026-08-01",
      court_date_source: "tenant_entered",
      court_date_verified: true,
    });
    expect(r.success).toBe(false);
  });

  it("REJECTS verified=true with a document_extracted_unverified source", () => {
    const r = CourtSchema.safeParse({
      court_date_source: "document_extracted_unverified",
      court_date_verified: true,
    });
    expect(r.success).toBe(false);
  });

  it("REJECTS verified=true with NO source at all (the literal-injection gap)", () => {
    const r = CourtSchema.safeParse({
      court_date: "2026-08-01",
      court_date_verified: true,
    });
    expect(r.success).toBe(false);
  });

  it("defaults court_date_verified to false when omitted, and allows any source", () => {
    const r = CourtSchema.safeParse({
      court_date: "2026-08-01",
      court_date_source: "tenant_entered",
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.court_date_verified).toBe(false);
  });

  it("rejects an unknown court_date_source value via the const enum", () => {
    const r = CourtSchema.safeParse({ court_date_source: "made_up_vendor" });
    expect(r.success).toBe(false);
  });
});
