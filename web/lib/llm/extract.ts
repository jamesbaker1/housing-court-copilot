/**
 * Document intake + field extraction (LLM-SCHEMAS.md Surfaces 2 & 3).
 *
 * SERVER ONLY. Given an uploaded image or PDF (base64 + media type) this module:
 *   1. Surface 2 — Field extraction (claude-opus-4-8, structured, hard reasoning):
 *      extracts the canonical nonpayment field set as `value` + `confidence`.
 *   2. Surface 3 — Case-type / document-type classification (claude-haiku-4-5,
 *      structured, no thinking / no effort): classifies what this document is.
 *
 * Boundary invariants honored (see LLM-SCHEMAS.md §0.1 / §0.2):
 *   - The LLM emits `documents[].extracted_fields.*` (ConfirmableValue), NEVER
 *     `court.court_date`/`court.index_number`/`claimed_arrears` (those are DET).
 *   - Every extracted field is wrapped as a ConfirmableValue with
 *     `tenant_confirmed: false`, `provenance.source: "llm_extraction"`. NONE of
 *     the five hard-const boundary fields is touched here.
 *   - `case_type_confirmed` stays false; the tenant confirms before any use.
 *   - The extracted court_date is `document_extracted_unverified` and must never
 *     set `court.court_date_verified` (that is a separate DET/eTrack source).
 *
 * Constraint-light LLM schema (LLM-SCHEMAS.md §0.5): the zod schemas below carry
 * NO min/max/length/pattern. The canonical Case Object schema (`@/lib/case`) is
 * the validator of record for amount_cents >= 0, BBL/ULID patterns, etc. We emit
 * raw values and let deterministic code validate them downstream.
 *
 * Citations (Surface 2 Pass B) are intentionally skipped for v1 — incompatible
 * with structured-output parsing (LLM-SCHEMAS.md §0.6); we do the structured
 * pass only, matching the @/lib/anthropic house-style note.
 */
import "server-only";

import { z } from "zod";

import {
  HAIKU,
  OPUS,
  imageMessage,
  pdfMessage,
  structuredExtract,
  type ImageMediaType,
  type MessageParam,
} from "@/lib/anthropic";
import {
  CaseTypeSchema,
  ConfidenceLevelSchema,
  DocumentTypeSchema,
  type CaseType,
  type ConfidenceLevel,
  type ConfirmableValue,
  type DocumentType,
  type ExtractedFields,
  type Provenance,
} from "@/lib/case";

// ---------------------------------------------------------------------------
// Supported intake media types (the file the tenant uploads).
// ---------------------------------------------------------------------------

/**
 * Media types this intake accepts. PDFs go through the document block; images
 * through the vision block. HEIC is NOT a supported Anthropic vision media type
 * (see @/lib/anthropic) — convert to JPEG/PNG upstream before calling extract.
 */
export type IntakeMediaType = "application/pdf" | ImageMediaType;

const INTAKE_IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export function isIntakeMediaType(value: string): value is IntakeMediaType {
  return (
    value === "application/pdf" ||
    INTAKE_IMAGE_MEDIA_TYPES.includes(value as ImageMediaType)
  );
}

// ---------------------------------------------------------------------------
// Surface 2 — Field-extraction structured schema (constraint-light).
//
// Mirrors LLM-SCHEMAS.md §3.2: each field carries only `value` + `confidence`.
// Deterministic code (this module's wrapping step) adds tenant_confirmed/
// provenance. The MVP route consumes the subset named in the module brief, but
// we extract the full canonical set so the Case Object is fully seeded.
// ---------------------------------------------------------------------------

/** USD money as integer cents — never a float, never a formatted string. */
const ExtractedMoneySchema = z
  .object({
    amount_cents: z.number().int(),
    currency: z.literal("USD"),
  })
  .nullable();

/** Postal address; all parts nullable (extract only what is literally present). */
const ExtractedAddressSchema = z
  .object({
    line1: z.string().nullable(),
    line2: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postal_code: z.string().nullable(),
  })
  .nullable();

const ExtractedBoroughSchema = z
  .enum(["manhattan", "bronx", "brooklyn", "queens", "staten_island"])
  .nullable();

const StringField = z.object({
  value: z.string().nullable(),
  confidence: ConfidenceLevelSchema,
});
const DateField = z.object({
  /** ISO YYYY-MM-DD exactly as printed. EXTRACTED only — never a computed deadline. */
  value: z.string().nullable(),
  confidence: ConfidenceLevelSchema,
});
const MoneyField = z.object({
  value: ExtractedMoneySchema,
  confidence: ConfidenceLevelSchema,
});
const BoroughField = z.object({
  value: ExtractedBoroughSchema,
  confidence: ConfidenceLevelSchema,
});
const AddressField = z.object({
  value: ExtractedAddressSchema,
  confidence: ConfidenceLevelSchema,
});

/** Surface 2 Pass A structured output. */
export const FieldExtractionSchema = z.object({
  court_date: DateField,
  index_number: StringField,
  borough: BoroughField,
  claimed_arrears: MoneyField,
  landlord_name: StringField,
  petitioner_name: StringField,
  respondent_name: StringField,
  premises_address: AddressField,
  apartment_unit: StringField,
  rent_demand_date: DateField,
  monthly_rent: MoneyField,
  petition_filed_date: DateField,
  service_date: DateField,
});
export type FieldExtractionOutput = z.infer<typeof FieldExtractionSchema>;

// ---------------------------------------------------------------------------
// Surface 3 — Case-type / document-type classification schema.
// ---------------------------------------------------------------------------

export const ClassificationSchema = z.object({
  case_type: CaseTypeSchema,
  case_type_confidence: ConfidenceLevelSchema,
  document_type: DocumentTypeSchema,
  document_type_confidence: ConfidenceLevelSchema,
});
export type ClassificationOutput = z.infer<typeof ClassificationSchema>;

// ---------------------------------------------------------------------------
// System prompts (frozen, cacheable prefixes — no per-case data interpolated).
// ---------------------------------------------------------------------------

const EXTRACTION_SYSTEM = [
  "You extract listed fields from a NYC nonpayment summons/petition, notice of petition, or rent demand.",
  "",
  "Rules:",
  "- Extract ONLY what is literally present in the document. Do not infer, guess, or fill in.",
  '- For any field that is not present or is unreadable, set "value": null and "confidence": "unreadable".',
  "- You EXTRACT dates exactly as printed; you NEVER compute or adjust a deadline or court date.",
  '- Return dates as ISO "YYYY-MM-DD" exactly as printed; do not adjust for any deadline.',
  '- Return monetary amounts as integer cents ("$1,234.56" -> 123456). Never a float, never a formatted string.',
  "- borough is the NYC borough of the housing court / premises, lowercased to the allowed enum.",
  "- index_number is the court index/docket number string as printed.",
  "- claimed_arrears is the total amount the document says is owed (on a rent demand, the demanded amount).",
  "- landlord_name / petitioner_name / respondent_name are party names as printed.",
  "- premises_address is the address of the rented premises; apartment_unit is the unit/apt designation.",
  "- You do NOT decide the case type, the document type, or any defense. You do NOT give legal advice.",
  "- Set confidence to high/medium/low based on how clearly the value is printed; unreadable when you cannot read it.",
].join("\n");

const CLASSIFICATION_SYSTEM = [
  "You classify the case type and document type of a NYC Housing Court document.",
  "This is information, not legal advice and not a legal conclusion.",
  "The MVP processes only `nonpayment` cases end-to-end; everything else routes to a human.",
  'Use "unknown" for case_type or document_type when you cannot tell from the document.',
  "Set each confidence to high/medium/low, or unreadable when the document cannot be read.",
].join("\n");

const EXTRACTION_USER_TEXT =
  "Extract the listed fields from this NYC nonpayment document. " +
  "Extract only what is literally present; use null + unreadable for anything missing or illegible.";

const CLASSIFICATION_USER_TEXT =
  "Classify the case type and the document type of this NYC Housing Court document.";

// ---------------------------------------------------------------------------
// Message builders (vision/PDF block before the text block).
// ---------------------------------------------------------------------------

function buildUserMessage(
  base64Data: string,
  mediaType: IntakeMediaType,
  text: string,
): MessageParam {
  if (mediaType === "application/pdf") {
    return pdfMessage(base64Data, text);
  }
  return imageMessage(base64Data, mediaType, text);
}

// ---------------------------------------------------------------------------
// ConfirmableValue wrapping (deterministic side-effect of an LLM extraction).
// ---------------------------------------------------------------------------

/** The keys of the field-extraction output, 1:1 with ExtractedFields. */
type ExtractionFieldKey = keyof FieldExtractionOutput;

function buildProvenance(
  model: typeof OPUS,
  extractedAt: string,
  documentId?: string,
): Provenance {
  return {
    source: "llm_extraction",
    model,
    extracted_at: extractedAt,
    ...(documentId ? { document_id: documentId } : {}),
  };
}

/**
 * Wrap a single Pass-A {value, confidence} into a ConfirmableValue. Always
 * non-authoritative: tenant_confirmed=false, provenance.source=llm_extraction.
 */
function toConfirmable(
  field: { value: unknown; confidence: ConfidenceLevel },
  provenance: Provenance,
): ConfirmableValue {
  return {
    value: field.value,
    confidence: field.confidence,
    tenant_confirmed: false,
    provenance,
  };
}

/**
 * Map the full Surface-2 output onto the Case Object's ExtractedFields, wrapping
 * each as a non-authoritative ConfirmableValue. The map key set is exactly the
 * canonical ExtractedFields key set, so this stays in lockstep with @/lib/case.
 */
export function toExtractedFields(
  output: FieldExtractionOutput,
  provenance: Provenance,
): ExtractedFields {
  const keys: ExtractionFieldKey[] = [
    "court_date",
    "index_number",
    "borough",
    "claimed_arrears",
    "landlord_name",
    "petitioner_name",
    "respondent_name",
    "premises_address",
    "apartment_unit",
    "rent_demand_date",
    "monthly_rent",
    "petition_filed_date",
    "service_date",
  ];
  const result: ExtractedFields = {};
  for (const key of keys) {
    result[key] = toConfirmable(output[key], provenance);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public extraction API.
// ---------------------------------------------------------------------------

export interface IntakeExtractionInput {
  /** Base64-encoded file bytes (no data: URI prefix). */
  base64Data: string;
  /** Media type of the uploaded file. */
  mediaType: IntakeMediaType;
  /**
   * Optional document_id (doc_ ULID) to stamp into provenance once the document
   * has been persisted. The route can omit it on the first pass and the
   * confirm/persist layer can re-stamp later.
   */
  documentId?: string;
}

/**
 * Outcome of an intake extraction. On a model refusal or empty parse, the
 * corresponding `parsed` field is null and `routeToReview` is true — the caller
 * should queue the case to human review and prompt a re-upload, NOT treat the
 * empty content as data (LLM-SCHEMAS.md §0.9).
 */
export interface IntakeExtractionResult {
  /** Surface 2 raw structured output (null if extraction failed/refused). */
  fields: FieldExtractionOutput | null;
  /** Surface 2 output mapped onto Case Object ExtractedFields (null if failed). */
  extractedFields: ExtractedFields | null;
  /** Surface 3 classification output (null if classification failed/refused). */
  classification: ClassificationOutput | null;
  /** True if any pass refused / returned nothing parseable -> route to a human. */
  routeToReview: boolean;
  /** The exact extraction model id, for audit/provenance records. */
  extractionModel: typeof OPUS;
  /** The exact classification model id, for audit/provenance records. */
  classificationModel: typeof HAIKU;
  /** RFC-3339 instant the extraction ran (for provenance.extracted_at). */
  extractedAt: string;
}

/**
 * Run Surface 2 (field extraction) + Surface 3 (classification) on one uploaded
 * document. The two passes are independent and run concurrently.
 *
 * Output is ALWAYS non-authoritative: every extracted field is a
 * ConfirmableValue with tenant_confirmed=false and provenance.source=
 * "llm_extraction"; classification leaves case_type_confirmed for the tenant.
 */
export async function extractIntakeDocument(
  input: IntakeExtractionInput,
): Promise<IntakeExtractionResult> {
  const { base64Data, mediaType, documentId } = input;
  const extractedAt = new Date().toISOString();

  // Surface 2 — field extraction (Opus, structured, hard reasoning for accuracy).
  const extractionPromise = structuredExtract({
    schema: FieldExtractionSchema,
    system: EXTRACTION_SYSTEM,
    model: OPUS,
    maxTokens: 8192,
    hardReasoning: true,
    messages: [buildUserMessage(base64Data, mediaType, EXTRACTION_USER_TEXT)],
  });

  // Surface 3 — case/document-type classification (Haiku, structured, no thinking).
  const classificationPromise = structuredExtract({
    schema: ClassificationSchema,
    system: CLASSIFICATION_SYSTEM,
    model: HAIKU,
    maxTokens: 256,
    hardReasoning: false,
    messages: [
      buildUserMessage(base64Data, mediaType, CLASSIFICATION_USER_TEXT),
    ],
  });

  const [extraction, classification] = await Promise.all([
    extractionPromise,
    classificationPromise,
  ]);

  const fields = extraction.parsedOutput;
  const classificationOutput = classification.parsedOutput;

  // §0.9: refusal / empty parse on either critical pass routes to a human.
  const extractionRefused =
    fields === null || extraction.message.stop_reason === "refusal";
  const classificationRefused =
    classificationOutput === null ||
    classification.message.stop_reason === "refusal";

  const provenance = buildProvenance(OPUS, extractedAt, documentId);

  return {
    fields,
    extractedFields:
      fields !== null && !extractionRefused
        ? toExtractedFields(fields, provenance)
        : null,
    classification: classificationRefused ? null : classificationOutput,
    routeToReview: extractionRefused || classificationRefused,
    extractionModel: OPUS,
    classificationModel: HAIKU,
    extractedAt,
  };
}

export type { CaseType, ConfidenceLevel, DocumentType };
