/**
 * POST /api/evidence — add an evidence item to a Case and (optionally) LLM-tag it.
 *
 * v1 shape: the client sends the current Case Object plus the evidence to add.
 * This handler:
 *   1. Validates the Case + request body (zod).
 *   2. Optionally runs Surface 6 tagging (Sonnet, structured) over the provided
 *      content when `auto_tag` is true and content is present.
 *   3. Deterministically mints the `ev_` id + holds `origin`, attaches the
 *      open-data verify gate (default unverified) for open-data items, and
 *      appends the item to the Case.
 *
 * Returns the updated Case + the new evidence item. Persistence is the caller's
 * job (no DB in v1). Server-only — imports the Anthropic helpers transitively.
 *
 * Boundary: the LLM proposes evidence_type/tags/summary/supports_defense_codes
 * only; `evidence_id` and `origin` are deterministic, and open-data items always
 * start with verify_before_file=unverified.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import {
  CaseSchema,
  EvidenceTypeSchema,
  OpenDataDatasetSchema,
} from "@/lib/case";
import {
  addEvidence,
  applyTags,
  buildOpenDataAssertion,
  type AddEvidenceInput,
} from "@/lib/evidence";
import { tagEvidence } from "@/lib/llm/tag-evidence";

export const runtime = "nodejs";

const RequestSchema = z.object({
  /** The current Case Object the evidence is being added to. */
  case: CaseSchema,
  origin: z.enum(["tenant_uploaded", "open_data", "tenant_stated"]),
  /** Declared/known type; the LLM may refine it when auto_tag is on. */
  evidence_type: EvidenceTypeSchema.optional(),
  document_id: z.string().nullable().optional(),
  /** Free text used for LLM tagging (OCR text or tenant description). */
  content: z.string().optional(),
  /** Run Surface 6 tagging over `content`. Defaults false. */
  auto_tag: z.boolean().optional(),
  /** Open-data provenance — required when origin="open_data". */
  open_data: z
    .object({
      dataset: OpenDataDatasetSchema,
      dataset_version: z.string(),
      retrieved_at: z.string().nullable().optional(),
      endpoint: z.string().nullable().optional(),
    })
    .optional(),
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

  if (input.origin === "open_data" && !input.open_data) {
    return NextResponse.json(
      {
        error: "open_data_required",
        message: "origin=open_data requires an open_data provenance block.",
      },
      { status: 400 },
    );
  }

  // Build the base add-input (deterministic id/origin/gate).
  const openDataAssertion =
    input.origin === "open_data" && input.open_data
      ? buildOpenDataAssertion({
          dataset: input.open_data.dataset,
          datasetVersion: input.open_data.dataset_version,
          retrievedAt: input.open_data.retrieved_at ?? null,
          endpoint: input.open_data.endpoint ?? null,
        })
      : null;

  const addInput: AddEvidenceInput = {
    // evidence_type may be refined by tagging below; default to a hint or "other".
    evidence_type: input.evidence_type ?? "other",
    origin: input.origin,
    document_id: input.document_id ?? null,
    open_data: openDataAssertion,
  };

  const { case: updatedCase, item } = addEvidence(input.case, addInput);

  // Optional LLM tagging pass over the provided content.
  let tagging_failed = false;
  if (input.auto_tag && input.content && input.content.trim().length > 0) {
    try {
      const { tags } = await tagEvidence({
        content: input.content,
        origin: input.origin,
        evidence_type_hint: input.evidence_type ?? null,
      });
      if (tags) {
        const tagged = applyTags(item, {
          evidence_type: tags.evidence_type,
          tags: tags.tags,
          summary: tags.summary,
          supports_defense_codes: tags.supports_defense_codes,
        });
        // Swap the freshly-tagged item back into the case.
        const evidence = updatedCase.evidence.map((e) =>
          e.evidence_id === tagged.evidence_id ? tagged : e,
        );
        return NextResponse.json(
          { case: { ...updatedCase, evidence }, item: tagged, tagging_failed: false },
          { status: 201 },
        );
      }
      tagging_failed = true; // model returned nothing parseable
    } catch {
      // Tagging is best-effort; the item is still added untagged.
      tagging_failed = true;
    }
  }

  return NextResponse.json(
    { case: updatedCase, item, tagging_failed },
    { status: 201 },
  );
}
