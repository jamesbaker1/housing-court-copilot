/**
 * POST /api/eligibility — run the deterministic eligibility engine on a Case and
 * persist the result (LEGAL-RULES §8).
 *
 * Body: { case_id }.
 *
 * Server-authoritative (Invariant #4): the `determined_by = "deterministic"`
 * eligibility slots are written ONLY here, by deterministic code, onto a
 * schema-valid Case — never by the LLM or a tenant PATCH (the case PATCH boundary
 * strips eligibility.*). Ownership-gated + rate-limited like every case write.
 *
 * The engine FAILS SAFE: with the default UNVALIDATED config it returns
 * insufficient_data / program_unavailable, never a fabricated "you qualify".
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { getCase, patchCase } from "@/lib/store";
import { evaluateEligibility } from "@/lib/eligibility";
import { limitPublicApi } from "@/lib/ratelimit";
import { authorizeCaseAccess, readAccessContext } from "@/lib/auth/session";

export const runtime = "nodejs";

const BodySchema = z.object({
  case_id: z.string().regex(/^case_[0-9a-hjkmnp-tv-z]{26}$/),
});

export async function POST(req: Request): Promise<NextResponse> {
  // Rate limit (cost protection).
  const limit = await limitPublicApi(req, "eligibility");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { case_id } = parsed.data;

  // OWNERSHIP GATE: writing eligibility is a write to the case.
  const authz = await authorizeCaseAccess(case_id, readAccessContext(req));
  if (!authz.ok) {
    return NextResponse.json(
      { error: "forbidden", message: "You must prove ownership of this case to access it." },
      { status: 403 },
    );
  }

  const existing = await getCase(case_id);
  if (!existing) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  // Deterministic evaluation (no LLM). `evaluated_at` is stamped by the server.
  const eligibility = evaluateEligibility(existing, {
    now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });

  let updated;
  try {
    updated = await patchCase(case_id, { eligibility });
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: err instanceof Error ? err.message : "Eligibility patch did not validate.",
      },
      { status: 400 },
    );
  }
  if (!updated) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  return NextResponse.json({ case_id, eligibility: updated.eligibility }, { status: 200 });
}
