/**
 * GET  /api/provider/cases/[id]/outcome — current outcome + deterministic
 *      disposition SUGGESTIONS for the case (provider confirms, never auto-set).
 * POST /api/provider/cases/[id]/outcome — record a terminal disposition.
 *
 * This lives on the PROVIDER surface (Access-gated by middleware, consent-scoped
 * here) because the actor who knows a case's disposition is the legal-aid
 * provider, not the tenant. `recorded_by` is therefore always "provider" — the
 * outcome is never an LLM conclusion and never a tenant PATCH (the case PATCH
 * boundary strips `outcome`).
 *
 * AUTHORIZATION: the same per-provider consent scoping as the parent triage
 * route — a provider may record an outcome only on a case that carries a granted
 * handoff_to_provider consent VISIBLE to their prv (or unscoped in dev). A
 * consent addressed to a different provider is invisible → uniform 403.
 *
 * When the tenant consented_to_report, the POST response includes the PII-free
 * anonymized aggregate row the ops metrics sink may store; otherwise nothing is
 * emitted (default-deny).
 *
 * Next 15: a dynamic segment's `params` is a Promise and MUST be awaited.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { OutcomeDispositionSchema, type Outcome } from "@/lib/case";
import { getCase, patchCase } from "@/lib/store";
import { buildAnonymizedOutcome, deriveOutcomeSignals } from "@/lib/outcomes";
import {
  readProviderPrincipal,
  hasVisibleHandoffConsent,
} from "@/lib/auth/provider-principal";

export const runtime = "nodejs";

const BodySchema = z.object({
  disposition: OutcomeDispositionSchema,
  note: z.string().max(2000).nullable().optional(),
  /** Provider attests the tenant consented to anonymized impact reporting. */
  consented_to_report: z.boolean().optional(),
});

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function consentRequired(): NextResponse {
  return NextResponse.json(
    {
      error: "consent_required",
      message:
        "No granted handoff_to_provider consent for a legal-aid provider on this case.",
    },
    { status: 403 },
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const { prv } = readProviderPrincipal(req);

  const found = await getCase(id);
  if (!found) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }
  // PER-PROVIDER SCOPING (§2.2): only a provider this case was handed off to (or
  // unscoped in dev) may see/record its outcome.
  if (!hasVisibleHandoffConsent(found, prv, nowIso())) return consentRequired();

  return NextResponse.json({
    case_id: id,
    outcome: found.outcome ?? null,
    signals: deriveOutcomeSignals(found),
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const principal = readProviderPrincipal(req);

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
  const { disposition, note, consented_to_report } = parsed.data;

  const existing = await getCase(id);
  if (!existing) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }
  if (!hasVisibleHandoffConsent(existing, principal.prv, nowIso())) {
    return consentRequired();
  }

  const outcome: Outcome = {
    disposition,
    // The actor is this verified provider (email if present, else org id). The
    // LLM never reaches this code path — recorded_by is always a human provider.
    recorded_by: {
      actor_type: "provider",
      actor_id: principal.email ?? principal.prv ?? null,
    },
    recorded_at: nowIso(),
    note: note ?? null,
    consented_to_report: consented_to_report === true,
  };

  let updated;
  try {
    updated = await patchCase(id, { outcome });
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: err instanceof Error ? err.message : "Outcome did not validate.",
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

  // Anonymized aggregate row (null unless the tenant consented_to_report). PII-free.
  const anonymized = buildAnonymizedOutcome(updated, outcome);
  if (anonymized) {
    console.log("[impact] anonymized_outcome", JSON.stringify(anonymized));
  }

  return NextResponse.json({ case_id: id, outcome: updated.outcome, anonymized });
}
