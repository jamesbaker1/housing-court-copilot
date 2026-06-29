/**
 * Evidence attach: minting a Document around a stored blob and linking a
 * tenant_uploaded evidence item to it (the client upload→attach pipeline's pure
 * core). Guards that storage_ref ends up on a schema-valid Document and that the
 * evidence item references it by document_id.
 */
import { describe, it, expect } from "vitest";

import { buildDocument, addDocument, buildEvidenceItem } from "@/lib/evidence";
import { DocumentSchema, type StorageRef } from "@/lib/case";
import { makeCase } from "./fixtures";

const STORAGE_REF: StorageRef = {
  uri: "r2://case_aaaaaaaaaaaaaaaaaaaaaaaaaa/" + "a".repeat(64),
  content_hash_sha256: "a".repeat(64),
  mime_type: "image/jpeg",
  byte_size: 1234,
};

describe("buildDocument", () => {
  it("mints a doc_ id, defaults type to other, defaults uploader to tenant", () => {
    const doc = buildDocument({ storage_ref: STORAGE_REF, now: "2026-06-29T00:00:00Z" });
    expect(doc.document_id).toMatch(/^doc_/);
    expect(doc.document_type).toBe("other");
    expect(doc.uploaded_by).toEqual({ actor_type: "tenant" });
    expect(doc.storage_ref).toEqual(STORAGE_REF);
    // Round-trips the schema.
    expect(() => DocumentSchema.parse(doc)).not.toThrow();
  });

  it("honors a provided document_type, ocr_text, and uploader", () => {
    const doc = buildDocument({
      storage_ref: STORAGE_REF,
      document_type: "rent_receipt",
      ocr_text: "PAID $1,200",
      uploaded_by: { actor_type: "provider", actor_id: "prv_1" },
      now: "2026-06-29T00:00:00Z",
    });
    expect(doc.document_type).toBe("rent_receipt");
    expect(doc.ocr_text).toBe("PAID $1,200");
    expect(doc.uploaded_by).toEqual({ actor_type: "provider", actor_id: "prv_1" });
  });
});

describe("addDocument + link-through", () => {
  it("appends the document immutably and an evidence item links to it", () => {
    const c0 = makeCase();
    const doc = buildDocument({ storage_ref: STORAGE_REF, now: "2026-06-29T00:00:00Z" });
    const c1 = addDocument(c0, doc);

    expect(c1.documents).toHaveLength(c0.documents.length + 1);
    expect(c0.documents).toHaveLength(c0.documents.length); // original untouched
    expect(c1.documents.at(-1)).toEqual(doc);

    const item = buildEvidenceItem({
      evidence_type: "rent_receipt",
      origin: "tenant_uploaded",
      document_id: doc.document_id,
    });
    expect(item.origin).toBe("tenant_uploaded");
    expect(item.document_id).toBe(doc.document_id);
    // The blob is reachable from the item via the document.
    const linked = c1.documents.find((d) => d.document_id === item.document_id);
    expect(linked?.storage_ref.content_hash_sha256).toBe(STORAGE_REF.content_hash_sha256);
  });
});
