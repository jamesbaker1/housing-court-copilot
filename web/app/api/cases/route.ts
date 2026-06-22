/**
 * POST /api/cases — mint a new, minimal valid Case and persist it.
 *
 * Body (all optional): { language?: string, case_type?: CaseType }.
 * Returns { case_id, case } with 201. This is the foundation that lets the
 * /copilot flow thread a real case_id so state survives a reload.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { CaseTypeSchema } from "@/lib/case";
import { createCase } from "@/lib/store";
import { issueCaseToken } from "@/lib/auth/session";
import { limitPublicApi } from "@/lib/ratelimit";

export const runtime = "nodejs";

const BodySchema = z
  .object({
    language: z.string().optional(),
    case_type: CaseTypeSchema.optional(),
  })
  .optional();

export async function POST(req: Request): Promise<NextResponse> {
  // Rate limit (per-IP) — this is an unauthenticated endpoint that creates a D1
  // row and mints a capability token on every call, so it is a row/token-flood
  // vector. Meter it like the other public routes (REVIEW fix #2).
  const limit = await limitPublicApi(req, "cases_create");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: unknown = undefined;
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

  const created = await createCase({
    language: parsed.data?.language,
    case_type: parsed.data?.case_type,
  });

  // Mint a per-case capability token and return it ONCE. The client stores it
  // and presents it (Authorization: Bearer / x-case-token) on every subsequent
  // GET / PATCH / DELETE of this case. Only its hash is persisted server-side.
  // Null in the file-fallback dev path (no D1 to persist the hash); the route
  // handler falls back to open dev access there.
  const case_token = await issueCaseToken(created.case_id);

  return NextResponse.json(
    { case_id: created.case_id, case: created, case_token },
    { status: 201 },
  );
}
