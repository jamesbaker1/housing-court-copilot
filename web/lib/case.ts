/**
 * Canonical Case Object (the spine) — v1, MVP: NYC nonpayment.
 *
 * This is the single shared data model. Every module imports its schemas and
 * types from here. It is a faithful but v1-trimmed port of spec/CASE-OBJECT.md.
 *
 * Provenance / LLM-vs-DETERMINISTIC boundary is enforced where the spec calls
 * for hard invariants (machine-checkable consts):
 *   - deadlines[].computed_by               === "deterministic"
 *   - eligibility.*.determined_by           === "deterministic"
 *   - answer_draft.form_fields[].placed_by  === "deterministic"
 *   - answer_draft.factual_statements[].transcription_only === true
 *   - defenses_checklist[].surfaced_as       === "information_not_advice"
 *
 * Two non-negotiable backstops show up structurally here:
 *   1) The authoritative court date lives on `court` with a `court_date_source`
 *      + `court_date_verified` flag (verified only when eTrack/NYSCEF-sourced).
 *      The LLM-extracted court_date lives on the document, never on `court`.
 *   2) Advice routing is recorded on `review.advice_routed` (DET decision).
 *
 * Money is ALWAYS integer cents. Dates (`*_date`) are bare ISO calendar dates;
 * timestamps (`*_at`) are RFC-3339 UTC instants. Booleans default false.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// ID patterns (Crockford base32 ULID with typed prefixes)
// ---------------------------------------------------------------------------

const ULID = "[0-9a-hjkmnp-tv-z]{26}";
const idPattern = (prefix: string) => new RegExp(`^${prefix}_${ULID}$`);

export const CaseIdSchema = z.string().regex(idPattern("case"));
export const TenantIdSchema = z.string().regex(idPattern("ten"));
export const AccountIdSchema = z.string().regex(idPattern("acct"));
export const DocumentIdSchema = z.string().regex(idPattern("doc"));
export const TimelineEventIdSchema = z.string().regex(idPattern("evt"));
export const DeadlineIdSchema = z.string().regex(idPattern("dl"));
export const EvidenceIdSchema = z.string().regex(idPattern("ev"));
export const ConsentIdSchema = z.string().regex(idPattern("cns"));
export const AnswerDraftIdSchema = z.string().regex(idPattern("ans"));
export const StatementIdSchema = z.string().regex(idPattern("stmt"));
export const PacketIdSchema = z.string().regex(idPattern("pkt"));
export const ReminderIdSchema = z.string().regex(idPattern("rem"));
export const ProviderIdSchema = z.string().regex(idPattern("prv"));
export const AttorneyIdSchema = z.string().regex(idPattern("atty"));

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** RFC-3339 / ISO-8601 UTC instant, 'Z'-suffixed. */
export const TimestampSchema = z.string().datetime({ offset: false });
/** ISO-8601 calendar date YYYY-MM-DD (court-local America/New_York calendar). */
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ModelIdSchema = z.enum([
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
]);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const ConfidenceLevelSchema = z.enum([
  "high",
  "medium",
  "low",
  "unreadable",
]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

/** Money — integer minor units (USD cents). NEVER a float. */
export const MoneySchema = z.object({
  amount_cents: z.number().int().min(0),
  currency: z.literal("USD"),
});
export type Money = z.infer<typeof MoneySchema>;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const CaseTypeSchema = z.enum([
  "nonpayment",
  "holdover",
  "illegal_lockout",
  "hp_action",
  "other",
  "unknown",
]);
export type CaseType = z.infer<typeof CaseTypeSchema>;

export const CaseStatusSchema = z.enum([
  "intake",
  "prepared",
  "referred",
  "represented",
  "resolved",
]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

export const BoroughSchema = z.enum([
  "manhattan",
  "bronx",
  "brooklyn",
  "queens",
  "staten_island",
]);
export type Borough = z.infer<typeof BoroughSchema>;

export const CountySchema = z.enum([
  "New York",
  "Bronx",
  "Kings",
  "Queens",
  "Richmond",
]);
export type County = z.infer<typeof CountySchema>;

export const DocumentTypeSchema = z.enum([
  "summons_petition",
  "rent_demand",
  "notice_of_petition",
  "lease",
  "rent_ledger",
  "rent_receipt",
  "repair_evidence",
  "correspondence",
  "court_notice",
  "other",
  "unknown",
]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const EvidenceTypeSchema = z.enum([
  "rent_payment_proof",
  "rent_receipt",
  "bank_record",
  "money_order",
  "repair_request",
  "hpd_violation",
  "hpd_complaint",
  "photo",
  "correspondence",
  "lease_term",
  "registration_record",
  "ownership_record",
  "witness_statement",
  "other",
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const DefenseCodeSchema = z.enum([
  "general_denial",
  "rent_paid",
  "rent_partially_paid",
  "improper_service",
  "defective_rent_demand",
  "defective_petition",
  "warranty_of_habitability",
  "repairs_needed",
  "rent_overcharge",
  "wrong_amount_claimed",
  "no_landlord_tenant_relationship",
  "not_registered_multiple_dwelling",
  "succession_rights",
  "laches",
  "rent_regulation_violation",
  "other",
]);
export type DefenseCode = z.infer<typeof DefenseCodeSchema>;

export const EligibilityProgramSchema = z.enum([
  "rtc",
  "legal_aid",
  "erap",
  "cityfheps",
  "one_shot_deal",
  "ofa_emergency_grant",
  "snap",
  "other",
]);
export type EligibilityProgram = z.infer<typeof EligibilityProgramSchema>;

export const DeadlineTypeSchema = z.enum([
  "answer_due",
  "first_appearance",
  "motion_due",
  "discovery_due",
  "hardship_declaration_due",
  "warrant_execution_stay_end",
  "other",
]);
export type DeadlineType = z.infer<typeof DeadlineTypeSchema>;

export const TimelineKindSchema = z.enum([
  "rent_demand_served",
  "petition_filed",
  "petition_served",
  "answer_due",
  "court_appearance",
  "adjournment",
  "judgment",
  "other",
]);
export type TimelineKind = z.infer<typeof TimelineKindSchema>;

export const MimeTypeSchema = z.enum([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
]);
export type MimeType = z.infer<typeof MimeTypeSchema>;

// ---------------------------------------------------------------------------
// Actor / provenance
// ---------------------------------------------------------------------------

export const ActorTypeSchema = z.enum([
  "tenant",
  "system",
  "attorney",
  "provider",
  "deterministic_engine",
]);

export const ActorSchema = z.object({
  actor_type: ActorTypeSchema,
  actor_id: z.string().nullable().optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

export const ProvenanceSourceSchema = z.enum([
  "llm_extraction",
  "llm_generation",
  "deterministic",
  "tenant_entered",
  "open_data",
  "system",
  "attorney_entered",
]);
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

/** Span / page / bbox within a source document, for citation. */
export const SourceLocatorSchema = z.object({
  page_number: z.number().int().min(1).nullable().optional(),
  start_char_index: z.number().int().min(0).nullable().optional(),
  end_char_index: z.number().int().min(0).nullable().optional(),
  /** [x0, y0, x1, y1] normalized 0..1 on the page, for vision-extracted fields. */
  bbox: z.array(z.number()).length(4).nullable().optional(),
  quote: z.string().nullable().optional(),
});
export type SourceLocator = z.infer<typeof SourceLocatorSchema>;

export const ProvenanceSchema = z.object({
  source: ProvenanceSourceSchema,
  model: ModelIdSchema.nullable().optional(),
  document_id: DocumentIdSchema.nullable().optional(),
  locator: SourceLocatorSchema.nullable().optional(),
  /** For source=open_data: dataset identifier. */
  dataset: z.string().nullable().optional(),
  dataset_version: z.string().nullable().optional(),
  extracted_at: TimestampSchema.nullable().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Generic wrapper for an LLM-extracted value needing tenant confirmation.
 * `value` type varies by field; `tenant_corrected_value` (when present) is
 * authoritative over `value`.
 */
export const ConfirmableValueSchema = z.object({
  value: z.unknown(),
  confidence: ConfidenceLevelSchema,
  tenant_confirmed: z.boolean().default(false),
  tenant_corrected_value: z.unknown().optional(),
  provenance: ProvenanceSchema,
});
export type ConfirmableValue = z.infer<typeof ConfirmableValueSchema>;

// ---------------------------------------------------------------------------
// Contact / consent / sensitive
// ---------------------------------------------------------------------------

export const PostalAddressSchema = z.object({
  line1: z.string().nullable().optional(),
  line2: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  postal_code: z
    .string()
    .regex(/^\d{5}(-\d{4})?$/)
    .nullable()
    .optional(),
});
export type PostalAddress = z.infer<typeof PostalAddressSchema>;

/** Minimal, data-minimized contact. Immigration status is NOT collected here. */
export const ContactSchema = z.object({
  full_name: z.string().nullable().optional(),
  preferred_name: z.string().nullable().optional(),
  phone_e164: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/)
    .nullable()
    .optional(),
  email: z.string().email().nullable().optional(),
  mailing_address: PostalAddressSchema.nullable().optional(),
  preferred_contact_method: z
    .enum(["sms", "email", "phone_call", "none"])
    .nullable()
    .optional(),
  /** DV/safety consideration. If false, SMS sends are suppressed. */
  safe_to_text: z.boolean().nullable().optional(),
});
export type Contact = z.infer<typeof ContactSchema>;

export const ConsentScopeSchema = z.enum([
  "handoff_to_provider",
  "court_filing_assistance",
  "benefits_screening_share",
  "sms_reminders",
  "store_sensitive_data",
]);
export type ConsentScope = z.infer<typeof ConsentScopeSchema>;

export const ConsentRecipientTypeSchema = z.enum([
  "legal_aid_provider",
  "court",
  "benefits_agency",
  "reminder_service",
  "attorney",
]);

export const ConsentDataCategorySchema = z.enum([
  "contact",
  "case_facts",
  "documents",
  "arrears",
  "eligibility",
  "immigration_status",
  "benefits_enrollment",
  "evidence",
]);

/**
 * One record per recipient. Per-recipient, time-limited, severable, voluntary,
 * written. NEVER names a landlord/agent (FCRA bar).
 */
export const ConsentSchema = z.object({
  consent_id: ConsentIdSchema,
  scope: ConsentScopeSchema,
  recipient: z.object({
    recipient_type: ConsentRecipientTypeSchema,
    recipient_id: z.string().nullable().optional(),
    recipient_name: z.string().nullable().optional(),
  }),
  /** True only on affirmative opt-in. Default-deny. */
  granted: z.boolean(),
  granted_at: TimestampSchema,
  expires_at: TimestampSchema.nullable().optional(),
  revoked_at: TimestampSchema.nullable().optional(),
  consent_text_version: z.string(),
  data_categories: z.array(ConsentDataCategorySchema).default([]),
  method: z
    .enum(["pwa_checkbox", "pwa_signature", "verbal_logged"])
    .default("pwa_checkbox"),
});
export type Consent = z.infer<typeof ConsentSchema>;

/**
 * Opt-in & severable sensitive data. Immigration is null by default and is only
 * collected when a specific defense needs it AND the tenant opted in via a
 * dedicated consent. Never furnished to landlords.
 */
export const SensitiveDataSchema = z.object({
  immigration: z
    .object({
      consent_id: ConsentIdSchema,
      status_relevant_to_defense: z.boolean().nullable().optional(),
      notes: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  benefits_enrollment: z
    .object({
      consent_id: ConsentIdSchema,
      programs: z.array(EligibilityProgramSchema).default([]),
    })
    .nullable()
    .optional(),
  /** Annual household income in cents. Used by DET RTC eligibility. Opt-in. */
  household_income_cents: z.number().int().min(0).nullable().optional(),
  household_size: z.number().int().min(1).nullable().optional(),
});
export type SensitiveData = z.infer<typeof SensitiveDataSchema>;

// ---------------------------------------------------------------------------
// Documents + extracted fields
// ---------------------------------------------------------------------------

export const StorageRefSchema = z.object({
  uri: z.string(),
  content_hash_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mime_type: MimeTypeSchema,
  byte_size: z.number().int().min(0).optional(),
  page_count: z.number().int().min(1).nullable().optional(),
});
export type StorageRef = z.infer<typeof StorageRefSchema>;

/**
 * LLM structured-output extraction. EVERY field is a ConfirmableValue. The
 * extracted court_date here is EXTRACTED ONLY — it is never the authoritative
 * date (that is DET-sourced onto `court`).
 */
export const ExtractedFieldsSchema = z.object({
  court_date: ConfirmableValueSchema.optional(),
  index_number: ConfirmableValueSchema.optional(),
  borough: ConfirmableValueSchema.optional(),
  claimed_arrears: ConfirmableValueSchema.optional(),
  landlord_name: ConfirmableValueSchema.optional(),
  petitioner_name: ConfirmableValueSchema.optional(),
  respondent_name: ConfirmableValueSchema.optional(),
  premises_address: ConfirmableValueSchema.optional(),
  apartment_unit: ConfirmableValueSchema.optional(),
  rent_demand_date: ConfirmableValueSchema.optional(),
  monthly_rent: ConfirmableValueSchema.optional(),
  petition_filed_date: ConfirmableValueSchema.optional(),
  service_date: ConfirmableValueSchema.optional(),
});
export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

export const DocumentSchema = z.object({
  document_id: DocumentIdSchema,
  document_type: DocumentTypeSchema,
  document_type_confidence: ConfidenceLevelSchema.optional(),
  storage_ref: StorageRefSchema,
  /** Full transcribed text from vision intake. */
  ocr_text: z.string().nullable().optional(),
  ocr_model: z.enum(["claude-opus-4-8", "claude-sonnet-4-6"]).nullable().optional(),
  extracted_fields: ExtractedFieldsSchema.optional(),
  uploaded_at: TimestampSchema,
  uploaded_by: ActorSchema.optional(),
});
export type Document = z.infer<typeof DocumentSchema>;

// ---------------------------------------------------------------------------
// Court / parties / property
// ---------------------------------------------------------------------------

/** Open-data assertion: stale data => tenant bears 22 NYCRR 130 risk. */
export const VerifyGateSchema = z.object({
  state: z.enum(["unverified", "verified", "disputed", "not_applicable"]),
  verified_at: TimestampSchema.nullable().optional(),
  verified_by: ActorSchema.nullable().optional(),
  tenant_note: z.string().nullable().optional(),
});
export type VerifyGate = z.infer<typeof VerifyGateSchema>;

export const OpenDataDatasetSchema = z.enum([
  "hpd_violations_wvxf-dwi5",
  "hpd_complaints_ygpa-z7cr",
  "hpd_registration_tesw-yqqr",
  "hpd_contacts_feu5-w2e2",
  "justfix_wow",
  "nyc_geosearch",
  "pluto_pad",
  "nycdb_selfhost",
]);
export type OpenDataDataset = z.infer<typeof OpenDataDatasetSchema>;

export const OpenDataAssertionSchema = z.object({
  dataset: OpenDataDatasetSchema,
  dataset_version: z.string(),
  retrieved_at: TimestampSchema.nullable().optional(),
  endpoint: z.string().nullable().optional(),
  /** Disclaimer shown to tenant; data may be stale and must be verified. */
  data_accuracy_disclaimer: z.string(),
  verify_before_file: VerifyGateSchema,
});
export type OpenDataAssertion = z.infer<typeof OpenDataAssertionSchema>;

/**
 * Court coordinates. The authoritative court_date is DET-sourced (eTrack /
 * NYSCEF) and is verified ONLY when so sourced — never trusted from the model.
 */
export const CourtSchema = z.object({
  county: CountySchema.nullable().optional(),
  borough: BoroughSchema.nullable().optional(),
  index_number: z.string().nullable().optional(),
  /** DET authoritative court date. The LLM-extracted value lives on the document. */
  court_date: DateSchema.nullable().optional(),
  court_date_source: z
    .enum(["etrack", "nyscef", "document_extracted_unverified", "tenant_entered"])
    .nullable()
    .optional(),
  /** True ONLY when sourced from eTrack/NYSCEF — never from a document extraction. */
  court_date_verified: z.boolean().default(false),
  part: z.string().nullable().optional(),
});
export type Court = z.infer<typeof CourtSchema>;

export const LandlordPartySchema = z.object({
  name: z.string().nullable().optional(),
  is_petitioner: z.boolean().nullable().optional(),
  attorney_name: z.string().nullable().optional(),
  /** open_data — carries disclaimer + verify gate. */
  registered_owner_name: z.string().nullable().optional(),
  wow_landlord_id: z.string().nullable().optional(),
  /** open_data registration-defense signal (expired/lapsed maps to false). */
  registration_on_file: z.boolean().nullable().optional(),
  open_data: OpenDataAssertionSchema.nullable().optional(),
});
export type LandlordParty = z.infer<typeof LandlordPartySchema>;

export const TenantPartySchema = z.object({
  name: z.string().nullable().optional(),
  is_respondent: z.boolean().nullable().optional(),
  matches_contact: z.boolean().nullable().optional(),
});
export type TenantParty = z.infer<typeof TenantPartySchema>;

export const PartiesSchema = z.object({
  landlord: LandlordPartySchema.optional(),
  tenant: TenantPartySchema.optional(),
});
export type Parties = z.infer<typeof PartiesSchema>;

export const PropertySchema = z.object({
  address: PostalAddressSchema.nullable().optional(),
  apartment_unit: z.string().nullable().optional(),
  /** DET: 10-digit Borough-Block-Lot from GeoSearch + PLUTO/PAD. */
  bbl: z
    .string()
    .regex(/^[1-5]\d{9}$/)
    .nullable()
    .optional(),
  bbl_resolved_via: z
    .enum(["geosearch_pluto", "geosearch_pad", "manual"])
    .nullable()
    .optional(),
  geo_confidence: z.enum(["exact", "approximate", "failed"]).nullable().optional(),
});
export type Property = z.infer<typeof PropertySchema>;

// ---------------------------------------------------------------------------
// Timeline + deadlines (deadlines are DET — hard invariant)
// ---------------------------------------------------------------------------

export const TimelineEventSchema = z.object({
  event_id: TimelineEventIdSchema,
  kind: TimelineKindSchema,
  date: DateSchema,
  /** true = DET/court-sourced (safe to rely on); false = LLM-extracted descriptive. */
  date_is_authoritative: z.boolean(),
  description: z.string(),
  deadline_id: DeadlineIdSchema.nullable().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const RiskFlagsSchema = z.object({
  is_imminent: z.boolean().default(false),
  is_missed: z.boolean().default(false),
  default_risk: z.boolean().default(false),
  uncertain_anchor: z.boolean().default(false),
});
export type RiskFlags = z.infer<typeof RiskFlagsSchema>;

/**
 * Safety-critical statutory clock. `computed_by` is a hard const "deterministic"
 * — the LLM may explain a deadline but never computes it as authoritative.
 */
export const DeadlineSchema = z.object({
  deadline_id: DeadlineIdSchema,
  deadline_type: DeadlineTypeSchema,
  due_date: DateSchema,
  /** Hard invariant: never "llm". */
  computed_by: z.literal("deterministic"),
  computation_basis: z
    .object({
      anchor_event: z.string().nullable().optional(),
      anchor_date: DateSchema.nullable().optional(),
      statute_rule_id: z.string().nullable().optional(),
      rule_version: z.string().nullable().optional(),
    })
    .optional(),
  /** Human-confirmed gate. */
  tenant_confirmed: z.boolean().default(false),
  attorney_validated: z.boolean().default(false),
  risk: RiskFlagsSchema,
  /** LLM plain-English explanation — NOT the computation. */
  explanation: z.string().nullable().optional(),
});
export type Deadline = z.infer<typeof DeadlineSchema>;

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Typed, tagged evidence. Open-data-derived items MUST carry an `open_data`
 * assertion with a verify_before_file gate.
 */
export const EvidenceItemSchema = z
  .object({
    evidence_id: EvidenceIdSchema,
    evidence_type: EvidenceTypeSchema,
    origin: z.enum(["tenant_uploaded", "open_data", "tenant_stated"]),
    document_id: DocumentIdSchema.nullable().optional(),
    tags: z.array(z.string()).default([]),
    summary: z.string().nullable().optional(),
    /** Information-not-advice mapping of evidence to candidate defenses. */
    supports_defense_codes: z.array(DefenseCodeSchema).default([]),
    open_data: OpenDataAssertionSchema.nullable().optional(),
  })
  .refine(
    (item) => item.origin !== "open_data" || item.open_data != null,
    { message: "open_data evidence must carry an open_data assertion", path: ["open_data"] },
  );
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

// ---------------------------------------------------------------------------
// Answer draft (faithful transcription) + defenses checklist (information)
// ---------------------------------------------------------------------------

/** Faithful transcription only — transcription_only is a hard const true. */
export const FactualStatementSchema = z.object({
  statement_id: StatementIdSchema,
  text: z.string(),
  source_language: z.string().nullable().optional(),
  tenant_confirmed: z.boolean().default(false),
  /** Hard invariant: faithful transcription, never legal advice or conclusion. */
  transcription_only: z.literal(true),
  provenance: ProvenanceSchema.optional(),
});
export type FactualStatement = z.infer<typeof FactualStatementSchema>;

/** DET mapping of confirmed facts to official NY fillable-PDF form fields. */
export const FormFieldSchema = z.object({
  form_field_id: z.string(),
  value: z.unknown(),
  /** Hard invariant: placement/validation is deterministic, never LLM. */
  placed_by: z.literal("deterministic"),
  validation_state: z.enum(["valid", "invalid", "missing_required", "pending"]),
  validation_message: z.string().nullable().optional(),
});
export type FormField = z.infer<typeof FormFieldSchema>;

export const AnswerDraftStatusSchema = z.enum([
  "draft",
  "tenant_reviewed",
  "attorney_reviewed",
  "finalized",
]);
export type AnswerDraftStatus = z.infer<typeof AnswerDraftStatusSchema>;

export const AnswerDraftSchema = z.object({
  answer_draft_id: AnswerDraftIdSchema.nullable().optional(),
  /** Tenant's selection — NOT an LLM legal conclusion. */
  general_denial: z.boolean().nullable().optional(),
  factual_statements: z.array(FactualStatementSchema).default([]),
  form_fields: z.array(FormFieldSchema).default([]),
  status: AnswerDraftStatusSchema.default("draft"),
});
export type AnswerDraft = z.infer<typeof AnswerDraftSchema>;

/**
 * Information, not advice. `surfaced_as` is a hard const. Surfacing a possible
 * defense is information; asserting it / saying the tenant "has a case" is the
 * advice line — attorney-owned.
 */
export const DefenseChecklistItemSchema = z.object({
  defense_code: DefenseCodeSchema,
  /** Hard invariant. This item informs; it does not advise or conclude. */
  surfaced_as: z.literal("information_not_advice"),
  relevance_signal: z
    .enum(["possible", "evidence_present", "not_indicated"])
    .nullable()
    .optional(),
  supporting_evidence_ids: z.array(EvidenceIdSchema).default([]),
  /** LLM plain-English description of what this defense is (general info). */
  explanation: z.string().nullable().optional(),
  attorney_reviewed: z.boolean().default(false),
  /** Attorney-only field — the advice line. */
  attorney_disposition: z
    .enum(["applicable", "not_applicable", "needs_more_info"])
    .nullable()
    .optional(),
});
export type DefenseChecklistItem = z.infer<typeof DefenseChecklistItemSchema>;

// ---------------------------------------------------------------------------
// Eligibility (lite) — determined_by is a hard const "deterministic"
// ---------------------------------------------------------------------------

export const EligibilityDeterminationSchema = z.enum([
  "eligible",
  "ineligible",
  "likely_eligible",
  "insufficient_data",
  "program_unavailable",
]);
export type EligibilityDetermination = z.infer<
  typeof EligibilityDeterminationSchema
>;

export const EligibilityResultSchema = z.object({
  program: EligibilityProgramSchema.nullable().optional(),
  determination: EligibilityDeterminationSchema,
  /** Hard invariant: eligibility is never an LLM conclusion. */
  determined_by: z.literal("deterministic"),
  rule_ids: z.array(z.string()).default([]),
  reasons: z.array(z.string()).default([]),
  data_source: z
    .enum(["nyc_benefits_screening_api", "internal_rules"])
    .nullable()
    .optional(),
  config_toggle_state: z.enum(["enabled", "disabled"]).nullable().optional(),
});
export type EligibilityResult = z.infer<typeof EligibilityResultSchema>;

export const EligibilitySchema = z.object({
  rtc: EligibilityResultSchema.optional(),
  legal_aid: EligibilityResultSchema.optional(),
  rental_assistance: EligibilityResultSchema.optional(),
  rental_assistance_programs: z.array(EligibilityResultSchema).default([]),
  config_version: z.string().nullable().optional(),
  evaluated_at: TimestampSchema.nullable().optional(),
});
export type Eligibility = z.infer<typeof EligibilitySchema>;

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export const ReminderSchema = z.object({
  reminder_id: ReminderIdSchema,
  channel: z.enum(["sms", "email", "push"]),
  /** Each reminder ties to a consent with scope=sms_reminders. */
  consent_id: ConsentIdSchema,
  reminder_type: z
    .enum(["court_date", "answer_deadline", "document_request", "appointment", "other"])
    .optional(),
  related_deadline_id: DeadlineIdSchema.nullable().optional(),
  /** DET-computed send time relative to an authoritative deadline/court date. */
  scheduled_for: TimestampSchema,
  state: z.enum(["scheduled", "sent", "failed", "cancelled"]),
  sent_at: TimestampSchema.nullable().optional(),
});
export type Reminder = z.infer<typeof ReminderSchema>;

// ---------------------------------------------------------------------------
// Review (advice routing) — the human-handoff backstop
// ---------------------------------------------------------------------------

export const AttorneyReviewSchema = z.object({
  assigned_attorney_id: AttorneyIdSchema.nullable().optional(),
  review_state: z
    .enum(["unassigned", "queued", "in_review", "reviewed", "escalated"])
    .default("unassigned"),
  /**
   * DET decision: true when an advice-seeking turn was detected and hard-routed
   * to a human. The classification is LLM; the routing decision is DET.
   */
  advice_routed: z.boolean().default(false),
  advice_detection_log: z
    .array(
      z.object({
        at: TimestampSchema,
        classifier_model: ModelIdSchema,
        is_advice_seeking: z.boolean(),
        confidence: ConfidenceLevelSchema,
      }),
    )
    .default([]),
  triage_score: z
    .object({
      score: z.number(),
      model: ModelIdSchema,
      rationale: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type AttorneyReview = z.infer<typeof AttorneyReviewSchema>;

// ---------------------------------------------------------------------------
// Status transitions + audit
// ---------------------------------------------------------------------------

export const StatusTransitionSchema = z.object({
  from_status: CaseStatusSchema.nullable(),
  to_status: CaseStatusSchema,
  at: TimestampSchema,
  actor: ActorSchema,
  reason: z.string().nullable().optional(),
});
export type StatusTransition = z.infer<typeof StatusTransitionSchema>;

export const AuditSchema = z.object({
  created_by: ActorSchema,
  legal_hold: z.boolean().default(false),
  data_retention_class: z
    .enum(["standard", "minimized", "sensitive"])
    .nullable()
    .optional(),
  events: z
    .array(
      z.object({
        at: TimestampSchema,
        actor: ActorSchema,
        action: z.string(),
        field_path: z.string().nullable().optional(),
        model: ModelIdSchema.nullable().optional(),
      }),
    )
    .default([]),
});
export type Audit = z.infer<typeof AuditSchema>;

// ---------------------------------------------------------------------------
// Root Case Object
// ---------------------------------------------------------------------------

export const CaseSchema = z.object({
  case_id: CaseIdSchema,
  schema_version: z.literal("1.0.0"),
  tenant_id: TenantIdSchema,
  tenant_account_id: AccountIdSchema.nullable().optional(),

  case_type: CaseTypeSchema,
  case_type_confidence: ConfidenceLevelSchema.optional(),
  case_type_confirmed: z.boolean().default(false),

  status: CaseStatusSchema,
  status_history: z.array(StatusTransitionSchema).default([]),

  /** BCP-47 preferred UI/output language. */
  language: z.string().default("en"),

  contact: ContactSchema.optional(),
  consents: z.array(ConsentSchema).default([]),
  sensitive: SensitiveDataSchema.optional(),

  documents: z.array(DocumentSchema).default([]),

  court: CourtSchema.optional(),
  parties: PartiesSchema.optional(),
  /** Total arrears the petition claims. Money format only. */
  claimed_arrears: MoneySchema.nullable().optional(),
  property: PropertySchema.optional(),

  timeline: z.array(TimelineEventSchema).default([]),
  deadlines: z.array(DeadlineSchema).default([]),

  evidence: z.array(EvidenceItemSchema).default([]),

  answer_draft: AnswerDraftSchema.optional(),
  defenses_checklist: z.array(DefenseChecklistItemSchema).default([]),

  eligibility: EligibilitySchema.optional(),
  reminders: z.array(ReminderSchema).default([]),

  review: AttorneyReviewSchema.optional(),

  created_at: TimestampSchema,
  updated_at: TimestampSchema,
  audit: AuditSchema,
});
export type Case = z.infer<typeof CaseSchema>;

/** The current schema version this build of the Case Object targets. */
export const CASE_SCHEMA_VERSION = "1.0.0" as const;
