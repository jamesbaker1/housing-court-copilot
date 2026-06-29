/**
 * POST /api/outcome — record a terminal case disposition (impact tracking).
 * GET  /api/outcome?case_id=… — deterministic outcome SUGGESTIONS for the case.
 *
 * Outcome is server-recorded, never an LLM conclusion and never a tenant PATCH
 * (the case PATCH boundary strips `outcome`). Ownership-gated + rate-limited.
 * When the tenant consented_to_report, the response includes the PII-free
 * anonymized aggregate row the ops metrics sink may store; otherwise nothing is
 * emitted (default-deny).
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { OutcomeDispositionSchema, type Outcome } from "@/lib/case";
import { getCase, patchCase } from "@/lib/store";
import { buildAnonymizedOutcome, deriveOutcomeSignals } from "@/lib/outcomes";
import { limitPublicApi } from "@/lib/ratelimit";
import { authorizeCaseAccess, readAccessContext } from "@/lib/auth/session";

export const runtime = "nodejs";

const CASE_ID_RE = /^case_[0-9a-hjkmnp-tv-z]{26}$/;

const BodySchema = z.object({
  case_id: z.string().regex(CASE_ID_RE),
  disposition: OutcomeDispositionSchema,
  note: z.string().max(2000).nullable().optional(),
  /** Tenant consent to include this (anonymized) in impact reporting. */
  consented_to_report: z.boolean().optional(),
  /** Who recorded it: provider console or system. Never "tenant"/LLM. */
  recorded_by: z.enum(["provider", "system"]).optional(),
});

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: "forbidden", message: "You must prove ownership of this case to access it." },
    { status: 403 },
  );
}

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const caseId = url.searchParams.get("case_id") ?? "";
  if (!CASE_ID_RE.test(caseId)) {
    return NextResponse.json({ error: "invalid_request", message: "case_id required." }, { status: 400 });
  }
  const authz = await authorizeCaseAccess(caseId, readAccessContext(req));
  if (!authz.ok) return forbidden();

  const found = await getCase(caseId);
  if (!found) {
    return NextResponse.json({ error: "not_found", message: "No case with that id." }, { status: 404 });
  }
  return NextResponse.json({
    case_id: caseId,
    outcome: found.outcome ?? null,
    signals: deriveOutcomeSignals(found),
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const limit = await limitPublicApi(req, "outcome");
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
    return NextResponse.json({ error: "invalid_json", message: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { case_id, disposition, note, consented_to_report, recorded_by } = parsed.data;

  const authz = await authorizeCaseAccess(case_id, readAccessContext(req));
  if (!authz.ok) return forbidden();

  const existing = await getCase(case_id);
  if (!existing) {
    return NextResponse.json({ error: "not_found", message: "No case with that id." }, { status: 404 });
  }

  const outcome: Outcome = {
    disposition,
    recorded_by: { actor_type: recorded_by ?? "system", actor_id: null },
    recorded_at: nowIso(),
    note: note ?? null,
    consented_to_report: consented_to_report === true,
  };

  let updated;
  try {
    updated = await patchCase(case_id, { outcome });
  } catch (err) {
    return NextResponse.json(
      { error: "invalid_request", message: err instanceof Error ? err.message : "Outcome did not validate." },
      { status: 400 },
    );
  }
  if (!updated) {
    return NextResponse.json({ error: "not_found", message: "No case with that id." }, { status: 404 });
  }

  // Anonymized aggregate row (null unless the tenant consented_to_report).
  const anonymized = buildAnonymizedOutcome(updated, outcome);
  if (anonymized) {
    // The durable metrics sink (a D1 aggregate table / analytics) is an ops
    // concern; for now we log the PII-free row so it's captured in Worker logs
    // and return it to the caller. No PII is emitted here.
    console.log("[impact] anonymized_outcome", JSON.stringify(anonymized));
  }

  return NextResponse.json({ case_id, outcome: updated.outcome, anonymized });
}
