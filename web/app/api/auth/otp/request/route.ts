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

  // Fire and forget the outcome: we never surface it to the client.
  await requestOtp({
    phone_e164: parsed.data.phone_e164,
    case_id: parsed.data.case_id,
  });

  return NextResponse.json(GENERIC_OK, { status: 200 });
}
