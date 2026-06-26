/**
 * PII-at-rest seal regression tests — confirm the tenant home address
 * (property) and OCR'd court-paper text (documents) are encrypted at rest, not
 * just contact/sensitive/parties/arrears. Without this they persisted as
 * plaintext in D1 `cases.doc` even with CASE_PII_KEY set.
 */
import { describe, it, expect } from "vitest";

import { sealCasePii, openCasePii, PII_FIELD_PATHS } from "@/lib/crypto-field";

// A valid base64-encoded 32-byte (AES-256) key.
const KEY = btoa("0123456789abcdef0123456789abcdef");

const doc: Record<string, unknown> = {
  case_id: "case_test",
  status: "intake",
  // court stays plaintext on purpose (derived court_date column needs it keyless).
  court: { court_date: "2026-07-15", court_date_source: "etrack", court_date_verified: true },
  property: { address: "123 Secret Street, Bronx, NY 10458" },
  documents: [{ document_id: "doc_1", ocr_text: "TENANT-SECRET-OCR-TEXT" }],
  contact: { phone_e164: "+15551234567" },
};

describe("crypto-field PII seal", () => {
  it("lists property and documents in the sealed field set", () => {
    expect(PII_FIELD_PATHS).toContain("property");
    expect(PII_FIELD_PATHS).toContain("documents");
  });

  it("seals home address + OCR text so they are not plaintext at rest", async () => {
    const sealed = await sealCasePii(doc, KEY);
    const blob = JSON.stringify(sealed);
    expect(blob).not.toContain("123 Secret Street");
    expect(blob).not.toContain("TENANT-SECRET-OCR-TEXT");
    expect(blob).not.toContain("+15551234567"); // existing contact field still sealed
    // court_date is intentionally still readable without the key (derived column).
    expect(blob).toContain("2026-07-15");
  });

  it("round-trips the sealed subtrees back to the original objects", async () => {
    const sealed = await sealCasePii(doc, KEY);
    const opened = await openCasePii(sealed, KEY);
    expect(opened.property).toEqual(doc.property);
    expect(opened.documents).toEqual(doc.documents);
    expect(opened.contact).toEqual(doc.contact);
    expect(opened.court).toEqual(doc.court);
  });

  it("is a no-op passthrough when no key is set (dev / file mode)", async () => {
    const sealed = await sealCasePii(doc, null);
    expect(sealed.property).toEqual(doc.property);
    const opened = await openCasePii(sealed, null);
    expect(opened.documents).toEqual(doc.documents);
  });
});
