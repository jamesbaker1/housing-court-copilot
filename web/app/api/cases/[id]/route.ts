/**
 * GET  /api/cases/[id] — fetch a persisted Case -> { case } or 404.
 * PATCH /api/cases/[id] — shallow top-level patch of a Case -> { case } or 404.
 *
 * On PATCH, protected identity fields in the body are stripped before the
 * store applies its own force-keep of identity (case_id, schema_version,
 * tenant_id, created_at) and bumps updated_at. A non-object body is a 400.
 *
 * Next 15: a dynamic segment's `params` is a Promise and MUST be awaited.
 */

import { NextResponse } from "next/server";

import type { Case } from "@/lib/case";
import { getCase, patchCase } from "@/lib/store";

export const runtime = "nodejs";

/** Fields the client may never set via PATCH (the store also force-keeps them). */
const PROTECTED_KEYS = [
  "case_id",
  "schema_version",
  "tenant_id",
  "created_at",
  "updated_at",
] as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const found = await getCase(id);
  if (!found) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }
  return NextResponse.json({ case: found });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "invalid_request", message: "Body must be a Case patch object." },
      { status: 400 },
    );
  }

  const patch: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const key of PROTECTED_KEYS) {
    delete patch[key];
  }

  let updated: Case | null;
  try {
    updated = await patchCase(id, patch as Partial<Case>);
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message:
          err instanceof Error ? err.message : "Patch did not produce a valid Case.",
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
  return NextResponse.json({ case: updated });
}
