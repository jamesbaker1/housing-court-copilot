/**
 * Client-side "your case" session helpers — browser-only.
 *
 * This is the SAME-DEVICE auth contract for the now-gated /api/cases routes,
 * factored out so both the stepped /copilot flow and the persistent /case
 * dashboard read/write the tenant's OWN case identically, with NO login.
 *
 * The contract (see lib/auth/session.ts + app/api/cases/route.ts):
 *   - On case create (POST /api/cases) the server mints a per-case CAPABILITY
 *     TOKEN and returns it ONCE. We persist it in localStorage alongside the
 *     case_id and present it as `Authorization: Bearer <token>` on every GET /
 *     PATCH / DELETE of that case. Only its hash lives server-side.
 *   - An OTP-verified OWNER SESSION (from ResumeByPhone, cross-device) can be
 *     held in-memory and presented as `x-owner-session` as an auth fallback.
 *
 * The URL case_id is a loggable LOCATOR, never an authenticator: a request with
 * no token (or a token for a different case) gets a uniform 403. Anonymous-first
 * is preserved because the token is minted automatically at case create — the
 * tenant never logs in.
 *
 * NOTE: this module touches window.localStorage and must only run in the
 * browser (the pages that import it are "use client").
 */

export const CASE_ID_STORAGE_KEY = "hcc_case_id";
export const CASE_TOKEN_STORAGE_KEY = "hcc_case_token";
export const LANGUAGE_STORAGE_KEY = "hcc_language";

/** Read the stored case id, or null (also null when storage is unavailable). */
export function readStoredCaseId(): string | null {
  try {
    return window.localStorage.getItem(CASE_ID_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Read the stored per-case capability token, or null. */
export function readStoredCaseToken(): string | null {
  try {
    return window.localStorage.getItem(CASE_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Persist the case id + (optional) capability token for same-device resume. */
export function storeCaseCredentials(caseId: string, token?: string | null): void {
  try {
    window.localStorage.setItem(CASE_ID_STORAGE_KEY, caseId);
    if (token) {
      window.localStorage.setItem(CASE_TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(CASE_TOKEN_STORAGE_KEY);
    }
  } catch {
    /* ignore storage failures — the in-memory flow still works */
  }
}

/**
 * Build the auth headers for any /api/cases/[id] call:
 *   - `Authorization: Bearer <case-token>` (the per-case capability token), and
 *   - `x-owner-session: <session>` (an OTP-verified owner session) as a fallback
 *     for a device that doesn't carry the capability token.
 * Pass `json` true to also set Content-Type for a PATCH/POST body.
 */
export function caseAuthHeaders(opts: {
  caseToken: string | null;
  ownerSession?: string | null;
  json?: boolean;
}): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts.json) h["Content-Type"] = "application/json";
  if (opts.caseToken) h["Authorization"] = `Bearer ${opts.caseToken}`;
  if (opts.ownerSession) h["x-owner-session"] = opts.ownerSession;
  return h;
}
