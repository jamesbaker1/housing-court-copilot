/**
 * Cloudflare Access JWT verification helper.
 *
 * Verifies the per-request Access application token Cloudflare injects on every
 * request that passed an Access policy. The token is a JWT signed by the team's
 * rotating keys, exposed as a JWKS at:
 *
 *   https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs
 *
 * We verify the signature against that JWKS (cached in-process by jose) and
 * enforce the issuer (team domain) and audience (the Access application's AUD
 * tag). On success we surface the authenticated provider email for audit.
 *
 * This module is Edge-runtime safe: it uses only `jose` (WebCrypto) and `fetch`,
 * never node:* APIs, so it can run from Next.js middleware on Cloudflare Workers.
 *
 * Env (Worker [vars]/secrets, NOT bindings):
 *   CF_ACCESS_TEAM_DOMAIN  e.g. "myteam.cloudflareaccess.com" (no scheme)
 *   CF_ACCESS_AUD          the Application Audience (AUD) tag of the Access app
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

/** Header Cloudflare Access injects with the application token. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
/** Cookie Cloudflare Access sets on browser navigations. */
export const ACCESS_JWT_COOKIE = "CF_Authorization";

export type AccessResult =
  | {
      ok: true;
      email: string | null;
      sub: string | null;
      /** Provider org id (consent.recipient.recipient_id), from a configured claim. */
      prv: string | null;
      /** Authorization roles (e.g. "provider_attorney"), from a configured claim. */
      roles: string[];
      payload: JWTPayload;
    }
  | { ok: false; reason: string };

/** Walk a dot-path (e.g. "custom.prv") into a JWT payload; undefined if absent. */
function claimAt(payload: JWTPayload, path: string): unknown {
  let cur: unknown = payload;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Extract the provider org id (`prv`) from the verified payload. The claim name
 * is IdP/Access-specific, so it's configurable via CF_ACCESS_PRV_CLAIM (a dot
 * path), defaulting to a search of the common locations. Returns null if absent.
 */
export function extractPrv(payload: JWTPayload): string | null {
  const configured = process.env.CF_ACCESS_PRV_CLAIM;
  const paths = configured ? [configured] : ["prv", "custom.prv", "custom.prv_id"];
  for (const p of paths) {
    const v = claimAt(payload, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Extract authorization roles from the verified payload. Configurable via
 * CF_ACCESS_ROLES_CLAIM (dot path), defaulting to common locations
 * (roles / custom.roles / groups). Accepts a string[] or a comma/space string.
 */
export function extractRoles(payload: JWTPayload): string[] {
  const configured = process.env.CF_ACCESS_ROLES_CLAIM;
  const paths = configured ? [configured] : ["roles", "custom.roles", "groups"];
  for (const p of paths) {
    const v = claimAt(payload, p);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    if (typeof v === "string" && v.trim()) {
      return v.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * Cache the remote JWKS key-getter keyed by team domain. jose's
 * createRemoteJWKSet caches the fetched keys internally (and refetches on a
 * cooldown when an unknown `kid` appears, handling key rotation), so we only
 * need one instance per team domain for the life of the isolate.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function normalizeTeamDomain(teamDomain: string): string {
  // Accept either "myteam.cloudflareaccess.com" or a full URL; strip scheme/slash.
  return teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function getJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const host = normalizeTeamDomain(teamDomain);
  let jwks = jwksCache.get(host);
  if (!jwks) {
    const certsUrl = new URL(`https://${host}/cdn-cgi/access/certs`);
    jwks = createRemoteJWKSet(certsUrl);
    jwksCache.set(host, jwks);
  }
  return jwks;
}

/**
 * Configuration pulled from the environment. Returns null with a reason when a
 * required value is missing so the caller can fail closed.
 */
export function readAccessConfig(): { teamDomain: string; aud: string } | { error: string } {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const aud = process.env.CF_ACCESS_AUD;
  if (!teamDomain) return { error: "CF_ACCESS_TEAM_DOMAIN is not set" };
  if (!aud) return { error: "CF_ACCESS_AUD is not set" };
  return { teamDomain, aud };
}

/**
 * Extract the Access JWT from a request: prefer the header Access injects,
 * fall back to the CF_Authorization cookie for direct browser navigations.
 */
export function extractAccessToken(req: Request): string | null {
  const header = req.headers.get(ACCESS_JWT_HEADER);
  if (header) return header;

  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === ACCESS_JWT_COOKIE) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

/**
 * Verify a raw Access JWT. Enforces signature (team JWKS), issuer (team domain)
 * and audience (Access app AUD). Returns the authenticated provider email for
 * audit on success.
 */
export async function verifyAccessToken(
  token: string,
  cfg: { teamDomain: string; aud: string },
): Promise<AccessResult> {
  const host = normalizeTeamDomain(cfg.teamDomain);
  try {
    const { payload } = await jwtVerify(token, getJwks(host), {
      issuer: `https://${host}`,
      audience: cfg.aud,
    });
    const email =
      typeof payload.email === "string" ? payload.email : null;
    const sub = typeof payload.sub === "string" ? payload.sub : null;
    return {
      ok: true,
      email,
      sub,
      prv: extractPrv(payload),
      roles: extractRoles(payload),
      payload,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "verification failed";
    return { ok: false, reason };
  }
}

/**
 * Convenience: pull the token off a Request, verify it against env config, and
 * return the result. Fails closed (ok:false) when config or token is missing.
 */
export async function verifyAccessRequest(req: Request): Promise<AccessResult> {
  const cfg = readAccessConfig();
  if ("error" in cfg) return { ok: false, reason: cfg.error };

  const token = extractAccessToken(req);
  if (!token) return { ok: false, reason: "no Access token present" };

  return verifyAccessToken(token, cfg);
}
