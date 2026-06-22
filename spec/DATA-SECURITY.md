# Data Model, Storage, Consent & Security

# Data Model, Storage, Consent & Security

**Product:** Housing Court Copilot — legal-aid intake autopilot for NYC nonpayment eviction defense (mobile-first PWA).
**Scope of this spec:** Storage, encryption, retention, role-based access, consent, legal-hold/subpoena response, the FCRA red line, breach-notification posture, and the LLM-inference data boundary for the canonical Case Object `housing_court_copilot.case` (schema_version `1.0.0`).
**Status:** Implementation spec. Every policy below maps to specific Case Object field paths. Where a field name appears, it is the exact canonical `snake_case` path — do not rename.
**Governing risk facts:** NY SHIELD Act (private information security), SHIELD + immigration exposure, FCRA bar on furnishing tenant data to landlords, S7263 chatbot-proprietor civil liability, 22 NYCRR 130 (tenant is the filer), UPL boundary, supervising attorney engaged from Phase 0.

---

## 0. Data Classification

Every field in the Case Object is assigned a sensitivity class. The class drives the encryption tier, retention class (`audit.data_retention_class`), RBAC default, and the redaction policy for LLM calls (§9, §11). Classification is derived from the field's content, not its provenance.

| Class | Definition | Case Object fields (representative) | `audit.data_retention_class` |
|---|---|---|---|
| **C0 — System/structural** | Identifiers, timestamps, enums, provenance metadata. Not PII on its own. | `case_id`, `schema_version`, `tenant_id`, `tenant_account_id`, `status`, `status_history[]`, `created_at`, `updated_at`, all `*_id`, `*_confidence`, `*_source`, `*_by`, `*_version`, `audit.events[]` (field paths + actors, not values) | `standard` |
| **C1 — Case PII** | Tenant identity, contact, case facts, documents, arrears. NY SHIELD "private information" when combined with name. | `contact.full_name`, `contact.preferred_name`, `contact.phone_e164`, `contact.email`, `contact.mailing_address`, `parties.tenant.name`, `documents[].ocr_text`, `documents[].extracted_fields.*`, `documents[].storage_ref.uri`, `claimed_arrears`, `property.address`, `property.bbl`, `answer_draft.factual_statements[].text`, `evidence[]`, `court.index_number`, `timeline[].description` | `standard` |
| **C2 — Highly sensitive PII** | SHIELD-elevated + immigration + financial. Collection is opt-in and defense-justified. | `sensitive.immigration` (entire sub-object), `sensitive.benefits_enrollment`, `sensitive.household_income_cents`, `sensitive.household_size`, `eligibility.*` results derived from C2 inputs | `sensitive` |
| **C3 — Open-data-derived** | Third-party open data; tenant bears 22 NYCRR 130 risk. Not PII about the tenant per se, but governs filing risk and the FCRA red line (never about the tenant's creditworthiness; never furnished to a landlord). | `parties.landlord.registered_owner_name`, `parties.landlord.wow_landlord_id`, `parties.landlord.registration_on_file`, `parties.landlord.open_data`, `evidence[].open_data`, `OpenDataAssertion.*` | `standard` (the assertion), but the **derived filing** inherits the source's `verify_before_file` gate |

A case that has any C2 field populated has `audit.data_retention_class = "sensitive"` and is governed by the shorter, opt-in retention rules in §5. A case with no C2 data uses `standard`. `minimized` is the class for anonymous/guest sessions (`tenant_account_id = null`) that never advanced past `status = "intake"` — see §5.4.

---

## 1. Data-Minimization Defaults

Minimization is enforced at three layers: schema defaults, write-time guards, and the C2 collection gate.

### 1.1 Schema-level defaults (from naming conventions)
- Nullable scalars default `null`; arrays default empty; booleans default `false`. **Absence of a value is never treated as a value, and absence of confirmation is never confirmation.**
- `sensitive.immigration`, `sensitive.benefits_enrollment`, `sensitive.household_income_cents`, `sensitive.household_size` all default `null`. The application MUST NOT populate any of these unless §1.3 is satisfied.

### 1.2 Immigration status — NOT collected unless a specific defense requires it
This is the load-bearing minimization rule (SHIELD + immigration exposure).

`sensitive.immigration` MUST remain `null` unless ALL of the following hold, checked by deterministic write-time code:
1. A supervising attorney (or the deterministic defense engine surfacing a defense for attorney review) has flagged a specific defense that requires immigration status. The justification is recorded on `sensitive.immigration.status_relevant_to_defense = true`.
2. The tenant has affirmatively opted in via a `Consent` record with `scope = "store_sensitive_data"` whose `data_categories` includes `immigration_status`. The `consent_id` of that record is written to `sensitive.immigration.consent_id` (required by schema — the field cannot be persisted without it).
3. The consent is currently valid: `granted = true`, `revoked_at = null`, and `expires_at` is null or in the future.

If any condition fails, the write is rejected. The PWA MUST NOT render an immigration-status input field unless a `store_sensitive_data` consent gate has already been presented and accepted. Free-text fields (`sensitive.immigration.notes`) are TEN-provenance and follow the same gate.

> **Hard invariant:** The intake UI never asks "what is your immigration status?" as a default question. It is reachable only down a defense-specific branch that the deterministic engine opens and the attorney owns.

### 1.3 General C2 collection gate (immigration, benefits, finances)
For any C2 field:
- `sensitive.benefits_enrollment` requires a `store_sensitive_data` consent whose `data_categories` includes `benefits_enrollment`; the `consent_id` is written to `sensitive.benefits_enrollment.consent_id`.
- `sensitive.household_income_cents` / `sensitive.household_size` are collected only when RTC/legal-aid/rental-assistance screening is actively running (the deterministic `Eligibility` engine requests them) AND a `store_sensitive_data` consent covering `eligibility` is present. They feed `eligibility.rtc` (≤200% FPL), `eligibility.legal_aid`, `eligibility.rental_assistance` — all `determined_by = "deterministic"`.

### 1.4 What is never collected
- No SSN, no DOB beyond what a document extraction surfaces (and that is C1, tenant-confirmable, not separately solicited).
- No landlord-side PII beyond what the petition/open data already exposes (names, registration contacts). This is never used to score or profile the tenant.
- `contact.safe_to_text` exists specifically so DV/safety-sensitive tenants can suppress SMS; if `false`, no `Reminder` with `channel = "sms"` may be scheduled regardless of consent.

---

## 2. Encryption in Transit

| Channel | Requirement |
|---|---|
| PWA ↔ API | TLS 1.3 (TLS 1.2 floor with PFS cipher suites only). HSTS with `max-age ≥ 31536000; includeSubDomains; preload`. No mixed content. |
| API ↔ datastore / object store | TLS 1.2+ on all connections; mutual TLS where the datastore supports it. |
| API ↔ Anthropic (LLM inference) | TLS 1.3 to `api.anthropic.com`. Payloads are pre-redacted per §11 before they leave the trust boundary. |
| API ↔ integration targets (NYC GeoSearch, HPD Socrata, JustFix WoW, NYC Benefits Screening, LegalServer, docassemble, eTrack/NYSCEF ingest, SMS gateway) | TLS 1.2+. Outbound only. Open-data lookups carry no C1/C2 tenant PII beyond the premises address needed for resolution (`property.address` → BBL); see §6.2. |
| SMS delivery (`Reminder` with `channel = "sms"`) | Carrier transport is not end-to-end encryptable; reminder bodies MUST be content-minimized (see §6.3). Gated by `contact.safe_to_text` and a `sms_reminders` consent. |

- Certificate pinning is applied in the PWA service worker for the API origin where the platform supports it.
- All object-store URIs in `documents[].storage_ref.uri` and `packets.*.storage_ref.uri` are served only via short-lived (≤15 min) signed URLs scoped to an authenticated, RBAC-authorized principal; never public.

---

## 3. Encryption at Rest

Three tiers keyed to the data classification in §0.

| Tier | Applies to | Mechanism |
|---|---|---|
| **Base AES-256** | All C0/C1 data in the primary datastore and object store | Storage-layer AES-256 (e.g. AES-256-GCM) with keys in a managed KMS/HSM. Per-environment data encryption keys (DEKs) wrapped by a KMS key-encryption key (KEK). |
| **Application-layer envelope encryption** | All C2 fields (`sensitive.*` and `eligibility.*` results derived from them) | Each C2 sub-object is encrypted application-side with a per-case DEK before it touches the datastore, so plaintext C2 never lands in the database, search index, logs, or backups. The per-case DEK is wrapped by a KMS KEK. Decryption requires both the KMS grant and an RBAC authorization carrying the right to read C2 (§7). |
| **Document/packet object encryption** | `documents[].storage_ref` raw uploads, `packets.court_packet`/`packets.legal_aid_handoff` PDFs | Server-side AES-256 at the object store plus envelope-wrapped keys. `content_hash_sha256` on the object (already in the schema) is verified on read to detect tampering. |

- **Key rotation:** KEKs rotate on a fixed schedule (≤365 days) and on suspected compromise; rotation re-wraps DEKs without re-encrypting bulk data. Per-case C2 DEKs are destroyed on secure deletion (§5.5) — destroying the DEK cryptographically erases the C2 data ("crypto-shredding").
- **Backups** inherit the same encryption and the same retention/deletion rules; a secure-deletion event MUST propagate to backups within the backup retention window, and crypto-shredding the C2 DEK renders C2 backups unreadable immediately.
- `audit` is append-only and encrypted at the base tier; `audit.events[]` records `field_path` and `actor` but MUST NOT record C1/C2 field *values*.

---

## 4. The Consent Object

The `consents[]` array is the legal and technical spine of every data-sharing and storage decision. Each element is a `Consent` (`consent_id` prefix `cns_`). The schema already enforces the four required properties of valid consent; this section specifies the runtime semantics.

### 4.1 The four properties, mapped to fields
| Property | Field enforcement |
|---|---|
| **Granular / per-recipient** | One `Consent` record per recipient. `recipient.recipient_type` ∈ {`legal_aid_provider`, `court`, `benefits_agency`, `reminder_service`, `attorney`}. `recipient_id` / `recipient_name` name the single specific recipient. A consent authorizes exactly one recipient — never a class. |
| **Granular / per-category** | `data_categories[]` lists exactly which categories this consent covers (`contact`, `case_facts`, `documents`, `arrears`, `eligibility`, `immigration_status`, `benefits_enrollment`, `evidence`). A handoff may share only the intersection of what the recipient needs and what `data_categories` permits (see §4.5 for the at-delivery reconciliation). |
| **Time-limited** | `expires_at`. Consent is invalid at or after this instant. Default-set an expiry on every record (e.g. matched to case lifecycle); a `null` `expires_at` is permitted only with explicit product sign-off and is treated as "until revoked." |
| **Severable** | `revoked_at` is independent per record. Revoking one consent (e.g. SMS reminders) MUST NOT affect any other (e.g. provider handoff). Each `scope` lives in its own record where practical. |
| **Voluntary** | `granted = true` only on an affirmative opt-in action. Default-deny: a missing or `false` `granted` is no consent. |
| **Written** | `consent_text_version` records the exact version of the consent language the tenant agreed to; `method` ∈ {`pwa_checkbox`, `pwa_signature`, `verbal_logged`}. The text version is retained for the legal record. |

### 4.2 Consent is never a precondition of service
The tenant can complete intake, see the plain-English timeline, receive deterministic deadline computations, draft answer fields, and assemble a tenant-only packet **without granting any optional consent.** Specifically:
- No `Consent` is required to populate or use C0/C1 fields the tenant entered or uploaded themselves.
- The only consents are *outbound-sharing* and *sensitive-storage* gates: `handoff_to_provider`, `court_filing_assistance`, `benefits_screening_share`, `sms_reminders`, `store_sensitive_data`.
- Declining `store_sensitive_data` simply means `sensitive.*` stays `null` and any eligibility result that needs that input returns `determination = "insufficient_data"` — it never blocks the rest of intake.
- Declining `handoff_to_provider` produces the PDF-packet fallback the tenant downloads themselves (`packets.legal_aid_handoff` is generated but `delivery` is `null`).

### 4.3 Consent validity check (deterministic, called before every gated action)
A consent is **active** iff: `granted == true` AND `revoked_at == null` AND (`expires_at == null` OR `expires_at > now`) AND the action's `scope` matches `Consent.scope` AND the recipient matches AND every data category the action will transmit is in `data_categories[]`. This check is deterministic code, logged to `audit.events[]`, and runs immediately before:
- Any `ProviderHandoff` (requires active `handoff_to_provider` consent whose `consent_id` is written to `packets.legal_aid_handoff.delivery.consent_id`; subject to the at-delivery category reconciliation in §4.5).
- Any `Reminder` send (requires active `sms_reminders` consent; `reminders[].consent_id` references it; plus `contact.safe_to_text != false` for SMS).
- Any benefits-screening share (`benefits_screening_share`).
- Any persistence of `sensitive.*` (`store_sensitive_data`; `consent_id` written into the sub-object).

### 4.4 Revocation
Revocation sets `revoked_at` and triggers: cancellation of any `reminders[]` tied to that `consent_id` (state → `cancelled`); halt of any pending `ProviderHandoff` with `delivery_state = "pending"`; and, for a revoked `store_sensitive_data` consent, crypto-shredding of the C2 fields that consent gated (§5.5) unless another active consent independently authorizes their retention. Revocation is logged to `audit.events[]`.

### 4.5 Packet contents MUST reconcile against consent `data_categories` at delivery time
This is a hard, deterministic gate run **at delivery** (immediately before `ProviderHandoff.delivery_state` leaves `pending`), closing the gap where a handoff packet can carry more than the consent authorizes:

1. The delivery engine computes the set of **data categories actually present** in the outbound `packets.legal_aid_handoff` payload. The mapping is fixed:
   - `intake_summary_text`, `answer_draft.factual_statements[]` content → `case_facts`
   - `contact.*` fields → `contact`
   - included `documents[]` / `documents[].ocr_text` → `documents`
   - `claimed_arrears` → `arrears`
   - included `evidence[]` (incl. `included_evidence_ids`) → `evidence`
   - **any `eligibility.*` result, `csr_tags`, or `list_tags` derived from eligibility → `eligibility`**
   - any `sensitive.immigration` reference → `immigration_status`; any `sensitive.benefits_enrollment` reference → `benefits_enrollment`
2. Delivery is **permitted only if every present category is in the matching `handoff_to_provider` consent's `data_categories[]`.** If a category is present but not authorized, the deterministic engine MUST either (a) redact that content from the packet before delivery, or (b) block delivery (`delivery_state` stays `pending`, an attorney/UI prompt is raised to re-consent for the missing category). It MUST NOT silently deliver out-of-scope content.
3. In particular: because the one-page `legal_aid_handoff` includes eligibility-derived content and CSR/LIST tags, a handoff consent that omits `eligibility` from `data_categories[]` either blocks delivery or forces eligibility content to be stripped (including the eligibility-derived `csr_tags`/`list_tags`). The default consent flow for `handoff_to_provider` therefore SHOULD surface `eligibility` as a category the tenant is asked to authorize when an intake summary will carry it.
4. The reconciliation result (categories present, categories authorized, action taken) is logged to `audit.events[]`.

---

## 5. Retention & Secure Deletion

### 5.1 Retention is keyed to `audit.data_retention_class` and `status`
| Retention class | Trigger to start the clock | Default retention | Notes |
|---|---|---|---|
| `minimized` | Guest/anonymous session (`tenant_account_id = null`) idle in `status = "intake"` | 30 days idle, then purge | No account to return to; minimize exposure. |
| `standard` | `status` reaches `resolved`, OR case inactive | Retain through the matter lifecycle + a fixed legal-defensibility window after `resolved` (config-driven; e.g. statute-of-limitations-aware), then purge C1 | Document originals (`documents[].storage_ref`) follow the same clock. |
| `sensitive` | Any C2 field populated | Shortest viable: purge `sensitive.*` as soon as the defense/eligibility need ends OR consent expires/revokes, whichever first | C2 retention is never longer than C1 retention; usually much shorter. |

- Retention windows are **config-driven and version-stamped** (a `retention_config_version`, owned by the deterministic layer, analogous to `eligibility.config_version`) so that a change is auditable and reproducible. The supervising attorney owns the legal-defensibility window value.
- A case under legal hold (`audit.legal_hold = true`) is exempt from automatic purge until the hold clears (§8).

### 5.2 What is deleted vs. retained on purge
On a `standard` purge after the legal-defensibility window:
- **Deleted:** all C1 values (`contact.*`, `documents[].ocr_text`, `documents[].extracted_fields.*`, `documents[].storage_ref` objects, `evidence[]`, `answer_draft.factual_statements[].text`, `claimed_arrears`, `property.address`/`bbl`, `timeline[].description`), all C2 (already crypto-shredded or shredded now), and the assembled `packets.*` PDFs.
- **Retained (C0 skeleton):** `case_id`, `schema_version`, `status` + `status_history[]`, `created_at`/`updated_at`, the `audit.events[]` trail (field paths/actors/models only — no values), and `consents[]` metadata (the legal record of who consented to what, when, under which `consent_text_version`) minus any free-text. This skeleton supports defensibility and SHIELD breach-scoping without retaining the underlying private information.

### 5.3 Open-data freshness vs. retention
`evidence[].open_data` and `parties.landlord.open_data` carry `dataset_version` + `retrieved_at`. Stale open data is a 22 NYCRR 130 risk, so open-data assertions are **not** retained as authoritative across the lifecycle — they are re-fetched at filing time and re-gated through `verify_before_file`. Retention here favors re-fetch over reuse.

### 5.4 Anonymous/guest minimization
Guest sessions (`tenant_account_id = null`) are `minimized`. If the tenant never authenticates, the session purges on the idle clock. If they later create an account, the case is migrated to `standard`/`sensitive` and the migration is logged.

### 5.5 Secure deletion mechanics
- **C2:** destroy the per-case C2 DEK (crypto-shredding) — instantly renders all `sensitive.*` ciphertext unrecoverable across primary store, index, and backups.
- **C1:** hard-delete rows/objects, then destroy or rotate the wrapping keys for the affected partitions; tombstone in `audit.events[]` with `action = "purge"` and the `field_path`s affected (not values).
- **Object store:** delete object versions and any lifecycle-retained copies; verify by `content_hash_sha256` absence.
- **Backups:** deletion propagates within the backup retention window; C2 is already crypto-shredded at the moment the DEK is destroyed.
- Deletion is **blocked** while `audit.legal_hold = true`.
- Every deletion (scheduled, consent-driven, or tenant-requested) is recorded in the append-only `audit.events[]`.

---

## 6. Role-Based Access Control

### 6.1 Roles and default field access
RBAC is enforced server-side at the field-class level. Actor identity maps to `Actor.actor_type` ∈ {`tenant`, `system`, `attorney`, `provider`, `deterministic_engine`} plus an admin role.

| Role | C0 | C1 | C2 | C3 (open data) | Notes |
|---|---|---|---|---|---|
| **Tenant** (`tenant`; own case only, scoped by `tenant_id`/`tenant_account_id`) | R/W (own) | R/W (own; W only via confirmation flows) | R/W (own; W only behind §1.3 gate) | R + may set `verify_before_file` state | Sees everything in their own case. Cannot see another tenant's case. Sets `*_confirmed` / `tenant_corrected_value` / `verify_before_file`. |
| **Supervising attorney** (`attorney`; assigned via `review.assigned_attorney_id`) | R | R | R (only with the case's C2 KMS grant + an active sharing basis) | R | Owns the advice line: `defenses_checklist[].attorney_disposition`, `attorney_reviewed`, reclassification of `case_type`, deadline `attorney_validated`. Access scoped to assigned/queued cases. |
| **Provider** (`provider`; external legal-aid org) | Limited | Only categories in the matching `handoff_to_provider` consent's `data_categories[]` | Only if `immigration_status`/`benefits_enrollment`/`eligibility` is explicitly in `data_categories[]` AND consent active | As shared in the handoff packet | Receives the one-page `legal_aid_handoff` packet via LegalServer/PDF fallback, subject to the §4.5 reconciliation. Access is delivery-time and consent-scoped, not a standing read grant into the live Case Object. |
| **System** (`system`) | R/W | R/W (process-scoped) | Encrypt/move only; no plaintext access outside the narrow service that needs it | R/W | Background jobs, schedulers, ingest. C2 plaintext access is restricted to the single service performing the gated operation. |
| **Deterministic engine** (`deterministic_engine`) | R | R (the inputs it needs) | R (eligibility inputs, behind grant) | R | Computes `deadlines[]`, `eligibility.*`, `answer_draft.form_fields[]`, status transitions, court-date sourcing. Writes only DET-owned fields. |
| **Admin** (platform/security) | R/W | No plaintext by default | No plaintext by default; break-glass only | R/W | Operates KMS, RBAC config, retention config, legal holds. C1/C2 plaintext requires a logged break-glass grant with a stated reason, time-boxed, and dual-control where feasible. |

### 6.2 Write authority follows the LLM/DET boundary
RBAC also enforces *which actor may set which field*, mirroring the schema's hard invariants:
- `deadlines[].computed_by`, `eligibility.*.determined_by`, `answer_draft.form_fields[].placed_by` MUST be set by `deterministic_engine`/`system` only. The LLM service has **no write path** to these.
- `answer_draft.factual_statements[].transcription_only` (const `true`) and `defenses_checklist[].surfaced_as` (const `information_not_advice`) are schema constants; the LLM service may create these records but cannot set the constant to any other value (schema rejects it) and cannot set `defenses_checklist[].attorney_disposition` (attorney-only — the advice line).
- `consents[].granted`, `*_confirmed`, `verify_before_file.state` are tenant-set (or attorney where the schema allows); no system/LLM write path.
- **`review.advice_routed` has a single deterministic writer — the conversational advice-router only.** See §6.4. The LLM advice-detection classifier writes `review.advice_detection_log[]`; it does not set `advice_routed`. No deterministic escalation rule (missed deadline, overcharge, default risk) may write `advice_routed` — those set `review.review_state = "escalated"` instead.

### 6.3 SMS content minimization (cross-cutting RBAC + transit)
`Reminder` bodies (delivered over a channel RBAC cannot fully control once handed to the carrier) MUST NOT contain C1/C2 specifics beyond a court date and a generic prompt to open the PWA. No index number, no arrears amount, no landlord name in the SMS body.

### 6.4 `review.advice_routed` is the UPL audit signal — preserve its single meaning
`review.advice_routed = true` means exactly one thing: **an advice-seeking conversational turn was hard-routed to a human.** Its integrity is part of the UPL audit trail, so the spec constrains who may set it and requires it to correlate with a classifier hit.

- **Only the conversational advice-router** sets `review.advice_routed = true`. The router's deterministic decision is logged, and there MUST be a corresponding `review.advice_detection_log[]` entry (the LLM advice-detection classifier hit, with `classifier_model` and `confidence`) for the turn that triggered it. The classification is LLM; the routing decision is DET.
- **Deterministic escalations are not advice-seeking events.** A missed/imminent deadline (`deadlines[].risk.is_missed`/`default_risk`), an overcharge or amount-mismatch signal, or any other engine-side escalation MUST set `review.review_state = "escalated"` (and may set `review.assigned_attorney_id`/queue state) — it MUST NOT set `advice_routed`, because there is no advice-seeking turn and no matching `advice_detection_log[]` entry. Conflating the two corrupts the audit signal and would make `advice_routed=true` appear without a classifier hit.
- **Fail-closed on the low-confidence positive path.** When the advice-detection classifier flags a turn as advice-seeking, the routing decision fails toward the human: a positive at any confidence band (`high`, `medium`, or `low`) routes to a human. A low-confidence positive may be escalated for a second-pass classification (e.g. Sonnet 4.6), but the substantive (KB Q&A) answer is withheld until the escalation **confirms non-advice** — a downgrade does not silently release a substantive answer. Absence of a confirmed non-advice determination is treated as advice-seeking. This honors the system-prompt rule ("when in doubt, classify as advice-seeking — fail toward a human") through the routing layer.

---

## 7. C2 Access Authorization (defense-in-depth)

Reading any `sensitive.*` field requires **all** of:
1. An RBAC role whose row in §6.1 permits C2 for this case.
2. A live KMS grant to unwrap the case's C2 DEK (admins and non-assigned attorneys do not hold it).
3. An active legal basis: for the tenant, ownership; for an attorney, assignment + an active `store_sensitive_data`/sharing consent; for a provider, the specific `data_categories` in an active `handoff_to_provider` consent (also subject to the §4.5 at-delivery reconciliation).

Every C2 decryption is logged to `audit.events[]` with `actor`, `action = "read_sensitive"`, and the `field_path` (never the value). This produces the access trail required for a SHIELD-Act reasonable-safeguards posture and for subpoena scoping (§8).

---

## 8. Legal-Hold & Subpoena-Response Plan (immigration/benefits emphasis)

### 8.1 Legal hold
- `audit.legal_hold` (boolean, default `false`) is the single switch. When `true`, all automatic purge (§5) is suspended for the entire Case Object, including C2 and backups, until the hold is cleared by an authorized admin with a logged reason.
- Setting/clearing a hold is an admin action, dual-control where feasible, recorded in `audit.events[]`.
- A hold can be scoped to a case; holds across multiple cases are applied per-case (no global silent hold).

### 8.2 Subpoena / legal-process response
Because the tenant is the client of a legal-aid pipeline and C2 includes immigration and benefits data, subpoenas are handled with a documented, attorney-supervised process:

1. **Intake & hold.** On receipt of any subpoena, court order, or law-enforcement/immigration-agency demand, immediately set `audit.legal_hold = true` on the affected case(s) to prevent spoliation, and route to the supervising attorney. No data is produced before attorney review.
2. **Attorney review for validity and scope.** The supervising attorney evaluates validity, objects/moves to quash where appropriate, and narrows scope. Immigration-related demands receive heightened scrutiny — C2 immigration data (`sensitive.immigration`) is never produced absent a valid, specific, enforceable order, and the tenant is notified where lawful.
3. **Scoped production via the audit trail.** If production is required, the `audit.events[]` trail and the field-class map (§0) are used to produce *only* the responsive fields. Crypto-shredded/purged data is unrecoverable and is reported as such.
4. **Never to the landlord.** Subpoena responses, like all outputs, are subject to the FCRA red line (§9). Tenant data is never produced to a landlord/agent under cover of "discovery" without an attorney-supervised, court-ordered process — and `Consent.recipient.recipient_type` can never be a landlord by schema.
5. **Notice & logging.** The tenant is notified of legal process affecting their data where law permits; every step is logged in `audit.events[]`.

### 8.3 Data-map for response
The classification table (§0) plus `audit.data_retention_class` and the `consents[]` ledger constitute the data map a responder uses to answer "what do we hold, where, for whom, and under what authority." This map is maintained as a living artifact, version-stamped with `retention_config_version`.

---

## 9. The FCRA Red Line

**Tenant data is consumer-side only. The system never assembles, scores, or furnishes tenant information *to* a landlord, the landlord's agent, or any consumer-reporting use against the tenant.** This is a hard architectural boundary, enforced in three places:

1. **Schema bar.** `Consent.recipient.recipient_type` enumerates only `legal_aid_provider`, `court`, `benefits_agency`, `reminder_service`, `attorney`. There is no `landlord`/`agent` value. A consent authorizing a landlord recipient cannot be represented and therefore cannot be acted on. Every `ProviderHandoff` requires a `consent_id` whose recipient is one of these — so there is no code path that delivers a packet to a landlord.
2. **No scoring of the tenant.** The product never computes a tenant creditworthiness/tenancy-risk score. The only scores in the model are `review.triage_score` (provider-routing, internal, never shared with a landlord) and LLM confidence bands — neither is a consumer report or a tenant risk score. The deterministic engine never emits a tenant-adverse score.
3. **Direction of open data.** Open-data flows are *inbound* about the *landlord/building* (HPD violations/complaints/registration, JustFix WoW ownership/standing) and used for the tenant's defense — `parties.landlord.registered_owner_name`, `wow_landlord_id`, `registration_on_file`. The system never queries or compiles open data *about the tenant* to furnish to a landlord. The landlord is a subject of inbound data, never a recipient of tenant data.

Outbound recipients of tenant data are limited to: the tenant themselves, the court (via the tenant's own filing — the tenant is the filer), the supervising attorney, a consented legal-aid provider, a consented benefits agency (eligibility-only, no submission), and the consented reminder service. The landlord is structurally excluded from all of them.

---

## 10. Breach-Notification Posture (NY SHIELD Act)

### 10.1 Reasonable-safeguards baseline (SHIELD §899-bb)
The controls in §§2–7 (encryption in transit and at rest, envelope-encrypted C2, RBAC, KMS key management, retention/secure-deletion, the append-only `audit`) constitute the administrative, technical, and physical safeguards SHIELD requires for "private information." The data-minimization defaults (§1) shrink the breach surface — most cases hold no C2 at all, and C2 that does exist is crypto-shreddable.

### 10.2 Detection & scoping
- The `audit.events[]` trail (actor, action, `field_path`, model) plus the §0 classification map allow rapid scoping of *which* fields and *which* tenants are implicated by an incident, distinguishing C0-only exposure (no notification trigger) from C1/C2 exposure of SHIELD "private information."
- C2 envelope encryption means a database-only compromise (without the KMS C2 grant) likely does not expose `sensitive.*` plaintext — relevant to SHIELD's "access/acquisition by an unauthorized person" analysis and the encryption safe-harbor consideration.

### 10.3 Notification process
1. **Containment & hold.** On suspected breach, set `audit.legal_hold` on affected cases to preserve evidence; rotate/revoke compromised keys.
2. **Assessment.** Determine whether SHIELD "private information" was accessed or acquired by an unauthorized person; scope by tenant via the audit trail. Consider the encryption posture in the access/acquisition determination.
3. **Notify.** Where SHIELD is triggered, notify affected NY residents in the most expedient time possible without unreasonable delay, and notify the NY Attorney General, Department of State, and State Police per SHIELD timing/threshold rules. Provide the categories of information involved (drawn from the §0 classification) and remediation guidance.
4. **S7263 awareness.** Because chatbot-proprietor civil liability (S7263) is a top-tier product risk, breach handling is coordinated with the supervising attorney and counsel, and the incident record (in `audit`) documents the safeguards in place at the time of the incident.
5. **No tenant data to landlords, ever** — including in breach remediation communications (FCRA red line, §9).

### 10.4 Tenant-borne open-data risk is distinct
A breach of `evidence[].open_data`/`parties.landlord.open_data` is open data about a building/landlord, not tenant private information; it is handled per the incident's facts but is not, by itself, a SHIELD "private information" event about the tenant.

---

## 11. Data-Handling Boundary for LLM Inference Calls

The LLM (default **`claude-opus-4-8`** for safety/trust-critical work; **`claude-haiku-4-5`** for cheap classification; **`claude-sonnet-4-6`** middle tier — use these exact model-id strings, never with a date suffix) does vision intake, extraction, plain-English explanation, faithful transcription, evidence tagging, multilingual rewrite, intake-summary generation, triage scoring, grounded KB Q&A, and advice-detection classification. It never computes deadlines, eligibility, form placement, court-date sourcing, or the advice line. This section governs **what data may and may not be sent to the model, and what must be redacted first.**

### 11.1 What MAY be sent
- **Tenant-provided content the tenant is asking the model to process:** uploaded document bytes/images for vision intake → `documents[].ocr_text` + `documents[].extracted_fields.*`; the tenant's own narrated facts for faithful transcription → `answer_draft.factual_statements[].text`; document text for tagging/explanation. This is the tenant's own data being processed on the tenant's behalf — it is in-scope by definition.
- **The grounding KB and system prefix** for grounded KB Q&A and explanation (NYC nonpayment law summaries, the conservative-on-conclusions system prompt). This content is non-PII and is the prompt-cached prefix (§11.4).
- **Open-data context for tagging/explanation** about the landlord/building (it is not tenant PII).

### 11.2 What MUST NOT be sent (redact before the call)
Before any payload leaves the trust boundary for `api.anthropic.com`, a deterministic redaction pass strips fields that are not necessary for the specific task:

- **C2 by default.** `sensitive.immigration` (status, notes, consent_id), `sensitive.benefits_enrollment`, `sensitive.household_income_cents`, `sensitive.household_size` are **never** sent to the LLM. Eligibility is deterministic, not LLM, so the LLM has no legitimate need for these inputs. If a future task genuinely needs a derived signal, send a coarsened, non-identifying flag computed deterministically — never the raw C2 value.
- **Direct identifiers not needed for the task.** Strip `contact.phone_e164`, `contact.email`, full `contact.mailing_address`, and `tenant_id`/`tenant_account_id`/`case_id` from the prompt body when the task (e.g. classification, tagging, transcription) does not require them. Pass an opaque per-call correlation token instead of `case_id` when one is needed for logging.
- **Cross-case data.** A call only ever contains the single subject case's data. No batching of multiple tenants' PII into one prompt.
- **Secrets.** No API keys, KMS material, signed-URL tokens, or consent secrets ever appear in a prompt.

The redaction pass is deterministic code, version-stamped, and its application is logged in `audit.events[]` (with `model` set, `field_path`s redacted recorded — not values).

### 11.3 Provenance and the boundary on the way back
- Every value the LLM produces is written as an LLM-provenance value: `Provenance.source` ∈ {`llm_extraction`, `llm_generation`} with `Provenance.model` set to the exact model id used. Extracted fields land as `ConfirmableValue` (carry `confidence`, `tenant_confirmed = false` by default, `provenance` with a citation `locator`).
- **Faithful transcription is `llm_generation`.** A transcribed/multilingual-rewritten tenant statement in `answer_draft.factual_statements[].text` carries `Provenance.source = "llm_generation"` (the model rewrote/transcribed it) — `llm_transcription` is **not** a value in the canonical `Provenance.source` enum and MUST NOT appear. `Provenance.source` is single-valued: a statement is either `llm_generation` (the model produced the text) or `tenant_entered` (the tenant typed it verbatim) — never both. The tenant's original-language source is recorded separately in `source_language`; it does not change `source`.
- **The LLM result is never authoritative and never leaves `draft` without tenant confirmation.** It cannot be written to any DET-owned field (`deadlines[]`, `eligibility.*`, `answer_draft.form_fields[]`) — RBAC (§6.2) gives the LLM service no write path there.
- **Advice-detection:** the LLM classifier writes to `review.advice_detection_log[]`; the **decision** to set `review.advice_routed = true` and hard-route to a human is deterministic (DET), made by the single advice-router writer per §6.4 — not the model, and not any deterministic escalation rule.

### 11.4 Prompt caching is a PII boundary
Prompt caching is a prefix match — the cached prefix is reused across requests and tenants. Therefore:
- **Only non-PII goes in the cached prefix:** the frozen system prompt, the conservative-on-conclusions instructions, and the NYC nonpayment KB. No tenant value (no name, no date, no `case_id`, no arrears) is ever interpolated into the cached prefix — doing so would both leak across the cache boundary and silently invalidate the cache on every request.
- **All tenant-specific content goes after the last cache breakpoint**, in the volatile suffix of the prompt. This keeps tenant PII out of any cross-tenant cache key and keeps cache hit rates high.

### 11.5 Structured outputs and citations (two passes)
- Extraction uses structured outputs via `output_config.format` / `messages.parse()` against the relevant `extracted_fields` schema, so the model returns schema-valid JSON that maps directly to `ConfirmableValue`s.
- **Citations are incompatible with structured outputs** (the combination returns a 400). When a value needs both a structured shape *and* a grounded citation `locator` (page/char span back to `documents[].storage_ref`), run two passes: (1) a structured-output extraction pass for the values, (2) a separate grounded/citation pass to attach the `locator`. The two are reconciled deterministically before writing the `ConfirmableValue`. Both passes obey §11.2 redaction.

### 11.6 Vision intake specifics
Document images sent for vision intake (`ocr_model` ∈ {`claude-opus-4-8`, `claude-sonnet-4-6`}) are the tenant's own uploaded summons/petition/rent demand — in-scope. The raw bytes referenced by `documents[].storage_ref.uri` are sent only for the OCR/extraction call, over TLS 1.3, never logged in full on our side beyond the encrypted object store, and the resulting `ocr_text` is C1 governed by all of the above.

---

## 12. Eligibility, ERAP, and `likely_eligible` Handling

This section reconciles eligibility storage with the canonical `Eligibility` object and constrains how determinations are surfaced, to keep clear of UPL/advice-adjacency.

### 12.1 ERAP lives inside `rental_assistance`, never as a sibling key
The canonical `Eligibility` `$def` has `additionalProperties: false` and defines only `rtc`, `legal_aid`, `rental_assistance`, `config_version`, `evaluated_at`. **There is no `eligibility.erap` field, and one MUST NOT be written.** ERAP is surfaced as an `EligibilityResult` inside `eligibility.rental_assistance` with `program = "erap"` and `determination = "program_unavailable"` (ERAP is closed). CityFHEPS — in active litigation — is likewise surfaced inside `rental_assistance` with `config_toggle_state` ∈ {`enabled`, `disabled`} driving `program_unavailable` when disabled. All of these are `determined_by = "deterministic"` and config-driven (`eligibility.config_version`).

### 12.2 `likely_eligible` display rule (advice-adjacency guard)
`EligibilityResult.determination` may take the value `likely_eligible`. Because surfacing "you likely qualify for a free lawyer" edges toward an advice-adjacent conclusion, the display/handling rule is:
- `eligibility.rtc.determination = "likely_eligible"` is treated as an **internal triage/routing signal** (it can raise `review.review_state`/queue a provider handoff) and is **not** rendered to the tenant as a free-standing entitlement claim.
- Tenant-facing copy for any `likely_eligible` result MUST be framed as informational and non-conclusive (e.g. "you may qualify — a legal-aid provider will confirm"), never as a determination the tenant can rely on. The authoritative determination remains attorney/provider-owned.
- `eligible` / `ineligible` / `program_unavailable` / `insufficient_data` may be shown as the deterministic, config-stamped facts they are, again with the data-source and config-version provenance available for audit.

---

## 13. Cross-Reference: Policy → Field Map (quick index)

| Policy | Primary Case Object fields governed |
|---|---|
| Data minimization (immigration not collected by default) | `sensitive.immigration` (+ `status_relevant_to_defense`, `consent_id`), `sensitive.benefits_enrollment`, `sensitive.household_income_cents`, `sensitive.household_size` |
| Encryption tiers | C0/C1 base; C2 envelope: `sensitive.*`, `eligibility.*`; object: `documents[].storage_ref`, `packets.*.storage_ref` |
| Consent object | `consents[]` (`scope`, `recipient`, `granted`, `expires_at`, `revoked_at`, `data_categories[]`, `consent_text_version`, `method`) |
| Consent never a precondition | tenant-only path: `documents[]`, `timeline[]`, `deadlines[]`, `answer_draft`, `packets.court_packet` work without optional consents |
| Packet ↔ consent reconciliation at delivery | `packets.legal_aid_handoff` (`intake_summary_text`, `csr_tags`, `list_tags`, `included_evidence_ids`), `ProviderHandoff.consent_id`/`delivery_state`, consent `data_categories[]`, `parties.landlord.open_data` |
| Retention & deletion | `audit.data_retention_class`, `status`/`status_history[]`, `audit.legal_hold`, `audit.events[]` |
| RBAC & write authority | `Actor.actor_type`, `review.assigned_attorney_id`, write-authority on `*_by`/`*_confirmed`/`attorney_disposition`; single-writer `review.advice_routed` |
| Legal hold / subpoena | `audit.legal_hold`, `audit.events[]`, `consents[]` ledger |
| FCRA red line | `Consent.recipient.recipient_type` (no landlord value), `ProviderHandoff.consent_id`, `review.triage_score` (never shared) |
| Breach notification | `audit.events[]`, `audit.data_retention_class`, §0 classification |
| LLM inference boundary | `documents[].ocr_text`/`extracted_fields.*`, `answer_draft.factual_statements[]`, `Provenance.model`/`source` (`llm_generation` for transcription), `review.advice_detection_log[]`/`advice_routed`; redaction of `sensitive.*` + direct identifiers |
| Eligibility / ERAP / `likely_eligible` | `eligibility.rtc`/`legal_aid`/`rental_assistance` (ERAP+CityFHEPS inside `rental_assistance`), `eligibility.config_version`, `EligibilityResult.determination`/`config_toggle_state` |
