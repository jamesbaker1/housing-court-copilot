# API & Service Contracts + State Machine — Housing Court Copilot (MVP: NYC Nonpayment)

# API & Service Contracts + State Machine

**Product:** Housing Court Copilot — legal-aid intake autopilot for NYC nonpayment eviction defense.
**Scope of this document:** the backend API for both surfaces (tenant PWA + provider triage console) over the shared **Case Object** (`housing_court_copilot.case` v1, `schema_version` = `1.0.0`), the case **state machine** (`intake -> prepared -> referred -> represented -> resolved`), auth, consent enforcement, the verify-before-file gate as an API invariant, idempotency, async/job patterns, and the LegalServer handoff + PDF fallback.
**Authority:** this spec implements `PLAN.md`, `LLM-ARCHITECTURE.md`, `RISKS-AND-COMPLIANCE.md`, `INTEGRATIONS.md`, the canonical Case Object schema, `LEGAL-RULES.md`, and `TOOL-CONTRACTS.md`. Where this document and the Case Object schema disagree on a field name, **the Case Object schema wins** and this document is in error. Where this document and `TOOL-CONTRACTS.md` disagree on a service-side gate or rule id, the reconciliations in §13 are authoritative.

---

## 0. Conventions

### 0.1 Transport, versioning, content
- **Style:** REST over HTTPS/1.1+2, JSON request/response (`application/json`), except raw uploads (`multipart/form-data` or pre-signed PUT).
- **Base URLs:** `https://api.housingcourtcopilot.org/v1` (tenant) and `https://api.housingcourtcopilot.org/v1/provider` (provider). Both share the same Case Object store; the path prefix selects the authz policy bundle, not a different datastore.
- **API version** is in the path (`/v1`). The Case Object payload independently carries `schema_version` (const `1.0.0`). A client MUST reject a payload whose `schema_version` it does not understand.
- **IDs** are always `<prefix>_` + 26-char Crockford base32 ULID, exactly as defined in the naming conventions (`case_`, `ten_`, `acct_`, `doc_`, `evt_`, `dl_`, `ev_`, `cns_`, `ans_`, `stmt_`, `pkt_`, `rem_`, `prv_`, `atty_`). Note `ev_` (evidence) vs `evt_` (timeline event) are distinct.
- **Money** is always `{ "amount_cents": <int>, "currency": "USD" }`. Never a float, never a formatted string.
- **Timestamps** (`*_at`) are RFC-3339 UTC `Z`-suffixed instants. **Dates** (`*_date`, `due_date`, `court_date`) are bare `YYYY-MM-DD` on the America/New_York court calendar. The two are never interchanged.

### 0.2 Standard response envelope
Success returns the resource or a sub-resource directly. All non-2xx responses use a single error envelope:

```json
{
  "error": {
    "code": "consent_required",
    "message": "Human-readable, non-legal, safe-to-display message.",
    "field_path": "/consents",
    "request_id": "req_01j9z3k7m2n8p4q6r8s0t2v4w6",
    "details": {}
  }
}
```

`error.code` is a stable machine token (see §11). `field_path` is a JSON Pointer into the Case Object when the error is about a specific field. `message` is non-legal copy safe to surface to a tenant.

### 0.3 Standard headers
| Header | Direction | Meaning |
|---|---|---|
| `Authorization: Bearer <jwt>` | req | OAuth2/OIDC access token (see §2). |
| `Idempotency-Key: <uuid-or-ulid>` | req | Required on all state-mutating POST/PATCH (see §8). |
| `If-Match: "<etag>"` | req | Optimistic concurrency on PATCH of the Case Object or sub-resources. |
| `ETag: "<version>"` | resp | Opaque version token; equals a hash of `(case_id, updated_at)`. |
| `X-Request-Id` | resp | Echoes/sets `request_id`, also written to `audit.events[]`. |
| `X-Schema-Version` | resp | Mirrors `schema_version` of the returned Case Object. |
| `Retry-After` | resp | On `429`/`503` and on `202` job polling hints. |

### 0.4 Read shapes & field-level provenance
Every Case Object read includes provenance. `documents[].extracted_fields.*` are returned as the full `ConfirmableValue` shape (`value`, `confidence`, `tenant_confirmed`, `tenant_corrected_value`, `provenance`). Open-data-derived items (`parties.landlord.open_data`, `evidence[].open_data`) always carry `OpenDataAssertion` (`dataset`, `dataset_version`, `data_accuracy_disclaimer`, `verify_before_file`). Clients MUST render `confidence`, `data_accuracy_disclaimer`, and the `verify_before_file.state` wherever the value is shown.

---

## 1. Service topology

```
                       ┌──────────────────────────────────────────────┐
  Tenant PWA  ───────▶ │  API Gateway (authz, idempotency, rate-limit) │ ◀─────── Provider Console
                       └───────────────┬──────────────────────────────┘
                                       │
            ┌──────────────┬───────────┼──────────────┬───────────────┬──────────────┐
            ▼              ▼           ▼               ▼               ▼              ▼
      Case Service   Document     Deterministic    Eligibility    Packet/Assembly  Handoff
      (Case Object,  /OCR svc     Engine (DET):    Engine (DET)    Service          Service
       state machine,(vision      deadlines,                       (docassemble +   (LegalServer
       audit)        extraction)  court-date src,                  AssemblyLine)    Trigger XML +
                                  form placement,                                   PDF fallback)
                                  open-data verify,
                                  advice-routing
            │              │           │               │               │              │
            └──────────────┴───────────┴───── Job Queue (async) ────────┴──────────────┘
                                       │
        LLM calls (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 per LLM-ARCHITECTURE.md), inside SHIELD boundary
        External (DET, server-side): GeoSearch+PLUTO/PAD, HPD Socrata, JustFix WoW, NYC Benefits Screening,
                                     eTrack/NYSCEF date sourcing, Twilio, LegalServer
```

**Hard boundary (non-negotiable):** the **Deterministic Engine** owns every value the schema marks `DET` and the five boundary-invariant `const`s. The LLM never writes those fields. The API layer enforces this: a write that attempts to set a `const`-guarded field to a non-const value is rejected with `400 boundary_violation` *before* it reaches the store (see §6.6).

---

## 2. Authentication & authorization

### 2.1 Principals and roles
| Role | Subject | Token claims | Surface |
|---|---|---|---|
| `tenant_guest` | anonymous PWA session bound to a single `case_id` | `sub=ten_…`, `case_id`, `guest=true`, `tenant_account_id=null` | Tenant PWA |
| `tenant_account` | authenticated PWA account | `sub=ten_…`, `acct=acct_…` | Tenant PWA |
| `provider_intake` | triage staff at a partner org | `sub`, `prv=prv_…`, `roles=[provider_intake]` | Provider console |
| `provider_attorney` | supervising/assigned attorney | `sub=atty_…`, `prv=prv_…`, `roles=[provider_attorney]` | Provider console |
| `system` | internal services (engine, jobs, webhooks) | mTLS + service identity (`actor_type` ∈ {`system`,`deterministic_engine`}) | internal only |

Tokens are short-lived OIDC access tokens (≤30 min) + refresh; guest sessions are device-bound and capability-scoped to one `case_id`. All requests TLS-only; the entire stack runs inside the SHIELD-compliant boundary (encryption at rest, RBAC, retention, breach + subpoena/legal-hold plan per `RISKS-AND-COMPLIANCE.md`).

### 2.2 Authorization model
- **Tenant principals** may read/write only Case Objects where `case.tenant_id == sub` (and, for accounts, `tenant_account_id == acct`). They MAY NOT read `review.advice_detection_log`, `review.triage_score`, `defenses_checklist[].attorney_disposition`, or any attorney-only field.
- **Provider principals** may read a Case Object **only after** a valid `Consent` exists with `scope=handoff_to_provider`, `recipient.recipient_type=legal_aid_provider`, `recipient.recipient_id == prv`, `granted=true`, not expired, not revoked (see §5). Provider read scope is **filtered by `consent.data_categories`** — the API redacts any field whose category is not consented (e.g. `sensitive.immigration` is never returned unless `immigration_status` is in `data_categories` *and* the dedicated `store_sensitive_data` consent exists).
- **No principal of any kind** may cause tenant data to be furnished to a landlord/agent. `consent.recipient.recipient_type` cannot be a landlord (schema enum bars it); the gateway additionally blocks landlord-domain delivery targets (FCRA, §5.4).
- **The advice line is attorney-only.** `defenses_checklist[].attorney_disposition` and `defenses_checklist[].attorney_reviewed`, `review.*` dispositions, and any reclassification of `case_type` after the tenant-facing classify are writable only by `provider_attorney`.

### 2.3 Scopes (token `scope` claim)
`case:read`, `case:write`, `document:upload`, `consent:write`, `eligibility:screen`, `reminder:write`, `handoff:read` (provider), `triage:read`, `triage:write` (provider), `attorney:disposition` (attorney only). The gateway maps role → allowed scopes; a request outside scope returns `403 forbidden_scope`.

---

## 3. Tenant PWA API

All tenant endpoints operate on a single Case Object. Reads return the Case Object (or sub-resource); writes return the mutated sub-resource plus the new `ETag`.

### 3.1 Create case — `POST /v1/cases`
Creates a Case Object in `status="intake"`. The first call for a guest mints a `tenant_id` and binds the session.

Request:
```json
{
  "language": "es",
  "contact": { "preferred_name": "A.", "preferred_contact_method": "sms", "safe_to_text": true }
}
```
- `case_type` is **not** accepted on create; it is LLM-classified later and tenant-confirmed. The server sets `case_type="unknown"`, `case_type_confirmed=false`.
- Server sets `case_id`, `schema_version="1.0.0"`, `tenant_id`, `status="intake"`, `created_at`, `updated_at`, `audit.created_by={actor_type:"tenant"|"system"}`, and seeds `status_history[]` with the initial `null -> intake` transition.

Response `201`: full Case Object. `ETag` header set.

### 3.2 Get case — `GET /v1/cases/{case_id}`
Returns the full Case Object filtered to the tenant view (attorney-only fields redacted). Supports `?fields=` sparse projection (JSON-Pointer list) and `?include=timeline,deadlines,eligibility` expansion. `ETag` returned.

### 3.3 Patch case header — `PATCH /v1/cases/{case_id}`
JSON-Merge-Patch for **tenant-writable** scalars only: `language`, `contact.*`, `case_type_confirmed` (true only), `parties.tenant.matches_contact`, `claimed_arrears` confirmation flips, etc. Requires `If-Match`. Attempts to write any `DET`/`SYS`/`const`-guarded field → `400 boundary_violation` or `403 read_only_field`.

### 3.4 Upload document — async OCR/extraction
**Two-step, pre-signed upload + async job.** Raw bytes never transit the JSON API.

1. **Request upload slot** — `POST /v1/cases/{case_id}/documents`
   ```json
   { "mime_type": "image/heic", "byte_size": 1840221, "document_type_hint": "summons_petition" }
   ```
   Response `201`:
   ```json
   {
     "document_id": "doc_01j9z3...",
     "upload": { "method": "PUT", "url": "https://uploads…?sig=…", "expires_at": "2026-06-22T14:20:00Z" },
     "storage_ref": { "uri": "s3://…/doc_01j9z3...", "mime_type": "image/heic" }
   }
   ```
   The `Document` is created with `storage_ref.uri`, `uploaded_at`, `uploaded_by`; `document_type` defaults `unknown`; `ocr_text=null`.

2. **Client PUTs bytes** to `upload.url`, then **finalizes** — `POST /v1/cases/{case_id}/documents/{document_id}:finalize`
   ```json
   { "content_hash_sha256": "ab12…(64 hex)" }
   ```
   Server verifies the hash against the stored object, sets `storage_ref.content_hash_sha256`, `byte_size`, `page_count`, and **enqueues the OCR+extraction job** (see §7.1). Response `202`:
   ```json
   { "document_id": "doc_01j9z3...", "job": { "job_id": "job_01j9z3...", "kind": "ocr_extract", "state": "queued" }, "poll": "/v1/cases/{case_id}/jobs/job_01j9z3..." }
   ```

When the job completes it populates `documents[].ocr_text` (vision, `ocr_model` ∈ {`claude-opus-4-8`,`claude-sonnet-4-6`}), `document_type`+`document_type_confidence`, and `extracted_fields.*` (each a `ConfirmableValue` with `confidence`, `tenant_confirmed=false`, `provenance` incl. citation `locator`). It also seeds candidate `parties.*`, `claimed_arrears`, and `documents[].extracted_fields.court_date` — **all non-authoritative** until confirmed/recomputed. The job NEVER sets `court.court_date`, `court.index_number`, any `deadlines[]`, or `property.bbl` (those are DET/propagated, §3.5).

> **Rent-demand amount input (reconciled with `LEGAL-RULES.md §2.1.1`).** `extracted_fields` is identical across document types, so the dollar amount stated *in the rent demand notice* is captured as `claimed_arrears` **on the `document_type="rent_demand"` document** — `documents[<rent_demand>].extracted_fields.claimed_arrears` — distinct from the top-level `case.claimed_arrears` (the petition total). **No new schema field is needed.** The rent-demand amount-consistency predicate (`LEGAL-RULES.md §5`) compares the two within `amount_match_tolerance_cents`; if the rent-demand document's `claimed_arrears` is absent or `unreadable`, that check is **skipped** (noted), not failed. See §13.7.

### 3.5 Confirm/correct an extracted field — `POST /v1/cases/{case_id}/documents/{document_id}/extracted_fields/{field}:confirm`
`{field}` ∈ the keys of `extracted_fields` (`court_date`, `index_number`, `borough`, `claimed_arrears`, `landlord_name`, `petitioner_name`, `respondent_name`, `premises_address`, `apartment_unit`, `rent_demand_date`, `monthly_rent`, `petition_filed_date`, `service_date`).

Request (confirm as-is):
```json
{ "tenant_confirmed": true }
```
Request (correct):
```json
{ "tenant_confirmed": true, "tenant_corrected_value": { "amount_cents": 412300, "currency": "USD" } }
```
- Sets `extracted_fields.{field}.tenant_confirmed=true`; if corrected, stores `tenant_corrected_value` (authoritative over `value`).
- **Side effects (DET propagation, server-side).** Confirmation never writes a DET field directly; it triggers deterministic propagation/recompute that does. The authoritative side effects are:
  - **`index_number`** → the confirmed value (corrected value if present, else `value`) is **propagated into `court.index_number`** by the Deterministic Engine, and queued for NYSCEF cross-check (§7.3). *(This propagation is authoritative here and is the canonical home of the confirmed index number; it resolves the prior drift where the value stranded on `documents[].extracted_fields.index_number`.)*
  - **`borough`** → propagated into `court.borough` and the mixed-case `court.county` (Borough→county map: `manhattan→New York`, `bronx→Bronx`, `brooklyn→Kings`, `queens→Queens`, `staten_island→Richmond`), both DET-validated. Confirming `index_number`+`borough` enables court-date sourcing (§7.3).
  - **`premises_address`/`apartment_unit`** → triggers BBL resolution (§7.4) → fills `property.address`, `property.apartment_unit`, `property.bbl`, `property.bbl_resolved_via`, `property.geo_confidence` (DET). When GeoSearch returns multiple candidates, the job returns them for tenant disambiguation (§7.4) rather than guessing.
  - **`claimed_arrears`** → propagated into the top-level `case.claimed_arrears` (Money).
  - **deadline anchors** (`service_date`, `petition_filed_date`, `rent_demand_date`) → triggers **deadline recomputation** (§7.2). If any anchor a clock depends on is still unconfirmed, the resulting `deadlines[].risk.uncertain_anchor=true`.
- Response `200`: the updated `ConfirmableValue` + a list of recomputed/propagated dependents (e.g. `{ "propagated": ["/court/index_number"], "deadlines_recomputed": ["dl_…"], "jobs": ["job_resolve_bbl"] }`).
- **Invariant:** no confirmation here ever sets a `DET` field as if it were tenant-authored; it triggers a deterministic recompute/propagation step that does, attributed to `actor_type:"deterministic_engine"` in `audit.events`.

### 3.6 Get timeline — `GET /v1/cases/{case_id}/timeline`
Returns `timeline[]` ordered by `date`. Each `TimelineEvent` carries `kind`, `date`, `date_is_authoritative`, `description` (LLM plain-English), and `deadline_id` when it represents a statutory clock. **Clients MUST visually distinguish `date_is_authoritative=false`** (LLM-extracted, descriptive, *not safe to file on*) from `true` (DET/court-sourced).

> **Single-author rule for statutory-clock kinds.** Timeline events whose `kind` is a statutory clock (`answer_due`) are **DET-created only** and always carry `date_is_authoritative=true` and a linked `deadline_id`. The LLM extraction surface is **barred from emitting `kind ∈ {answer_due, judgment}`** (it may only emit descriptive kinds: `rent_demand_served`, `petition_filed`, `petition_served`, `court_appearance`, `adjournment`, `other`). This prevents an LLM-authored `answer_due` event (with `date_is_authoritative=false`) from colliding with or being mistaken for the real DET clock. A timeline payload that presents an LLM-provenance `answer_due`/`judgment` event is rejected at write with `400 boundary_violation`.

The endpoint also returns `deadlines[]` joined by `deadline_id` so the UI can show `due_date`, `risk.is_imminent`, `risk.is_missed`, `risk.default_risk`, `tenant_confirmed`, `attorney_validated`, and the LLM `explanation`.

### 3.7 Confirm a deadline — `POST /v1/cases/{case_id}/deadlines/{deadline_id}:confirm`
```json
{ "tenant_confirmed": true }
```
Sets `deadlines[].tenant_confirmed=true` (human-confirmed gate). `due_date`/`computed_by`/`computation_basis`/`risk` remain DET and are not writable here. `attorney_validated` is **not** tenant-writable — it flips only via the attorney endpoint (§4.7). Response `200`: updated `Deadline`.

### 3.8 Draft answer (faithful transcription) — `POST /v1/cases/{case_id}/answer_draft/statements`
The tenant submits their own narrative (any `language`); the LLM (Opus 4.8) faithfully transcribes/translates into `answer_draft.factual_statements[]`. **No legal characterization.**

Request:
```json
{ "narrative": "El casero no arregló la calefacción y pagué la renta de marzo en money order.", "source_language": "es" }
```
Response `202` (LLM job) → on completion, appends items to `factual_statements[]`, each with `statement_id`, `text` (transcription/multilingual-rewrite), `source_language`, `tenant_confirmed=false`, `transcription_only=true` (const), and **`provenance.source="llm_generation"`** (the canonical enum value; the LLM rewrote/translated the tenant's words), `provenance.model="claude-opus-4-8"`.

> **Provenance is single-valued.** Each statement has exactly one `provenance.source`. A statement the LLM rewrote/transcribed/translated is `llm_generation`. A statement the tenant typed verbatim with no LLM transformation (e.g. accepted as-is) is `tenant_entered`. The spec never asserts both for one statement, and `llm_transcription` is **not** a legal `Provenance.source` value (faithful-transcription output uses `llm_generation`).

- **Confirm a statement:** `POST /v1/cases/{case_id}/answer_draft/statements/{statement_id}:confirm` → `tenant_confirmed=true`.
- **General denial selection (tenant, not LLM):** `PATCH /v1/cases/{case_id}/answer_draft` `{ "general_denial": true }`.
- **Defenses checklist** is read-only to the tenant: `GET /v1/cases/{case_id}/defenses_checklist` returns items with `surfaced_as="information_not_advice"` (const), `relevance_signal`, `explanation` (general info). `attorney_disposition` and `attorney_reviewed` are **redacted** from the tenant view. The API rejects any tenant write to these (`403 advice_line_attorney_only`).
- **Form-field placement is DET** and is not exposed as a tenant write. When the answer advances, the Deterministic Engine maps confirmed facts → `answer_draft.form_fields[]` with `placed_by="deterministic"` and `validation_state`. The tenant endpoint only *triggers* it: `POST /v1/cases/{case_id}/answer_draft:place` (202 job).

### 3.9 Build evidence packet — `POST /v1/cases/{case_id}/packets/court_packet:assemble`
Assembles the court packet via docassemble + Suffolk AssemblyLine on official NY fillable PDFs → PDF/A (async, §7.5).

Request:
```json
{ "included_evidence_ids": ["ev_01j9z3...", "ev_01j9z3..."] }
```
**Hard preconditions (enforced before the job is enqueued; `409` if violated). These are the canonical assembly gate and are mirrored exactly in `TOOL-CONTRACTS.md` `assemble_packet` (see §13.1):**
1. Every included `evidence[]` item with `origin="open_data"` MUST have `open_data.verify_before_file.state == "verified"`, **and** every `parties.landlord.open_data` assertion referenced by the packet MUST be `verified`. Otherwise `409 unverified_open_data` listing the offending assertion paths. The assembled `Packet.blocked_by_unverified_open_data` is computed DET over **both** evidence open-data and `parties.landlord.open_data`, and MUST be `false` to produce a fileable PDF/A.
2. Every form-driving field MUST be tenant-confirmed (no unconfirmed `ConfirmableValue` may flow into `form_fields[]`); the engine refuses to place an unconfirmed value (`409 unconfirmed_field`).
3. Every `deadlines[]` item referenced for filing MUST have `tenant_confirmed=true`. `attorney_validated=true` is a **soft warning** at court-packet build (the tenant is the filer and may proceed pro se) but a **hard gate** at the `prepared → referred` transition (§6.1 guard, §9). The assembly job records `attorney_validated` status per referenced deadline in its `result` so the caller can surface the warning.

Response `202` with a `job_id`; on completion `packets.court_packet.status` transitions through `assembling → ready` (or `blocked`/`error`), and `storage_ref` (`format:"pdf_a"`, `content_hash_sha256`) is set.

### 3.10 Manage evidence — `POST /v1/cases/{case_id}/evidence`
Creates `EvidenceItem` of `origin` ∈ {`tenant_uploaded`,`tenant_stated`}. `tenant_uploaded` references a `document_id`. LLM tagging (`tags`, `summary`, `supports_defense_codes`) is async (Sonnet/Haiku). **Open-data evidence is created by the system**, not this endpoint; the tenant interacts with it only through the verify gate (§3.11).

### 3.11 Verify-before-file gate — `POST /v1/cases/{case_id}/evidence/{evidence_id}/verify`
The single tenant action that flips an open-data assertion to fileable.
```json
{ "state": "verified", "tenant_note": "I confirmed this HPD violation is still open." }
```
- Writes `evidence[].open_data.verify_before_file = { state, verified_at, verified_by:{actor_type:"tenant"}, tenant_note }`. Allowed transitions: `unverified → verified | disputed`, `disputed → verified`. Cannot set `verified` programmatically/on behalf of the tenant.
- The same gate applies to `parties.landlord.open_data` (registration/standing signals). Verifying there uses `POST /v1/cases/{case_id}/parties/landlord/open_data:verify`.
- **Staleness expiry (config-driven).** A `verified` gate reverts to `unverified` once `now - verify_before_file.verified_at` exceeds `config.verify_gate.staleness_window` (config key `verify_gate.staleness_window`, version-stamped via the open-data ingest config; default value is **attorney/config-owned and unset in v1 — a Phase-0/1 config blocker**, see §13.8). On revert, any packet that included the assertion has `blocked_by_unverified_open_data` recomputed to `true` and is no longer fileable until re-verified. This is the enforcement behind acceptance test AT-3.6.
- **API invariant:** an open-data assertion with `verify_before_file.state != "verified"` MUST NOT enter any `Packet`. Assembly recomputes `blocked_by_unverified_open_data` and refuses (§3.9). This is the machine enforcement of the 22 NYCRR 130 filer-risk rule: the tenant is the filer; nothing open-data is auto-asserted.

### 3.12 Screen eligibility — `POST /v1/cases/{case_id}/eligibility:screen`
**Eligibility is DET.** The LLM is not in this path.

Request:
```json
{ "household_income_cents": 2880000, "household_size": 3, "consent_id": "cns_01j9z3..." }
```
- Requires a `Consent` with `scope=store_sensitive_data` (and `data_categories` incl. `eligibility`) to persist income into `sensitive.household_income_cents`/`sensitive.household_size`. Without it, screening runs ephemerally and persists only the `EligibilityResult` (not the raw income), per data minimization.
- Runs the rules engine and (where applicable) the NYC Benefits Screening API (eligibility-only; `data_source="nyc_benefits_screening_api"` or `internal_rules`). Populates exactly the three canonical slots — `eligibility.rtc`, `eligibility.legal_aid`, `eligibility.rental_assistance` — each an `EligibilityResult` with `determined_by="deterministic"` (const), `determination`, `program`, `rule_ids`, `reasons`, plus top-level `eligibility.config_version` and `eligibility.evaluated_at`.
- **ERAP placement (canonical).** `Eligibility` is `additionalProperties:false` and defines only `rtc`, `legal_aid`, `rental_assistance`, `config_version`, `evaluated_at`. **There is no `eligibility.erap` key.** ERAP is surfaced **inside `eligibility.rental_assistance`** as an `EligibilityResult` with `program="erap"` and `determination="program_unavailable"` (closed). CityFHEPS likewise rides in `rental_assistance` with `program="cityfheps"` and `config_toggle_state ∈ {enabled,disabled}` (active litigation). `TOOL-CONTRACTS.md screen_eligibility` and `LEGAL-RULES.md §8.3/§12` are reconciled to write into this slot (see §13.2); any payload presenting a top-level `eligibility.erap` is rejected `400 schema_invalid`.
- **Config-driven, toggleable** per `RISKS-AND-COMPLIANCE.md`: RTC `≤200% FPL` citywide (monitored config); `program_unavailable` for ERAP (closed); CityFHEPS honors `config_toggle_state`. The `config_version` stamps reproducibility against `LEGAL-RULES.md` (which is the rule registry; its day-counts/FPL multipliers must be attorney-validated before this endpoint may return anything other than `insufficient_data` / `program_unavailable` — see §13.6).
- **`likely_eligible` display rule.** `determination="likely_eligible"` (e.g. RTC) is **internal-triage-grade information**: it MAY be returned to provider triage (`triage:read`) and used for routing, but the tenant-facing PWA MUST render it as a neutral, non-conclusory prompt ("You may qualify for a free attorney — let's connect you to a provider who can confirm"), never as a determination ("You qualify for a free lawyer"). The API tags the field with `display_class="internal_or_softened"` so the PWA can enforce the softened copy. This keeps `likely_eligible` clear of implied legal advice.
- Response `200`: the `eligibility` sub-object. `determination` values are neutral reason-coded results, **not advice** (no "you qualify, so do X").

### 3.13 Opt into reminders — `POST /v1/cases/{case_id}/reminders`
**Consent-gated, DET-scheduled.**

Request:
```json
{ "reminder_type": "court_date", "channel": "sms", "consent_id": "cns_01j9z3..." }
```
- Requires a `Consent` with `scope=sms_reminders`, `granted=true`, `recipient.recipient_type=reminder_service`, not expired/revoked, AND `contact.safe_to_text != false` AND `contact.phone_e164` present. Otherwise `409 reminder_consent_missing` / `409 unsafe_to_text`.
- `scheduled_for` is **DET-computed** from an authoritative source: `court.court_date` (only when `court_date_verified=true`) or a `deadlines[].due_date` referenced by `related_deadline_id`. A reminder MUST NOT be scheduled off an LLM-extracted (`document_extracted_unverified`) date — `409 nonauthoritative_reminder_anchor`. (Wrong-date delivery is a substantive liability vector.)
- **Cadence is version-stamped config**, not hard-coded. The offset schedule lives in config key `reminders.cadence` (e.g. court-date offsets `[-7d, -3d, -1d]`, answer-deadline offsets relative to `due_date`), carried by `reminders.cadence_version` and tied to the deadline-engine `imminent_window`. The concrete offset values are **attorney/ops-owned config** (unset placeholder in v1 — see §13.9). Each offset that resolves to a future instant creates one `Reminder` record in `state="scheduled"`. Copy is LLM-generated (Haiku) at send time; the **date is never model-authored**.
- Cancel: `POST /v1/cases/{case_id}/reminders/{reminder_id}:cancel` (also fired on `consents` revocation and STOP keyword).

### 3.14 Generate handoff packet — `POST /v1/cases/{case_id}/packets/legal_aid_handoff:generate`
Builds the one-page CSR/LIST-tagged intake summary (`LegalAidHandoffPacket`).

Request:
```json
{ "provider_id": "prv_01j9z3...", "consent_id": "cns_01j9z3..." }
```
- **Preconditions (`409` if unmet):**
  - A valid `Consent`: `scope=handoff_to_provider`, `recipient.recipient_type=legal_aid_provider`, `recipient.recipient_id == provider_id`, `granted=true`, not expired/revoked. Per-recipient: a handoff to a different provider needs its own consent record.
  - **`blocked_by_unverified_open_data` MUST be `false`, computed over the full open-data surface** — both `included_evidence_ids[]` open-data items **and** `parties.landlord.open_data` (registration/standing). The handoff generator scans `parties.landlord.open_data` explicitly; an unverified landlord-registration assertion blocks generation (`409 unverified_open_data`). This closes the prior enforcement-point gap where the summary could include an unverified landlord-registration signal.
  - **Consent `data_categories` MUST cover the packet's contents.** Because the `legal_aid_handoff` packet includes eligibility-derived content (RTC/legal-aid results) and CSR/LIST tags derived from case facts, the gating consent's `data_categories[]` MUST include `eligibility` (in addition to `contact`, `case_facts`, and any `documents`/`evidence`/`arrears` actually embedded). If `eligibility` is omitted from the consent, the generator either (a) **omits eligibility content and the eligibility-derived tags** from the packet, or (b) returns `409 consent_category_missing` (`details.missing_categories`) so the tenant can extend consent. Default behavior is (a) redact-and-proceed; the response flags `redacted_categories`. No packet ever carries a category outside the consent (see §13.5).
- Async (Opus 4.8 summary). On completion sets `packets.legal_aid_handoff`: `intake_summary_text` (LLM, information; attorney reviews), `csr_tags` (LSC CSR), `list_tags` (LIST) — tags are **DET-assigned** from the structured case via the deterministic tagging layer keyed to the published CSR/LIST code sets in `LEGAL-RULES.md` (the concrete code set is a Phase-0/1 content blocker — see §13.10) — `status="ready"`, `storage_ref` (PDF/A).
- This **generates** the packet; **delivery** (the actual handoff that can move the case to `referred`) is the provider/handoff flow in §3.15 / §10. Generation alone does not transition status.

### 3.15 Request handoff delivery — `POST /v1/cases/{case_id}/handoff:deliver`
Initiates delivery to the consented provider via LegalServer Trigger XML (or PDF fallback). See §10 for the integration contract. Requires the same consent as §3.14 and a `ready` `legal_aid_handoff` packet. Sets `packets.legal_aid_handoff.delivery` (`ProviderHandoff`: `provider_id`, `consent_id`, `method`, `delivery_state="pending"`). This is what arms the `prepared → referred` transition (§9). Delivery progression and the no-deadlock guarantee are specified in §10.5.

### 3.16 Consent endpoints — `POST /v1/cases/{case_id}/consents`
See §5.

### 3.17 Job polling — `GET /v1/cases/{case_id}/jobs/{job_id}`
See §7.6.

---

## 4. Provider triage console API

Provider endpoints are read-mostly over the consented subset and own the human handoff + the advice line. Base prefix `/v1/provider`.

### 4.1 List/triage intake inbox — `GET /v1/provider/intakes`
Returns a paginated list of Case Objects where this `prv` has a valid `handoff_to_provider` consent and `packets.legal_aid_handoff.delivery.provider_id == prv`. Each row is a **redacted projection** (filtered to consented `data_categories`):
```json
{
  "case_id": "case_01j9z3...",
  "status": "referred",
  "case_type": "nonpayment",
  "court": { "borough": "bronx", "court_date": "2026-07-09", "court_date_verified": true },
  "claimed_arrears": { "amount_cents": 412300, "currency": "USD" },
  "deadlines_summary": { "next_due_date": "2026-07-02", "default_risk": true, "is_imminent": true },
  "csr_tags": ["..."], "list_tags": ["HO-..."],
  "review": { "review_state": "queued", "advice_routed": false, "triage_score": { "score": 0.82 } },
  "handoff": { "delivery_state": "sent", "method": "legalserver_trigger_xml" }
}
```
Query filters: `?status=`, `?borough=`, `?default_risk=true`, `?review_state=`, `?sort=triage_score|court_date|default_risk`. `review.triage_score` is the LLM (Sonnet) routing aid — **information, not a legal conclusion**; it never auto-accepts/declines.

### 4.2 Fetch full intake — `GET /v1/provider/intakes/{case_id}`
Returns the consent-filtered Case Object, including `packets.legal_aid_handoff.intake_summary_text`, `evidence[]` (with `open_data` disclaimers + verify state), `answer_draft.factual_statements[]` (transcription), `defenses_checklist[]` (now with `attorney_disposition`/`attorney_reviewed` **visible to `provider_attorney`**), and `review.advice_detection_log`. Redacts `sensitive.immigration` unless `immigration_status` is in the consent `data_categories` and a `store_sensitive_data` consent exists. `403 consent_required` if no valid consent.

### 4.3 Fetch handoff packet (PDF) — `GET /v1/provider/intakes/{case_id}/packets/legal_aid_handoff`
Returns a short-lived signed URL to the PDF/A (`storage_ref`) plus `csr_tags`/`list_tags`/`included_evidence_ids`. Access logged to `audit.events`. PDF fallback path for CMS-agnostic providers (§10.3).

### 4.4 Accept intake — `POST /v1/provider/intakes/{case_id}:accept`
```json
{ "assigned_attorney_id": "atty_01j9z3...", "note": "Accepted for full representation." }
```
- Sets `review.review_state="in_review"` → on representation, transitions `status: referred → represented` (§9), sets `review.assigned_attorney_id`.
- Idempotent on `Idempotency-Key`. `409 invalid_status_transition` if case is not in `referred`.

### 4.5 Refer onward — `POST /v1/provider/intakes/{case_id}:refer`
Re-routes to another provider (e.g. conflict / population mismatch — LSC vs non-LSC). **Requires a new per-recipient consent** for the new provider (`409 consent_required` otherwise). Does not regress status below `referred`; records the re-route in `audit.events`. Sets `review.review_state="escalated"` if it needs supervising-attorney review first.

### 4.6 Decline intake — `POST /v1/provider/intakes/{case_id}:decline`
```json
{ "reason_code": "capacity", "note": "..." }
```
- Sets `review.review_state="reviewed"`; status remains `referred` (or returns to `prepared` only via the explicit guarded transition in §9 if the tenant chooses to re-route). Decline does **not** delete data; it logs to `audit.events` and notifies the tenant via consented channel.

### 4.7 Attorney disposition & validation (advice-line, attorney-only) — `POST /v1/provider/intakes/{case_id}/review`
Scope `attorney:disposition`, role `provider_attorney` only.
```json
{
  "defenses": [ { "defense_code": "defective_rent_demand", "attorney_reviewed": true, "attorney_disposition": "needs_more_info" } ],
  "deadline_validations": [ { "deadline_id": "dl_01j9z3...", "attorney_validated": true } ],
  "case_type_reclassification": "nonpayment"
}
```
- Writes `defenses_checklist[].attorney_disposition` / `attorney_reviewed` (the advice line), flips `deadlines[].attorney_validated=true`, and may reclassify `case_type` (attorney owns reclassification). **No tenant or LLM principal can write these.**
- `answer_draft.status` may advance `tenant_reviewed → attorney_reviewed → finalized` here.

### 4.8 Advice-routing visibility & single-writer ownership of `review.advice_routed`
`review.advice_routed` has a **single, narrow meaning**: a *tenant conversational turn* was classified advice-seeking by the LLM advice-detection classifier and the deterministic router therefore hard-routed the case to a human. To preserve the UPL audit signal, **`review.advice_routed` has exactly one deterministic writer — the conversational advice-router** (the path described in `GUARDRAILS.md §1`):
- The LLM advice-detection classifier (Haiku, escalating to Sonnet) appends a hit to `review.advice_detection_log[]` (`at`, `classifier_model`, `is_advice_seeking`, `confidence`).
- The deterministic router decides routing and sets `review.advice_routed=true` + `review.review_state="queued"`/`escalated`. Every `advice_routed=true` write MUST have a corresponding `advice_detection_log[]` entry; the API rejects an `advice_routed=true` write with no matching log entry (`400 boundary_violation`).
- **Other deterministic escalations do NOT touch `advice_routed`.** A missed-deadline / default-risk escalation (`LEGAL-RULES.md §4.4`) and an overcharge-signal escalation (`§7.3`) are **not** advice-seeking events; they set `review.review_state="escalated"` **only**, never `advice_routed`. Conflating them would corrupt the audit signal and create multiple uncoordinated writers — explicitly disallowed here (see §13.3). `LEGAL-RULES.md §4.4/§7.3` are reconciled accordingly.

No API lets the LLM set `advice_routed` directly (§6.6). Providers see `advice_routed`, `advice_detection_log`, and `review_state` in §4.1/§4.2.

---

## 5. Consent: model, endpoints, and enforcement points

Consent is the load-bearing compliance primitive: **per-recipient, time-limited, severable, voluntary, written** (`RISKS-AND-COMPLIANCE.md`).

### 5.1 Create consent — `POST /v1/cases/{case_id}/consents`
```json
{
  "scope": "handoff_to_provider",
  "recipient": { "recipient_type": "legal_aid_provider", "recipient_id": "prv_01j9z3...", "recipient_name": "Bronx Legal Aid" },
  "granted": true,
  "expires_at": "2026-09-22T00:00:00Z",
  "consent_text_version": "handoff-v3",
  "data_categories": ["contact", "case_facts", "documents", "arrears", "evidence", "eligibility"],
  "method": "pwa_checkbox"
}
```
- Server mints `consent_id`, stamps `granted_at`. `granted=true` only on affirmative opt-in (default-deny). Appends to `consents[]`.
- **One recipient per record.** A second provider requires a second `Consent`. Severable: revoking one never affects others.
- **Handoff `data_categories` must cover packet contents.** Because the `legal_aid_handoff` packet carries eligibility-derived content and tags, a `handoff_to_provider` consent intended to deliver the full packet SHOULD include `eligibility`. If it does not, packet generation redacts eligibility content (§3.14). The example above includes `eligibility`; a consent that omits it yields a redacted packet, never a scope violation.
- **FCRA hard block:** `recipient.recipient_type` cannot be a landlord/agent (schema enum bars it); the API additionally rejects any `recipient_name`/delivery target matching a known landlord/agent or the case's `parties.landlord` (`403 fcra_landlord_recipient`).

### 5.2 Revoke consent — `POST /v1/cases/{case_id}/consents/{consent_id}:revoke`
Sets `revoked_at`. **Cascade:** cancels dependent `reminders[]`, blocks future handoff delivery on that recipient, and (if it gated `sensitive.*`) marks that sensitive sub-object for retention review. Severable — only this consent's dependents are affected.

### 5.3 Consent enforcement points (where the API checks)
| Action | Required consent (`scope`, recipient, categories) |
|---|---|
| Persist income for eligibility (§3.12) | `store_sensitive_data` incl. `eligibility` |
| Persist `sensitive.immigration` | `store_sensitive_data` incl. `immigration_status` **and** a defense-justified need (`status_relevant_to_defense`) |
| Schedule/send any reminder (§3.13) | `sms_reminders`, recipient `reminder_service`, + `safe_to_text` |
| Generate handoff packet (§3.14) | `handoff_to_provider`, recipient = target `provider_id`; `data_categories` must cover embedded content (incl. `eligibility` for full eligibility section) |
| Deliver handoff / provider read (§3.15, §4.x) | `handoff_to_provider`, recipient = `prv`, unexpired, unrevoked |
| Benefits screening share to agency | `benefits_screening_share`, recipient `benefits_agency` |
| Court filing assistance | `court_filing_assistance` |

Every consent check is evaluated at **request time** (expiry/revocation are live), not cached. **At delivery time (§3.15/§10), the Handoff Service re-validates that every data category present in the assembled packet is covered by the live consent's `data_categories[]`**; a packet carrying a category outside the consent is blocked (`409 consent_category_missing`) rather than delivered. A failed consent check otherwise returns `403 consent_required` / `403 consent_expired` / `403 consent_revoked` with `field_path:"/consents"`.

### 5.4 Sensitive data minimization
`sensitive.immigration` defaults `null` and is collected **only** when a specific defense requires it AND the tenant opted in via the dedicated `consent_id`. The API refuses to store it otherwise (`422 sensitive_not_justified`). Sensitive data is never furnished to landlords and is redacted from provider reads unless explicitly consented (§4.2).

---

## 6. The Case State Machine

`status` ∈ {`intake`, `prepared`, `referred`, `represented`, `resolved`}. **All transitions are DET-guarded** (`status` is `x-provenance: DET`) and recorded append-only in `status_history[]` (`from_status`, `to_status`, `at`, `actor`, `reason`). The LLM never sets `status`.

### 6.1 Transition table

| From | To | Trigger (who/what) | Guard invariants (all must hold) |
|---|---|---|---|
| `null` | `intake` | `POST /v1/cases` (tenant/system) | Case created; `schema_version="1.0.0"`. |
| `intake` | `prepared` | Deterministic Engine, on `POST …:prepare` (tenant action) | (a) `case_type="nonpayment"` AND `case_type_confirmed=true`; (b) all **deadline-anchor** `extracted_fields` used by computed deadlines are `tenant_confirmed=true`; (c) `deadlines[]` recomputed DET with no `risk.uncertain_anchor=true` for any `default_risk` deadline; (d) `court.court_date_verified=true` OR an explicit, logged tenant acknowledgment (`prepare` request body `acknowledge_unverified_court_date:true`) that the date is unverified; (e) **answer-required determination (deterministic): if the deterministic engine determines a nonpayment answer is required to avoid default for this case (i.e. an `answer_due` deadline exists with `default_risk=true`), then `answer_draft.status ∈ {tenant_reviewed, attorney_reviewed, finalized}`; if no such answer-due deadline exists (e.g. an oral answer is permitted and no written answer is required), this guard is satisfied vacuously.** The "answer required?" predicate is a DET function of the computed deadlines, not a free-text "not-yet-required" flag — there is no ambiguous "not yet required" field. |
| `prepared` | `referred` | Handoff delivery (tenant initiates §3.15; system completes on provider receipt) | (a) a valid `handoff_to_provider` `Consent` for the target `prv` (unexpired, unrevoked, default-deny); (b) `packets.legal_aid_handoff.status="ready"` AND `blocked_by_unverified_open_data=false` (computed over evidence open-data **and** `parties.landlord.open_data`); (c) `packets.legal_aid_handoff.delivery.delivery_state` ∈ {`sent`,`acknowledged`} (delivery progression + anti-deadlock in §10.5); (d) any deadline referenced for filing has `attorney_validated=true` (hard gate here). |
| `referred` | `represented` | `provider_attorney` accept (§4.4) | (a) `review.assigned_attorney_id` set; (b) `review.review_state="in_review"`→representation confirmed; (c) actor is `provider_attorney` for the consented `prv`. |
| `represented` | `resolved` | `provider_attorney` or system | (a) actor authorized; (b) `reason` recorded (outcome is a fact log, **not** an LLM outcome prediction). |
| `referred` | `prepared` | Tenant re-route after a provider `decline` (§4.6) | (a) provider declined or consent revoked; (b) re-route requires a fresh per-recipient consent before re-`referred`. (Backward, explicitly allowed.) |
| any | (same) | idempotent re-POST | No-op if already in target state and `Idempotency-Key` matches (§8). |

**Disallowed:** skipping states forward (e.g. `intake → referred`), `resolved → *` (terminal except via attorney-supervised reopen, out of MVP), any LLM-actor transition. Illegal transitions return `409 invalid_status_transition` with the allowed set in `error.details.allowed`.

### 6.2 Transition endpoints
- `POST /v1/cases/{case_id}:prepare` — request `intake → prepared`. Body may carry `acknowledge_unverified_court_date:true` (guard d). Returns `200` with new status or `409 transition_guard_failed` + `error.details.failed_guards: ["court_date_unverified", "answer_required_not_reviewed", ...]`.
- `POST /v1/cases/{case_id}/handoff:deliver` — arms/completes `prepared → referred` (§3.15, §10).
- `POST /v1/provider/intakes/{case_id}:accept` — `referred → represented` (§4.4).
- `POST /v1/provider/intakes/{case_id}:resolve` — `represented → resolved` `{ "reason": "settled_stip" }`.

### 6.3 Cross-cutting invariants (enforced on every write, all states)
1. **No auto-assert of an unconfirmed field into a packet.** A `ConfirmableValue` with `tenant_confirmed=false` cannot populate `answer_draft.form_fields[]` or any `Packet`. (`409 unconfirmed_field`.)
2. **Verify-before-file.** No `evidence[].open_data` or `parties.landlord.open_data` assertion with `verify_before_file.state != "verified"` enters a packet; assembly recomputes `blocked_by_unverified_open_data` over both surfaces and refuses (§3.9, §3.14).
3. **`referred` requires consent + a complete handoff packet + attorney-validated filing deadlines** (table row, guards a–d). No consent → no provider visibility, no transition.
4. **Deadlines are DET + human-confirmed + attorney-validated** to be filing-authoritative. `computed_by` is const `deterministic`; `tenant_confirmed=true` is the human gate (required to leave `intake→prepared` when a filing deadline exists); `attorney_validated=true` is the attorney gate (soft warning at court-packet build per §3.9, hard gate at `prepared→referred`).
5. **The advice line is attorney-only** (§4.7). `defenses_checklist[].attorney_disposition`, reclassification, and outcome are never tenant/LLM-writable.
6. **`review.advice_routed` has a single deterministic writer** — the conversational advice-router with a matching `advice_detection_log[]` entry (§4.8). Other escalations use `review_state="escalated"` only.
7. **Boundary `const`s are immutable by non-DET actors** (§6.6).

### 6.6 Boundary-invariant enforcement (machine-checkable)
The API validates every write against the five schema `const`s and rejects violations with `400 boundary_violation`:
- `deadlines[].computed_by == "deterministic"`
- `eligibility.{rtc,legal_aid,rental_assistance}.determined_by == "deterministic"`
- `answer_draft.form_fields[].placed_by == "deterministic"`
- `answer_draft.factual_statements[].transcription_only == true`
- `defenses_checklist[].surfaced_as == "information_not_advice"`

Additionally, the gateway tags each writer with an `actor_type`; writes to `DET`/`SYS`-provenance fields from a non-`deterministic_engine`/`system` actor are rejected, any field whose `provenance.source` would be `llm_*` for a `DET` field is rejected, and an LLM-provenance timeline event with `kind ∈ {answer_due, judgment}` is rejected (§3.6) — all `400 boundary_violation`.

---

## 7. Async / job patterns

Long-running, LLM, or external-dependency work runs as jobs. The mutating request returns `202 Accepted` + a `job` handle; the client polls (§7.6) or receives a push (§7.7).

### 7.1 OCR + extraction job (`kind: "ocr_extract"`) — §3.4
Pipeline: vision OCR (`ocr_model` Opus 4.8 / Sonnet 4.6) → `documents[].ocr_text`; structured-output extraction (Opus 4.8, `output_config.format` JSON schema) → `extracted_fields.*` as `ConfirmableValue`s; a **second citations pass** (citations incompatible with structured outputs) populates each `provenance.locator` (page/bbox/quote) for the verify-before-file UI; doc classification (Haiku/Sonnet) → `document_type`. Writes only LLM-provenance fields; never `court.court_date`/`court.index_number`/`deadlines[]`/`property.bbl`. Timeline contributions from this surface are descriptive kinds only (§3.6).

### 7.2 Deadline computation job (`kind: "compute_deadlines"`, DET) — §3.5
Deterministic rules engine over tenant-**confirmed** anchors (`service_date`, `petition_filed_date`, `rent_demand_date`, court date). Produces/updates `deadlines[]` with `computed_by="deterministic"`, `computation_basis` (`anchor_event`, `anchor_date`, **canonical `statute_rule_id="nonpayment_answer_window"`** for the answer-due clock — reconciled with `TOOL-CONTRACTS.md §6.3`, see §13.4 — and `rule_version`), `due_date`, and `risk` flags (`is_imminent`, `is_missed`, `default_risk`, `uncertain_anchor`). Emits/links `timeline[]` events with `date_is_authoritative=true` and a `deadline_id`. The LLM may later attach `explanation` (plain-English) but never the math.

> **Inputs and the day-count blocker.** The engine reads tenant-confirmed anchors plus `case.claimed_arrears` and `documents[].extracted_fields.monthly_rent` (confirmed) as available. The concrete day-counts/windows live in `LEGAL-RULES.md` and are **unpopulated/unvalidated in v1** (`attorney_validated_config:false`); until they are populated and attorney-validated, this job returns deadlines flagged `risk.uncertain_anchor=true` and the `:prepare` answer-required guard cannot pass. This is the single largest Phase-0/1 ship blocker (§13.6).

> **Court-day counting requires the holiday calendar.** Any window with `unit: court_days` consumes `calendars/court_holidays.yaml` (NY Unified Court System judicial-holiday source, maintained by the deterministic-engine config owner, version-stamped via `rule_version`). Its absence blocks court-day computation (§13.11).

> **"Satisfied" / default-risk resolution predicate.** `risk.is_missed` and `risk.default_risk` for a filing deadline clear to `false` when the deterministic engine observes a **satisfaction signal**. Because there is no e-filing rail and `answer_draft.status` tops out at `finalized` (drafted, not filed), v1 defines satisfaction as **any** of: (i) a court-sourced docket event (eTrack/NYSCEF, §7.3) indicating an answer/appearance was recorded; or (ii) a tenant-asserted "I filed / I appeared" attestation captured as a `TimelineEvent` of `kind ∈ {court_appearance}` or a dedicated `answer_filed` attestation flag on `answer_draft` (proposed schema addition — see §13.12) with `date_is_authoritative=false` (informational; clears the *imminent reminder* but, on its own, downgrades rather than fully clears `default_risk` until corroborated by (i)). The authoritative clear is (i). This makes default-risk resolvable instead of permanently latched.

### 7.3 Court-date sourcing job (`kind: "source_court_date"`, DET) — eTrack + NYSCEF
Sources the authoritative `court.court_date` from **eTrack email ingest** and the **NYSCEF public docket** (e-filed subset). Sets `court.court_date`, `court.court_date_source` ∈ {`etrack`,`nyscef`,`document_extracted_unverified`,`tenant_entered`}, and `court.court_date_verified=true` **only** for `etrack`/`nyscef`. Also performs the **NYSCEF cross-check of `court.index_number`** (propagated from §3.5). **Never scrapes the live eCourts portal.** A document-extracted date stays `document_extracted_unverified` and is non-authoritative (cannot anchor reminders, §3.13).

> **Source contracts (referenced; concrete schemas are Phase-0/1 deliverables — §13.13).** *eTrack:* a dedicated ingest mailbox parses NY Unified Court System eTrack notification emails into `{index_number, county, court_date, part}`; parse schema + sender allowlist are an integration deliverable. *NYSCEF:* the public docket is queried by `index_number`/county for the next scheduled appearance; query/response shape is an integration deliverable. **Discrepancy handling:** if eTrack and NYSCEF disagree on `court_date`, the job sets the value to the **more recent authoritative source**, records both in `audit.events`, sets `review.review_state="escalated"`, and raises a `court_date_discrepancy` warning surfaced to the tenant ("we found two different dates — please confirm with the court") and to the provider inbox. It never silently picks one without flagging.

### 7.4 BBL resolution & address disambiguation job (`kind: "resolve_bbl"`, DET) — §3.5
NYC **GeoSearch + PLUTO/PAD** (not legacy Geoclient) resolves confirmed `property.address` → `property.bbl` (`^[1-5]\d{9}$`), `bbl_resolved_via` ∈ {`geosearch_pluto`,`geosearch_pad`,`manual`}, `geo_confidence` ∈ {`exact`,`approximate`,`failed`}. The BBL keys the HPD/JustFix open-data lookups (§7.8).

> **Disambiguation wiring (closes the prior gap).** When GeoSearch returns multiple candidates (`AMBIGUOUS_MATCH` in `TOOL-CONTRACTS.md §1`), the job does **not** guess. The job result carries a `candidates[]` array (`{label, bbl, bin, geo_confidence}`) and sets `geo_confidence="approximate"`, leaving `property.bbl` unset. The tenant disambiguates via **`POST /v1/cases/{case_id}/property:resolve_address`** `{ "selected_bbl": "1008440051" }`, which sets `property.bbl` (DET) from the chosen candidate. **`bin` and the candidate set are transient job output, not Case Object fields** (the canonical `Property` has no `bin`); they live only in the job `result` for the duration of disambiguation and are not persisted on the case. This gives the disambiguation UX an API home without inventing non-canonical persisted fields.

### 7.5 Packet assembly job (`kind: "assemble_court_packet" | "generate_handoff"`) — §3.9/§3.14
Self-hosted **docassemble + Suffolk AssemblyLine** fills official NY fillable PDFs → PDF/A. Field **placement/validation is DET** (`form_fields[].placed_by="deterministic"`, `validation_state`). Recomputes `blocked_by_unverified_open_data` over evidence open-data **and** `parties.landlord.open_data`; if any included/referenced open-data assertion is unverified, sets `status="blocked"` and does not emit a fileable PDF. For the court packet, also surfaces per-deadline `attorney_validated` status (soft warning, §3.9). Narrative sections (handoff `intake_summary_text`) are LLM (Opus 4.8, `generated_by_model`); tags (`csr_tags`/`list_tags`) are DET. Status walks `not_started → assembling → ready | blocked | error`.

> **Form-field map blocker.** `form_fields[].form_field_id` values (e.g. `answer.general_denial`, `answer.tenant_name`) and `form_template_version` (e.g. `ny-lt-answer-2025.1`) are **illustrative**. The authoritative AcroForm/AssemblyLine variable map between confirmed Case Object facts and official NY fillable-PDF field ids does not yet exist and is a Phase-0/1 assembly blocker (§13.14). Until it exists, `assemble_court_packet` cannot produce a fileable PDF/A and returns `status="blocked"` with reason `form_map_unavailable`.

### 7.6 Job status — `GET /v1/cases/{case_id}/jobs/{job_id}`
```json
{
  "job_id": "job_01j9z3...", "kind": "ocr_extract",
  "state": "succeeded", "progress": 1.0,
  "result": { "document_id": "doc_01j9z3...", "extracted_field_count": 9, "lowest_confidence": "medium" },
  "error": null, "created_at": "…", "updated_at": "…"
}
```
`state` ∈ {`queued`,`running`,`succeeded`,`failed`,`cancelled`}. On `429`/queued, honor `Retry-After`. Jobs are **idempotent and keyed** — re-finalizing the same `document_id` with the same `content_hash_sha256` returns the existing job, never a duplicate. The `resolve_bbl` job result carries `candidates[]`/`bin` (transient, §7.4); the `assemble_court_packet` result carries per-deadline `attorney_validated` status (§3.9).

### 7.7 Internal push
Job completion publishes an internal event the API uses to (a) update the Case Object, (b) optionally PWA-push/web-push the tenant, and (c) recompute downstream guards (e.g. a completed `source_court_date` may now satisfy a `prepare` guard). This is internal; the only **external** webhook is the handoff/LegalServer flow (§10).

### 7.8 Open-data enrichment job (`kind: "enrich_open_data"`, DET) — HPD + JustFix
After BBL resolution, server-side calls **HPD Violations (`wvxf-dwi5`)**, **HPD Complaints (`ygpa-z7cr`)**, **HPD Registration+Contacts (`tesw-yqqr` + `feu5-w2e2`)**, and **JustFix Who Owns What** (verified endpoints `/api/address`, `/api/address/wowza`, `/api/address/buildinginfo`, `/api/address/indicatorhistory` — **never the full path `/api/address/aggregate`**; NYCDB self-host fallback). Results are written as `evidence[]` with `origin="open_data"` and a populated `open_data` `OpenDataAssertion` (`dataset`, `dataset_version`, `retrieved_at`, `endpoint`, `data_accuracy_disclaimer`, `verify_before_file={state:"unverified"}`), and as `parties.landlord.registered_owner_name`/`wow_landlord_id`/`registration_on_file` (open_data provenance) with their own `parties.landlord.open_data` assertion.

> **Registration expiry mapping (closes the lost-signal gap).** The canonical `parties.landlord` has only the boolean `registration_on_file`; there is no `registration_current` field. The HPD registration lookup (`TOOL-CONTRACTS.md §4`) may distinguish *on-file-but-expired/lapsed* from *current*. v1 maps this deterministically without losing the signal: **`registration_on_file=true` means a *current, non-lapsed* registration exists. An on-file-but-expired/lapsed registration is recorded as `registration_on_file=false`** (no valid current registration — which is the registration-defense-relevant state), with the expiry detail captured in the `parties.landlord.open_data.data_accuracy_disclaimer`/note and surfaced as a `defenses_checklist[]` item `defense_code="not_registered_multiple_dwelling"` with `relevance_signal="possible"`. (A future schema minor may add an explicit `registration_status` enum; until then this mapping is canonical so the registration-defense signal is never silently dropped — §13.4-reg.)

> **Consistent relevance-signal semantics for unverified open-data defenses.** All `defenses_checklist[]` items mirrored from **unverified** open-data assertions use `relevance_signal="possible"` (not `evidence_present`), across sibling tools (HPD violations/complaints, registration, WoW). `relevance_signal="evidence_present"` is reserved for items backed by **tenant-uploaded** or **verified** evidence. This reconciles the prior inconsistency where HPD-violations items used `evidence_present` while registration used `possible`.

Created `unverified` — the tenant must verify before any of it enters a packet (§3.11).

---

## 8. Idempotency & concurrency

- **Idempotency-Key** is **required** on every state-mutating POST/PATCH (create case, finalize upload, confirm field/deadline, screen, reminders, assemble, handoff, accept/refer/decline/resolve, consent create/revoke). The server stores `(idempotency_key, route, request_hash) → response` for ≥24h. A replay with the same key+hash returns the stored response (same status code). Same key + **different** body → `409 idempotency_conflict`.
- **Optimistic concurrency:** `PATCH` and transition endpoints require `If-Match: "<etag>"`. A stale ETag → `412 precondition_failed`; the client re-GETs and retries. This prevents two confirmations or a tenant-confirm racing a DET recompute from clobbering each other.
- **Job idempotency:** the OCR/assembly/handoff jobs are keyed by their content (e.g. document hash, packet input set), so re-enqueue returns the in-flight/finished job.
- **Audit:** every mutation appends to `audit.events[]` (`at`, `actor`, `action`, `field_path`, `model` when LLM). Append-only; supports SHIELD, subpoena/legal-hold.

---

## 9. End-to-end happy path (status-annotated)

1. `POST /v1/cases` → `intake`. (§3.1)
2. Upload petition → finalize → `ocr_extract` job fills `extracted_fields.*` (unconfirmed). (§3.4, §7.1)
3. Tenant confirms `borough`, `index_number`, `service_date`, `petition_filed_date`, `claimed_arrears`, `premises_address`; `case_type_confirmed=true`. Confirmation propagates `court.index_number`, `court.borough`/`court.county`, `case.claimed_arrears` (DET, §3.5).
4. DET jobs fire: `resolve_bbl` → `property.bbl` (or `candidates[]` → tenant disambiguates §7.4); `source_court_date` → `court.court_date_verified=true` (+ index cross-check); `compute_deadlines` → `deadlines[]` (`answer_due`, `default_risk`, `statute_rule_id="nonpayment_answer_window"`); `enrich_open_data` → open-data `evidence[]` + `parties.landlord.open_data` (`unverified`). (§7.2–7.4, §7.8)
5. Tenant confirms the `answer_due` deadline (§3.7); submits narrative → `factual_statements[]` (`llm_generation`); confirms statements (§3.8); verifies the open-data HPD violation and the landlord-registration assertion (§3.11).
6. `POST …:prepare` → guards pass (incl. answer-required determination, court-date verified, no uncertain default-risk anchor) → `prepared`. (§6.2)
7. Tenant consents to a provider (`handoff_to_provider`, `data_categories` incl. `eligibility`), generates the handoff packet (`ready`, not blocked — open-data + landlord registration verified), and delivers it (§3.14–3.15, §10).
8. Delivery `sent`/`acknowledged` + consent valid + packet ready + filing deadlines `attorney_validated` → `prepared → referred`.
9. Provider attorney accepts (§4.4) → `referred → represented`, sets `assigned_attorney_id`, validates deadlines (`attorney_validated=true`) and dispositions defenses (§4.7).
10. Outcome recorded → `represented → resolved`. (§6.2)

---

## 10. Handoff to LegalServer Online Intake (+ PDF fallback)

### 10.1 Trigger XML push (primary)
`POST /v1/cases/{case_id}/handoff:deliver` with `{ "method": "legalserver_trigger_xml", "provider_id": "prv_…", "consent_id": "cns_…" }`. The Handoff Service builds a LegalServer **Online Intake Trigger** XML carrying the consented, redacted subset (filtered to `consent.data_categories`, re-validated at delivery per §5.3): contact, premises address, `court` coordinates, `claimed_arrears`, `csr_tags` (LSC CSR), `list_tags` (LIST, `HO-` housing codes), `intake_summary_text`, eligibility section (only if `eligibility` is a consented category), and attached documents (≤100MB). It POSTs to the **per-provider** intake site (N integrations, one per provider). Sets `ProviderHandoff.delivery_state`: `pending → sent`; on the provider's acknowledgment callback → `acknowledged` + `external_reference` (provider-side intake id). Trigger API passes only "limited" fields — anything beyond uses the PDF fallback.

### 10.2 Inbound provider webhook — `POST /v1/provider/webhooks/legalserver`
Authenticated (per-provider HMAC signature, `prv` scoping). Receives delivery acknowledgments and intake-status updates; the API maps them to `delivery_state` (`acknowledged`/`failed`) and may arm the `prepared → referred` completion (§6.1). Idempotent on the provider's event id. Signature failure → `401 webhook_signature_invalid`.

### 10.3 PDF-packet fallback (CMS-agnostic)
If a provider has no LegalServer site or the Trigger push fails, `method="pdf_packet_fallback"`: the `legal_aid_handoff` PDF/A (§3.14) is delivered via a secure, consent-scoped, short-lived signed link (provider pulls it via §4.3) or an out-of-band channel the provider configured. `delivery_state` tracks `pending → sent → acknowledged`. Falling back never bypasses consent, the consent-category check, or the verify-before-file gate.

### 10.4 Delivery invariants
- Delivery requires a live `handoff_to_provider` consent for that exact `provider_id`; revocation mid-flight aborts (`409 consent_revoked`) and no further data is sent.
- `blocked_by_unverified_open_data` must be `false` (over evidence open-data **and** `parties.landlord.open_data`).
- Every category in the assembled packet is covered by the live consent's `data_categories[]` (re-validated at delivery; otherwise `409 consent_category_missing`).
- Tenant data is **never** delivered to a landlord/agent target (FCRA; §5.4).

### 10.5 Delivery progression & anti-deadlock (closes the `pending` deadlock gap)
The Trigger POST is **async/queued**, so `delivery_state` does not flip synchronously. To prevent a case sitting in `prepared` with `delivery_state="pending"` indefinitely:
- On `:deliver`, the Handoff Service enqueues the Trigger POST and sets `delivery_state="pending"`. A **synchronous accepted-by-queue** result (HTTP 2xx from the queue, not the provider) is required before `:deliver` returns `202`; a queue-enqueue failure returns `503 dependency_unavailable`.
- The delivery worker retries the provider POST with bounded exponential backoff (config `handoff.delivery.max_attempts`, `handoff.delivery.backoff`). On the **first successful provider HTTP 2xx** it flips `pending → sent`; the provider acknowledgment webhook (§10.2) flips `sent → acknowledged`.
- A **delivery timeout** (`handoff.delivery.timeout`, version-stamped config) bounds the `pending` state: on expiry the worker sets `delivery_state="failed"`, raises `handoff_delivery_failed` (surfaced to tenant + provider inbox), and the case **remains in `prepared`** (it never advances to `referred` on a failed/timed-out delivery). The tenant may retry `:deliver` (idempotency-keyed) or re-route to another provider (requiring a fresh consent). There is thus always a terminal outcome (`sent`/`acknowledged` → advance, or `failed` → stay + retry surface) — no indefinite deadlock.
- The transition `prepared → referred` (§6.1 guard c) fires only on `delivery_state ∈ {sent, acknowledged}`, never on `pending` or `failed`.

---

## 11. Error code catalog (selected, stable tokens)

| HTTP | `error.code` | When |
|---|---|---|
| 400 | `boundary_violation` | Write would set a `const`/DET field improperly, an LLM-provenance statutory-clock timeline event, or `advice_routed=true` with no matching `advice_detection_log` entry (§6.6, §3.6, §4.8). |
| 400 | `schema_invalid` | Payload fails Case Object JSON Schema (e.g. a top-level `eligibility.erap` key). |
| 401 | `unauthenticated` / `webhook_signature_invalid` | Missing/invalid token or webhook HMAC. |
| 403 | `forbidden_scope` | Token scope insufficient. |
| 403 | `consent_required` / `consent_expired` / `consent_revoked` | Consent enforcement point failed (§5.3). |
| 403 | `advice_line_attorney_only` | Tenant/LLM attempted an attorney-only write (§4.7, §6.3.5). |
| 403 | `fcra_landlord_recipient` | Recipient/delivery target is a landlord/agent (§5.1). |
| 403 | `read_only_field` | Write to a SYS/DET field by a non-authorized actor. |
| 409 | `invalid_status_transition` | Illegal `status` transition; `details.allowed` lists valid targets. |
| 409 | `transition_guard_failed` | Transition guards unmet; `details.failed_guards` enumerated (§6.2). |
| 409 | `unverified_open_data` | Open-data assertion (evidence or `parties.landlord.open_data`) not `verified` entering a packet (§3.9, §3.14, §6.3.2). |
| 409 | `unconfirmed_field` | Unconfirmed `ConfirmableValue` flowing into a packet/form (§6.3.1). |
| 409 | `consent_category_missing` | Packet/delivery carries a data category outside the consent's `data_categories` (§3.14, §5.3, §10.4). |
| 409 | `nonauthoritative_reminder_anchor` | Reminder anchored on a non-verified date (§3.13). |
| 409 | `reminder_consent_missing` / `unsafe_to_text` | SMS consent/`safe_to_text` gate (§3.13). |
| 409 | `handoff_delivery_failed` | Trigger delivery timed out/failed; case stays `prepared`, retry surface (§10.5). |
| 409 | `idempotency_conflict` | Same key, different body (§8). |
| 412 | `precondition_failed` | Stale `If-Match` ETag (§8). |
| 422 | `sensitive_not_justified` | Storing `sensitive.immigration` without defense justification + consent (§5.4). |
| 429 | `rate_limited` | Honor `Retry-After`. |
| 503 | `dependency_unavailable` | External DET dependency (GeoSearch/HPD/JustFix/eTrack/NYSCEF/Benefits/LegalServer queue) down; jobs retry with backoff. |

---

## 12. Implementation notes / non-goals

- **No programmatic e-filing rail.** Pro se tenants are statutorily exempt from mandatory e-filing; output is a print-ready / NYSCEF-uploadable **PDF/A** plus an opt-in assisted-upload checklist. The API exposes **no** "file to court" endpoint.
- **Court-date sourcing never scrapes the live eCourts/WebCivil portal** — eTrack email ingest + NYSCEF public docket only (§7.3).
- **LLM calls run inside the SHIELD boundary** with data minimization (don't send `sensitive.immigration` to the model unless a specific defense requires it); model ids are the exact strings `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5` (no date suffix), stamped into `provenance.model` and `audit.events[].model`.
- **Prompt-cache** the KB/system prefix and form-field maps; keep the per-case payload after the last cache breakpoint.
- **Config-driven legal rules** (`eligibility.config_version`, `deadlines[].computation_basis.rule_version`, `consents[].consent_text_version`, `OpenDataAssertion.dataset_version`, `reminders.cadence_version`, `verify_gate.staleness_window`): ERAP → `program_unavailable` (inside `rental_assistance`); CityFHEPS → `config_toggle_state` (inside `rental_assistance`); RTC ≤200% FPL monitored config. Anything legally/temporally sensitive is version-stamped for audit/reproducibility.

---

## 13. Cross-spec reconciliations & open build blockers

This section records the resolutions of inter-spec drift and the acknowledged Phase-0/1 blockers, so an implementer sees them in one place.

**Reconciliations (resolved in this document):**
1. **§13.1 — Packet assembly gate parity.** The court-packet assembly gate (§3.9) is the canonical superset and MUST be mirrored by `TOOL-CONTRACTS.md assemble_packet`: `blocked_by_unverified_open_data=false` (over evidence open-data **and** `parties.landlord.open_data`) AND all required `form_fields.validation_state=valid` AND every filing-referenced deadline `tenant_confirmed=true`, with `attorney_validated` a soft warning at court-packet build and a hard gate at `prepared→referred`. `assemble_packet` MUST add the deadline checks.
2. **§13.2 — ERAP slot.** ERAP/CityFHEPS are `EligibilityResult`s inside `eligibility.rental_assistance` (`program="erap"|"cityfheps"`), never a sibling `eligibility.erap` key (`Eligibility` is `additionalProperties:false`). `TOOL-CONTRACTS.md §7` and `LEGAL-RULES.md §8.3/§12` reconcile here.
3. **§13.3 — `advice_routed` single writer.** Only the conversational advice-router writes `review.advice_routed` (with a matching `advice_detection_log` entry). Default-risk (`LEGAL-RULES.md §4.4`) and overcharge (`§7.3`) escalations set `review.review_state="escalated"` only.
4. **§13.4 — `statute_rule_id`.** The answer-due deadline uses canonical `statute_rule_id="nonpayment_answer_window"` everywhere (`TOOL-CONTRACTS.md §6.3` reconciles from `rpapl_answer_window`). **§13.4-reg** — registration expiry maps via `registration_on_file` semantics (current=true, lapsed/expired=false) with detail in the open-data note (§7.8).
5. **§13.5 — Consent categories vs packet contents.** At generation and at delivery, packet contents are reconciled against `consent.data_categories`; eligibility content requires the `eligibility` category or is redacted (§3.14, §5.3, §10.4).
6. **Provenance value.** Faithful-transcription statements use `provenance.source="llm_generation"` (single-valued); `llm_transcription` is not a legal enum value (§3.8). `data-security` references to `llm_transcription` map to `llm_generation`.
7. **§13.7 — Rent-demand amount (reconciled with `LEGAL-RULES.md §2.1.1`).** The rent-demand notice amount is `claimed_arrears` on the `document_type="rent_demand"` document (`extracted_fields` is per-document), distinct from the petition's top-level `case.claimed_arrears`. The amount-consistency predicate (§5) compares the two; it is `insufficient_data` **only** when the rent-demand document's `claimed_arrears` is absent/`unreadable` (check skipped, not failed). No new schema field needed (§3.4).
8. **§13.8 — JustFix forbidden endpoint** is the full path `/api/address/aggregate` (§7.8).

**Acknowledged Phase-0/1 build blockers (not resolvable in an API spec; owned by `LEGAL-RULES.md`/config/integration deliverables):**
- **§13.6 — Day-counts/thresholds/FPL multipliers** in `LEGAL-RULES.md` are unpopulated/`attorney_validated_config:false`. `compute_deadlines` and `screen_eligibility` cannot ship real values until populated + attorney-validated (returns `insufficient_data`/`uncertain_anchor` meanwhile).
- **§13.9 — Reminder cadence** offsets (`reminders.cadence`/`cadence_version`) unset.
- **§13.8(gate) — Verify-gate staleness window** (`verify_gate.staleness_window`) unset.
- **§13.10 — CSR/LIST code sets** and their deterministic assignment rules unspecified; handoff tags blocked until published.
- **§13.11 — Court-holiday calendar** (`calendars/court_holidays.yaml`) source/owner/contents required for `court_days` counting.
- **§13.12 — "Answer filed" satisfaction marker (reconciled with `LEGAL-RULES.md §4.3.1`; not a blocker).** No new canonical field is introduced for MVP. The satisfaction predicate is the disjunction of (1) a court-sourced docket event (`timeline[]`, `date_is_authoritative=true`, `court_date_source ∈ {etrack,nyscef}`) — authoritative, fully clears `default_risk`; and (2) a tenant-attested filing marker on `timeline[]` (`kind="other"` + structured tag `answer_filed_attested`, `date_is_authoritative=false`) plus `answer_draft.status="finalized"` — clears `is_missed` but keeps a soft advisory until a court-sourced event confirms. Default = not satisfied (fail-safe). An explicit `answer_filed` field is a recommended v1.1 addition.
- **§13.13 — eTrack parse schema + NYSCEF query/response** contracts and discrepancy surfacing are integration deliverables (§7.3).
- **§13.14 — NY fillable-PDF AcroForm/AssemblyLine field map** (`form_template_version`, `form_field_id` set) does not exist; court-packet assembly returns `status="blocked"` (`form_map_unavailable`) until delivered.
- **§13.15 — NYC Benefits Screening API** request/response/auth/fallback contract unspecified; `screen_eligibility` falls back to `internal_rules` until the integration is defined.