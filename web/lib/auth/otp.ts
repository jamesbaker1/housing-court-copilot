/**
 * OPTIONAL SMS-OTP tenant resume — server-only.
 *
 * Lets a tenant who OPTS IN link the case they're working on to a verified
 * phone number, so they can resume it on another device. This is NOT a login
 * wall: tenants stay anonymous by default and the copilot never requires this.
 *
 * Flow:
 *   requestOtp({ phone_e164, case_id }) — mint a 6-digit code, store only its
 *     HASH (SHA-256) with a short expiry + attempt counter (UPSERT: one live
 *     code per phone), pin the case_id to link on success, then send the code
 *     via lib/sms/twilio.ts (dry-run if Twilio unconfigured — never throws).
 *   verifyOtp({ phone_e164, code }) — constant-time-ish compare against the
 *     stored hash; on success record the verified phone and link the pinned
 *     case_id into case_owners, then return all case_ids that phone owns. On
 *     failure bump attempts and, past the cap, invalidate the code.
 *
 * Backend: Cloudflare D1 via getCloudflareContext (same detection as
 * lib/store.ts). When unbound (plain node / local tooling / tests), every
 * function is a graceful no-op that never throws — mirroring the store's file
 * fallback philosophy so the build/dev never depend on a Cloudflare account.
 *
 * Privacy: the plaintext code is never persisted (hash only) and never logged
 * (twilio.ts truncates bodies). Callers MUST return generic results to clients
 * so an attacker cannot tell whether a phone exists or a case is real.
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";

import { sendSms } from "@/lib/sms/twilio";

// E.164, matching ContactSchema.phone_e164 in @/lib/case.
const E164_RE = /^\+[1-9]\d{1,14}$/;
// Crockford-base32 ULID case id, matching CASE_ID_RE in lib/store.ts.
const CASE_ID_RE = /^case_[0-9a-hjkmnp-tv-z]{26}$/;

/** Code lifetime and the hard cap on failed verify attempts. */
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

// --- D1 binding shim (same minimal shape as lib/store.ts) -------------------

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

async function getDB(): Promise<D1Database | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const ctx = await mod.getCloudflareContext({ async: true });
    const db = (ctx?.env as { DB?: unknown } | undefined)?.DB;
    return db ? (db as D1Database) : null;
  } catch {
    return null;
  }
}

// --- helpers ----------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** SHA-256 hex of `${phone}:${code}` — salts the hash with the phone. */
function hashCode(phoneE164: string, code: string): string {
  return createHash("sha256").update(`${phoneE164}:${code}`).digest("hex");
}

/** Cryptographically uniform 6-digit code, zero-padded. */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Constant-time equality for two hex digests of equal length. */
function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// --- public API -------------------------------------------------------------

export type RequestOtpResult =
  | { ok: true; sent: "sent" | "dry_run" }
  // `ok: false` is returned for malformed input or when no backend is bound.
  // Callers MUST translate this to a GENERIC client message (never leak which).
  | { ok: false; reason: string };

/**
 * Mint + store (hashed) a one-time code for `phone_e164`, pin `case_id` to link
 * on success, and send the code via SMS. Idempotent per phone: a new request
 * replaces any prior pending code. Never throws.
 */
export async function requestOtp(args: {
  phone_e164: string;
  case_id: string;
}): Promise<RequestOtpResult> {
  const { phone_e164, case_id } = args;
  if (!E164_RE.test(phone_e164)) {
    return { ok: false, reason: "invalid_phone" };
  }
  if (!CASE_ID_RE.test(case_id)) {
    return { ok: false, reason: "invalid_case_id" };
  }

  const db = await getDB();
  if (!db) {
    // No D1 bound (local/file mode). We cannot persist a code to verify later,
    // so do not pretend to send. Caller surfaces a generic "try again" message.
    return { ok: false, reason: "unavailable" };
  }

  const code = generateCode();
  const codeHash = hashCode(phone_e164, code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  try {
    await db
      .prepare(
        `INSERT INTO otp_codes (phone_e164, code_hash, case_id, expires_at, attempts)
         VALUES (?1, ?2, ?3, ?4, 0)
         ON CONFLICT(phone_e164) DO UPDATE SET
           code_hash = excluded.code_hash,
           case_id = excluded.case_id,
           expires_at = excluded.expires_at,
           attempts = 0`,
      )
      .bind(phone_e164, codeHash, case_id, expiresAt)
      .run();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  // The tenant explicitly opted in by submitting their number to receive this
  // code, so consent for THIS transactional verification SMS is asserted true.
  const res = await sendSms({
    to: phone_e164,
    body: `Your Housing Court Copilot code is ${code}. It expires in 10 minutes. Do not share it.`,
    consent: true,
  });

  if (res.status === "sent") return { ok: true, sent: "sent" };
  if (res.status === "dry_run") return { ok: true, sent: "dry_run" };
  // suppressed (opt-out) or error: treat as generic failure (no leak).
  return { ok: false, reason: "send_failed" };
}

export type VerifyOtpResult =
  | { ok: true; case_ids: string[] }
  | { ok: false; reason: string };

/**
 * Verify a submitted code for `phone_e164`. On success: record the verified
 * phone, link the pinned case_id into case_owners, consume the code, and return
 * every case_id the phone owns. On failure: bump attempts and invalidate the
 * code once the cap is hit. Never throws.
 */
export async function verifyOtp(args: {
  phone_e164: string;
  code: string;
}): Promise<VerifyOtpResult> {
  const { phone_e164, code } = args;
  if (!E164_RE.test(phone_e164) || !/^\d{6}$/.test(code)) {
    return { ok: false, reason: "invalid" };
  }

  const db = await getDB();
  if (!db) return { ok: false, reason: "unavailable" };

  let row: {
    code_hash: string;
    case_id: string;
    expires_at: string;
    attempts: number;
  } | null;
  try {
    row = await db
      .prepare(
        `SELECT code_hash, case_id, expires_at, attempts
           FROM otp_codes WHERE phone_e164 = ?1`,
      )
      .bind(phone_e164)
      .first<{
        code_hash: string;
        case_id: string;
        expires_at: string;
        attempts: number;
      }>();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  if (!row) return { ok: false, reason: "invalid" };

  // Expired or attempt-capped: consume and reject.
  const expired = Date.parse(row.expires_at) <= Date.now();
  const capped = row.attempts >= MAX_ATTEMPTS;
  if (expired || capped) {
    await db
      .prepare(`DELETE FROM otp_codes WHERE phone_e164 = ?1`)
      .bind(phone_e164)
      .run()
      .catch(() => {});
    return { ok: false, reason: "invalid" };
  }

  const match = hashesEqual(row.code_hash, hashCode(phone_e164, code));
  if (!match) {
    // Bump attempts; if this pushes us to the cap, the next request is rejected.
    await db
      .prepare(
        `UPDATE otp_codes SET attempts = attempts + 1 WHERE phone_e164 = ?1`,
      )
      .bind(phone_e164)
      .run()
      .catch(() => {});
    return { ok: false, reason: "invalid" };
  }

  // --- Success: record phone, link case, consume code ---
  const ts = nowIso();
  const caseId = row.case_id;

  try {
    await db
      .prepare(
        `INSERT INTO tenant_phones (phone_e164, created_at)
         VALUES (?1, ?2)
         ON CONFLICT(phone_e164) DO NOTHING`,
      )
      .bind(phone_e164, ts)
      .run();

    await db
      .prepare(
        `INSERT INTO case_owners (case_id, phone_e164, linked_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(case_id, phone_e164) DO NOTHING`,
      )
      .bind(caseId, phone_e164, ts)
      .run();

    // Consume the code so it can't be replayed.
    await db
      .prepare(`DELETE FROM otp_codes WHERE phone_e164 = ?1`)
      .bind(phone_e164)
      .run();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  // Return all cases this phone owns (so the tenant can pick one to resume).
  let caseIds: string[] = [caseId];
  try {
    const { results } = await db
      .prepare(
        `SELECT case_id FROM case_owners WHERE phone_e164 = ?1 ORDER BY linked_at DESC`,
      )
      .bind(phone_e164)
      .all<{ case_id: string }>();
    caseIds = results
      .map((r) => r.case_id)
      .filter((id) => CASE_ID_RE.test(id));
    if (caseIds.length === 0) caseIds = [caseId];
  } catch {
    // fall back to just the freshly linked case
  }

  return { ok: true, case_ids: caseIds };
}
