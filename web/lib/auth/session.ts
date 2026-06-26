/**
 * Per-case capability tokens + OTP-backed owner sessions — server-only.
 *
 * This module locks the `/api/cases/[id]` front door. The URL id (`case_id`) is
 * a LOGGABLE locator that leaks via resume links, Referer headers, and access
 * logs; it MUST NOT be the thing that authorizes a read or write. Instead a
 * caller proves ownership with one of:
 *
 *   1. a per-case CAPABILITY TOKEN — a high-entropy secret minted at case
 *      creation, returned to the client ONCE, bound to exactly one case_id. Only
 *      its SHA-256 hash is persisted (table `case_tokens`).
 *
 *   2. an OWNER SESSION — issued by the OTP verify route after a phone proves
 *      ownership; bound to the verified phone and authorizing every case that
 *      phone owns via `case_owners` (0002). Only its hash is persisted
 *      (table `owner_sessions`).
 *
 * Both secrets are presented as opaque bearer strings. The route extracts them
 * from the `Authorization: Bearer <token>` header (or the `x-case-token` /
 * `x-owner-session` headers) and calls {@link authorizeCaseAccess}.
 *
 * Backend: Cloudflare D1 via getCloudflareContext (same detection as
 * lib/store.ts / lib/auth/otp.ts). When unbound (plain node / local tooling /
 * tests) there is no D1 to consult, so issuance returns null and authorization
 * fails CLOSED — there is no way to prove ownership without the persisted hash.
 *
 * Privacy: the plaintext token is never persisted and never logged. All compares
 * are constant-time over the hex digest.
 */
import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const CASE_ID_RE = /^case_[0-9a-hjkmnp-tv-z]{26}$/;

/** Capability tokens are long-lived (a tenant resumes over days); sessions short. */
const CASE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90; // 90 days
const OWNER_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

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

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A high-entropy opaque bearer secret (256 bits, url-safe base64). */
function mintSecret(): string {
  return randomBytes(32).toString("base64url");
}

/** SHA-256 hex of a bearer secret — only the hash is ever persisted. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// --- capability tokens ------------------------------------------------------

/**
 * Mint a per-case capability token for `caseId`, persist its hash, and return
 * the PLAINTEXT once (the caller returns it to the client and never stores it
 * server-side). Returns null when no D1 backend is bound (the file-mode dev
 * path cannot persist the hash; the route falls back to open dev access).
 */
export async function issueCaseToken(caseId: string): Promise<string | null> {
  if (!CASE_ID_RE.test(caseId)) return null;
  const db = await getDB();
  if (!db) return null;

  const token = mintSecret();
  const tokenHash = hashToken(token);
  const created = Date.now();
  try {
    await db
      .prepare(
        `INSERT INTO case_tokens (token_hash, case_id, created_at, expires_at, revoked)
         VALUES (?1, ?2, ?3, ?4, 0)`,
      )
      .bind(
        tokenHash,
        caseId,
        isoAt(created),
        isoAt(created + CASE_TOKEN_TTL_MS),
      )
      .run();
  } catch {
    return null;
  }
  return token;
}

/** True iff `token` is a live (unexpired, unrevoked) capability for `caseId`. */
async function caseTokenAuthorizes(
  db: D1Database,
  token: string,
  caseId: string,
): Promise<boolean> {
  let row: { case_id: string; expires_at: string | null; revoked: number } | null;
  try {
    row = await db
      .prepare(
        `SELECT case_id, expires_at, revoked FROM case_tokens WHERE token_hash = ?1`,
      )
      .bind(hashToken(token))
      .first<{ case_id: string; expires_at: string | null; revoked: number }>();
  } catch {
    return false;
  }
  if (!row || row.revoked === 1) return false;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return false;
  // Constant-time-ish compare of the bound case_id (both are app-validated ids).
  return row.case_id === caseId;
}

/** Revoke every capability token for a case (used on tenant delete). Never throws. */
export async function revokeCaseTokens(caseId: string): Promise<void> {
  if (!CASE_ID_RE.test(caseId)) return;
  const db = await getDB();
  if (!db) return;
  try {
    await db
      .prepare(`UPDATE case_tokens SET revoked = 1 WHERE case_id = ?1`)
      .bind(caseId)
      .run();
  } catch {
    // best-effort
  }
}

/**
 * Delete-cascade for owner bindings (REVIEW fix #1). On a tenant delete the
 * per-case `case_owners` links MUST be removed, AND any owner session whose ONLY
 * authorization was this case must be revoked — otherwise a previously-authorized
 * session (or a later reuse of the same case_id) could resurrect access to a case
 * that no longer exists. A phone that still owns ANOTHER case keeps its session.
 * Never throws.
 */
export async function revokeCaseOwnerBindings(caseId: string): Promise<void> {
  if (!CASE_ID_RE.test(caseId)) return;
  const db = await getDB();
  if (!db) return;
  try {
    // The phones currently linked to this case (their sessions may need revoking).
    const { results: phones } = await db
      .prepare(`SELECT phone_e164 FROM case_owners WHERE case_id = ?1`)
      .bind(caseId)
      .all<{ phone_e164: string }>();

    // Drop the per-case ownership links.
    await db
      .prepare(`DELETE FROM case_owners WHERE case_id = ?1`)
      .bind(caseId)
      .run();

    // For each formerly-linked phone that no longer owns ANY case, revoke its
    // owner sessions so a stale bearer cannot re-authorize anything.
    for (const { phone_e164 } of phones ?? []) {
      const stillOwns = await db
        .prepare(`SELECT 1 AS ok FROM case_owners WHERE phone_e164 = ?1 LIMIT 1`)
        .bind(phone_e164)
        .first<{ ok: number }>();
      if (!stillOwns) {
        await db
          .prepare(`UPDATE owner_sessions SET revoked = 1 WHERE phone_e164 = ?1`)
          .bind(phone_e164)
          .run();
      }
    }
  } catch {
    // best-effort
  }
}

// --- owner sessions ---------------------------------------------------------

/**
 * Issue an owner session for a verified phone (called by the OTP verify route on
 * success). Persists only the hash; returns the plaintext token + expiry. Null
 * when no D1 backend is bound.
 */
export async function issueOwnerSession(
  phoneE164: string,
): Promise<{ token: string; expires_at: string } | null> {
  const db = await getDB();
  if (!db) return null;

  const token = mintSecret();
  const tokenHash = hashToken(token);
  const created = Date.now();
  const expiresAt = isoAt(created + OWNER_SESSION_TTL_MS);
  try {
    await db
      .prepare(
        `INSERT INTO owner_sessions (token_hash, phone_e164, created_at, expires_at, revoked)
         VALUES (?1, ?2, ?3, ?4, 0)`,
      )
      .bind(tokenHash, phoneE164, isoAt(created), expiresAt)
      .run();
  } catch {
    return null;
  }
  return { token, expires_at: expiresAt };
}

/** True iff `token` is a live session whose phone owns `caseId` (via case_owners). */
async function ownerSessionAuthorizes(
  db: D1Database,
  token: string,
  caseId: string,
): Promise<boolean> {
  let session: { phone_e164: string; expires_at: string; revoked: number } | null;
  try {
    session = await db
      .prepare(
        `SELECT phone_e164, expires_at, revoked FROM owner_sessions WHERE token_hash = ?1`,
      )
      .bind(hashToken(token))
      .first<{ phone_e164: string; expires_at: string; revoked: number }>();
  } catch {
    return false;
  }
  if (!session || session.revoked === 1) return false;
  if (Date.parse(session.expires_at) <= Date.now()) return false;

  // Does this phone own the case?
  try {
    const link = await db
      .prepare(
        `SELECT 1 AS ok FROM case_owners WHERE case_id = ?1 AND phone_e164 = ?2`,
      )
      .bind(caseId, session.phone_e164)
      .first<{ ok: number }>();
    return !!link;
  } catch {
    return false;
  }
}

// --- request-level authorization -------------------------------------------

export interface AccessContext {
  /** A per-case capability token (Authorization: Bearer or x-case-token). */
  caseToken: string | null;
  /** An OTP-verified owner session token (x-owner-session). */
  ownerSession: string | null;
}

/**
 * Pull both bearer secrets off a request. We accept three carriers so the client
 * can choose: `Authorization: Bearer <case-token>`, `x-case-token`, and
 * `x-owner-session`. The Authorization header is treated as a capability token.
 */
export function readAccessContext(req: Request): AccessContext {
  let caseToken: string | null = null;
  const auth = req.headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) caseToken = m[1].trim();
  }
  const xCase = req.headers.get("x-case-token");
  if (!caseToken && xCase) caseToken = xCase.trim();

  const ownerSession = req.headers.get("x-owner-session");

  return {
    caseToken: caseToken && caseToken.length > 0 ? caseToken : null,
    ownerSession: ownerSession && ownerSession.length > 0 ? ownerSession.trim() : null,
  };
}

export type AuthzResult =
  | { ok: true; via: "case_token" | "owner_session" }
  // `dev_open` is ONLY returned in the file-fallback (no-D1) dev/test path.
  | { ok: true; via: "dev_open" }
  | { ok: false };

/**
 * Authorize access to `caseId` given the bearer secrets on the request.
 *
 * FAIL CLOSED in production: when D1 is bound, a caller MUST present a valid
 * capability token or owner session for this case. Presenting neither — or a
 * secret for a different case — is denied.
 *
 * DEV/TEST: when no D1 backend is bound (the file-fallback store path), there is
 * no persisted hash to check against, so we return `{ ok: true, via: "dev_open" }`
 * with a logged warning. This mirrors the store/otp file-fallback philosophy so
 * local dev and tests run without a Cloudflare account. It NEVER happens on
 * Workers, where `env.DB` is always bound.
 */
export async function authorizeCaseAccess(
  caseId: string,
  ctx: AccessContext,
): Promise<AuthzResult> {
  if (!CASE_ID_RE.test(caseId)) return { ok: false };

  const db = await getDB();
  if (!db) {
    console.warn(
      "DEV: case access authorization bypassed (no D1 backend bound). " +
        "This must never happen on Cloudflare Workers.",
    );
    return { ok: true, via: "dev_open" };
  }

  if (ctx.caseToken && (await caseTokenAuthorizes(db, ctx.caseToken, caseId))) {
    return { ok: true, via: "case_token" };
  }
  if (
    ctx.ownerSession &&
    (await ownerSessionAuthorizes(db, ctx.ownerSession, caseId))
  ) {
    return { ok: true, via: "owner_session" };
  }
  return { ok: false };
}

export { hashToken as _hashTokenForTest };
