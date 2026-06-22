/**
 * Server-side Cloudflare Turnstile verification — bot protection for the public
 * entry points (intake / chat / defenses / answer / stipulation / OTP request).
 *
 * The client renders a Turnstile widget and sends its token to the API; the API
 * calls {@link verifyTurnstile} to validate that token against Cloudflare's
 * siteverify endpoint using the server-held `TURNSTILE_SECRET_KEY`.
 *
 * Policy:
 *   - Production (NODE_ENV === "production"): FAIL CLOSED. If the secret is
 *     unset, or the token is missing/invalid, the request is rejected. We never
 *     let an unprotected public endpoint serve real traffic.
 *   - Dev / test (secret unset): ALLOW with a logged warning, so local `next dev`
 *     and tests work without a Turnstile site key. If the secret IS set in dev,
 *     we verify for real (so you can exercise the path locally).
 *
 * The token carrier is the `cf-turnstile-token` header or a `turnstileToken`
 * field on the JSON body; the route passes whichever it has.
 */
import "server-only";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileResult =
  | { ok: true; via: "verified" | "dev_skip" }
  | { ok: false; reason: string };

interface SiteverifyResponse {
  success: boolean;
  "error-codes"?: string[];
}

/**
 * Verify a Turnstile token. `remoteIp` is optional but recommended (Cloudflare
 * cross-checks it). Never throws — a network failure to siteverify is treated as
 * a verification failure (fail closed) in production.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  remoteIp?: string | null,
): Promise<TurnstileResult> {
  const isProd = process.env.NODE_ENV === "production";
  const secret = process.env.TURNSTILE_SECRET_KEY;

  if (!secret) {
    if (isProd) {
      // Misconfiguration: a public endpoint in production with no bot secret.
      console.error(
        "TURNSTILE_SECRET_KEY is not set in production — failing closed.",
      );
      return { ok: false, reason: "turnstile_not_configured" };
    }
    console.warn(
      "DEV: Turnstile verification skipped (TURNSTILE_SECRET_KEY unset). " +
        "Set it to exercise the real verification path locally.",
    );
    return { ok: true, via: "dev_skip" };
  }

  if (!token || token.trim().length === 0) {
    return { ok: false, reason: "missing_token" };
  }

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (!res.ok) {
      return { ok: false, reason: `siteverify_http_${res.status}` };
    }
    const data = (await res.json()) as SiteverifyResponse;
    if (data.success) return { ok: true, via: "verified" };
    return {
      ok: false,
      reason: (data["error-codes"] ?? ["verification_failed"]).join(","),
    };
  } catch {
    // Network / parse failure — fail closed in production.
    return { ok: false, reason: "siteverify_unreachable" };
  }
}

/** Pull the Turnstile token off a request header or a parsed JSON body. */
export function extractTurnstileToken(
  req: Request,
  body?: unknown,
): string | null {
  const header = req.headers.get("cf-turnstile-token");
  if (header && header.trim().length > 0) return header.trim();
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const t = (body as Record<string, unknown>).turnstileToken;
    if (typeof t === "string" && t.trim().length > 0) return t.trim();
  }
  return null;
}
