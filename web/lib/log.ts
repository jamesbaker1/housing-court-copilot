/**
 * Tiny dependency-free structured logger — one JSON line per event.
 *
 * Most of the app still uses ad-hoc `console.*` (e.g. app/api/intake/route.ts,
 * lib/retention.ts); this module is the structured alternative, introduced so
 * request handlers can record an event WITHOUT leaking the detail to the client.
 * The pattern: log the real cause server-side here, return a fixed, code-tagged
 * message to the caller (see app/api/building/route.ts). Each call emits exactly
 * one `JSON.stringify`'d line so log collectors can parse it as JSON.
 *
 * No PII in logs: never pass raw case_id, phone, name, address, or arrears as
 * fields — use hashCaseId() for case correlation.
 *
 * Why a non-reversible hash for case_id: the case_id is a LOGGABLE locator (it
 * leaks via resume links / access logs — see lib/auth/session.ts), but it still
 * keys the tenant's record, so we never want the raw value sitting in a log
 * aggregator. hashCaseId() gives a stable correlation key that cannot be
 * reversed back to the locator. It uses node:crypto SHA-256 (the same primitive
 * as lib/auth/session.ts:79-81 / lib/auth/otp.ts), so it is SYNCHRONOUS and
 * `log()` stays sync — the only required consumer is the building route, which
 * is `runtime = "nodejs"`. (Web Crypto's `crypto.subtle.digest` is async and
 * would force every caller to await, so it is deliberately NOT used here.)
 */
import { createHash } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One structured log record. `level` routes the console sink and `event` is the
 * stable, greppable name (e.g. "building.persist_failed"); any other fields are
 * arbitrary correlation data — but see the "No PII in logs" note above.
 */
export interface LogFields {
  level: LogLevel;
  event: string;
  [k: string]: unknown;
}

/**
 * Emit one JSON line for `entry`, stamped with an ISO `ts`, routed by level
 * ('error' -> console.error, 'warn' -> console.warn, else console.log).
 *
 * Serialization is wrapped in try/catch: a circular or otherwise unserializable
 * field must NEVER throw out of a request handler, so on failure we fall back to
 * a minimal `console.error` that still names the event.
 */
export function log(entry: LogFields): void {
  const record = { ts: new Date().toISOString(), ...entry };

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    console.error("[log] serialize failed", { event: entry.event });
    return;
  }

  if (entry.level === "error") {
    console.error(line);
  } else if (entry.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

/**
 * Non-reversible correlation key for a case_id, safe to put in logs.
 *
 * Returns `c_<first 12 hex of SHA-256(caseId)>`. Same SHA-256 primitive used to
 * persist token hashes in lib/auth/session.ts:79-81; truncated because a log
 * only needs enough bits to correlate lines for one case, not to be unique
 * across the universe. The raw caseId is never recoverable from the output.
 */
export function hashCaseId(caseId: string): string {
  return "c_" + createHash("sha256").update(caseId).digest("hex").slice(0, 12);
}
