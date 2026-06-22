# Canonical Case Object (the spine)

> Every other spec in `spec/` references these exact field names. This is the single shared data model for the MVP (NYC nonpayment).

## Canonical Case Object — `housing_court_copilot.case` (v1, MVP: NYC nonpayment)

The Case Object is the single shared spine. Every other spec (LLM extraction schemas, deterministic tool I/O, API payloads, provider handoff) references these exact `snake_case` field names. The root object is `case`.

### Provenance legend (used in field tables and glossary)

| Code | Meaning | Trust gate |
|---|---|---|
| `LLM` | LLM-extracted/generated (Opus 4.8 default; Haiku 4.5 cheap classify; Sonnet 4.6 middle). **Never authoritative** — must carry `confidence` and be tenant-confirmed before any filing use. | requires `tenant_confirmed = true` to leave `draft` |
| `DET` | Deterministic code only. Safety-critical: deadlines, eligibility, form placement/validation, court-date sourcing, the advice line. The LLM may extract/explain but never compute these as authoritative. | attorney-validated logic; human-confirmed |
| `TEN` | Tenant-entered directly (typed/selected in PWA). | self-asserted |
| `SYS` | System-generated (ids, timestamps, status transitions, hashes). | n/a |
| `TENANT` (open-data) | Derived from external open data (HPD/JustFix/GeoSearch). Carries `data_accuracy_disclaimer` + `verify_before_file` gate; tenant bears 22 NYCRR 130 risk. | never auto-asserted into a filing |

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://housingcourtcopilot.org/schemas/case.v1.json",
  "title": "HousingCourtCopilotCase",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "case_id", "schema_version", "tenant_id", "case_type",
    "status", "created_at", "updated_at", "audit"
  ],
  "properties": {
    "case_id": {
      "type": "string",
      "pattern": "^case_[0-9a-hjkmnp-tv-z]{26}$",
      "description": "SYS. Canonical case identifier. Prefix 'case_' + 26-char Crockford base32 ULID.",
      "x-provenance": "SYS"
    },
    "schema_version": {
      "type": "string",
      "const": "1.0.0",
      "description": "SYS. Semantic version of this Case Object schema.",
      "x-provenance": "SYS"
    },
    "tenant_id": {
      "type": "string",
      "pattern": "^ten_[0-9a-hjkmnp-tv-z]{26}$",
      "description": "SYS. FK to the tenant/contact subject of this case.",
      "x-provenance": "SYS"
    },
    "tenant_account_id": {
      "type": ["string", "null"],
      "pattern": "^acct_[0-9a-hjkmnp-tv-z]{26}$",
      "description": "SYS. FK to the authenticated PWA account, if the tenant created one. Null for anonymous/guest sessions.",
      "x-provenance": "SYS"
    },

    "case_type": {
      "$ref": "#/$defs/CaseType",
      "description": "LLM-classified then tenant-confirmed. MVP authoritative value is 'nonpayment'. Classification is information, not the advice line; the supervising attorney owns reclassification.",
      "x-provenance": "LLM"
    },
    "case_type_confidence": {
      "$ref": "#/$defs/ConfidenceLevel",
      "description": "LLM. Classifier confidence for case_type.",
      "x-provenance": "LLM"
    },
    "case_type_confirmed": {
      "type": "boolean",
      "default": false,
      "description": "TEN. True once the tenant confirms the classified case type.",
      "x-provenance": "TEN"
    },

    "status": {
      "$ref": "#/$defs/CaseStatus",
      "description": "DET. State machine: intake -> prepared -> referred -> represented -> resolved. Transitions are computed/guarded by deterministic code, never set by the LLM.",
      "x-provenance": "DET"
    },
    "status_history": {
      "type": "array",
      "description": "SYS. Append-only log of status transitions.",
      "items": { "$ref": "#/$defs/StatusTransition" }
    },

    "language": {
      "type": "string",
      "description": "TEN. BCP-47 tag of the tenant's preferred UI/output language (e.g. 'en', 'es', 'zh-Hant', 'ht', 'bn', 'ru', 'ar', 'ko').",
      "default": "en",
      "x-provenance": "TEN"
    },

    "contact": { "$ref": "#/$defs/Contact" },
    "consents": {
      "type": "array",
      "description": "TEN. Per-recipient, time-limited, severable, voluntary written consents. Each handoff requires its own record.",
      "items": { "$ref": "#/$defs/Consent" }
    },
    "sensitive": { "$ref": "#/$defs/SensitiveData" },

    "documents": {
      "type": "array",
      "description": "Uploaded source docs with OCR text + extracted fields. Each extracted field carries confidence, tenant_confirmed, and provenance for citations.",
      "items": { "$ref": "#/$defs/Document" }
    },

    "court": { "$ref": "#/$defs/Court" },
    "parties": { "$ref": "#/$defs/Parties" },
    "claimed_arrears": {
      "anyOf": [{ "$ref": "#/$defs/Money" }, { "type": "null" }],
      "description": "LLM-extracted, tenant-confirmed. Total arrears the petition claims. Money format only.",
      "x-provenance": "LLM"
    },
    "property": { "$ref": "#/$defs/Property" },

    "timeline": {
      "type": "array",
      "description": "Plain-English case timeline. Date values are DET-computed where authoritative (deadlines) and LLM-extracted where descriptive (events on the documents). Each entry flags which.",
      "items": { "$ref": "#/$defs/TimelineEvent" }
    },
    "deadlines": {
      "type": "array",
      "description": "DET. Derived, safety-critical statutory clocks. computed_by is ALWAYS 'deterministic'. Human-confirmed, attorney-validated.",
      "items": { "$ref": "#/$defs/Deadline" }
    },

    "evidence": {
      "type": "array",
      "description": "Typed, tagged evidence. Open-data-derived items carry data_accuracy_disclaimer + verify_before_file gate + source dataset/version.",
      "items": { "$ref": "#/$defs/EvidenceItem" }
    },

    "answer_draft": { "$ref": "#/$defs/AnswerDraft" },
    "defenses_checklist": {
      "type": "array",
      "description": "Information-not-advice. Surfaces possible defenses for human review; each item carries attorney_reviewed. Selecting/asserting a defense is the advice line and is DET-gated + attorney-owned.",
      "items": { "$ref": "#/$defs/DefenseChecklistItem" }
    },

    "eligibility": { "$ref": "#/$defs/Eligibility" },
    "packets": { "$ref": "#/$defs/Packets" },
    "reminders": {
      "type": "array",
      "description": "Opt-in SMS/notification reminders. Each requires a consent_id and is consent-logged.",
      "items": { "$ref": "#/$defs/Reminder" }
    },

    "review": { "$ref": "#/$defs/AttorneyReview" },

    "created_at": { "$ref": "#/$defs/Timestamp", "x-provenance": "SYS" },
    "updated_at": { "$ref": "#/$defs/Timestamp", "x-provenance": "SYS" },
    "audit": { "$ref": "#/$defs/Audit" }
  },

  "$defs": {
    "Timestamp": {
      "type": "string",
      "format": "date-time",
      "description": "RFC 3339 / ISO-8601 UTC instant, 'Z'-suffixed (e.g. 2026-06-22T14:05:00Z)."
    },
    "Date": {
      "type": "string",
      "format": "date",
      "description": "ISO-8601 calendar date YYYY-MM-DD. No time component. Court/America-New_York local calendar date."
    },
    "ConfidenceLevel": {
      "type": "string",
      "enum": ["high", "medium", "low", "unreadable"],
      "description": "LLM extraction/classification confidence band. 'unreadable' = OCR/vision could not extract."
    },

    "Money": {
      "type": "object",
      "additionalProperties": false,
      "required": ["amount_cents", "currency"],
      "properties": {
        "amount_cents": {
          "type": "integer",
          "minimum": 0,
          "description": "Integer minor units (USD cents). NEVER a float. $1,234.56 -> 123456."
        },
        "currency": { "type": "string", "const": "USD" }
      }
    },

    "Provenance": {
      "type": "object",
      "additionalProperties": false,
      "required": ["source"],
      "description": "Source location for a value, supporting citations and the LLM/DET boundary audit.",
      "properties": {
        "source": {
          "type": "string",
          "enum": ["llm_extraction", "llm_generation", "deterministic", "tenant_entered", "open_data", "system", "attorney_entered"]
        },
        "model": {
          "type": ["string", "null"],
          "enum": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", null],
          "description": "For source in {llm_extraction, llm_generation}: the exact model id used."
        },
        "document_id": {
          "type": ["string", "null"],
          "pattern": "^doc_[0-9a-hjkmnp-tv-z]{26}$",
          "description": "Document this value was extracted from, if any."
        },
        "locator": {
          "anyOf": [{ "$ref": "#/$defs/SourceLocator" }, { "type": "null" }],
          "description": "Span/page/bbox within the source document, for citation (page_location / char_location style)."
        },
        "dataset": {
          "type": ["string", "null"],
          "description": "For source=open_data: dataset identifier (e.g. 'hpd_violations_wvxf-dwi5')."
        },
        "dataset_version": {
          "type": ["string", "null"],
          "description": "For source=open_data: snapshot/ingest timestamp or version of the dataset."
        },
        "extracted_at": { "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }] }
      }
    },
    "SourceLocator": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "page_number": { "type": ["integer", "null"], "minimum": 1, "description": "1-indexed PDF page." },
        "start_char_index": { "type": ["integer", "null"], "minimum": 0 },
        "end_char_index": { "type": ["integer", "null"], "minimum": 0 },
        "bbox": {
          "type": ["array", "null"],
          "items": { "type": "number" },
          "minItems": 4,
          "maxItems": 4,
          "description": "[x0, y0, x1, y1] normalized 0..1 on the page, for vision-extracted fields."
        },
        "quote": { "type": ["string", "null"], "description": "Verbatim cited text from the source." }
      }
    },

    "ConfirmableValue": {
      "type": "object",
      "additionalProperties": false,
      "description": "Generic wrapper for an LLM-extracted value needing tenant confirmation. Used by extracted document fields.",
      "required": ["value", "confidence", "tenant_confirmed", "provenance"],
      "properties": {
        "value": { "description": "The extracted value (type varies by field)." },
        "confidence": { "$ref": "#/$defs/ConfidenceLevel" },
        "tenant_confirmed": { "type": "boolean", "default": false },
        "tenant_corrected_value": { "description": "Tenant override; when present this is authoritative over value." },
        "provenance": { "$ref": "#/$defs/Provenance" }
      }
    },

    "CaseType": {
      "type": "string",
      "enum": ["nonpayment", "holdover", "illegal_lockout", "hp_action", "other", "unknown"],
      "description": "MVP processes only 'nonpayment' end-to-end. Other values route to human triage."
    },
    "CaseStatus": {
      "type": "string",
      "enum": ["intake", "prepared", "referred", "represented", "resolved"],
      "description": "From PLAN.md state machine."
    },
    "StatusTransition": {
      "type": "object",
      "additionalProperties": false,
      "required": ["from_status", "to_status", "at", "actor"],
      "properties": {
        "from_status": { "anyOf": [{ "$ref": "#/$defs/CaseStatus" }, { "type": "null" }] },
        "to_status": { "$ref": "#/$defs/CaseStatus" },
        "at": { "$ref": "#/$defs/Timestamp" },
        "actor": { "$ref": "#/$defs/Actor" },
        "reason": { "type": ["string", "null"] }
      }
    },
    "Actor": {
      "type": "object",
      "additionalProperties": false,
      "required": ["actor_type"],
      "properties": {
        "actor_type": { "type": "string", "enum": ["tenant", "system", "attorney", "provider", "deterministic_engine"] },
        "actor_id": { "type": ["string", "null"] }
      }
    },

    "Contact": {
      "type": "object",
      "additionalProperties": false,
      "description": "Identity & contact. Data-minimized: collect only what intake + reminders need.",
      "properties": {
        "full_name": { "type": ["string", "null"], "x-provenance": "TEN" },
        "preferred_name": { "type": ["string", "null"], "x-provenance": "TEN" },
        "phone_e164": {
          "type": ["string", "null"],
          "pattern": "^\\+[1-9]\\d{1,14}$",
          "description": "TEN. E.164. Used for SMS reminders (requires consent).",
          "x-provenance": "TEN"
        },
        "email": { "type": ["string", "null"], "format": "email", "x-provenance": "TEN" },
        "mailing_address": { "anyOf": [{ "$ref": "#/$defs/PostalAddress" }, { "type": "null" }] },
        "preferred_contact_method": {
          "type": ["string", "null"],
          "enum": ["sms", "email", "phone_call", "none", null],
          "x-provenance": "TEN"
        },
        "safe_to_text": {
          "type": ["boolean", "null"],
          "description": "TEN. Whether SMS to phone_e164 is safe (DV/safety consideration).",
          "x-provenance": "TEN"
        }
      }
    },
    "PostalAddress": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "line1": { "type": ["string", "null"] },
        "line2": { "type": ["string", "null"] },
        "city": { "type": ["string", "null"] },
        "state": { "type": ["string", "null"], "description": "USPS 2-letter; MVP 'NY'." },
        "postal_code": { "type": ["string", "null"], "pattern": "^\\d{5}(-\\d{4})?$" }
      }
    },

    "Consent": {
      "type": "object",
      "additionalProperties": false,
      "description": "TEN. One record per recipient. Per-recipient, time-limited, severable, voluntary, written.",
      "required": ["consent_id", "scope", "recipient", "granted", "granted_at", "consent_text_version"],
      "properties": {
        "consent_id": { "type": "string", "pattern": "^cns_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
        "scope": { "$ref": "#/$defs/ConsentScope" },
        "recipient": {
          "type": "object",
          "additionalProperties": false,
          "required": ["recipient_type"],
          "description": "The single, specific recipient this consent authorizes. NEVER a landlord/agent (FCRA).",
          "properties": {
            "recipient_type": { "type": "string", "enum": ["legal_aid_provider", "court", "benefits_agency", "reminder_service", "attorney"] },
            "recipient_id": { "type": ["string", "null"], "description": "e.g. provider_id (prv_...)." },
            "recipient_name": { "type": ["string", "null"] }
          }
        },
        "granted": { "type": "boolean", "description": "True only on affirmative opt-in. Default-deny." },
        "granted_at": { "$ref": "#/$defs/Timestamp" },
        "expires_at": {
          "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }],
          "description": "Time-limited. Consent is invalid past this instant."
        },
        "revoked_at": { "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }], "description": "Severable: revoking one does not affect others." },
        "consent_text_version": { "type": "string", "description": "Version of the consent language the tenant agreed to (for legal record)." },
        "data_categories": {
          "type": "array",
          "description": "Severable per-category list of what this consent covers (data minimization).",
          "items": { "type": "string", "enum": ["contact", "case_facts", "documents", "arrears", "eligibility", "immigration_status", "benefits_enrollment", "evidence"] }
        },
        "method": { "type": "string", "enum": ["pwa_checkbox", "pwa_signature", "verbal_logged"], "default": "pwa_checkbox" }
      }
    },
    "ConsentScope": {
      "type": "string",
      "enum": ["handoff_to_provider", "court_filing_assistance", "benefits_screening_share", "sms_reminders", "store_sensitive_data"],
      "description": "What the consent authorizes. One scope per consent record where practical."
    },

    "SensitiveData": {
      "type": "object",
      "additionalProperties": false,
      "description": "Opt-in & severable. SHIELD Act + immigration exposure: do NOT collect unless a specific defense/benefit needs it, and only with a matching consent (scope=store_sensitive_data).",
      "properties": {
        "immigration": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["consent_id"],
              "properties": {
                "consent_id": { "type": "string", "pattern": "^cns_[0-9a-hjkmnp-tv-z]{26}$", "description": "Required: severable consent gating this field." },
                "status_relevant_to_defense": { "type": ["boolean", "null"], "description": "Whether collected at all is justified by a specific defense." },
                "notes": { "type": ["string", "null"], "x-provenance": "TEN" }
              }
            },
            { "type": "null" }
          ],
          "description": "Null unless a specific defense requires it AND tenant opted in. Never furnished to landlords."
        },
        "benefits_enrollment": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["consent_id"],
              "properties": {
                "consent_id": { "type": "string", "pattern": "^cns_[0-9a-hjkmnp-tv-z]{26}$" },
                "programs": { "type": "array", "items": { "$ref": "#/$defs/EligibilityProgram" }, "x-provenance": "TEN" }
              }
            },
            { "type": "null" }
          ]
        },
        "household_income_cents": {
          "type": ["integer", "null"],
          "minimum": 0,
          "description": "TEN. Annual household income in cents. Used by DET eligibility (RTC <=200% FPL). Opt-in.",
          "x-provenance": "TEN"
        },
        "household_size": { "type": ["integer", "null"], "minimum": 1, "x-provenance": "TEN" }
      }
    },

    "Document": {
      "type": "object",
      "additionalProperties": false,
      "required": ["document_id", "document_type", "storage_ref", "uploaded_at"],
      "properties": {
        "document_id": { "type": "string", "pattern": "^doc_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
        "document_type": { "$ref": "#/$defs/DocumentType", "description": "LLM-classified, tenant-confirmable." },
        "document_type_confidence": { "$ref": "#/$defs/ConfidenceLevel" },
        "storage_ref": {
          "type": "object",
          "additionalProperties": false,
          "required": ["uri", "content_hash_sha256", "mime_type"],
          "description": "SYS. Raw upload reference.",
          "properties": {
            "uri": { "type": "string", "description": "Object-store URI of the raw upload." },
            "content_hash_sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
            "mime_type": { "type": "string", "enum": ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/webp"] },
            "byte_size": { "type": "integer", "minimum": 0 },
            "page_count": { "type": ["integer", "null"], "minimum": 1 }
          }
        },
        "ocr_text": {
          "type": ["string", "null"],
          "description": "LLM (vision intake) full transcribed text of the document.",
          "x-provenance": "LLM"
        },
        "ocr_model": { "type": ["string", "null"], "enum": ["claude-opus-4-8", "claude-sonnet-4-6", null] },
        "extracted_fields": {
          "type": "object",
          "additionalProperties": false,
          "description": "LLM structured-output extraction. EVERY field is a ConfirmableValue (confidence + tenant_confirmed + provenance). Authoritative dates/eligibility are NOT derived here — they are recomputed deterministically.",
          "properties": {
            "court_date": { "$ref": "#/$defs/ConfirmableValue", "description": "value: Date. EXTRACTED only; deadline computation is deterministic." },
            "index_number": { "$ref": "#/$defs/ConfirmableValue", "description": "value: string (LT index format)." },
            "borough": { "$ref": "#/$defs/ConfirmableValue", "description": "value: Borough enum." },
            "claimed_arrears": { "$ref": "#/$defs/ConfirmableValue", "description": "value: Money." },
            "landlord_name": { "$ref": "#/$defs/ConfirmableValue", "description": "value: string." },
            "petitioner_name": { "$ref": "#/$defs/ConfirmableValue", "description": "value: string." },
            "respondent_name": { "$ref": "#/$defs/ConfirmableValue", "description": "value: string." },
            "premises_address": { "$ref": "#/$defs/ConfirmableValue", "description": "value: PostalAddress." },
            "apartment_unit": { "$ref": "#/$defs/ConfirmableValue", "description": "value: string." },
            "rent_demand_date": { "$ref": "#/$defs/ConfirmableValue", "description": "value: Date." },
            "monthly_rent": { "$ref": "#/$defs/ConfirmableValue", "description": "value: Money." },
            "petition_filed_date": { "$ref": "#/$defs/ConfirmableValue", "description": "value: Date." },
            "service_date": { "$ref": "#/$defs/ConfirmableValue", "description": "value: Date." }
          }
        },
        "uploaded_at": { "$ref": "#/$defs/Timestamp", "x-provenance": "SYS" },
        "uploaded_by": { "$ref": "#/$defs/Actor" }
      }
    },
    "DocumentType": {
      "type": "string",
      "enum": ["summons_petition", "rent_demand", "notice_of_petition", "lease", "rent_ledger", "rent_receipt", "repair_evidence", "correspondence", "court_notice", "other", "unknown"]
    },

    "Court": {
      "type": "object",
      "additionalProperties": false,
      "description": "Court coordinates. court_date is DET-sourced (eTrack/NYSCEF), never the LLM-extracted value, for authoritative use.",
      "properties": {
        "county": {
          "type": ["string", "null"],
          "enum": ["New York", "Bronx", "Kings", "Queens", "Richmond", null],
          "description": "DET-validated. NYC county name."
        },
        "borough": { "anyOf": [{ "$ref": "#/$defs/Borough" }, { "type": "null" }], "description": "DET-validated borough." },
        "index_number": {
          "type": ["string", "null"],
          "description": "LLM-extracted + tenant-confirmed; cross-checked against NYSCEF docket where available.",
          "x-provenance": "LLM"
        },
        "court_date": {
          "anyOf": [{ "$ref": "#/$defs/Date" }, { "type": "null" }],
          "description": "DET. Authoritative court date from court-date sourcing (eTrack email ingest / NYSCEF public docket). The LLM-extracted court_date lives on the document, not here.",
          "x-provenance": "DET"
        },
        "court_date_source": {
          "type": ["string", "null"],
          "enum": ["etrack", "nyscef", "document_extracted_unverified", "tenant_entered", null],
          "description": "DET. Provenance of court_date. 'document_extracted_unverified' must not be treated as authoritative."
        },
        "court_date_verified": {
          "type": "boolean",
          "default": false,
          "description": "DET. True only when sourced from eTrack/NYSCEF (not from a document extraction)."
        },
        "part": { "type": ["string", "null"], "description": "DET/SYS. Court part/room if known." }
      }
    },
    "Borough": {
      "type": "string",
      "enum": ["manhattan", "bronx", "brooklyn", "queens", "staten_island"]
    },

    "Parties": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "landlord": { "$ref": "#/$defs/LandlordParty" },
        "tenant": { "$ref": "#/$defs/TenantParty" }
      }
    },
    "LandlordParty": {
      "type": "object",
      "additionalProperties": false,
      "description": "Petitioner/landlord. Names LLM-extracted+confirmed; ownership/standing signals DET from JustFix WoW / HPD registration (open-data, verify_before_file).",
      "properties": {
        "name": { "type": ["string", "null"], "x-provenance": "LLM" },
        "is_petitioner": { "type": ["boolean", "null"] },
        "attorney_name": { "type": ["string", "null"], "x-provenance": "LLM" },
        "registered_owner_name": {
          "type": ["string", "null"],
          "description": "TENANT(open-data). From HPD Registration+Contacts. Carries disclaimer + verify gate.",
          "x-provenance": "open_data"
        },
        "wow_landlord_id": {
          "type": ["string", "null"],
          "description": "TENANT(open-data). JustFix Who Owns What landlord identifier.",
          "x-provenance": "open_data"
        },
        "registration_on_file": {
          "type": ["boolean", "null"],
          "description": "TENANT(open-data). Whether a CURRENT, valid HPD registration exists (registration-defense signal). Per the lookup_hpd_registration mapping, an on-file-but-expired/lapsed registration maps to false (no current registration), with the expired-vs-absent reason preserved in the open_data disclaimer/explanation. A canonical registration_status enum is a recommended v1.1 addition.",
          "x-provenance": "open_data"
        },
        "open_data": { "anyOf": [{ "$ref": "#/$defs/OpenDataAssertion" }, { "type": "null" }] }
      }
    },
    "TenantParty": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "name": { "type": ["string", "null"], "x-provenance": "LLM" },
        "is_respondent": { "type": ["boolean", "null"] },
        "matches_contact": { "type": ["boolean", "null"], "description": "TEN. Tenant confirms the named respondent is them." }
      }
    },

    "Property": {
      "type": "object",
      "additionalProperties": false,
      "description": "Premises. Address resolved via NYC GeoSearch -> BBL (DET, not legacy Geoclient).",
      "properties": {
        "address": { "anyOf": [{ "$ref": "#/$defs/PostalAddress" }, { "type": "null" }], "x-provenance": "LLM" },
        "apartment_unit": { "type": ["string", "null"], "x-provenance": "LLM" },
        "bbl": {
          "type": ["string", "null"],
          "pattern": "^[1-5]\\d{9}$",
          "description": "DET. 10-digit Borough-Block-Lot from GeoSearch + PLUTO/PAD.",
          "x-provenance": "deterministic"
        },
        "bbl_resolved_via": { "type": ["string", "null"], "enum": ["geosearch_pluto", "geosearch_pad", "manual", null] },
        "geo_confidence": { "type": ["string", "null"], "enum": ["exact", "approximate", "failed", null] }
      }
    },

    "TimelineEvent": {
      "type": "object",
      "additionalProperties": false,
      "required": ["event_id", "kind", "date", "date_is_authoritative", "description"],
      "properties": {
        "event_id": { "type": "string", "pattern": "^evt_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
        "kind": { "type": "string", "enum": ["rent_demand_served", "petition_filed", "petition_served", "answer_due", "court_appearance", "adjournment", "judgment", "other"] },
        "date": { "$ref": "#/$defs/Date" },
        "date_is_authoritative": {
          "type": "boolean",
          "description": "True = DET-computed/court-sourced date. False = LLM-extracted, descriptive only, not safe to file on."
        },
        "description": { "type": "string", "description": "LLM plain-English explanation of the event.", "x-provenance": "LLM" },
        "deadline_id": { "type": ["string", "null"], "pattern": "^dl_[0-9a-hjkmnp-tv-z]{26}$", "description": "FK to a Deadline when this event represents a statutory clock." }
      }
    },

    "Deadline": {
      "type": "object",
      "additionalProperties": false,
      "required": ["deadline_id", "deadline_type", "due_date", "computed_by", "tenant_confirmed", "risk"],
      "description": "Safety-critical. Wrong-deadline = malpractice-style liability. computed_by is ALWAYS deterministic.",
      "properties": {
        "deadline_id": { "type": "string", "pattern": "^dl_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
        "deadline_type": { "$ref": "#/$defs/DeadlineType" },
        "due_date": { "$ref": "#/$defs/Date", "description": "DET-computed authoritative due date (court-local calendar)." },
        "computed_by": {
          "type": "string",
          "const": "deterministic",
          "description": "Hard invariant: never 'llm'. The LLM may explain a deadline but never computes it as authoritative."
        },
        "computation_basis": {
          "type": "object",
          "additionalProperties": false,
          "description": "DET. Inputs the clock was computed from, for auditability.",
          "properties": {
            "anchor_event": { "type": ["string", "null"], "description": "e.g. 'petition_served'." },
            "anchor_date": { "anyOf": [{ "$ref": "#/$defs/Date" }, { "type": "null" }] },
            "statute_rule_id": { "type": ["string", "null"], "description": "Versioned id of the deterministic rule applied (e.g. 'rpapl_732_answer')." },
            "rule_version": { "type": ["string", "null"] }
          }
        },
        "tenant_confirmed": { "type": "boolean", "default": false, "description": "Human-confirmed gate." },
        "attorney_validated": { "type": "boolean", "default": false, "description": "Attorney-validated logic confirmation." },
        "risk": { "$ref": "#/$defs/RiskFlags" },
        "explanation": { "type": ["string", "null"], "description": "LLM plain-English explanation of the deadline. NOT the computation.", "x-provenance": "LLM" }
      }
    },
    "DeadlineType": {
      "type": "string",
      "enum": ["answer_due", "first_appearance", "motion_due", "discovery_due", "hardship_declaration_due", "warrant_execution_stay_end", "other"]
    },
    "RiskFlags": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "is_imminent": { "type": "boolean", "default": false, "description": "DET. Within configurable urgency window of due_date." },
        "is_missed": { "type": "boolean", "default": false, "description": "DET. due_date is in the past and not satisfied." },
        "default_risk": { "type": "boolean", "default": false, "description": "DET. Missing this could cause a default judgment." },
        "uncertain_anchor": { "type": "boolean", "default": false, "description": "DET. Anchor date is unverified/LLM-only; clock is provisional pending confirmation." }
      }
    },

    "EvidenceItem": {
      "type": "object",
      "additionalProperties": false,
      "required": ["evidence_id", "evidence_type", "origin"],
      "properties": {
        "evidence_id": { "type": "string", "pattern": "^ev_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
        "evidence_type": { "$ref": "#/$defs/EvidenceType" },
        "origin": { "type": "string", "enum": ["tenant_uploaded", "open_data", "tenant_stated"], "description": "Source class of the evidence." },
        "document_id": { "type": ["string", "null"], "pattern": "^doc_[0-9a-hjkmnp-tv-z]{26}$", "description": "FK when origin=tenant_uploaded." },
        "tags": {
          "type": "array",
          "description": "LLM-tagged categorization (evidence tagging).",
          "items": { "type": "string" },
          "x-provenance": "LLM"
        },
        "summary": { "type": ["string", "null"], "description": "LLM plain-English summary.", "x-provenance": "LLM" },
        "supports_defense_codes": {
          "type": "array",
          "items": { "$ref": "#/$defs/DefenseCode" },
          "description": "Information-not-advice mapping of evidence to candidate defenses; for human review."
        },
        "open_data": {
          "anyOf": [{ "$ref": "#/$defs/OpenDataAssertion" }, { "type": "null" }],
          "description": "REQUIRED when origin=open_data. Carries data_accuracy_disclaimer + verify_before_file gate + dataset/version."
        }
      },
      "allOf": [
        {
          "if": { "properties": { "origin": { "const": "open_data" } } },
          "then": { "required": ["open_data"] }
        }
      ]
    },
    "EvidenceType": {
      "type": "string",
      "enum": ["rent_payment_proof", "rent_receipt", "bank_record", "money_order", "repair_request", "hpd_violation", "hpd_complaint", "photo", "correspondence", "lease_term", "registration_record", "ownership_record", "witness_statement", "other"]
    },
    "OpenDataAssertion": {
      "type": "object",
      "additionalProperties": false,
      "required": ["dataset", "dataset_version", "data_accuracy_disclaimer", "verify_before_file"],
      "description": "Stale open data => TENANT bears 22 NYCRR 130 risk. Every open-data assertion carries a disclaimer + a tenant verify gate. NEVER auto-asserted into a filing.",
      "properties": {
        "dataset": {
          "type": "string",
          "enum": ["hpd_violations_wvxf-dwi5", "hpd_complaints_ygpa-z7cr", "hpd_registration_tesw-yqqr", "hpd_contacts_feu5-w2e2", "justfix_wow", "nyc_geosearch", "pluto_pad", "nycdb_selfhost"],
          "description": "Source dataset identifier."
        },
        "dataset_version": { "type": "string", "description": "Ingest/snapshot timestamp or published version of the dataset." },
        "retrieved_at": { "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }] },
        "endpoint": { "type": ["string", "null"], "description": "Verified API endpoint used (e.g. '/api/address/wowza')." },
        "data_accuracy_disclaimer": {
          "type": "string",
          "description": "Disclaimer text shown to tenant; this data may be stale/incomplete and must be verified before filing."
        },
        "verify_before_file": { "$ref": "#/$defs/VerifyGate" }
      }
    },
    "VerifyGate": {
      "type": "object",
      "additionalProperties": false,
      "required": ["state"],
      "description": "Tenant 'verify before filing' gate state. Must be 'verified' before this assertion may enter any packet.",
      "properties": {
        "state": { "type": "string", "enum": ["unverified", "verified", "disputed", "not_applicable"] },
        "verified_at": { "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }] },
        "verified_by": { "anyOf": [{ "$ref": "#/$defs/Actor" }, { "type": "null" }] },
        "tenant_note": { "type": ["string", "null"] }
      }
    },

    "AnswerDraft": {
      "type": "object",
      "additionalProperties": false,
      "description": "Faithful transcription ONLY. The LLM transcribes the tenant's own factual statements into answer fields; it does not select defenses or make legal conclusions.",
      "properties": {
        "answer_draft_id": { "type": ["string", "null"], "pattern": "^ans_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
        "general_denial": { "type": ["boolean", "null"], "description": "TEN. Tenant's selection; not an LLM legal conclusion." },
        "factual_statements": {
          "type": "array",
          "description": "LLM faithful transcription of tenant-stated facts. Each is tenant-confirmable, verbatim-grounded, no legal characterization.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["statement_id", "text", "tenant_confirmed", "transcription_only"],
            "properties": {
              "statement_id": { "type": "string", "pattern": "^stmt_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
              "text": { "type": "string", "description": "Transcribed/multilingual-rewritten tenant statement.", "x-provenance": "LLM" },
              "source_language": { "type": ["string", "null"], "description": "BCP-47 of the tenant's original statement." },
              "tenant_confirmed": { "type": "boolean", "default": false },
              "transcription_only": {
                "type": "boolean",
                "const": true,
                "description": "Hard invariant: this field is faithful transcription, never legal advice or conclusion."
              },
              "provenance": { "$ref": "#/$defs/Provenance" }
            }
          }
        },
        "form_fields": {
          "type": "array",
          "description": "DET. Mapping of confirmed facts to official NY fillable-PDF form fields. Placement/validation is deterministic, never LLM.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["form_field_id", "value", "placed_by", "validation_state"],
            "properties": {
              "form_field_id": { "type": "string", "description": "Official form field identifier (docassemble/AssemblyLine variable)." },
              "value": { "description": "Placed value (string/bool/Money etc.)." },
              "placed_by": { "type": "string", "const": "deterministic" },
              "validation_state": { "type": "string", "enum": ["valid", "invalid", "missing_required", "pending"] },
              "validation_message": { "type": ["string", "null"] }
            }
          }
        },
        "status": { "type": "string", "enum": ["draft", "tenant_reviewed", "attorney_reviewed", "finalized"], "default": "draft" }
      }
    },

    "DefenseChecklistItem": {
      "type": "object",
      "additionalProperties": false,
      "required": ["defense_code", "surfaced_as", "attorney_reviewed"],
      "description": "Information, not advice. Surfacing a possible defense is information; ASSERTING it / saying the tenant 'has a case' is the advice line and is attorney-owned + DET-gated.",
      "properties": {
        "defense_code": { "$ref": "#/$defs/DefenseCode" },
        "surfaced_as": {
          "type": "string",
          "const": "information_not_advice",
          "description": "Hard invariant. This item informs; it does not advise or conclude."
        },
        "relevance_signal": {
          "type": ["string", "null"],
          "enum": ["possible", "evidence_present", "not_indicated", null],
          "description": "Neutral signal derived from facts/evidence; NOT a recommendation."
        },
        "supporting_evidence_ids": { "type": "array", "items": { "type": "string", "pattern": "^ev_[0-9a-hjkmnp-tv-z]{26}$" } },
        "explanation": { "type": ["string", "null"], "description": "LLM plain-English description of what this defense is (general info).", "x-provenance": "LLM" },
        "attorney_reviewed": { "type": "boolean", "default": false },
        "attorney_disposition": { "type": ["string", "null"], "enum": ["applicable", "not_applicable", "needs_more_info", null], "description": "Attorney-only field; the advice line." }
      }
    },

    "Eligibility": {
      "type": "object",
      "additionalProperties": false,
      "description": "DET. All determinations by deterministic, config-driven rules. ERAP CLOSED; CityFHEPS in litigation -> rules toggleable. RTC <=200% FPL citywide (monitored config).",
      "properties": {
        "rtc": { "$ref": "#/$defs/EligibilityResult", "description": "Right to Counsel determination." },
        "legal_aid": { "$ref": "#/$defs/EligibilityResult", "description": "Legal-aid/provider intake eligibility." },
        "rental_assistance": { "$ref": "#/$defs/EligibilityResult", "description": "Summary / best-available rental-assistance result. Per-program breakdown lives in rental_assistance_programs[]." },
        "rental_assistance_programs": {
          "type": "array",
          "description": "DET. Per-program rental-assistance results (each an EligibilityResult with its `program` set): one_shot_deal, cityfheps, erap (program_unavailable — CLOSED), etc. screen_eligibility writes ERAP HERE, never as a top-level eligibility.erap key (the Eligibility object is additionalProperties:false and cannot hold one).",
          "items": { "$ref": "#/$defs/EligibilityResult" }
        },
        "config_version": { "type": ["string", "null"], "description": "DET. Version of the eligibility config/ruleset applied (RTC geography/income, program toggles)." },
        "evaluated_at": { "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }] }
      }
    },
    "EligibilityResult": {
      "type": "object",
      "additionalProperties": false,
      "required": ["determination", "determined_by"],
      "properties": {
        "program": { "anyOf": [{ "$ref": "#/$defs/EligibilityProgram" }, { "type": "null" }] },
        "determination": { "type": "string", "enum": ["eligible", "ineligible", "likely_eligible", "insufficient_data", "program_unavailable"], "description": "'program_unavailable' for closed programs (e.g. ERAP)." },
        "determined_by": { "type": "string", "const": "deterministic", "description": "Hard invariant: eligibility is never an LLM conclusion." },
        "rule_ids": { "type": "array", "items": { "type": "string" }, "description": "Deterministic rule ids that produced the result." },
        "reasons": { "type": "array", "items": { "type": "string" }, "description": "Structured reason codes (not advice)." },
        "data_source": {
          "type": ["string", "null"],
          "enum": ["nyc_benefits_screening_api", "internal_rules", null],
          "description": "NYC Benefits Screening API is eligibility-only (no submission)."
        },
        "config_toggle_state": { "type": ["string", "null"], "enum": ["enabled", "disabled", null], "description": "For litigation-sensitive programs (CityFHEPS)." }
      }
    },
    "EligibilityProgram": {
      "type": "string",
      "enum": ["rtc", "legal_aid", "erap", "cityfheps", "one_shot_deal", "ofa_emergency_grant", "snap", "other"],
      "description": "ERAP is CLOSED; CityFHEPS in active litigation (toggleable)."
    },

    "Packets": {
      "type": "object",
      "additionalProperties": false,
      "description": "Assembled outputs. court_packet via docassemble/AssemblyLine -> PDF/A on official NY fillable PDFs. legal_aid_handoff is the one-page CSR/LIST-tagged intake summary.",
      "properties": {
        "court_packet": { "$ref": "#/$defs/Packet" },
        "legal_aid_handoff": { "$ref": "#/$defs/LegalAidHandoffPacket" }
      }
    },
    "Packet": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "packet_id": { "type": ["string", "null"], "pattern": "^pkt_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
        "kind": { "type": "string", "enum": ["court_packet", "legal_aid_handoff"] },
        "status": { "$ref": "#/$defs/DocumentAssemblyStatus" },
        "storage_ref": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["uri", "format"],
              "properties": {
                "uri": { "type": "string" },
                "format": { "type": "string", "enum": ["pdf_a", "pdf"] },
                "content_hash_sha256": { "type": ["string", "null"], "pattern": "^[a-f0-9]{64}$" }
              }
            },
            { "type": "null" }
          ]
        },
        "included_evidence_ids": { "type": "array", "items": { "type": "string", "pattern": "^ev_[0-9a-hjkmnp-tv-z]{26}$" } },
        "blocked_by_unverified_open_data": {
          "type": "boolean",
          "default": false,
          "description": "DET. True if any included open-data assertion is not yet verify_before_file=verified. Hard block on filing assembly."
        },
        "generated_by_model": { "type": ["string", "null"], "enum": ["claude-opus-4-8", "claude-sonnet-4-6", null], "description": "For narrative sections only; field placement is deterministic." },
        "generated_at": { "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }] }
      }
    },
    "LegalAidHandoffPacket": {
      "type": "object",
      "additionalProperties": false,
      "description": "One-page CSR/LIST-tagged legal-aid intake summary. Routed via LegalServer Online Intake (Trigger API/XML) with PDF-packet fallback (CMS-agnostic).",
      "allOf": [{ "$ref": "#/$defs/Packet" }],
      "properties": {
        "packet_id": true,
        "kind": true,
        "status": true,
        "storage_ref": true,
        "included_evidence_ids": true,
        "blocked_by_unverified_open_data": true,
        "generated_by_model": true,
        "generated_at": true,
        "csr_tags": {
          "type": "array",
          "description": "LSC CSR problem/closure codes tagged for this intake.",
          "items": { "type": "string" }
        },
        "list_tags": {
          "type": "array",
          "description": "Legal Issue/Service Taxonomy (LIST) codes.",
          "items": { "type": "string" }
        },
        "intake_summary_text": { "type": ["string", "null"], "description": "LLM-generated one-page summary (information; attorney reviews).", "x-provenance": "LLM" },
        "delivery": { "anyOf": [{ "$ref": "#/$defs/ProviderHandoff" }, { "type": "null" }] }
      }
    },
    "ProviderHandoff": {
      "type": "object",
      "additionalProperties": false,
      "required": ["consent_id", "method"],
      "description": "Delivery of handoff packet to a provider. REQUIRES a matching per-recipient consent.",
      "properties": {
        "provider_id": { "type": ["string", "null"], "pattern": "^prv_[0-9a-hjkmnp-tv-z]{26}$" },
        "consent_id": { "type": "string", "pattern": "^cns_[0-9a-hjkmnp-tv-z]{26}$", "description": "The specific consent authorizing THIS recipient." },
        "method": { "type": "string", "enum": ["legalserver_trigger_xml", "pdf_packet_fallback"] },
        "delivered_at": { "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }] },
        "delivery_state": { "type": "string", "enum": ["pending", "sent", "acknowledged", "failed"], "default": "pending" },
        "external_reference": { "type": ["string", "null"], "description": "Provider-side intake/reference id." }
      }
    },
    "DocumentAssemblyStatus": {
      "type": "string",
      "enum": ["not_started", "assembling", "ready", "blocked", "delivered", "error"]
    },

    "Reminder": {
      "type": "object",
      "additionalProperties": false,
      "required": ["reminder_id", "channel", "consent_id", "scheduled_for", "state"],
      "description": "Opt-in, consent-logged. Each reminder ties to a consent with scope=sms_reminders.",
      "properties": {
        "reminder_id": { "type": "string", "pattern": "^rem_[0-9a-hjkmnp-tv-z]{26}$", "x-provenance": "SYS" },
        "channel": { "type": "string", "enum": ["sms", "email", "push"] },
        "consent_id": { "type": "string", "pattern": "^cns_[0-9a-hjkmnp-tv-z]{26}$" },
        "reminder_type": { "type": "string", "enum": ["court_date", "answer_deadline", "document_request", "appointment", "other"] },
        "related_deadline_id": { "type": ["string", "null"], "pattern": "^dl_[0-9a-hjkmnp-tv-z]{26}$" },
        "scheduled_for": { "$ref": "#/$defs/Timestamp", "description": "DET-computed send time relative to an authoritative deadline/court date." },
        "state": { "type": "string", "enum": ["scheduled", "sent", "failed", "cancelled"] },
        "sent_at": { "anyOf": [{ "$ref": "#/$defs/Timestamp" }, { "type": "null" }] }
      }
    },

    "AttorneyReview": {
      "type": "object",
      "additionalProperties": false,
      "description": "Human handoff. Supervising attorney engaged from Phase 0. Advice-seeking turns are hard-routed here.",
      "properties": {
        "assigned_attorney_id": { "type": ["string", "null"], "pattern": "^atty_[0-9a-hjkmnp-tv-z]{26}$" },
        "review_state": { "type": "string", "enum": ["unassigned", "queued", "in_review", "reviewed", "escalated"], "default": "unassigned" },
        "advice_routed": {
          "type": "boolean",
          "default": false,
          "description": "True when an advice-seeking turn (advice-detection classifier) hard-routed this case to a human.",
          "x-provenance": "DET"
        },
        "advice_detection_log": {
          "type": "array",
          "description": "LLM advice-detection classifier hits; the DECISION to route is deterministic.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "at": { "$ref": "#/$defs/Timestamp" },
              "classifier_model": { "type": "string", "enum": ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"] },
              "is_advice_seeking": { "type": "boolean" },
              "confidence": { "$ref": "#/$defs/ConfidenceLevel" }
            }
          }
        },
        "triage_score": {
          "anyOf": [
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "score": { "type": "number", "description": "LLM provider-triage score (information for routing; not a legal conclusion)." },
                "model": { "type": "string", "enum": ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"] },
                "rationale": { "type": ["string", "null"] }
              }
            },
            { "type": "null" }
          ]
        }
      }
    },

    "Audit": {
      "type": "object",
      "additionalProperties": false,
      "description": "Provenance/audit envelope. Supports subpoena/legal-hold, SHIELD compliance, and the LLM/DET boundary trail.",
      "required": ["created_by"],
      "properties": {
        "created_by": { "$ref": "#/$defs/Actor" },
        "legal_hold": { "type": "boolean", "default": false },
        "data_retention_class": { "type": ["string", "null"], "enum": ["standard", "minimized", "sensitive", null] },
        "events": {
          "type": "array",
          "description": "Append-only audit trail of mutations.",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["at", "actor", "action"],
            "properties": {
              "at": { "$ref": "#/$defs/Timestamp" },
              "actor": { "$ref": "#/$defs/Actor" },
              "action": { "type": "string" },
              "field_path": { "type": ["string", "null"], "description": "JSON pointer of the changed field." },
              "model": { "type": ["string", "null"], "enum": ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5", null] }
            }
          }
        }
      }
    }
  }
}
```

### Field table (top-level + key nested), with provenance and confirmation

| Field path | Type | Provenance | Confirmation required |
|---|---|---|---|
| `case_id` | string (`case_` ULID) | SYS | n/a |
| `schema_version` | const "1.0.0" | SYS | n/a |
| `tenant_id` / `tenant_account_id` | string FK | SYS | n/a |
| `case_type` | enum | LLM classify | `case_type_confirmed` |
| `status` | enum (state machine) | DET | DET-guarded transitions |
| `contact.*` | strings | TEN | self-asserted |
| `consents[]` | objects | TEN | affirmative opt-in per recipient |
| `sensitive.immigration` / `sensitive.benefits_enrollment` | objects/null | TEN | opt-in + severable consent_id; null by default |
| `documents[].storage_ref` | object | SYS | n/a |
| `documents[].ocr_text` | string | LLM (vision) | tenant-visible |
| `documents[].extracted_fields.*` | ConfirmableValue | LLM | `tenant_confirmed` per field |
| `court.court_date` | Date | DET (eTrack/NYSCEF) | `court_date_verified` |
| `court.index_number` | string | LLM + tenant | tenant-confirmed; NYSCEF cross-check |
| `parties.landlord.name` | string | LLM | tenant-confirmed |
| `parties.landlord.registered_owner_name` / `wow_landlord_id` | string | open_data | `open_data.verify_before_file` |
| `claimed_arrears` | Money | LLM | tenant-confirmed |
| `property.bbl` | string | DET (GeoSearch/PLUTO) | n/a |
| `timeline[].date` | Date | DET if `date_is_authoritative=true`, else LLM | per flag |
| `deadlines[]` | objects | DET (`computed_by=deterministic`) | `tenant_confirmed` + `attorney_validated` |
| `evidence[]` | objects | tenant_uploaded / open_data / tenant_stated | open_data items: `verify_before_file=verified` |
| `answer_draft.factual_statements[]` | objects | LLM faithful transcription (`transcription_only=true`) | `tenant_confirmed` |
| `answer_draft.form_fields[]` | objects | DET (`placed_by=deterministic`) | `validation_state=valid` |
| `defenses_checklist[]` | objects | LLM info (`surfaced_as=information_not_advice`) | `attorney_reviewed`; disposition attorney-only |
| `eligibility.{rtc,legal_aid,rental_assistance}` | EligibilityResult | DET (`determined_by=deterministic`) | config-driven |
| `packets.court_packet` / `packets.legal_aid_handoff` | objects | DET assembly + LLM narrative | `blocked_by_unverified_open_data=false` to file |
| `reminders[]` | objects | DET scheduling | `consent_id` (scope=sms_reminders) |
| `review.advice_routed` | boolean | DET decision (LLM detect) | hard-routes to human (advice-seeking conversational turn ONLY; deterministic escalations use `review_state="escalated"`) |
| `audit` | object | SYS append-only | n/a |

## Field Glossary

## Field-by-field Glossary

Format: **field** — meaning | source | confirmation requirement.

### Identity & contact
- **case_id** — canonical case key (`case_` + ULID). | SYS | none.
- **tenant_id / tenant_account_id** — FK to the contact subject / authenticated PWA account (null for guest). | SYS | none.
- **language** — BCP-47 preferred language for UI and multilingual rewrite. | TEN | none.
- **contact.full_name / preferred_name** — tenant name. | TEN | self-asserted.
- **contact.phone_e164** — E.164 phone, used for SMS reminders. | TEN | requires `sms_reminders` consent before any send.
- **contact.email / mailing_address** — contact channels. | TEN | self-asserted.
- **contact.safe_to_text** — DV/safety flag; if false, SMS is suppressed. | TEN | self-asserted.

### Consent & sensitive data
- **consents[]** — one record per recipient. Per-recipient, time-limited (`expires_at`), severable (`revoked_at` independent), voluntary (`granted` only on affirmative opt-in), written (`consent_text_version`, `method`). | TEN | affirmative opt-in. Never names a landlord/agent (FCRA bar).
- **consents[].data_categories** — severable per-category coverage (data minimization). | TEN | per-category opt-in.
- **sensitive.immigration** — null unless a specific defense needs it AND the tenant opted in via a severable `consent_id`. Never furnished to landlords (SHIELD/immigration exposure). | TEN | opt-in + dedicated consent.
- **sensitive.benefits_enrollment** — enrolled programs; opt-in, consent-gated. | TEN | opt-in + consent.
- **sensitive.household_income_cents / household_size** — inputs to DET RTC (<=200% FPL) eligibility. | TEN | opt-in.

### Documents
- **documents[].document_type** — classified doc kind (summons_petition, rent_demand, …). | LLM classify | tenant-confirmable.
- **documents[].storage_ref** — raw upload URI + SHA-256 + MIME + page count. | SYS | none.
- **documents[].ocr_text** — full transcription via vision intake. | LLM (Opus 4.8 / Sonnet 4.6) | tenant-visible.
- **documents[].extracted_fields.\*** — each is a `ConfirmableValue` (value + `confidence` + `tenant_confirmed` + `provenance` with citation `locator`). court_date here is EXTRACTED only — it is never the authoritative date. | LLM structured output | `tenant_confirmed` per field.

### Court / parties / arrears / property
- **court.court_date** — authoritative court date from eTrack ingest / NYSCEF docket. | DET | `court_date_verified` true only when DET-sourced; `document_extracted_unverified` is non-authoritative.
- **court.county / borough / part** — DET-validated court coordinates. | DET | n/a.
- **court.index_number** — LT index; extracted then confirmed, cross-checked against NYSCEF. | LLM + TEN | tenant-confirmed.
- **parties.landlord.name / attorney_name / petitioner_name** — from the petition. | LLM | tenant-confirmed.
- **parties.landlord.registered_owner_name / wow_landlord_id / registration_on_file** — ownership/standing + registration-defense signals from HPD Registration+Contacts and JustFix WoW. `registration_on_file=false` covers both "no registration" and "on file but expired/lapsed" (the lookup_hpd_registration mapping); the expired-vs-absent reason is preserved in the open-data explanation. | open_data | `open_data.verify_before_file` gate.
- **parties.tenant.matches_contact** — tenant confirms the named respondent is them. | TEN | confirmation.
- **claimed_arrears** — total arrears claimed, Money (cents). | LLM | tenant-confirmed.
- **property.address / apartment_unit** — premises. | LLM | tenant-confirmed.
- **property.bbl** — 10-digit Borough-Block-Lot resolved via NYC GeoSearch + PLUTO/PAD (not legacy Geoclient). | DET | n/a.

### Timeline & deadlines
- **timeline[]** — plain-English chronology. Each event has `date_is_authoritative`: true = DET/court-sourced (safe), false = LLM-extracted descriptive (not safe to file on). | mixed | per-event flag.
- **deadlines[]** — safety-critical statutory clocks. `computed_by` is a hard const "deterministic" — the LLM may explain a deadline (`explanation`) but never computes it. `computation_basis` records anchor event/date + versioned `statute_rule_id`. | DET | `tenant_confirmed` (human-confirmed) AND `attorney_validated`.
- **deadlines[].risk** — DET-computed flags: `is_imminent`, `is_missed`, `default_risk`, `uncertain_anchor` (anchor is unverified/LLM-only → provisional). | DET | n/a.

### Evidence
- **evidence[].evidence_type / tags / summary** — typed and LLM-tagged categorization with plain-English summary. | LLM tagging | n/a (informational).
- **evidence[].origin** — `tenant_uploaded` / `open_data` / `tenant_stated`.
- **evidence[].supports_defense_codes** — information-not-advice mapping of evidence to candidate defenses, for human review. | LLM info | attorney review.
- **evidence[].open_data** — REQUIRED when origin=open_data. Carries `dataset`, `dataset_version`, `retrieved_at`, `endpoint`, `data_accuracy_disclaimer`, and `verify_before_file` gate. Tenant is the filer and bears 22 NYCRR 130 risk → never auto-asserted into a filing; must be `verified` to enter a packet. | open_data | `verify_before_file.state=verified`.

### Answer draft & defenses
- **answer_draft.factual_statements[]** — faithful transcription only. `transcription_only` is a hard const true; text is the tenant's own facts (multilingual-rewritten), grounded by `provenance`, no legal characterization. | LLM transcription | `tenant_confirmed`.
- **answer_draft.general_denial** — tenant's selection, not an LLM conclusion. | TEN | tenant selection.
- **answer_draft.form_fields[]** — DET mapping of confirmed facts into official NY fillable-PDF fields; `placed_by` const "deterministic"; `validation_state` deterministic. | DET | `validation_state=valid`.
- **defenses_checklist[]** — information, not advice. `surfaced_as` const "information_not_advice". Surfacing a possible defense is information; `attorney_disposition` (whether it applies / "you have a case") is the advice line and is attorney-only. | LLM info | `attorney_reviewed`; disposition attorney-only.

### Eligibility
- **eligibility.{rtc, legal_aid, rental_assistance}** — DET determinations; `determined_by` const "deterministic". Config-driven (`config_version`): RTC <=200% FPL citywide (monitored config); ERAP `program_unavailable` (closed); CityFHEPS toggleable via `config_toggle_state` (active litigation). NYC Benefits Screening API is eligibility-only (no submission). | DET | config-driven, attorney-validated rules.

### Packets & handoff
- **packets.court_packet** — assembled via docassemble + Suffolk AssemblyLine on official NY fillable PDFs → PDF/A. `blocked_by_unverified_open_data` hard-blocks assembly if any open-data assertion is not `verified`. | DET assembly (+ LLM narrative) | open-data verify gate.
- **packets.legal_aid_handoff** — one-page CSR/LIST-tagged intake summary. `csr_tags` (LSC CSR), `list_tags` (LIST). `intake_summary_text` is LLM-generated (information; attorney reviews). `delivery` via LegalServer Trigger API/XML or PDF-packet fallback, and REQUIRES a matching per-recipient `consent_id`. | LLM summary + DET tags + DET delivery | consent + attorney review.

### Reminders, review, audit
- **reminders[]** — opt-in; each ties to a `consent_id` (scope=sms_reminders) and is consent-logged. `scheduled_for` is DET relative to an authoritative deadline/court date. | DET schedule | consent.
- **review.advice_routed** — DET decision to hard-route to a human after the LLM advice-detection classifier flags an advice-seeking turn. The classification is LLM; the routing decision is DET. | DET (LLM-detect) | hard-routes to attorney.
- **review.triage_score** — LLM provider-triage score for routing; informational, not a legal conclusion. | LLM | informational.
- **audit** — append-only provenance trail; supports subpoena/legal-hold, SHIELD, and the LLM/DET boundary audit. Every mutation logs actor, action, `field_path`, and `model` (when LLM). | SYS | none.

### Boundary invariants (hard constants enforced by schema)
- `deadlines[].computed_by` = `"deterministic"`
- `eligibility.*.determined_by` = `"deterministic"`
- `answer_draft.form_fields[].placed_by` = `"deterministic"`
- `answer_draft.factual_statements[].transcription_only` = `true`
- `defenses_checklist[].surfaced_as` = `"information_not_advice"`

These five constants are the machine-checkable expression of the LLM/DETERMINISTIC boundary: a value that should be deterministic (or transcription/information) can never be silently set by the LLM, because the schema rejects any other value.

## Enums

## Canonical Enums

All enum values are lowercase `snake_case` unless they mirror an external/legal convention (county names, currency).

### case_type (`CaseType`)
`nonpayment` · `holdover` · `illegal_lockout` · `hp_action` · `other` · `unknown`
> MVP processes only `nonpayment` end-to-end; all others route to human triage.

### status (`CaseStatus`) — state machine
`intake` → `prepared` → `referred` → `represented` → `resolved`
> Transitions are DET-guarded; recorded in `status_history[]`.

### confidence_level (`ConfidenceLevel`)
`high` · `medium` · `low` · `unreadable`
> `unreadable` = OCR/vision could not extract the value.

### document_type (`DocumentType`)
`summons_petition` · `rent_demand` · `notice_of_petition` · `lease` · `rent_ledger` · `rent_receipt` · `repair_evidence` · `correspondence` · `court_notice` · `other` · `unknown`

### evidence_type (`EvidenceType`)
`rent_payment_proof` · `rent_receipt` · `bank_record` · `money_order` · `repair_request` · `hpd_violation` · `hpd_complaint` · `photo` · `correspondence` · `lease_term` · `registration_record` · `ownership_record` · `witness_statement` · `other`

### defense_code (`DefenseCode`) — information-not-advice
`general_denial` · `rent_paid` · `rent_partially_paid` · `improper_service` · `defective_rent_demand` · `defective_petition` · `warranty_of_habitability` · `repairs_needed` · `rent_overcharge` · `wrong_amount_claimed` · `no_landlord_tenant_relationship` · `not_registered_multiple_dwelling` · `succession_rights` · `laches` · `rent_regulation_violation` · `other`
> A defense code is surfaced as information. Asserting one / concluding the tenant "has a case" is the advice line — attorney-owned, never set by the LLM.

### eligibility_program (`EligibilityProgram`)
`rtc` · `legal_aid` · `erap` · `cityfheps` · `one_shot_deal` · `ofa_emergency_grant` · `snap` · `other`
> `erap` is CLOSED (yields `program_unavailable`). `cityfheps` is in active litigation — gated by `config_toggle_state`.

### eligibility determination (`EligibilityResult.determination`)
`eligible` · `ineligible` · `likely_eligible` · `insufficient_data` · `program_unavailable`

### eligibility data_source (`EligibilityResult.data_source`)
`nyc_benefits_screening_api` (eligibility-only, no submission) · `internal_rules`

### config_toggle_state
`enabled` · `disabled`

### consent scope (`ConsentScope`)
`handoff_to_provider` · `court_filing_assistance` · `benefits_screening_share` · `sms_reminders` · `store_sensitive_data`

### consent recipient_type
`legal_aid_provider` · `court` · `benefits_agency` · `reminder_service` · `attorney`
> Never `landlord`/`agent`. Tenant data is never furnished to landlords (FCRA).

### consent data_categories
`contact` · `case_facts` · `documents` · `arrears` · `eligibility` · `immigration_status` · `benefits_enrollment` · `evidence`

### consent method
`pwa_checkbox` · `pwa_signature` · `verbal_logged`

### borough (`Borough`)
`manhattan` · `bronx` · `brooklyn` · `queens` · `staten_island`

### court county (`Court.county`) — legal convention, mixed case
`New York` · `Bronx` · `Kings` · `Queens` · `Richmond`

### court_date_source (`Court.court_date_source`)
`etrack` · `nyscef` · `document_extracted_unverified` · `tenant_entered`
> Only `etrack` / `nyscef` set `court_date_verified=true`.

### deadline_type (`DeadlineType`)
`answer_due` · `first_appearance` · `motion_due` · `discovery_due` · `hardship_declaration_due` · `warrant_execution_stay_end` · `other`

### deadline computed_by
`deterministic` (const — only legal value)

### timeline kind (`TimelineEvent.kind`)
`rent_demand_served` · `petition_filed` · `petition_served` · `answer_due` · `court_appearance` · `adjournment` · `judgment` · `other`

### evidence origin (`EvidenceItem.origin`)
`tenant_uploaded` · `open_data` · `tenant_stated`

### open-data dataset (`OpenDataAssertion.dataset`)
`hpd_violations_wvxf-dwi5` · `hpd_complaints_ygpa-z7cr` · `hpd_registration_tesw-yqqr` · `hpd_contacts_feu5-w2e2` · `justfix_wow` · `nyc_geosearch` · `pluto_pad` · `nycdb_selfhost`

### verify_before_file state (`VerifyGate.state`)
`unverified` · `verified` · `disputed` · `not_applicable`
> Must be `verified` before an open-data assertion may enter any packet.

### bbl_resolved_via (`Property.bbl_resolved_via`)
`geosearch_pluto` · `geosearch_pad` · `manual`

### geo_confidence (`Property.geo_confidence`)
`exact` · `approximate` · `failed`

### answer_draft status (`AnswerDraft.status`)
`draft` · `tenant_reviewed` · `attorney_reviewed` · `finalized`

### form_field validation_state (`AnswerDraft.form_fields[].validation_state`)
`valid` · `invalid` · `missing_required` · `pending`

### defense attorney_disposition (`DefenseChecklistItem.attorney_disposition`)
`applicable` · `not_applicable` · `needs_more_info`
> Attorney-only field; the advice line.

### packet kind (`Packet.kind`)
`court_packet` · `legal_aid_handoff`

### packet format (`Packet.storage_ref.format`)
`pdf_a` · `pdf`

### document_assembly_status (`DocumentAssemblyStatus`)
`not_started` · `assembling` · `ready` · `blocked` · `delivered` · `error`

### provider handoff method (`ProviderHandoff.method`)
`legalserver_trigger_xml` · `pdf_packet_fallback`

### provider handoff delivery_state
`pending` · `sent` · `acknowledged` · `failed`

### reminder channel (`Reminder.channel`)
`sms` · `email` · `push`

### reminder_type (`Reminder.reminder_type`)
`court_date` · `answer_deadline` · `document_request` · `appointment` · `other`

### reminder state (`Reminder.state`)
`scheduled` · `sent` · `failed` · `cancelled`

### attorney review_state (`AttorneyReview.review_state`)
`unassigned` · `queued` · `in_review` · `reviewed` · `escalated`

### provenance source (`Provenance.source`)
`llm_extraction` · `llm_generation` · `deterministic` · `tenant_entered` · `open_data` · `system` · `attorney_entered`

### actor_type (`Actor.actor_type`)
`tenant` · `system` · `attorney` · `provider` · `deterministic_engine`

### model id (`Provenance.model`, `*_model` fields) — exact, no date suffix
`claude-opus-4-8` (default; safety/trust-critical: vision intake, faithful transcription, intake-summary, grounded KB Q&A) · `claude-sonnet-4-6` (middle tier) · `claude-haiku-4-5` (cheap classification: case-type, advice-detection, triage)
> Verified against the Claude API reference. Use these exact strings — never append a date suffix. Structured outputs use `output_config.format` (json_schema) / `messages.parse()`; citations are incompatible with structured outputs, so extraction (structured) and citation (grounded) run as two passes.

### mime_type (`Document.storage_ref.mime_type`)
`application/pdf` · `image/jpeg` · `image/png` · `image/heic` · `image/webp`

### data_retention_class (`Audit.data_retention_class`)
`standard` · `minimized` · `sensitive`

## Naming Conventions

## Naming Conventions & ID Prefixes

### Field naming
- **All field names are `snake_case`**, lowercase ASCII. No camelCase, no PascalCase, no hyphens in keys.
- **Booleans** read as predicates: `is_*` for computed state (`is_imminent`, `is_missed`), `*_confirmed` / `*_verified` / `*_validated` / `*_reviewed` / `*_routed` for gate flags, `has_*`/`matches_*`/`safe_to_*` for tenant-asserted facts. A boolean is always default-`false` and only flips on an affirmative event.
- **Enums** are lowercase `snake_case` values, EXCEPT where mirroring an external/legal convention: NYC county names (`New York`, `Kings`, `Bronx`, `Queens`, `Richmond`) keep their official mixed-case form, and `currency` is the ISO `USD`. Open-data dataset enums embed the Socrata 4x4 id with a hyphen (`hpd_violations_wvxf-dwi5`) because that is the canonical external identifier.
- **Timestamps vs dates are distinct types.** `*_at` fields are full RFC-3339/ISO-8601 UTC instants ending in `Z` (`created_at`, `granted_at`, `retrieved_at`). `*_date` fields are bare ISO-8601 calendar dates `YYYY-MM-DD` with no time component (`court_date`, `due_date`, `rent_demand_date`), interpreted on the court-local (America/New_York) calendar. Never mix the two.
- **Money is always `Money` (integer cents).** Any monetary field is an object `{ "amount_cents": <int>, "currency": "USD" }`. NEVER a float, NEVER a formatted string. `$1,234.56` → `123456`. Field names for money end in a plain noun (`claimed_arrears`, `monthly_rent`) or, when the raw integer is exposed directly (sensitive sub-object), the `_cents` suffix (`household_income_cents`).
- **Foreign keys** are named `<entity>_id` and carry the referenced entity's prefix pattern (`deadline_id`, `consent_id`, `document_id`, `provider_id`, `assigned_attorney_id`, `related_deadline_id`).
- **Provenance suffixes** are consistent: `*_confidence` (LLM band), `*_source` / `*_via` (where a value came from), `*_by` (which engine: const `deterministic` on safety-critical fields), `*_model` (exact Claude model id when LLM-produced), `*_version` (config/rule/schema/dataset version).
- **Arrays** are plural nouns (`documents`, `deadlines`, `consents`, `reminders`, `defenses_checklist`); their item objects are singular (`Document`, `Deadline`).
- **No abbreviations** except established domain acronyms used as full tokens: `bbl`, `rtc`, `hpd`, `csr_tags`, `list_tags`, `erap`, `cityfheps`, `ocr_text`, `mime_type`, `bcp-47` (in descriptions), `e164` (phone format suffix).

### ID prefixes (all ids = `<prefix>_` + 26-char Crockford base32 ULID)
ULID gives time-sortable, collision-resistant, URL-safe ids. Pattern: `^<prefix>_[0-9a-hjkmnp-tv-z]{26}$`.

| Entity | Prefix | Example |
|---|---|---|
| Case (root) | `case_` | `case_01j9z3k7m2n8p4q6r8s0t2v4w6` |
| Tenant / contact subject | `ten_` | `ten_01j9z3...` |
| Authenticated account | `acct_` | `acct_01j9z3...` |
| Document | `doc_` | `doc_01j9z3...` |
| Timeline event | `evt_` | `evt_01j9z3...` |
| Deadline | `dl_` | `dl_01j9z3...` |
| Evidence item | `ev_` | `ev_01j9z3...` |
| Consent | `cns_` | `cns_01j9z3...` |
| Answer draft | `ans_` | `ans_01j9z3...` |
| Answer factual statement | `stmt_` | `stmt_01j9z3...` |
| Packet | `pkt_` | `pkt_01j9z3...` |
| Reminder | `rem_` | `rem_01j9z3...` |
| Provider (external) | `prv_` | `prv_01j9z3...` |
| Attorney | `atty_` | `atty_01j9z3...` |

> `ev_` (evidence) and `evt_` (timeline event) are deliberately distinct prefixes — do not conflate. `dl_` is deadline (not "download").

### Domain-specific value formats
- **BBL** — 10 digits, regex `^[1-5]\d{9}$` (leading digit is the borough code 1–5). String, never integer (preserves leading semantics and avoids numeric coercion).
- **Index number** — free string in the NYC Housing Court LT index format; not pattern-constrained (formats vary by borough/year), validated against NYSCEF where available.
- **Phone** — `phone_e164`, regex `^\+[1-9]\d{1,14}$` (E.164).
- **Postal code** — `^\d{5}(-\d{4})?$`.
- **Content hash** — `content_hash_sha256`, lowercase hex `^[a-f0-9]{64}$`.
- **Language** — BCP-47 tag string (`en`, `es`, `zh-Hant`, `ht`, `bn`, `ru`, `ar`, `ko`).

### Versioning & boundary invariants
- **schema_version** is SemVer (`MAJOR.MINOR.PATCH`), root const `1.0.0` for v1; downstream specs pin to it.
- **Rule/config versions** are free strings owned by the deterministic engine: `statute_rule_id` + `rule_version` on deadlines, `config_version` on eligibility, `consent_text_version` on consents, `dataset_version` on open-data assertions. Anything legally/temporally sensitive (RTC geography/income, CityFHEPS toggle, statute clocks) is version-stamped so a value can be reproduced and audited.
- **Boundary-enforcing constants** — five fields are JSON-Schema `const` values that make the LLM/DETERMINISTIC line machine-checkable: `deadlines[].computed_by = "deterministic"`, `eligibility.*.determined_by = "deterministic"`, `answer_draft.form_fields[].placed_by = "deterministic"`, `answer_draft.factual_statements[].transcription_only = true`, `defenses_checklist[].surfaced_as = "information_not_advice"`. Any payload that tries to set these otherwise fails validation — the schema itself refuses to let an LLM author a safety-critical or advice value.
- **Defaults**: booleans default `false`; arrays default empty; nullable scalars default `null`. Absence of confirmation is never treated as confirmation.