/**
 * POST /api/handoff — build a legal-aid handoff intake packet from a Case.
 *
 * v1 shape: the client sends the current Case Object plus a target `provider_id`.
 * This handler:
 *   1. Validates the Case + body.
 *   2. Runs the STUB consent pre-check (handoff_to_provider, granted, not
 *      expired/revoked, this provider). The authoritative gate is the API
 *      gateway — this is a convenience pre-check.
 *   3. Builds the `LegalAidHandoffPacket` object + a plain-text summary, with
 *      DET open-data block computation over evidence AND parties.landlord.open_data.
 *
 * It does NOT deliver to any provider (no LegalServer/PDF integration in v1) and
 * does NOT generate the LLM summary text (Surface 8 is upstream); if no summary
 * text is supplied, a deterministic factual summary is produced.
 *
 * Returns the packet, the plain-text summary, the consent-check result, and any
 * unverified open-data paths that block delivery.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { CaseSchema, type Case } from "@/lib/case";
import {
  buildHandoffPacket,
  checkHandoffConsent,
} from "@/lib/handoff";
import { evaluateEligibility } from "@/lib/eligibility";

export const runtime = "nodejs";

const RequestSchema = z.object({
  case: CaseSchema,
  /** Target legal-aid provider for the consent pre-check (prv_ id). */
  provider_id: z.string(),
  /** Optional subset of evidence ids to include; defaults to all. */
  include_evidence_ids: z.array(z.string()).optional(),
  /** Optional LLM-generated summary text (Surface 8). DET fallback otherwise. */
  intake_summary_text: z.string().nullable().optional(),
  generated_by_model: z
    .enum(["claude-opus-4-8", "claude-sonnet-4-6"])
    .nullable()
    .optional(),
  /** CSR/LIST placeholders (Phase-0/1 content blocker for the canonical set). */
  csr_tags: z.array(z.string()).optional(),
  list_tags: z.array(z.string()).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // Run the deterministic eligibility engine over the case so the attorney
  // handoff summary always carries a current RTC / legal-aid / rental-assistance
  // read (the engine FAILS SAFE — e.g. "insufficient_data: income not provided"
  // is itself useful triage signal for the attorney). determined_by stays
  // "deterministic" (Invariant #4) — never an LLM/tenant conclusion.
  const eligibility = evaluateEligibility(input.case, {
    now: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  const caseWithEligibility: Case = { ...input.case, eligibility };

  // Consent pre-check (stub). Generation itself does not require consent per
  // API-CONTRACTS §3.14, but we surface the check so the client knows whether
  // delivery would be permitted. Delivery (not implemented in v1) re-checks.
  const consent = checkHandoffConsent(caseWithEligibility, {
    providerId: input.provider_id,
  });

  const result = buildHandoffPacket(caseWithEligibility, {
    includeEvidenceIds: input.include_evidence_ids,
    intakeSummaryText: input.intake_summary_text ?? null,
    generatedByModel: input.generated_by_model ?? null,
    csrTags: input.csr_tags,
    listTags: input.list_tags,
  });

  // If open data blocks the packet, mirror the API's 409 for an unfileable packet.
  if (result.packet.blocked_by_unverified_open_data) {
    return NextResponse.json(
      {
        error: "unverified_open_data",
        message:
          "Packet references open-data that is not yet verified. Verify each " +
          "item before this can be delivered.",
        unverified_paths: result.unverifiedOpenDataPaths,
        packet: result.packet,
        plain_text: result.plainText,
        consent,
      },
      { status: 409 },
    );
  }

  return NextResponse.json(
    {
      packet: result.packet,
      plain_text: result.plainText,
      consent,
      eligibility,
    },
    { status: 201 },
  );
}
