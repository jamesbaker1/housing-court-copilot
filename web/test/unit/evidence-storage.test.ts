/**
 * Evidence blob storage (R2) — content-addressing, retention metadata, per-case
 * purge, and the graceful no-binding fallback.
 *
 * A fake in-memory R2 bucket is injected by mocking getCloudflareContext, so the
 * put/get/purge happy paths run without a live Cloudflare account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable holder the mock reads — set to a fake bucket per test, or undefined to
// exercise the "no R2 binding" fallback.
let BUCKET: unknown;

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env: { EVIDENCE_BUCKET: BUCKET } }),
}));

import {
  putEvidenceBlob,
  getEvidenceBlob,
  purgeCaseEvidence,
  evidenceKey,
  sha256Hex,
  evidenceStorageAvailable,
} from "@/lib/evidence-storage";

const CASE_A = "case_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = "2026-06-29T00:00:00Z";

interface StoredObj {
  bytes: Uint8Array;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

function fakeBucket() {
  const store = new Map<string, StoredObj>();
  return {
    store,
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) {
      store.set(key, { bytes: value, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata });
    },
    async get(key: string) {
      const o = store.get(key);
      if (!o) return null;
      return {
        body: new ReadableStream(),
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
        size: o.bytes.byteLength,
      };
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
    async list(opts?: { prefix?: string }) {
      const prefix = opts?.prefix ?? "";
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

afterEach(() => {
  BUCKET = undefined;
});

describe("evidenceKey + sha256Hex (pure)", () => {
  it("key is content-addressed and case-namespaced (no PII)", () => {
    expect(evidenceKey(CASE_A, "deadbeef")).toBe(`evidence/${CASE_A}/deadbeef`);
  });
  it("sha256Hex is stable for the same bytes", async () => {
    const a = await sha256Hex(new Uint8Array([1, 2, 3]));
    const b = await sha256Hex(new Uint8Array([1, 2, 3]));
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("no R2 binding (fallback)", () => {
  it("put/get/purge degrade to unavailable, never throw", async () => {
    BUCKET = undefined;
    expect(await evidenceStorageAvailable()).toBe(false);
    expect(await putEvidenceBlob({ caseId: CASE_A, bytes: new Uint8Array([1]), mimeType: "image/png", now: NOW }))
      .toEqual({ ok: false, reason: "unavailable" });
    expect(await getEvidenceBlob("r2://evidence/x/y")).toEqual({ ok: false, reason: "unavailable" });
    expect(await purgeCaseEvidence(CASE_A)).toBeNull();
  });
});

describe("with an R2 bucket", () => {
  beforeEach(() => {
    BUCKET = fakeBucket();
  });

  it("stores under a content-addressed key with retention metadata", async () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    const res = await putEvidenceBlob({ caseId: CASE_A, bytes, mimeType: "image/jpeg", retentionClass: "sensitive", now: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.uri).toBe(`r2://${res.key}`);
    expect(res.key).toBe(evidenceKey(CASE_A, await sha256Hex(bytes)));
    expect(res.byte_size).toBe(4);
    // sensitive class → 90-day window from NOW
    expect(res.purge_after).toBe("2026-09-27T00:00:00Z");

    const got = await getEvidenceBlob(res.uri);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.object.httpMetadata?.contentType).toBe("image/jpeg");
      expect(got.object.customMetadata?.case_id).toBe(CASE_A);
      expect(got.object.customMetadata?.purge_after).toBe("2026-09-27T00:00:00Z");
    }
  });

  it("de-duplicates identical bytes to the same key", async () => {
    const bytes = new Uint8Array([1, 1, 1]);
    const a = await putEvidenceBlob({ caseId: CASE_A, bytes, mimeType: "image/png", now: NOW });
    const b = await putEvidenceBlob({ caseId: CASE_A, bytes, mimeType: "image/png", now: NOW });
    expect(a.ok && b.ok && a.key === b.key).toBe(true);
  });

  it("rejects an invalid case id before touching R2", async () => {
    expect(await putEvidenceBlob({ caseId: "nope", bytes: new Uint8Array([1]), mimeType: "image/png", now: NOW }))
      .toEqual({ ok: false, reason: "invalid_case_id" });
  });

  it("purgeCaseEvidence deletes only this case's prefix", async () => {
    await putEvidenceBlob({ caseId: CASE_A, bytes: new Uint8Array([1]), mimeType: "image/png", now: NOW });
    await putEvidenceBlob({ caseId: CASE_A, bytes: new Uint8Array([2]), mimeType: "image/png", now: NOW });
    const other = "case_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    await putEvidenceBlob({ caseId: other, bytes: new Uint8Array([3]), mimeType: "image/png", now: NOW });

    const deleted = await purgeCaseEvidence(CASE_A);
    expect(deleted).toBe(2);
    // the other case's blob survives
    const survivors = (BUCKET as ReturnType<typeof fakeBucket>).store;
    expect([...survivors.keys()].every((k) => k.startsWith(`evidence/${other}/`))).toBe(true);
  });

  it("get returns not_found for a missing key", async () => {
    expect(await getEvidenceBlob("r2://evidence/case_x/missing")).toEqual({ ok: false, reason: "not_found" });
  });
});
