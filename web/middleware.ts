/**
 * Cloudflare Access gate for the PROVIDER surface.
 *
 * Protects:
 *   - /provider and everything under it (staff UI)
 *   - /api/provider/* (staff JSON API)
 *
 * In production every matched request must carry a valid Cloudflare Access
 * application token (header `Cf-Access-Jwt-Assertion`, or the `CF_Authorization`
 * cookie for direct browser navigations). The token is verified in
 * `lib/auth/access.ts` against the team's JWKS, enforcing issuer + audience.
 *
 *   - API routes that fail  -> 403 JSON.
 *   - Page routes that fail -> 403 HTML (self-contained; no dependency on an
 *     app route the Auth phase doesn't own).
 *
 * DEV BYPASS: when NODE_ENV !== "production" the gate is bypassed (so local
 * `next dev` works without an Access tunnel) UNLESS CF_ACCESS_DISABLE_DEV === "1",
 * which forces real verification even in dev. Every bypass is logged loudly.
 *
 * Runs on the Edge runtime (Next.js middleware): uses only Web APIs + jose.
 */
import { NextResponse, type NextRequest } from "next/server";
import { verifyAccessRequest } from "@/lib/auth/access";

export const config = {
  // Match the provider page surface and the provider API surface, PLUS the
  // tenant case surface so we can strip spoofable identity headers inbound.
  //
  // NOTE: /api/cases/* is NOT gated by Cloudflare Access (it is tenant-facing,
  // anonymous-by-default). Its ownership gate lives IN the route handler
  // (per-case capability token / OTP owner session via lib/auth/session.ts).
  // Middleware's only job on that surface is the inbound header strip below.
  matcher: [
    "/provider",
    "/provider/:path*",
    "/api/provider/:path*",
    "/api/cases/:path*",
  ],
};

function isApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

function isProviderPath(pathname: string): boolean {
  return pathname === "/provider" || pathname.startsWith("/provider/") ||
    pathname.startsWith("/api/provider/");
}

/**
 * Delete attacker-supplied identity headers BEFORE any handler reads them. Only
 * the verified-token path below may set x-access-*; a client must never be able
 * to inject them. Returns a fresh Headers with the spoofable keys removed.
 */
function stripInboundIdentityHeaders(req: NextRequest): Headers {
  const headers = new Headers(req.headers);
  headers.delete("x-access-email");
  headers.delete("x-access-sub");
  return headers;
}

function forbiddenResponse(req: NextRequest, reason: string): NextResponse {
  const pathname = req.nextUrl.pathname;
  if (isApiPath(pathname)) {
    return NextResponse.json(
      { error: "forbidden", detail: "Cloudflare Access authentication required." },
      { status: 403 },
    );
  }
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Access required</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b0f17; color: #e6edf3; }
      main { max-width: 28rem; padding: 2rem; text-align: center; }
      h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
      p { color: #9aa7b4; line-height: 1.5; margin: .25rem 0; }
      code { background: #161b22; padding: .1rem .35rem; border-radius: .25rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Provider access required</h1>
      <p>This area is protected by Cloudflare Access and is limited to authorized staff.</p>
      <p>Sign in through your organization, then reload this page.</p>
    </main>
  </body>
</html>`;
  return new NextResponse(html, {
    status: 403,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Surface the reason for operators without leaking it to the page body.
      "x-access-denied-reason": reason.slice(0, 200),
    },
  });
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const pathname = req.nextUrl.pathname;

  // Always strip spoofable identity headers inbound (latent spoofing footgun).
  const safeHeaders = stripInboundIdentityHeaders(req);

  // Tenant case surface: NOT Access-gated. The route handler enforces the
  // per-case ownership gate. Here we only pass the header-stripped request on.
  if (!isProviderPath(pathname)) {
    return NextResponse.next({ request: { headers: safeHeaders } });
  }

  const isProd = process.env.NODE_ENV === "production";
  const devBypassDisabled = process.env.CF_ACCESS_DISABLE_DEV === "1";

  // DEV BYPASS: allow through in non-production unless explicitly disabled.
  if (!isProd && !devBypassDisabled) {
    console.warn(
      `DEV: Access bypassed for ${req.method} ${pathname} ` +
        `(set CF_ACCESS_DISABLE_DEV=1 to enforce Cloudflare Access locally)`,
    );
    return NextResponse.next({ request: { headers: safeHeaders } });
  }

  const result = await verifyAccessRequest(req);
  if (!result.ok) {
    console.warn(
      `Access denied for ${req.method} ${pathname}: ${result.reason}`,
    );
    return forbiddenResponse(req, result.reason);
  }

  // Authenticated. Forward the provider identity downstream for audit; route
  // handlers may read `x-access-email` instead of re-verifying the token. These
  // are set ONLY from the verified token (the inbound copies were stripped above).
  if (result.email) safeHeaders.set("x-access-email", result.email);
  if (result.sub) safeHeaders.set("x-access-sub", result.sub);
  return NextResponse.next({ request: { headers: safeHeaders } });
}
