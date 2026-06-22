/**
 * POST /api/auth/otp/request — send a one-time code to link the current case to
 * a phone (OPTIONAL tenant resume; never a login wall).
 *
 * Body: { phone_e164: string, case_id: string }.
 *
 * Privacy / anti-enumeration: the response is intentionally GENERIC and does not
 * reveal whether the phone exists, whether SMS actually went out, or whether the
 * code was a real send vs a dry-run. Malformed input still returns 400 (shape
 * error only), but a valid-shaped request always yields the same opaque 200 so a
 * caller cannot probe state.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { requestOtp } from "@/lib/auth/otp";
import { checkOtpSendLimit, clientIp } from "@/lib/ratelimit";
import { verifyTurnstile, extractTurnstileToken } from "@/lib/turnstile";

export const runtime = "nodejs";

const BodySchema = z.object({
  phone_e164: z.string().regex(/^\+[1-9]\d{1,14}$/),
  case_id: z.string().regex(/^case_[0-9a-hjkmnp-tv-z]{26}$/),
});

// Generic acknowledgement — identical regardless of outcome.
const GENERIC_OK = {
  ok: true,
  message: "If that number can receive texts, we sent a 6-digit code.",
} as const;

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const ip = clientIp(req);

  // Bot protection: a Turnstile token is required before we will send any SMS.
  // Fails closed in production (open in dev when TURNSTILE_SECRET_KEY is unset).
  const turnstile = await verifyTurnstile(extractTurnstileToken(req, body), ip);
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "challenge_failed", message: "Please complete the verification and try again." },
      { status: 403 },
    );
  }

  // SMS toll-fraud / harassment protection: per-phone (3/hr) + per-IP (10/hr) +
  // a global daily SMS ceiling. On a tripped limit we return the SAME generic OK
  // as a successful request, so an attacker cannot probe the limiter state or
  // learn whether the phone is known (anti-enumeration is preserved).
  const decision = await checkOtpSendLimit(parsed.data.phone_e164, ip);
  if (!decision.allowed) {
    console.warn(`OTP send suppressed by rate limit (${decision.reason}).`);
    return NextResponse.json(GENERIC_OK, { status: 200 });
  }

  // Fire and forget the outcome: we never surface it to the client.
  await requestOtp({
    phone_e164: parsed.data.phone_e164,
    case_id: parsed.data.case_id,
  });

  return NextResponse.json(GENERIC_OK, { status: 200 });
}
