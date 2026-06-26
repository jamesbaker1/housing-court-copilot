/**
 * Field-level encryption hook for the PII subset of a Case, at rest in D1.
 * Server-only. Uses WebCrypto AES-256-GCM, which is available in the Workers
 * runtime (and Node 20+), so no extra dependency.
 *
 * REVIEW fix #5 (encryption posture). Goal: the bytes sitting in D1 `cases.doc`
 * should not, on their own, hand a subpoena/seizure the tenant's name, phone,
 * address, arrears, immigration-relevant notes, etc. We do this WITHOUT
 * weakening CaseSchema validation: encryption is an at-rest transform applied to
 * a well-defined PII SUBTREE, transparently reversed before the Case is parsed
 * and validated. The plaintext Case the application sees is byte-identical to
 * the unencrypted path.
 *
 * KEY MANAGEMENT
 *   - The data-encryption key comes from env.CASE_PII_KEY (a Wrangler SECRET:
 *     `wrangler secret put CASE_PII_KEY` — a base64-encoded 32-byte key). It is
 *     NEVER committed and NEVER in wrangler.toml.
 *   - When the key is absent (local dev / tests with no secret), encryption is a
 *     NO-OP passthrough so the file-fallback store keeps working. Production
 *     posture is documented in DATA-SECURITY.md: set the secret before real
 *     tenants. (We do NOT fail-closed here because that would brick local dev;
 *     the operational control is "the secret is set in prod", verified by the
 *     deploy runbook.)
 *
 * CRYPTO-SHRED / LEGAL-HOLD
 *   - Because every record is sealed under CASE_PII_KEY, rotating/destroying that
 *     key renders ALL ciphertext unrecoverable — a coarse but real crypto-shred.
 *     A per-case data key (enveloped under a master key) would enable per-case
 *     shred; that is the documented next step (see DATA-SECURITY.md). v1 ships
 *     the single-key envelope + row-level DELETE (lib/retention) as the primary
 *     delete, with key-destruction as the break-glass shred.
 *
 * WIRE FORMAT (per sealed value): a JSON string
 *   { "v": 1, "alg": "A256GCM", "iv": <b64>, "ct": <b64> }
 * `decryptString` round-trips it; anything not matching is returned as-is
 * (so a doc written before encryption was enabled still reads).
 */
import "server-only";

/**
 * The Case key paths that constitute the PII subtree sealed at rest.
 *
 * These are the top-level Case keys whose VALUES carry tenant-identifying or
 * sensitive content. They are sealed as whole subtrees (JSON.stringify'd, then
 * AES-GCM-encrypted). NOTE on what is deliberately NOT here:
 *   - `court` stays plaintext: `court.court_date` is projected to a derived D1
 *     column (for the reminder schedule + the retention-purge cron) which MUST
 *     work without the key; the rest of `court` is low-sensitivity index/part.
 *   - `status`/`deadlines`/`audit`/`ids` stay plaintext (non-PII structure).
 * `property` (tenant home address) and `documents` (OCR'd court-paper text) ARE
 * sealed — they are tenant-identifying and are not read from the doc without the
 * key (derived columns come from the plaintext Case before sealing).
 */
export const PII_FIELD_PATHS = [
  "contact",
  "sensitive",
  "parties",
  "claimed_arrears",
  "property",
  "documents",
] as const;

const ENC_PREFIX = '{"v":1,"alg":"A256GCM"';

interface SealedEnvelope {
  v: 1;
  alg: "A256GCM";
  iv: string; // base64
  ct: string; // base64
}

function b64encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}
/** Decode base64 into a fresh ArrayBuffer-backed Uint8Array (WebCrypto-safe). */
function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import the AES-256-GCM key from a base64 32-byte secret, or null if absent/invalid. */
async function importKey(rawKeyB64: string | undefined | null): Promise<CryptoKey | null> {
  if (!rawKeyB64) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = b64decode(rawKeyB64.trim());
  } catch {
    return null;
  }
  if (raw.length !== 32) return null; // require a full 256-bit key
  try {
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    return null;
  }
}

/**
 * Seal a UTF-8 string under the key. Returns the envelope JSON. With no key,
 * returns the plaintext unchanged (no-op passthrough for dev/file mode).
 */
export async function encryptString(
  plaintext: string,
  rawKeyB64: string | undefined | null,
): Promise<string> {
  const key = await importKey(rawKeyB64);
  if (!key) return plaintext;
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const enc = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc as Uint8Array<ArrayBuffer>,
  );
  const env: SealedEnvelope = {
    v: 1,
    alg: "A256GCM",
    iv: b64encode(iv),
    ct: b64encode(new Uint8Array(ctBuf)),
  };
  return JSON.stringify(env);
}

/**
 * Reverse {@link encryptString}. If `value` is not a recognized envelope (e.g.
 * it was written before encryption was enabled), it is returned as-is, so reads
 * are backward-compatible. Throws only if a recognized envelope fails to decrypt
 * (tampering / wrong key) — the caller treats that like a corrupt doc.
 */
export async function decryptString(
  value: string,
  rawKeyB64: string | undefined | null,
): Promise<string> {
  if (!value.startsWith(ENC_PREFIX)) return value; // not sealed → passthrough
  let env: SealedEnvelope;
  try {
    env = JSON.parse(value) as SealedEnvelope;
  } catch {
    return value;
  }
  if (env.v !== 1 || env.alg !== "A256GCM" || !env.iv || !env.ct) return value;
  const key = await importKey(rawKeyB64);
  if (!key) {
    // We have ciphertext but no key — cannot read. Surface as an error rather
    // than returning ciphertext that would fail CaseSchema.parse confusingly.
    throw new Error("CASE_PII_KEY required to decrypt sealed Case PII");
  }
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64decode(env.iv) },
    key,
    b64decode(env.ct),
  );
  return new TextDecoder().decode(ptBuf);
}

/**
 * Seal the PII subtree of a Case doc for at-rest storage. Takes the parsed Case
 * object, returns a SHALLOW CLONE whose PII_FIELD_PATHS values are replaced by
 * sealed-envelope strings. The non-PII structure (status, court, deadlines,
 * audit, ids) stays plaintext so the derived-column projection + retention scan
 * keep working without the key.
 *
 * This is the at-rest HOOK. It is intentionally decoupled from lib/store so the
 * backend-owned store interface is untouched; wiring is documented in
 * DATA-SECURITY.md ("Enabling field-level encryption").
 */
export async function sealCasePii(
  doc: Record<string, unknown>,
  rawKeyB64: string | undefined | null,
): Promise<Record<string, unknown>> {
  const key = await importKey(rawKeyB64);
  if (!key) return doc; // no-op without a key
  const out: Record<string, unknown> = { ...doc };
  for (const field of PII_FIELD_PATHS) {
    if (out[field] === undefined || out[field] === null) continue;
    out[field] = await encryptString(JSON.stringify(out[field]), rawKeyB64);
  }
  return out;
}

/**
 * Reverse {@link sealCasePii}: decrypt any sealed PII fields back to their
 * objects BEFORE the doc is handed to CaseSchema.parse. Fields that were never
 * sealed (legacy docs / no key) pass through untouched.
 */
export async function openCasePii(
  doc: Record<string, unknown>,
  rawKeyB64: string | undefined | null,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...doc };
  for (const field of PII_FIELD_PATHS) {
    const v = out[field];
    if (typeof v !== "string" || !v.startsWith(ENC_PREFIX)) continue;
    const json = await decryptString(v, rawKeyB64);
    out[field] = JSON.parse(json);
  }
  return out;
}
