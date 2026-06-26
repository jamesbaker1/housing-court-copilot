/**
 * Mechanical-fill Answer packet — field mapping + PDF render.
 *
 * Guards the UPL-safe contract: the engine TRANSCRIBES confirmed facts only and
 * never carries a defense selection (AnswerFields has no defense field), and a
 * valid PDF is produced even when fields are missing (blanks, never silent empty).
 */
import { describe, it, expect } from "vitest";

import {
  buildAnswerFields,
  generateAnswerDraftPdf,
  DEFENSE_CHECKLIST,
} from "@/lib/packet/answer";
import { makeCase } from "./fixtures";

describe("buildAnswerFields", () => {
  it("transcribes confirmed caption/parties/premises/contact", () => {
    const c = makeCase({
      court: { index_number: "LT-012345-26/NY", county: "New York", court_date_verified: false },
      parties: {
        landlord: { name: "Acme Realty LLC" },
        tenant: { name: "Jane Tenant" },
      },
      property: {
        address: { line1: "123 Main St", city: "New York", state: "NY", postal_code: "10002" },
        apartment_unit: "4B",
      },
      contact: { phone_e164: "+15551234567" },
    });
    const f = buildAnswerFields(c);
    expect(f.indexNumber).toBe("LT-012345-26/NY");
    expect(f.county).toBe("County of New York");
    expect(f.petitioner).toBe("Acme Realty LLC");
    expect(f.respondent).toBe("Jane Tenant");
    expect(f.premises).toContain("123 Main St");
    expect(f.premises).toContain("Apt 4B");
    expect(f.respondentPhone).toBe("+15551234567");
  });

  it("renders blank fill-lines for missing values (never silently empty)", () => {
    const f = buildAnswerFields(makeCase());
    for (const v of [f.indexNumber, f.petitioner, f.respondent, f.county]) {
      expect(v.length).toBeGreaterThan(0);
      expect(v).toMatch(/_{6,}/); // a blank line, not an empty string
    }
  });

  it("falls back to the contact full_name when no tenant party name", () => {
    const c = makeCase({ contact: { full_name: "Maria Respondent" } });
    expect(buildAnswerFields(c).respondent).toBe("Maria Respondent");
  });

  it("never carries a defense selection (no legal judgment in the mapping)", () => {
    const f = buildAnswerFields(makeCase());
    // The mechanical mapping has NO defense fields at all — defenses are listed
    // unchecked in the PDF for the tenant/lawyer to choose.
    expect(Object.keys(f)).not.toContain("defenses");
    expect(DEFENSE_CHECKLIST.length).toBeGreaterThan(0);
  });
});

describe("generateAnswerDraftPdf", () => {
  it("produces a non-empty PDF document", async () => {
    const bytes = await generateAnswerDraftPdf(
      makeCase({ parties: { tenant: { name: "Jane Tenant" } } }),
    );
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // PDF magic header "%PDF"
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("renders even an almost-empty case (all blanks) without throwing", async () => {
    const bytes = await generateAnswerDraftPdf(makeCase());
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
