/**
 * POST /api/intake — document intake + extraction endpoint.
 *
 * Node runtime (the Anthropic SDK + base64 decoding need Node, not Edge).
 *
 * Accepts an uploaded file (base64 + media type), runs:
 *   - Surface 2 field extraction + Surface 3 classification (lib/llm/extract)
 *   - the plain-English explainer (lib/llm/explain) over the extracted values
 * and returns the extracted fields (as non-authoritative ConfirmableValues) +
 * the classification + the explanation + the disclaimer.
 *
 * Boundary: every extracted value comes back tenant_confirmed=false with
 * provenance.source="llm_extraction". Nothing here is authoritative; the PWA
 * drives the confirm/correct loop, and the court date / deadlines are sourced /
 * computed by deterministic code, never trusted from this response.
 */
import { NextResponse } from "next/server";

import {
  explainDocument,
  type ExplainFacts,
} from "@/lib/llm/explain";
import {
  extractIntakeDocument,
  isIntakeMediaType,
  type FieldExtractionOutput,
  type IntakeMediaType,
} from "@/lib/llm/extract";
import type { Borough, CaseType, Money } from "@/lib/case";

export const runtime = "nodejs";
/** Vision + extraction can take a while; allow a generous budget. */
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// Request body.
// ---------------------------------------------------------------------------

interface IntakeRequestBody {
  /** Base64-encoded file bytes. A `data:` URI prefix is tolerated and stripped. */
  base64Data?: unknown;
  /** Media type of the uploaded file (e.g. "application/pdf", "image/jpeg"). */
  mediaType?: unknown;
  /** Optional doc_ ULID to stamp into provenance. */
  documentId?: unknown;
  /** Optional BCP-47 output language for the explanation. Defaults to "en". */
  language?: unknown;
}

/** Strip a leading `data:<mime>;base64,` prefix if the client sent a data URI. */
function normalizeBase64(input: string): string {
  const match = input.match(/^data:[^;]+;base64,(.*)$/s);
  return match ? (match[1] ?? input) : input;
}

// ---------------------------------------------------------------------------
// Unwrap the extracted field values into plain primitives for the explainer.
// The explainer is information-only and never authoritative, so using the
// freshly extracted (unconfirmed) values for a first-pass summary is fine — the
// summary is shown WITH the "double-check this" disclaimer and the confirm loop.
// ---------------------------------------------------------------------------

function pickString(field: { value: string | null }): string | null {
  return field.value;
}

function pickMoney(field: { value: Money | null }): Money | null {
  return field.value;
}

function joinAddress(
  field: FieldExtractionOutput["premises_address"],
): string | null {
  const a = field.value;
  if (!a) return null;
  const parts = [a.line1, a.line2, a.city, a.state, a.postal_code].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function buildExplainFacts(
  fields: FieldExtractionOutput,
  caseType: CaseType | null,
  documentType: string | null,
): ExplainFacts {
  return {
    case_type: caseType,
    document_type: documentType,
    landlord_name: pickString(fields.landlord_name),
    petitioner_name: pickString(fields.petitioner_name),
    respondent_name: pickString(fields.respondent_name),
    premises_address: joinAddress(fields.premises_address),
    apartment_unit: pickString(fields.apartment_unit),
    borough: fields.borough.value as Borough | null,
    claimed_arrears: pickMoney(fields.claimed_arrears),
    monthly_rent: pickMoney(fields.monthly_rent),
    rent_demand_date: pickString(fields.rent_demand_date),
    petition_filed_date: pickString(fields.petition_filed_date),
    service_date: pickString(fields.service_date),
    court_date: pickString(fields.court_date),
  };
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  let body: IntakeRequestBody;
  try {
    body = (await request.json()) as IntakeRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  // Validate base64Data.
  if (typeof body.base64Data !== "string" || body.base64Data.length === 0) {
    return NextResponse.json(
      { error: "Missing or invalid `base64Data` (expected a non-empty string)." },
      { status: 400 },
    );
  }

  // Validate mediaType.
  if (typeof body.mediaType !== "string" || !isIntakeMediaType(body.mediaType)) {
    return NextResponse.json(
      {
        error:
          "Missing or unsupported `mediaType`. Supported: application/pdf, image/jpeg, image/png, image/gif, image/webp. Convert HEIC to JPEG/PNG before upload.",
      },
      { status: 400 },
    );
  }

  const base64Data = normalizeBase64(body.base64Data);
  const mediaType = body.mediaType as IntakeMediaType;
  const documentId =
    typeof body.documentId === "string" ? body.documentId : undefined;
  const language =
    typeof body.language === "string" && body.language.length > 0
      ? body.language
      : "en";

  // Run extraction + classification.
  let extraction;
  try {
    extraction = await extractIntakeDocument({
      base64Data,
      mediaType,
      ...(documentId ? { documentId } : {}),
    });
  } catch (err) {
    console.error("[intake] extraction failed:", err);
    return NextResponse.json(
      {
        error:
          "We couldn't read that document. Please try uploading it again, or use a clearer photo or PDF.",
      },
      { status: 502 },
    );
  }

  // §0.9: a refusal / empty parse on a critical pass routes to a human and asks
  // for a re-upload rather than returning empty content as if it were data.
  if (extraction.routeToReview || extraction.fields === null) {
    return NextResponse.json(
      {
        routeToReview: true,
        extractedFields: extraction.extractedFields,
        classification: extraction.classification,
        explanation: null,
        message:
          "We had trouble reading this document clearly. A person can help — and you can try re-uploading a clearer photo or PDF.",
        extractionModel: extraction.extractionModel,
        classificationModel: extraction.classificationModel,
        extractedAt: extraction.extractedAt,
      },
      { status: 200 },
    );
  }

  // Generate the plain-English explanation over the extracted values.
  const caseType = extraction.classification?.case_type ?? null;
  const documentType = extraction.classification?.document_type ?? null;
  const facts = buildExplainFacts(extraction.fields, caseType, documentType);

  let explanation: { summary: string; refused: boolean; disclaimer: { label: string; body: string } } | null =
    null;
  try {
    const explainResult = await explainDocument({ facts, language });
    explanation = {
      summary: explainResult.summary,
      refused: explainResult.refused,
      disclaimer: explainResult.disclaimer,
    };
  } catch (err) {
    // The explanation is a nice-to-have; extraction still succeeded. Don't fail
    // the whole request — return the fields and let the PWA show them without
    // the prose summary.
    console.error("[intake] explanation failed:", err);
    explanation = null;
  }

  return NextResponse.json(
    {
      routeToReview: false,
      /** Non-authoritative ConfirmableValues (tenant_confirmed=false). */
      extractedFields: extraction.extractedFields,
      classification: extraction.classification,
      explanation,
      extractionModel: extraction.extractionModel,
      classificationModel: extraction.classificationModel,
      extractedAt: extraction.extractedAt,
    },
    { status: 200 },
  );
}
