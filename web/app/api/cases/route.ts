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

export const runtime = "nodejs";

const BodySchema = z
  .object({
    language: z.string().optional(),
    case_type: CaseTypeSchema.optional(),
  })
  .optional();

export async function POST(req: Request): Promise<NextResponse> {
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

  return NextResponse.json(
    { case_id: created.case_id, case: created },
    { status: 201 },
  );
}
