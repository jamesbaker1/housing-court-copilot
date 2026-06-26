/**
 * Shared test fixtures: a minimal schema-valid Case and small builders. Kept in
 * the node project (no server-only / no network). Everything is built through
 * CaseSchema.parse so a fixture can never drift out of schema.
 */
import {
  CaseSchema,
  type Case,
  type ConfirmableValue,
  type Document,
} from "@/lib/case";

let counter = 0;
/** Deterministic-enough unique ULID-shaped id (Crockford base32, lowercase). */
export function testId(prefix: string): string {
  counter += 1;
  const body = (counter.toString(36) + "0000000000000000000000000000").slice(
    0,
    26,
  );
  // map any chars outside the Crockford set to '0' (digits + a-h,j,k,m,n,p-t,v-z)
  const safe = body.replace(/[ilou]/g, "0");
  return `${prefix}_${safe}`;
}

export const NOW_TS = "2026-06-24T00:00:00Z";

/** Build a minimal schema-valid Case, with overrides shallow-merged on top. */
export function makeCase(overrides: Partial<Case> = {}): Case {
  return CaseSchema.parse({
    case_id: testId("case"),
    schema_version: "1.0.0",
    tenant_id: testId("ten"),
    case_type: "nonpayment",
    status: "intake",
    language: "en",
    created_at: NOW_TS,
    updated_at: NOW_TS,
    audit: { created_by: { actor_type: "system" }, events: [] },
    ...overrides,
  });
}

/** A ConfirmableValue wrapper for an extracted date field. */
export function extractedDate(
  value: string,
  opts: {
    confidence?: ConfirmableValue["confidence"];
    tenant_confirmed?: boolean;
    tenant_corrected_value?: string;
  } = {},
): ConfirmableValue {
  return {
    value,
    confidence: opts.confidence ?? "high",
    tenant_confirmed: opts.tenant_confirmed ?? false,
    ...(opts.tenant_corrected_value !== undefined
      ? { tenant_corrected_value: opts.tenant_corrected_value }
      : {}),
    provenance: { source: "llm_extraction" },
  } as ConfirmableValue;
}

const ZERO_HASH = "0".repeat(64);

/** A minimal document carrying a service_date extracted field. */
export function docWithServiceDate(cv: ConfirmableValue): Document {
  return {
    document_id: testId("doc"),
    document_type: "summons_petition",
    storage_ref: {
      uri: "test://doc.pdf",
      content_hash_sha256: ZERO_HASH,
      mime_type: "application/pdf",
    },
    extracted_fields: { service_date: cv },
    uploaded_at: NOW_TS,
  } as Document;
}
