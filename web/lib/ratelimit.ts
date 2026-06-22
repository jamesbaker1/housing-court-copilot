/**
 * D1-backed fixed-window rate limiter — cost/abuse protection for the public
 * endpoints (intake / chat / defenses / answer / stipulation) and the OTP send
 * route (SMS toll-fraud + harassment protection).
 *
 * Design: a fixed-window counter. For a `bucketKey` we compute the current
 * window index `floor(now_ms / windowMs)` and atomically increment the count for
 * `(bucketKey, window)` in the `rate_limits` table (UPSERT). If the post-increment
 * count exceeds `limit`, the request is denied. A fresh window starts a fresh
 * count, so old rows are harmless (swept by the Ops cron / lazily).
 *
 * Keying:
 *   - Most endpoints: one IP bucket (`ip:<ip>:<route>`).
 *   - OTP send: THREE buckets enforced together — per-phone, per-IP, and a
 *     global daily SMS ceiling (see {@link checkOtpSendLimit}).
 *
 * Backend: Cloudflare D1 via getCloudflareContext (same detection as
 * lib/store.ts). When unbound (plain node / local tooling / tests), there is no
 * store to meter against; the limiter FAILS OPEN for general metering (a downed
 * limiter must never lock a real tenant out). The SMS GLOBAL ceiling is the one
 * place the OTP route additionally guards defensively in app code.
 */
import "server-only";

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

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface RateLimitResult {
  /** Whether the request is allowed (under the limit). */
  allowed: boolean;
  /** Requests remaining in the current window (>= 0). */
  remaining: number;
  /** Epoch ms when the current window resets. */
  resetAt: number;
}

export interface RateLimitRule {
  /** Max requests permitted per window. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

/**
 * Increment + check one bucket. Returns `allowed=false` once the count for the
 * current window exceeds `rule.limit`. Fails OPEN (allowed=true) if no D1
 * backend is bound or a DB error occurs — a downed limiter must not block real
 * users; the higher-stakes SMS ceiling is double-guarded by the caller.
 */
export async function rateLimit(
  bucketKey: string,
  rule: RateLimitRule,
): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = Math.floor(now / rule.windowMs);
  const resetAt = (windowStart + 1) * rule.windowMs;

  const db = await getDB();
  if (!db) {
    return { allowed: true, remaining: rule.limit, resetAt };
  }

  try {
    // Atomic UPSERT-increment: a new window inserts count=1; an existing window
    // bumps count. The RETURNING gives us the post-increment count in one round.
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (bucket_key, window_start, count, updated_at)
         VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(bucket_key, window_start) DO UPDATE SET
           count = count + 1,
           updated_at = excluded.updated_at
         RETURNING count`,
      )
      .bind(bucketKey, windowStart, nowIso())
      .first<{ count: number }>();

    const count = row?.count ?? 1;
    const allowed = count <= rule.limit;
    return {
      allowed,
      remaining: Math.max(0, rule.limit - count),
      resetAt,
    };
  } catch {
    // Fail open on limiter error.
    return { allowed: true, remaining: rule.limit, resetAt };
  }
}

/**
 * Read a bucket's current count WITHOUT incrementing (used to enforce the SMS
 * global ceiling defensively before sending). Returns 0 when unavailable.
 */
async function peekCount(bucketKey: string, windowMs: number): Promise<number> {
  const db = await getDB();
  if (!db) return 0;
  const windowStart = Math.floor(Date.now() / windowMs);
  try {
    const row = await db
      .prepare(
        `SELECT count FROM rate_limits WHERE bucket_key = ?1 AND window_start = ?2`,
      )
      .bind(bucketKey, windowStart)
      .first<{ count: number }>();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

// --- Standard rules ---------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Per-IP rule for the LLM-backed public endpoints (cost-DoS protection). */
export const PUBLIC_API_RULE: RateLimitRule = { limit: 30, windowMs: MINUTE };

/** OTP send limits (SMS toll-fraud + harassment). */
export const OTP_PER_PHONE_RULE: RateLimitRule = { limit: 3, windowMs: HOUR };
export const OTP_PER_IP_RULE: RateLimitRule = { limit: 10, windowMs: HOUR };
/** Global daily SMS ceiling across ALL phones/IPs — a hard spend cap. */
export const OTP_GLOBAL_DAILY_RULE: RateLimitRule = { limit: 500, windowMs: DAY };
const OTP_GLOBAL_BUCKET = "sms_global";

/**
 * Best-effort client IP from the standard edge headers. Falls back to a fixed
 * sentinel so a missing IP still shares ONE conservative bucket (never bypasses
 * the limiter by being keyless).
 */
export function clientIp(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return (xff.split(",")[0] ?? "").trim() || "unknown";
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim();
  return "unknown";
}

/**
 * Meter a public API route by IP. Returns the result so the caller can 429.
 */
export async function limitPublicApi(
  req: Request,
  route: string,
): Promise<RateLimitResult> {
  return rateLimit(`ip:${clientIp(req)}:${route}`, PUBLIC_API_RULE);
}

export interface OtpSendDecision {
  allowed: boolean;
  /** Which limit tripped (for server logs only — never surfaced to the client). */
  reason: "per_phone" | "per_ip" | "global_daily" | null;
}

/**
 * Enforce all three OTP-send limits together: per-phone (3/hr), per-IP (10/hr),
 * and a global daily SMS ceiling (500/day). The global ceiling is checked by a
 * peek FIRST (so a tripped global limit doesn't consume per-phone budget), then
 * the per-phone and per-IP buckets are incremented.
 */
export async function checkOtpSendLimit(
  phoneE164: string,
  ip: string,
): Promise<OtpSendDecision> {
  // Global daily ceiling: peek; if already at/over the cap, deny without
  // incrementing the narrower buckets.
  const globalCount = await peekCount(
    OTP_GLOBAL_BUCKET,
    OTP_GLOBAL_DAILY_RULE.windowMs,
  );
  if (globalCount >= OTP_GLOBAL_DAILY_RULE.limit) {
    return { allowed: false, reason: "global_daily" };
  }

  const perPhone = await rateLimit(`otp_phone:${phoneE164}`, OTP_PER_PHONE_RULE);
  if (!perPhone.allowed) return { allowed: false, reason: "per_phone" };

  const perIp = await rateLimit(`otp_ip:${ip}`, OTP_PER_IP_RULE);
  if (!perIp.allowed) return { allowed: false, reason: "per_ip" };

  // Consume one unit of the global daily budget now that this send is cleared.
  const global = await rateLimit(OTP_GLOBAL_BUCKET, OTP_GLOBAL_DAILY_RULE);
  if (!global.allowed) return { allowed: false, reason: "global_daily" };

  return { allowed: true, reason: null };
}
