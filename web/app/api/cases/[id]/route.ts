/**
 * GET    /api/cases/[id] — fetch a persisted Case -> { case } or 403/404.
 * PATCH  /api/cases/[id] — owner-mutable shallow top-level patch -> { case }.
 * DELETE /api/cases/[id] — owner-initiated delete of a Case (tenant delete path).
 *
 * OWNERSHIP GATE (REVIEW fix #1): the URL `id` is a loggable LOCATOR, not an
 * authenticator. Every GET / PATCH / DELETE requires PROOF OF OWNERSHIP — a
 * per-case capability token (Authorization: Bearer / x-case-token) or an
 * OTP-verified owner session (x-owner-session). Unauthorized requests get a
 * uniform 403 that does NOT leak whether the case exists (no existence oracle).
 *
 * SAFETY-FIELD STRIP (REVIEW fix #1): on PATCH we strip both top-level identity
 * fields AND the nested safety-owned fields (court_date_verified/source,
 * review.advice_routed / advice_detection_log, deadlines[].computed_by,
 * eligibility.*.determined_by, answer_draft.form_fields[].placed_by) so a tenant
 * patch can never write any of the four safety invariants. The store also
 * force-keeps identity and re-validates with CaseSchema (which now refines
 * court_date_verified ⇒ source ∈ {etrack,nyscef}).
 *
 * Next 15: a dynamic segment's `params` is a Promise and MUST be awaited.
 */

import { NextResponse } from "next/server";

import { type Case, stripSafetyOwnedFields } from "@/lib/case";
import { getCase, patchCase, deleteCase } from "@/lib/store";
import {
  authorizeCaseAccess,
  readAccessContext,
  revokeCaseTokens,
  revokeCaseOwnerBindings,
} from "@/lib/auth/session";

export const runtime = "nodejs";

/** Top-level fields the client may never set via PATCH (store also force-keeps). */
const PROTECTED_KEYS = [
  "case_id",
  "schema_version",
  "tenant_id",
  "created_at",
  "updated_at",
] as const;

/** Uniform unauthorized response — does NOT reveal whether the case exists. */
function forbidden(): NextResponse {
  return NextResponse.json(
    {
      error: "forbidden",
      message: "You must prove ownership of this case to access it.",
    },
    { status: 403 },
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const authz = await authorizeCaseAccess(id, readAccessContext(req));
  if (!authz.ok) return forbidden();

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

  const authz = await authorizeCaseAccess(id, readAccessContext(req));
  if (!authz.ok) return forbidden();

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

  // 1) Strip top-level identity fields.
  let patch: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const key of PROTECTED_KEYS) {
    delete patch[key];
  }
  // 2) Strip nested SAFETY-OWNED fields so a tenant patch can never write any of
  //    the four safety invariants (written only by server-side deterministic
  //    code). See lib/case.ts stripSafetyOwnedFields for the full list.
  patch = stripSafetyOwnedFields(patch);

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

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;

  const authz = await authorizeCaseAccess(id, readAccessContext(req));
  if (!authz.ok) return forbidden();

  const existed = await deleteCase(id);
  // Revoke the capability tokens AND the owner bindings regardless, so neither a
  // stale capability token nor a previously-authorized owner session (nor a later
  // reuse of this case_id) can resurrect access. Best-effort; never throws.
  await revokeCaseTokens(id);
  await revokeCaseOwnerBindings(id);

  if (!existed) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }
  return NextResponse.json({ deleted: true, case_id: id });
}
