/**
 * Evidence organizer — pure TypeScript over the shared Case Object.
 *
 * Responsibilities (deterministic; NO LLM in this file — LLM tagging lives in
 * `@/lib/llm/tag-evidence`):
 *   - Mint `ev_`-prefixed evidence ids and add typed evidence items onto a Case.
 *   - Hold `evidence_id` and `origin` deterministically (the LLM may propose
 *     `evidence_type`/`tags`/`summary`/`supports_defense_codes`, never the id or
 *     origin — see LLM-SCHEMAS §7).
 *   - Enforce the open-data invariant: every `origin="open_data"` item MUST carry
 *     an `OpenDataAssertion` whose `verify_before_file` gate defaults to
 *     `unverified` (22 NYCRR 130 filer-risk rule — nothing open-data is auto-
 *     asserted; the tenant is the filer).
 *
 * Functions are immutable: they return a new Case / item rather than mutating in
 * place, so callers stay in control of persistence.
 */

import {
  DocumentSchema,
  EvidenceItemSchema,
  OpenDataAssertionSchema,
  type Actor,
  type Case,
  type DefenseCode,
  type Document,
  type DocumentType,
  type EvidenceItem,
  type EvidenceType,
  type OpenDataAssertion,
  type OpenDataDataset,
  type StorageRef,
} from "@/lib/case";

import { newId } from "@/lib/ids";

// ---------------------------------------------------------------------------
// Open-data verify gate
// ---------------------------------------------------------------------------

/**
 * The disclaimer shown to the tenant on any open-data-derived evidence item. It
 * is intentionally blunt: open data can be stale, and the tenant — as the filer
 * — bears the risk of asserting something unverified.
 */
export const OPEN_DATA_ACCURACY_DISCLAIMER =
  "This came from a public NYC dataset, not from you. Public data can be out of " +
  "date or wrong. Don't rely on it or file anything based on it until you've " +
  "checked it yourself — you're the one filing.";

/**
 * Build an `OpenDataAssertion` with its `verify_before_file` gate defaulted to
 * `unverified`. This is the ONLY way open-data evidence should be constructed in
 * this module — it guarantees the gate starts closed.
 */
export function buildOpenDataAssertion(input: {
  dataset: OpenDataDataset;
  datasetVersion: string;
  retrievedAt?: string | null;
  endpoint?: string | null;
  /** Override the default disclaimer copy if a caller needs to. */
  disclaimer?: string;
}): OpenDataAssertion {
  const assertion: OpenDataAssertion = {
    dataset: input.dataset,
    dataset_version: input.datasetVersion,
    retrieved_at: input.retrievedAt ?? null,
    endpoint: input.endpoint ?? null,
    data_accuracy_disclaimer: input.disclaimer ?? OPEN_DATA_ACCURACY_DISCLAIMER,
    verify_before_file: {
      state: "unverified",
      verified_at: null,
      verified_by: null,
      tenant_note: null,
    },
  };
  // Validate so a malformed dataset enum / version can't slip through.
  return OpenDataAssertionSchema.parse(assertion);
}

// ---------------------------------------------------------------------------
// Adding evidence
// ---------------------------------------------------------------------------

export interface AddEvidenceInput {
  evidence_type: EvidenceType;
  origin: EvidenceItem["origin"];
  /** Link to the source document for tenant_uploaded items. */
  document_id?: string | null;
  tags?: string[];
  summary?: string | null;
  /** Candidate defenses — information for human review, never an assertion. */
  supports_defense_codes?: DefenseCode[];
  /**
   * Required when `origin="open_data"`. Build it with
   * {@link buildOpenDataAssertion} so the verify gate starts `unverified`.
   */
  open_data?: OpenDataAssertion | null;
}

/**
 * Construct a validated {@link EvidenceItem} (mints the `ev_` id deterministically).
 * Throws if `origin="open_data"` without an `open_data` assertion (the schema
 * refinement enforces this too, but we fail fast with a clearer message).
 */
export function buildEvidenceItem(input: AddEvidenceInput): EvidenceItem {
  if (input.origin === "open_data" && input.open_data == null) {
    throw new Error(
      "open_data evidence must carry an OpenDataAssertion (build it with " +
        "buildOpenDataAssertion so verify_before_file starts unverified).",
    );
  }

  const item: EvidenceItem = {
    evidence_id: newId("ev"),
    evidence_type: input.evidence_type,
    origin: input.origin,
    document_id: input.document_id ?? null,
    tags: input.tags ?? [],
    summary: input.summary ?? null,
    supports_defense_codes: input.supports_defense_codes ?? [],
    open_data: input.open_data ?? null,
  };

  // Runtime-validate (also enforces the open_data refinement invariant).
  return EvidenceItemSchema.parse(item);
}

/** Return a new Case with the evidence item appended. Does not mutate `c`. */
export function addEvidence(c: Case, input: AddEvidenceInput): {
  case: Case;
  item: EvidenceItem;
} {
  const item = buildEvidenceItem(input);
  return {
    case: { ...c, evidence: [...c.evidence, item] },
    item,
  };
}

// ---------------------------------------------------------------------------
// Documents (the blob a tenant_uploaded evidence item links to)
// ---------------------------------------------------------------------------

export interface BuildDocumentInput {
  /** Content-addressed R2 reference returned by POST /api/evidence/upload. */
  storage_ref: StorageRef;
  /** Declared/known document type; defaults to "other". */
  document_type?: DocumentType;
  /** Optional transcribed text (from vision intake), kept for provider review. */
  ocr_text?: string | null;
  /** Who uploaded it; defaults to the tenant. Never the LLM. */
  uploaded_by?: Actor;
  /** ISO timestamp (caller-provided so this stays pure / deterministic). */
  now: string;
}

/**
 * Construct a validated {@link Document} (mints the `doc_` id deterministically)
 * around a stored blob's {@link StorageRef}. This is how an uploaded blob becomes
 * a first-class, linkable record on the Case — a tenant_uploaded evidence item
 * points at it via `document_id`.
 */
export function buildDocument(input: BuildDocumentInput): Document {
  const doc: Document = {
    document_id: newId("doc"),
    document_type: input.document_type ?? "other",
    storage_ref: input.storage_ref,
    ocr_text: input.ocr_text ?? null,
    uploaded_at: input.now,
    uploaded_by: input.uploaded_by ?? { actor_type: "tenant" },
  };
  return DocumentSchema.parse(doc);
}

/** Return a new Case with the document appended. Does not mutate `c`. */
export function addDocument(c: Case, doc: Document): Case {
  return { ...c, documents: [...c.documents, doc] };
}

// ---------------------------------------------------------------------------
// Tagging existing items (apply LLM-proposed tags onto a held item)
// ---------------------------------------------------------------------------

/**
 * Fields an LLM tagging pass may propose. Deterministic code owns `evidence_id`
 * and `origin`; the LLM never touches them. `evidence_type` MAY be refined by
 * the tagging pass (the spec lists it as an LLM write), but `origin` is fixed.
 */
export interface ProposedTags {
  evidence_type?: EvidenceType;
  tags?: string[];
  summary?: string | null;
  supports_defense_codes?: DefenseCode[];
}

/**
 * Apply LLM-proposed tags onto an existing evidence item, preserving the
 * deterministic identity fields (`evidence_id`, `origin`) and the open-data
 * assertion/gate. Returns a new, validated item.
 */
export function applyTags(item: EvidenceItem, proposed: ProposedTags): EvidenceItem {
  const merged: EvidenceItem = {
    ...item,
    ...(proposed.evidence_type ? { evidence_type: proposed.evidence_type } : {}),
    ...(proposed.tags ? { tags: proposed.tags } : {}),
    ...(proposed.summary !== undefined ? { summary: proposed.summary } : {}),
    ...(proposed.supports_defense_codes
      ? { supports_defense_codes: proposed.supports_defense_codes }
      : {}),
    // Identity + provenance fields are never overwritten:
    evidence_id: item.evidence_id,
    origin: item.origin,
    open_data: item.open_data,
  };
  return EvidenceItemSchema.parse(merged);
}

/** Return a new Case with the given evidence item's tags applied. */
export function tagEvidenceInCase(
  c: Case,
  evidenceId: string,
  proposed: ProposedTags,
): Case {
  let found = false;
  const evidence = c.evidence.map((item) => {
    if (item.evidence_id !== evidenceId) return item;
    found = true;
    return applyTags(item, proposed);
  });
  if (!found) {
    throw new Error(`evidence item not found: ${evidenceId}`);
  }
  return { ...c, evidence };
}

// ---------------------------------------------------------------------------
// Verify-gate helpers + queries
// ---------------------------------------------------------------------------

/** True if the item is open-data-derived and NOT yet verified (blocks filing). */
export function isUnverifiedOpenData(item: EvidenceItem): boolean {
  return (
    item.origin === "open_data" &&
    item.open_data?.verify_before_file.state !== "verified"
  );
}

/**
 * Mark an open-data evidence item's verify gate as `verified` (the tenant
 * confirmed it against a primary source). Tenant-only action — `verified_by` is
 * recorded as the tenant actor. No-op-safe for non-open-data items (throws,
 * since there's no gate to verify).
 */
export function verifyOpenDataGate(
  c: Case,
  evidenceId: string,
  opts: { verifiedAt: string; tenantId?: string | null; tenantNote?: string | null },
): Case {
  const evidence = c.evidence.map((item) => {
    if (item.evidence_id !== evidenceId) return item;
    if (item.origin !== "open_data" || item.open_data == null) {
      throw new Error(`evidence ${evidenceId} has no open-data gate to verify`);
    }
    const updated: EvidenceItem = {
      ...item,
      open_data: {
        ...item.open_data,
        verify_before_file: {
          ...item.open_data.verify_before_file,
          state: "verified",
          verified_at: opts.verifiedAt,
          verified_by: { actor_type: "tenant", actor_id: opts.tenantId ?? null },
          tenant_note: opts.tenantNote ?? item.open_data.verify_before_file.tenant_note ?? null,
        },
      },
    };
    return EvidenceItemSchema.parse(updated);
  });
  return { ...c, evidence };
}

/**
 * Evidence ids that would block a court packet / handoff from being filed
 * because their open-data verify gate is not yet `verified`. Mirrors the API
 * assembly precondition (API-CONTRACTS §3.9 / §3.14).
 */
export function unverifiedOpenDataEvidenceIds(c: Case): string[] {
  return c.evidence.filter(isUnverifiedOpenData).map((e) => e.evidence_id);
}
