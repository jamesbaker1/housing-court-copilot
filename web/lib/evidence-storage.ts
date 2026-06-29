/**
 * Evidence blob storage — Cloudflare R2 (object storage) with a graceful
 * no-binding fallback. Server-only.
 *
 * Tenant evidence (receipt photos, repair pictures, document scans) should live
 * in R2, not be held in-flight or in D1. This module:
 *   - puts a blob under a CONTENT-ADDRESSED key (sha256 of the bytes), so the
 *     same upload de-duplicates and the key itself is a tamper-evident digest;
 *   - keys are namespaced by case_id so a per-case purge is a prefix delete;
 *   - stamps retention metadata (data_retention_class + an absolute purge-after
 *     date) on the object so the lifecycle/purge job can act on it;
 *   - reads a blob back for a short-lived, owner-gated download (the app streams
 *     it through the ownership-gated route — we do NOT mint public R2 URLs, so a
 *     loggable URL can never leak an eviction document).
 *
 * Detection mirrors lib/store.ts: when the R2 binding is absent (plain Node /
 * local dev / tests) every call degrades to a typed "unavailable" result and
 * NEVER throws — callers fall back to the in-Case storage_ref they already use.
 *
 * Privacy: object keys contain only the case_id + content hash (no tenant name,
 * no filename). Bytes are the tenant's own evidence; R2 is inside the SHIELD
 * boundary alongside D1.
 */
import "server-only";

import type { MimeType } from "@/lib/case";

const CASE_ID_RE = /^case_[0-9a-hjkmnp-tv-z]{26}$/;

/** Default retention windows (days) by class — mirrors lib/retention.ts intent. */
const RETENTION_DAYS: Record<string, number> = {
  minimized: 30,
  standard: 365,
  sensitive: 90,
};

// --- minimal R2 binding shim (the subset we use) ---------------------------

export interface R2Object {
  body: ReadableStream;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  size: number;
}
interface R2PutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}
export interface R2Bucket {
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: R2PutOptions): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
  delete(key: string | string[]): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
}

/** Resolve the R2 binding (env.EVIDENCE_BUCKET) if on Cloudflare, else null. */
async function getBucket(): Promise<R2Bucket | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const ctx = await mod.getCloudflareContext({ async: true });
    const bucket = (ctx?.env as { EVIDENCE_BUCKET?: unknown } | undefined)?.EVIDENCE_BUCKET;
    return bucket ? (bucket as R2Bucket) : null;
  } catch {
    return null;
  }
}

// --- helpers ----------------------------------------------------------------

/** SHA-256 hex of bytes via WebCrypto (available on Workers + modern Node). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer so the digest input is unambiguously a
  // BufferSource (a Uint8Array may be SharedArrayBuffer-backed per the TS lib).
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Content-addressed, case-namespaced object key. No PII in the key. */
export function evidenceKey(caseId: string, contentHash: string): string {
  return `evidence/${caseId}/${contentHash}`;
}

function purgeAfterIso(retentionClass: string, nowMs: number): string {
  const days = RETENTION_DAYS[retentionClass] ?? RETENTION_DAYS.standard!;
  return new Date(nowMs + days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// --- public API -------------------------------------------------------------

export type PutResult =
  | {
      ok: true;
      /** r2://<bucket-key> — stored in the Case's StorageRef.uri. */
      uri: string;
      key: string;
      content_hash_sha256: string;
      byte_size: number;
      purge_after: string;
    }
  | { ok: false; reason: "unavailable" | "invalid_case_id" | "error" };

/**
 * Store an evidence blob in R2 under a content-addressed, case-namespaced key.
 * Returns the r2:// uri + digest to persist in the Case StorageRef. Degrades to
 * `{ ok:false, reason:"unavailable" }` when no R2 binding is bound (never throws)
 * so the caller can fall back to its existing in-Case storage handling.
 */
export async function putEvidenceBlob(args: {
  caseId: string;
  bytes: Uint8Array;
  mimeType: MimeType;
  retentionClass?: string;
  /** ISO now (server-supplied; keeps the lib deterministic/testable). */
  now: string;
}): Promise<PutResult> {
  if (!CASE_ID_RE.test(args.caseId)) return { ok: false, reason: "invalid_case_id" };
  const bucket = await getBucket();
  if (!bucket) return { ok: false, reason: "unavailable" };

  try {
    const contentHash = await sha256Hex(args.bytes);
    const key = evidenceKey(args.caseId, contentHash);
    const purge_after = purgeAfterIso(args.retentionClass ?? "standard", Date.parse(args.now));
    await bucket.put(key, args.bytes, {
      httpMetadata: { contentType: args.mimeType },
      customMetadata: {
        case_id: args.caseId,
        retention_class: args.retentionClass ?? "standard",
        purge_after,
      },
    });
    return {
      ok: true,
      uri: `r2://${key}`,
      key,
      content_hash_sha256: contentHash,
      byte_size: args.bytes.byteLength,
      purge_after,
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type GetResult =
  | { ok: true; object: R2Object }
  | { ok: false; reason: "unavailable" | "not_found" | "error" };

/**
 * Fetch an evidence blob by its r2:// uri (or raw key) for an OWNER-GATED stream.
 * We never return a public URL — the route authorizes the owner and streams the
 * object body itself, so a loggable URL can't leak the document.
 */
export async function getEvidenceBlob(uriOrKey: string): Promise<GetResult> {
  const bucket = await getBucket();
  if (!bucket) return { ok: false, reason: "unavailable" };
  const key = uriOrKey.startsWith("r2://") ? uriOrKey.slice("r2://".length) : uriOrKey;
  try {
    const object = await bucket.get(key);
    if (!object) return { ok: false, reason: "not_found" };
    return { ok: true, object };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Delete every evidence blob for a case (the per-case purge / tenant-delete
 * path). Prefix-lists then deletes. Best-effort; never throws. Returns the count
 * deleted, or null when R2 is unbound.
 */
export async function purgeCaseEvidence(caseId: string): Promise<number | null> {
  if (!CASE_ID_RE.test(caseId)) return 0;
  const bucket = await getBucket();
  if (!bucket) return null;
  try {
    const { objects } = await bucket.list({ prefix: `evidence/${caseId}/` });
    const keys = objects.map((o) => o.key);
    if (keys.length > 0) await bucket.delete(keys);
    return keys.length;
  } catch {
    return null;
  }
}

/** True iff an R2 evidence bucket is bound (for ops/health surfacing). */
export async function evidenceStorageAvailable(): Promise<boolean> {
  return (await getBucket()) !== null;
}
