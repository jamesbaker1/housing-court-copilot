/**
 * POST /api/auth/otp/verify — verify a one-time code and link the pinned case to
 * the now-verified phone (OPTIONAL tenant resume).
 *
 * Body: { phone_e164: string, code: string }. The case to link is the one that
 * was pinned at request time (stored server-side with the code), so a client
 * cannot link an arbitrary case here.
 *
 * On success: returns { ok: true, case_ids: [...] } — every case the phone owns,
 * so the tenant can resume one on this device.
 *
 * Anti-enumeration: every failure (bad code, expired, capped, unknown phone,
 * no backend) returns the SAME generic 400. Only a shape error is distinguished.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { verifyOtp } from "@/lib/auth/otp";

export const runtime = "nodejs";

const BodySchema = z.object({
  phone_e164: z.string().regex(/^\+[1-9]\d{1,14}$/),
  code: z.string().regex(/^\d{6}$/),
});

// Generic failure — identical for every non-success outcome.
const GENERIC_FAIL = {
  error: "invalid_code",
  message: "That code didn't work. Request a new one and try again.",
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

  const result = await verifyOtp({
    phone_e164: parsed.data.phone_e164,
    code: parsed.data.code,
  });

  if (!result.ok) {
    return NextResponse.json(GENERIC_FAIL, { status: 400 });
  }

  return NextResponse.json(
    { ok: true, case_ids: result.case_ids },
    { status: 200 },
  );
}
