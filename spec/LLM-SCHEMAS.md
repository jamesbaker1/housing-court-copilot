# LLM Call Specs & Structured-Output Schemas (MVP: NYC Nonpayment)

# LLM Call Specs & Structured-Output Schemas

**Product:** Housing Court Copilot — legal-aid intake autopilot for NYC nonpayment eviction defense.
**Scope:** Every LLM call in the MVP. This document is the implementation contract between the LLM layer and the Case Object (`housing_court_copilot.case` v1).
**Audience:** Engineers wiring the Anthropic API into the intake pipeline.

> Verified against the Claude API reference (claude-api skill). Exact model IDs — never append a date suffix: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5`.

---

## 0. Cross-cutting rules (apply to EVERY call below)

These are non-negotiable and derive from `LLM-ARCHITECTURE.md` and `RISKS-AND-COMPLIANCE.md`.

### 0.1 The LLM/DETERMINISTIC boundary
The LLM **never** writes an authoritative deadline, eligibility determination, form-field placement, court date, or the advice line (which defense / "do they have a case" / outcome prediction). Five schema `const` invariants make this machine-checkable; **no LLM call below may emit a payload that sets any of them to a different value:**

- `deadlines[].computed_by = "deterministic"`
- `eligibility.*.determined_by = "deterministic"`
- `answer_draft.form_fields[].placed_by = "deterministic"`
- `answer_draft.factual_statements[].transcription_only = true`
- `defenses_checklist[].surfaced_as = "information_not_advice"`

Concretely: LLM extraction schemas emit `documents[].extracted_fields.court_date` (a `ConfirmableValue`), **not** `court.court_date` (which is `DET`, sourced from eTrack/NYSCEF). The deterministic engine recomputes/sources the authoritative versions.

### 0.2 Every LLM-written value requires tenant confirmation before any filing use
Provenance `LLM` (`llm_extraction` / `llm_generation`) values are **never authoritative**. They carry `confidence` and must be tenant-confirmed (`tenant_confirmed = true`, or `case_type_confirmed`, or a `VerifyGate` for open-data) before leaving `draft`. The schemas below populate the `ConfirmableValue` wrapper (`value` + `confidence` + `tenant_confirmed:false` + `provenance`) so the PWA can drive the confirm/correct loop.

### 0.3 Provenance source enum — single value per write (NOT two)
`Provenance.source` is a **single-valued** enum: `llm_extraction` · `llm_generation` · `deterministic` · `tenant_entered` · `open_data` · `system` · `attorney_entered`. There is **no** `llm_transcription` value, and a value is **never** two sources at once. Rules used below:

- **OCR / field extraction** (Surfaces 1–3): `provenance.source = "llm_extraction"`.
- **Faithful transcription, multilingual rewrite, narration, summaries, evidence tags, defense explanations** (Surfaces 4–8, 12): `provenance.source = "llm_generation"` — the LLM produced/rewrote the text. (Faithful transcription is still `llm_generation`; the `transcription_only:true` invariant — not the provenance enum — is what marks it as transcription, not advice.)
- **Verbatim tenant input typed directly into the PWA** (no LLM in the loop): `provenance.source = "tenant_entered"`. A given `factual_statement` is **one or the other**, decided per statement at write time — never both.

### 0.4 Model selection
| Tier | Model ID | Used for |
|---|---|---|
| Safety/trust-critical (default) | `claude-opus-4-8` | Vision intake, field extraction, faithful transcription, intake-summary generation, grounded KB Q&A |
| Middle | `claude-sonnet-4-6` | Plain-English timeline narration, evidence tagging, multilingual rewrite, defenses-checklist explanation (volume + quality balance) |
| Cheap classification | `claude-haiku-4-5` | Case-type classification, advice-detection classifier, provider triage scoring |

Record the exact model id in `provenance.model` / `documents[].ocr_model` / `*_model` fields on every write.

### 0.5 Structured outputs
- Use `output_config: {format: {type: "json_schema", schema: <schema>}}` on `messages.create()`, or `messages.parse()` with the SDK model. The deprecated top-level `output_format` is **not** used.
- Every schema below is JSON Schema **draft 2020-12**, every object has `additionalProperties: false`, and every object has an explicit `required` array.
- **Unsupported keywords** (the API rejects them; the Python/TS SDK strips + validates client-side, but do not rely on that across languages): `minimum`/`maximum`/`multipleOf`, `minLength`/`maxLength`, complex array constraints, recursive `$ref`. Where the Case Object needs `amount_cents >= 0` or BBL/ULID `pattern`s, **do not put the constraint in the LLM output schema** — emit the raw value and let deterministic code validate against the canonical Case Object schema. The schemas below are deliberately constraint-light for this reason.
- Supported and used below: `enum`, `const`, `anyOf`, `$ref`/`$defs`, string `format` (`date`, `date-time`), `additionalProperties: false`.

### 0.6 Citations are incompatible with structured outputs → TWO PASSES
`citations: {enabled: true}` on a `document` block + `output_config.format` returns **400**. Wherever a field must carry a verbatim source span (`provenance.locator.quote`, page/char index), run two passes against the same cached document prefix:
1. **Pass A (structured):** `output_config.format` → the typed extraction (values + confidence).
2. **Pass B (grounded):** same documents, `citations: {enabled: true}`, **no** `output_config.format` → free-form text whose `text` blocks carry a `citations` array (`page_location`/`char_location` with `cited_text`). Deterministic code maps Pass B citations onto Pass A fields by value match and writes `provenance.locator`.

Both passes share the same prompt-cached document + system prefix (see 0.7), so Pass B is mostly a cache read.

### 0.7 Prompt caching
Caching is a **prefix match**: `tools → system → messages`. Place the **frozen system prefix + the immutable KB** first, mark the last stable block with `cache_control: {type: "ephemeral"}`, and put volatile content (this case's documents, this turn's question) **after** the breakpoint.

- **Stable cached prefix (shared across all calls of a given surface):** the surface's system prompt + (for KB Q&A and advice-detection) the grounded knowledge base. This is byte-frozen — **no** `datetime.now()`, case ids, or tenant ids interpolated into it.
- Minimum cacheable prefix: **4096 tokens** on `claude-opus-4-8` and `claude-haiku-4-5`; **2048** on `claude-sonnet-4-6`. The KB system prefix clears this easily; a bare extraction system prompt may not — pad/accept no-cache for tiny prefixes.
- Use `ttl: "1h"` for the KB prefix (long-lived, reused across many tenants). Verify with `usage.cache_read_input_tokens`.
- **Never** interpolate per-case data into `system`. Per-case context goes in the `messages` turn.

### 0.8 Thinking / effort
- `claude-opus-4-8` and `claude-sonnet-4-6`: adaptive thinking only — `thinking: {type: "adaptive"}`. `budget_tokens` returns **400**. Surface reasoning to ops only via `display: "summarized"` (default is `"omitted"`); tenant-facing surfaces leave it omitted.
- `output_config.effort`: `low | medium | high | xhigh | max`. **`claude-haiku-4-5` does NOT support `effort`** — sending it 400s; omit `effort` on all Haiku calls.
- Per-surface settings are given in each section.

### 0.9 Refusal & error handling
- Check `response.stop_reason` before reading `content[0]`. On `"refusal"` (HTTP 200), do **not** treat the empty/partial content as data — route the case to `review` (set `review.review_state = "queued"`) and surface a neutral message. `stop_details` is `null` for every non-refusal stop reason — guard before reading `.category`.
- On `stop_reason == "max_tokens"`, the structured output is incomplete → retry with higher `max_tokens` (extraction/transcription/summary use streaming + `max_tokens` 16000–64000).
- `confidence: "unreadable"` is the LLM's in-band signal that OCR/vision failed; it is **not** an error — the field stays `draft` and the PWA prompts a re-upload.

### 0.10 Audit
Every LLM write appends an `audit.events[]` entry: `{at, actor:{actor_type:"system"}, action, field_path, model}`. `field_path` is the JSON pointer of the written field; `model` is the exact model id.

---

## 1. Surface index

| # | Surface | Model | Structured output? | Citations pass? | Writes (Case Object) |
|---|---|---|---|---|---|
| 1 | Vision intake (OCR transcription) | `claude-opus-4-8` | No (free text) | N/A | `documents[].ocr_text`, `documents[].ocr_model` |
| 2 | Field extraction | `claude-opus-4-8` | **Yes** | **Yes (Pass B)** | `documents[].extracted_fields.*` (ConfirmableValue) |
| 3 | Case-type classification | `claude-haiku-4-5` | **Yes** | No | `case_type`, `case_type_confidence`, `documents[].document_type(_confidence)` |
| 4 | Plain-English timeline narration | `claude-sonnet-4-6` | **Yes** | No | `timeline[].description` (+ proposes descriptive-only `kind`/`date`/`date_is_authoritative=false`) |
| 5 | Answer-field transcription | `claude-opus-4-8` | **Yes** | optional Pass B | `answer_draft.factual_statements[]` |
| 6 | Evidence tagging | `claude-sonnet-4-6` | **Yes** | No | `evidence[].tags`, `evidence[].summary`, `evidence[].supports_defense_codes` |
| 7 | Multilingual rewrite | `claude-sonnet-4-6` | **Yes** | No | rewritten `factual_statements[].text` (+ `source_language`); tenant-facing UI strings |
| 8 | Intake-summary generation | `claude-opus-4-8` | **Yes** | No | `packets.legal_aid_handoff.intake_summary_text` (proposes CSR/LIST tags for DET confirmation) |
| 9 | Provider triage scoring | `claude-haiku-4-5` | **Yes** | No | `review.triage_score` |
| 10 | Grounded KB Q&A | `claude-opus-4-8` | No (free text) | **Yes (KB grounding)** | none (read-only; transient chat) |
| 11 | Advice-detection classifier | `claude-haiku-4-5` | **Yes** | No | `review.advice_detection_log[]` (DET reads it to set `review.advice_routed`) |
| 12 | Defenses checklist explanation | `claude-sonnet-4-6` | **Yes** | No | `defenses_checklist[].explanation`, `.relevance_signal` (NOT `.attorney_disposition`) |

> **Gate:** Surface 11 (advice-detection) runs **before** Surface 10 (KB Q&A) on every tenant chat turn. If the classifier flags advice-seeking, deterministic code hard-routes to a human and the KB Q&A call is **suppressed**. The advice router (§11) is the **single deterministic owner** of `review.advice_routed`. See §11.

---

## 2. Surface 1 — Vision intake (OCR transcription)

**Model:** `claude-opus-4-8` (trust-critical: faithful transcription of a legal document).
**Why no structured output:** this pass produces the full verbatim text only; field extraction is Surface 2. Keeping them separate lets Surface 2 cite into `ocr_text` and lets the tenant see the raw transcription.

**System prompt outline (cached prefix):**
- Role: "You faithfully transcribe the full text of an uploaded NYC Housing Court document. Transcribe verbatim. Do not summarize, interpret, correct, or add legal commentary. Preserve line breaks, headings, party names, dates, and dollar amounts exactly as written. If a region is illegible, write `[illegible]`."
- Hard rule: no legal conclusions, no advice, no inferred values.
- Output: plain transcribed text only.

**User turn (volatile, after cache breakpoint):**
- `document` content block: base64 PDF (`{type:"document", source:{type:"base64", media_type:"application/pdf", data:<b64>}}`) **before** the text block, or `image/*` block for photos (`image/jpeg|png|heic|webp`). For multi-call reuse use the Files API (`file_id`, beta `files-api-2025-04-14`).
- Text: "Transcribe this document in full."

**Settings:** `thinking: {type:"adaptive"}`, `output_config: {effort: "medium"}`, **streaming** with `max_tokens: 16000` (legal docs can be long). PDFs: 32 MB / 600-page request limit.

**Writes:**
- `documents[].ocr_text` (string, provenance `source: "llm_extraction"`)
- `documents[].ocr_model = "claude-opus-4-8"`

`ocr_text` is tenant-visible but not a `ConfirmableValue` (it is raw transcription, not an extracted field). `confidence: "unreadable"` is expressed by the model emitting `[illegible]` markers.

---

## 3. Surface 2 — Field extraction

**Model:** `claude-opus-4-8` (trust-critical — these fields seed deadlines, eligibility, and the answer; a wrong extraction propagates).
**Structured output: YES. Citations: YES (two passes — see 0.6).**

> **Canonical input set.** The extracted-field schema below is the **authoritative, complete** list of fields the LLM extracts for the MVP nonpayment flow. Any downstream deterministic predicate that needs a value (e.g. the rent-demand amount-consistency check in the deadline/legal-rules engine) must consume one of these exact `extracted_fields` keys; there is no out-of-band extraction. If a predicate needs a value not in this list, the schema must be extended here first (and the canonical Case Object `extracted_fields` set updated in lockstep) — predicates may not assume a field that this surface does not emit.

### 3.1 Input
**System prompt outline (cached prefix):**
- Role: "Extract the listed fields from a NYC nonpayment summons/petition/rent demand. Extract only what is literally present. For any field not present or unreadable, set `confidence: \"unreadable\"` and `value: null`. You EXTRACT dates; you NEVER compute deadlines. You do not decide the case type or any defense."
- Field glossary (each key below) mapped to the document regions where each typically appears.
- Money rule: "Return monetary amounts as integer cents (`$1,234.56` → `123456`), never a float or formatted string."
- Date rule: "Return dates as ISO `YYYY-MM-DD` exactly as printed; do not adjust for any deadline."

**User turn (volatile):** the `documents[].ocr_text` for this doc **and** the source `document`/image block (vision improves extraction of stamped index numbers). Prefix-cache the system prompt; the per-doc content sits after the breakpoint.

### 3.2 Pass A schema (structured)
Each field is emitted as `value` + `confidence` only; deterministic code wraps it into the full `ConfirmableValue` (setting `tenant_confirmed:false`, `provenance.source:"llm_extraction"`, `provenance.model`, `provenance.document_id`).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "court_date", "index_number", "borough", "claimed_arrears",
    "landlord_name", "petitioner_name", "respondent_name",
    "premises_address", "apartment_unit", "rent_demand_date",
    "monthly_rent", "petition_filed_date", "service_date"
  ],
  "$defs": {
    "Confidence": { "type": "string", "enum": ["high", "medium", "low", "unreadable"] },
    "Money": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["amount_cents", "currency"],
      "properties": {
        "amount_cents": { "type": "integer", "description": "USD cents, integer. Never a float." },
        "currency": { "type": "string", "const": "USD" }
      }
    },
    "PostalAddress": {
      "type": ["object", "null"],
      "additionalProperties": false,
      "required": ["line1", "line2", "city", "state", "postal_code"],
      "properties": {
        "line1": { "type": ["string", "null"] },
        "line2": { "type": ["string", "null"] },
        "city": { "type": ["string", "null"] },
        "state": { "type": ["string", "null"], "description": "USPS 2-letter; MVP 'NY'." },
        "postal_code": { "type": ["string", "null"] }
      }
    },
    "StringField": {
      "type": "object", "additionalProperties": false,
      "required": ["value", "confidence"],
      "properties": {
        "value": { "type": ["string", "null"] },
        "confidence": { "$ref": "#/$defs/Confidence" }
      }
    },
    "DateField": {
      "type": "object", "additionalProperties": false,
      "required": ["value", "confidence"],
      "properties": {
        "value": { "type": ["string", "null"], "format": "date", "description": "ISO YYYY-MM-DD as printed. EXTRACTED only — not a computed deadline." },
        "confidence": { "$ref": "#/$defs/Confidence" }
      }
    },
    "MoneyField": {
      "type": "object", "additionalProperties": false,
      "required": ["value", "confidence"],
      "properties": { "value": { "$ref": "#/$defs/Money" }, "confidence": { "$ref": "#/$defs/Confidence" } }
    },
    "BoroughField": {
      "type": "object", "additionalProperties": false,
      "required": ["value", "confidence"],
      "properties": {
        "value": { "type": ["string", "null"], "enum": ["manhattan", "bronx", "brooklyn", "queens", "staten_island", null] },
        "confidence": { "$ref": "#/$defs/Confidence" }
      }
    },
    "AddressField": {
      "type": "object", "additionalProperties": false,
      "required": ["value", "confidence"],
      "properties": { "value": { "$ref": "#/$defs/PostalAddress" }, "confidence": { "$ref": "#/$defs/Confidence" } }
    }
  },
  "properties": {
    "court_date": { "$ref": "#/$defs/DateField" },
    "index_number": { "$ref": "#/$defs/StringField" },
    "borough": { "$ref": "#/$defs/BoroughField" },
    "claimed_arrears": { "$ref": "#/$defs/MoneyField" },
    "landlord_name": { "$ref": "#/$defs/StringField" },
    "petitioner_name": { "$ref": "#/$defs/StringField" },
    "respondent_name": { "$ref": "#/$defs/StringField" },
    "premises_address": { "$ref": "#/$defs/AddressField" },
    "apartment_unit": { "$ref": "#/$defs/StringField" },
    "rent_demand_date": { "$ref": "#/$defs/DateField" },
    "monthly_rent": { "$ref": "#/$defs/MoneyField" },
    "petition_filed_date": { "$ref": "#/$defs/DateField" },
    "service_date": { "$ref": "#/$defs/DateField" }
  }
}
```

> **Note on the rent-demand amount (reconciled with `LEGAL-RULES.md §2.1.1`).** `extracted_fields` is per-document, so the amount the *rent demand* states is extracted as `claimed_arrears` **on the `document_type="rent_demand"` document** — distinct from the top-level `case.claimed_arrears` (the petition total). The legal-rules rent-demand consistency predicate (`§5`) compares those two confirmed values. There is no separate "rent demand amount" key in v1, and none is needed; if a future version wants a dedicated field, add a `rent_demand_amount` `MoneyField` to this schema **and** the canonical `extracted_fields` set in the same change — do not synthesize it elsewhere.

### 3.3 Pass B (citations)
Same documents, **no** `output_config.format`, `citations: {enabled: true}` on the document block. Prompt: "For each of these extracted values, quote the exact phrase from the document that supports it: <list the Pass-A values>." Cited `text` blocks carry a `citations` array with `page_location`/`char_location` + `cited_text`. Deterministic code maps each citation to its Pass-A field by value match and writes `documents[].extracted_fields.<field>.provenance.locator = {page_number, start_char_index, end_char_index, quote}`.

### 3.4 Settings
`thinking: {type:"adaptive"}`, `output_config: {effort: "high"}` (accuracy-critical), `max_tokens: 4096`. Streaming optional.

### 3.5 Writes & confirmation
- `documents[].extracted_fields.{court_date,index_number,borough,claimed_arrears,landlord_name,petitioner_name,respondent_name,premises_address,apartment_unit,rent_demand_date,monthly_rent,petition_filed_date,service_date}` — each a `ConfirmableValue` with `confidence`, `tenant_confirmed:false`, `provenance` (`source:"llm_extraction"`, `model`, `document_id`, `locator` from Pass B).
- **Deterministic propagation (NOT this LLM call).** Once the tenant confirms a field, deterministic code copies the confirmed value into its canonical home. This includes **`court.index_number`** (copied from the confirmed `documents[].extracted_fields.index_number`, then cross-checked against the NYSCEF docket), `claimed_arrears`, `parties.landlord.name`, and `property.address`/`apartment_unit`. The confirm-endpoint side-effects MUST include this index-number copy — otherwise the confirmed index number is stranded on `documents[].extracted_fields` and `court.index_number` stays null. `court.court_date` is sourced separately from eTrack/NYSCEF (DET); deadlines are computed deterministically from the confirmed `service_date`/`petition_filed_date`/`rent_demand_date` anchors.
- **Every field requires `tenant_confirmed = true` (or `tenant_corrected_value`) before any filing use.** The extracted `court_date` is `document_extracted_unverified` and must never set `court.court_date_verified`.

---

## 4. Surface 3 — Case-type classification

**Model:** `claude-haiku-4-5` (cheap classify). **Structured: YES. Citations: No. No `effort` (Haiku).**

**System prompt (cached prefix):** "Classify the case type of a NYC Housing Court document and the document type. This is information, not advice or a legal conclusion. MVP processes only `nonpayment` end-to-end; everything else routes to human triage. Use `unknown` when you cannot tell."

**User turn:** `documents[].ocr_text` (+ optional image block).

**Schema:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["case_type", "case_type_confidence", "document_type", "document_type_confidence"],
  "properties": {
    "case_type": { "type": "string", "enum": ["nonpayment", "holdover", "illegal_lockout", "hp_action", "other", "unknown"] },
    "case_type_confidence": { "type": "string", "enum": ["high", "medium", "low", "unreadable"] },
    "document_type": { "type": "string", "enum": ["summons_petition", "rent_demand", "notice_of_petition", "lease", "rent_ledger", "rent_receipt", "repair_evidence", "correspondence", "court_notice", "other", "unknown"] },
    "document_type_confidence": { "type": "string", "enum": ["high", "medium", "low", "unreadable"] }
  }
}
```

**Settings:** `max_tokens: 256`. No thinking config needed (cheap classify), no `effort`.

**Writes:** `case_type` (provenance `source:"llm_extraction"`), `case_type_confidence`, `documents[].document_type`, `documents[].document_type_confidence`.
**Confirmation:** `case_type_confirmed = false` until tenant confirms. Classification is information, not the advice line; the supervising attorney owns reclassification. If `case_type != "nonpayment"` after confirmation, deterministic routing sends the case to human triage (out of MVP automation).

---

## 5. Surface 4 — Plain-English timeline narration

**Model:** `claude-sonnet-4-6`. **Structured: YES. Citations: No.**

> **Boundary.** The LLM narrates events and proposes **descriptive** dates only. It is **barred from emitting deadline/statutory-clock event kinds** (`answer_due`, `judgment`) — see the restricted `kind` enum below. Authoritative statutory-clock timeline entries (e.g. `answer_due`) are created by the **deterministic engine** with `date_is_authoritative = true` and a linked `deadline_id`. Forcing `date_is_authoritative = false` on LLM events is necessary but **not sufficient**: if the LLM were also allowed to emit `kind:"answer_due"`, the UI could render a false (LLM-extracted) answer-due date next to the real DET one. Restricting the enum prevents that collision at the schema level.

**System prompt (cached prefix):** "Explain, in plain 8th-grade English, what happened on each date in this nonpayment case, based ONLY on the confirmed extracted facts provided. Describe only events that already occurred or were served (rent demand, petition filing, petition service, a scheduled appearance). Do NOT describe deadlines, do NOT compute or state when an answer is due, do NOT describe judgments, do not predict outcomes, do not recommend defenses, do not say whether the tenant has a case. Each event you describe is descriptive only."

**User turn:** confirmed extracted fields (rent_demand_date, petition_filed_date, service_date, court_date-as-extracted, claimed_arrears, monthly_rent) as JSON.

**Schema:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["events"],
  "properties": {
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["kind", "date", "date_is_authoritative", "description"],
        "properties": {
          "kind": {
            "type": "string",
            "enum": ["rent_demand_served", "petition_filed", "petition_served", "court_appearance", "adjournment", "other"],
            "description": "Descriptive event kinds ONLY. answer_due and judgment are deliberately excluded — those are DET-authored statutory-clock entries the LLM may not emit."
          },
          "date": { "type": ["string", "null"], "format": "date" },
          "date_is_authoritative": { "type": "boolean", "const": false, "description": "Hard invariant: LLM-narrated timeline events are never authoritative. DET creates authoritative entries." },
          "description": { "type": "string", "description": "Plain-English explanation of this event." }
        }
      }
    }
  }
}
```

**Settings:** `thinking:{type:"adaptive"}`, `output_config:{effort:"medium"}`, `max_tokens: 4096`, BCP-47 output language = `case.language`.

**Writes:** `timeline[]` entries — deterministic code assigns each an `event_id` (`evt_` ULID) and stores `kind`, `date`, `date_is_authoritative:false`, `description` (provenance `source:"llm_generation"`). `deadline_id` is left null on LLM events. The deterministic engine separately emits the `answer_due` (and any `judgment`) authoritative event with `date_is_authoritative:true` and links its `deadline_id`; the LLM never produces those kinds, so there is no double-`answer_due` collision.

---

## 6. Surface 5 — Answer-field transcription

**Model:** `claude-opus-4-8` (trust-critical — faithful transcription is the heart of the UPL boundary). **Structured: YES. Citations: optional Pass B against the tenant's own statement source.**

> **Boundary.** This is **faithful transcription ONLY**. The LLM restates the tenant's own factual statements into clean answer-field text. It does **not** select a defense, characterize facts legally, assert the tenant "has a case", or decide `general_denial`. Every statement carries `transcription_only: true` (hard const).

**System prompt (cached prefix):** "Transcribe the tenant's own statements of fact into clear, first-person answer-field text. Rules: (1) Include only facts the tenant stated. (2) Add NO legal characterization, conclusion, defense label, or recommendation. (3) Do not infer facts the tenant did not state. (4) Fix grammar/spelling and translate into the tenant's preferred language if needed, but never change the meaning. (5) If a statement contains a legal conclusion ('my landlord broke the warranty of habitability'), transcribe the underlying FACT ('the heat was off for two weeks in January') and drop the legal label. (6) If the tenant is asking for advice rather than stating a fact, do not transcribe it — flag it."

**User turn:** the tenant's raw statements (typed or transcribed from voice), plus `case.language`.

**Schema:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["factual_statements"],
  "properties": {
    "factual_statements": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["text", "source_language", "transcription_only", "is_advice_request"],
        "properties": {
          "text": { "type": "string", "description": "Faithful transcription of one tenant-stated fact. No legal characterization." },
          "source_language": { "type": ["string", "null"], "description": "BCP-47 of the tenant's original statement." },
          "transcription_only": { "type": "boolean", "const": true },
          "is_advice_request": { "type": "boolean", "description": "True if this utterance is the tenant seeking advice rather than stating a fact; if true, DET routes it and it is NOT written as a factual_statement." }
        }
      }
    }
  }
}
```

**Optional Pass B (citations):** if statements were extracted from an uploaded narrative/correspondence document, run a citation pass to fill `provenance.locator.quote`.

**Provenance (single value per statement):** because the LLM produced/rewrote the text, each written statement uses **`provenance.source = "llm_generation"`** — a single value, never two. The `transcription_only:true` const (not the provenance enum) is what records that this is faithful transcription rather than advice. If a tenant later types a statement directly into the PWA with **no** LLM in the loop, that statement is written by deterministic/PWA code with `provenance.source = "tenant_entered"` instead — a per-statement choice, never both at once.

**Settings:** `thinking:{type:"adaptive"}`, `output_config:{effort:"high"}`, `max_tokens: 8192` (streaming for long statements).

**Writes:** `answer_draft.factual_statements[]` — deterministic code assigns `statement_id` (`stmt_` ULID), sets `tenant_confirmed:false`, `transcription_only:true`, and `provenance` (`source:"llm_generation"`, `model:"claude-opus-4-8"`). Statements where `is_advice_request=true` are NOT written as factual statements; they feed the advice-detection / human-routing path (§11).
**Confirmation:** each statement requires `tenant_confirmed = true`. `answer_draft.general_denial` is set by the **tenant** in the PWA — never by this call. `answer_draft.form_fields[]` is populated by **deterministic** placement (`placed_by:"deterministic"`), never by the LLM.

---

## 7. Surface 6 — Evidence tagging

**Model:** `claude-sonnet-4-6`. **Structured: YES. Citations: No.**

> **Boundary.** Tagging and defense-code *mapping* is information-not-advice surfaced for human review. The LLM may map evidence to **candidate** `defense_code`s (`supports_defense_codes`), but it never asserts a defense applies — that is `defenses_checklist[].attorney_disposition`, attorney-only.

**System prompt (cached prefix):** "Categorize and summarize a piece of evidence for a nonpayment case. Output tags, a one-line plain-English summary, and any defense codes this evidence COULD be relevant to (for a human attorney to review). Do not conclude the tenant has a case or that any defense applies."

**User turn:** the evidence item — `documents[].ocr_text` for uploaded docs, or the tenant's description for `tenant_stated`, plus `evidence[].origin` and `evidence_type` if known.

**Schema:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["evidence_type", "tags", "summary", "supports_defense_codes"],
  "properties": {
    "evidence_type": { "type": "string", "enum": ["rent_payment_proof", "rent_receipt", "bank_record", "money_order", "repair_request", "hpd_violation", "hpd_complaint", "photo", "correspondence", "lease_term", "registration_record", "ownership_record", "witness_statement", "other"] },
    "tags": { "type": "array", "items": { "type": "string" } },
    "summary": { "type": ["string", "null"], "description": "Plain-English one-line summary." },
    "supports_defense_codes": {
      "type": "array",
      "items": { "type": "string", "enum": ["general_denial", "rent_paid", "rent_partially_paid", "improper_service", "defective_rent_demand", "defective_petition", "warranty_of_habitability", "repairs_needed", "rent_overcharge", "wrong_amount_claimed", "no_landlord_tenant_relationship", "not_registered_multiple_dwelling", "succession_rights", "laches", "rent_regulation_violation", "other"] },
      "description": "Candidate defenses this evidence COULD relate to — information for human review, not an assertion."
    }
  }
}
```

**Settings:** `thinking:{type:"adaptive"}`, `output_config:{effort:"low"}`, `max_tokens: 1024`.

**Writes:** `evidence[].evidence_type`, `.tags` (provenance `source:"llm_generation"`), `.summary`, `.supports_defense_codes`. Deterministic code holds `evidence_id` (`ev_` ULID) and `origin`. For `origin = open_data` items, the `open_data` `OpenDataAssertion` (disclaimer + `verify_before_file`) is attached by the open-data ingest layer, NOT this call.

> **Relevance-signal consistency (cross-tool).** When an evidence item or a HPD/JustFix open-data signal is *mirrored* into a `defenses_checklist[]` item, the deterministic mirroring layer must apply one consistent rule for `relevance_signal` across sibling open-data tools: an **unverified** open-data-derived signal (HPD violation/complaint, registration-on-file/expired) maps to `relevance_signal = "possible"` until its `verify_before_file.state = "verified"`, at which point it may be promoted to `evidence_present`. Tenant-uploaded evidence the tenant has produced maps to `evidence_present` directly. The signal is neutral information, never a recommendation, and `attorney_disposition` remains attorney-only.

---

## 8. Surface 7 — Multilingual rewrite

**Model:** `claude-sonnet-4-6`. **Structured: YES. Citations: No.**

Two modes share one surface:
- **(a) Statement rewrite:** translate/rewrite `answer_draft.factual_statements[].text` into `case.language` (or back to English for the handoff packet) while preserving meaning. Same `transcription_only:true` invariant as §6 — meaning never changes.
- **(b) UI/output rewrite:** translate tenant-facing plain-English strings (timeline descriptions, deadline explanations, KB answers) into `case.language`. Read-only re-render; writes nothing authoritative.

**System prompt (cached prefix):** "Rewrite the provided text in <target BCP-47 language>. Preserve meaning exactly. Do not add, remove, or characterize any fact. Do not add legal commentary. Output is a faithful translation only."

**Schema (statement rewrite mode):**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["rewrites"],
  "properties": {
    "rewrites": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["statement_id", "text", "target_language", "source_language", "transcription_only"],
        "properties": {
          "statement_id": { "type": "string", "description": "FK to the factual_statement being rewritten (stmt_ ULID, echoed back)." },
          "text": { "type": "string" },
          "target_language": { "type": "string", "description": "BCP-47 of the rewrite." },
          "source_language": { "type": ["string", "null"] },
          "transcription_only": { "type": "boolean", "const": true }
        }
      }
    }
  }
}
```

**Settings:** `thinking:{type:"adaptive"}`, `output_config:{effort:"low"}`, `max_tokens: 8192`.

**Writes:** updates `answer_draft.factual_statements[].text` + `.source_language`, keeps `provenance.source = "llm_generation"`, and **re-sets `tenant_confirmed:false`** so the tenant re-confirms the translated version (translation is a change the tenant must approve). UI-mode rewrites write no Case Object fields.

---

## 9. Surface 8 — Intake-summary generation

**Model:** `claude-opus-4-8` (trust-critical — this is the artifact the attorney reads first). **Structured: YES. Citations: No.**

> **Boundary.** The summary is **information; the attorney reviews it.** CSR (LSC) and LIST tags proposed here are **candidates** — the deterministic tagging layer + attorney confirm the authoritative `csr_tags`/`list_tags`. The summary never asserts a defense or predicts an outcome.

**System prompt (cached prefix):** "Write a one-page legal-aid intake summary for a NYC nonpayment case, for a supervising attorney. Use only confirmed facts provided. Neutral, factual, no legal conclusions, no defense recommendations, no outcome predictions. Propose candidate CSR (LSC problem/closure) and LIST (Legal Issue/Service Taxonomy) codes for attorney confirmation."

**User turn:** confirmed `claimed_arrears`, `monthly_rent`, parties, `court.borough`/`index_number`, confirmed `factual_statements[]`, `eligibility` results (already DET-computed), evidence summaries. **Do not** include immigration status unless `sensitive.immigration` is present with a matching consent (data minimization).

**Schema:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["intake_summary_text", "proposed_csr_tags", "proposed_list_tags"],
  "properties": {
    "intake_summary_text": { "type": "string", "description": "One-page neutral factual summary. No legal conclusions." },
    "proposed_csr_tags": { "type": "array", "items": { "type": "string" }, "description": "Candidate LSC CSR codes for attorney confirmation." },
    "proposed_list_tags": { "type": "array", "items": { "type": "string" }, "description": "Candidate LIST codes for attorney confirmation." }
  }
}
```

**Settings:** `thinking:{type:"adaptive"}`, `output_config:{effort:"high"}`, `max_tokens: 4096` (streaming).

**Writes:** `packets.legal_aid_handoff.intake_summary_text` (provenance `source:"llm_generation"`, `generated_by_model="claude-opus-4-8"`, `generated_at`). `csr_tags`/`list_tags` are written by the **deterministic** tagging layer after attorney confirmation — this call only *proposes* (the canonical CSR/LIST code set and the deterministic rules that assign them are owned by the legal-aid-handoff spec, not this LLM call). Delivery (`ProviderHandoff` via `legalserver_trigger_xml` / `pdf_packet_fallback`) requires a matching per-recipient `consent_id` and is **not** part of this call.

> **Open-data block at handoff generation (cross-ref).** The handoff packet may reference open-data assertions that live in places other than `included_evidence_ids` — notably `parties.landlord.open_data` (registration/standing signals). The deterministic handoff generator MUST scan **all** referenced open-data assertions (evidence items *and* `parties.landlord.open_data`) and set `packets.legal_aid_handoff.blocked_by_unverified_open_data = true` if any has `verify_before_file.state != "verified"`. An unverified landlord-registration assertion must not flow into the intake summary text either; this LLM call must not be asked to summarize an open-data signal whose gate is unverified.

> **Consent-scope vs packet contents at delivery (cross-ref).** The handoff packet carries eligibility-derived content and CSR/LIST tags. Delivery is gated on the matching `handoff_to_provider` consent including the `eligibility` data category in its `data_categories[]`. The deterministic delivery step MUST reconcile packet contents against the consent's `data_categories[]` at send time: if `eligibility` is not in the consent, eligibility-derived content is redacted from the delivered packet (or delivery is blocked pending an expanded consent). This LLM call only proposes summary text; it does not gate delivery.

---

## 10. Surface 9 — Provider triage scoring

**Model:** `claude-haiku-4-5` (cheap classify). **Structured: YES. Citations: No. No `effort` (Haiku).**

> **Boundary.** The triage score is **information for routing, not a legal conclusion.** It does not determine eligibility (that is DET) or whether the tenant has a case.

**System prompt (cached prefix):** "Produce a routing-priority score (0–100) for a nonpayment intake, reflecting urgency and completeness for a human triage queue. This is operational routing, not legal advice and not an eligibility decision. Provide a one-line rationale."

**User turn:** imminence signals (any DET `deadlines[].risk.is_imminent`/`default_risk`), completeness (which `extracted_fields` confirmed), `eligibility.rtc` determination (DET, read-only).

> **`likely_eligible` is internal-routing only here.** The DET eligibility engine may produce `determination = "likely_eligible"` (e.g. for RTC). That value is consumed by this triage surface and the attorney queue as an **internal routing signal only**; it is never surfaced to the tenant as "you likely qualify for a free lawyer" (an advice-adjacent conclusion). The PWA display layer must gate `likely_eligible` to internal/attorney views; tenant-facing copy describes RTC neutrally ("you may be connected with a free attorney — an attorney will confirm whether you qualify"). This LLM call reads the determination but does not display it.

**Schema:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["score", "rationale"],
  "properties": {
    "score": { "type": "number", "description": "Routing priority 0–100. Operational, not legal." },
    "rationale": { "type": ["string", "null"] }
  }
}
```

**Settings:** `max_tokens: 512`. No thinking config, no `effort`.

**Writes:** `review.triage_score = {score, model:"claude-haiku-4-5", rationale}`. Informational; the routing decision and queue placement are deterministic.

---

## 11. Surface 11 — Advice-detection classifier (gates KB Q&A)

**Model:** `claude-haiku-4-5` (cheap classify, runs on every tenant chat turn). **Structured: YES. Citations: No. No `effort` (Haiku).**

> **This is the UPL safety gate, and it fails CLOSED.** The classifier is LLM; the **decision to route is deterministic**, and the **advice router is the single deterministic owner of `review.advice_routed`** (see "single-owner" rule below). It runs **before** the KB Q&A call (Surface 10). If the deterministic router decides advice-seeking, it sets `review.advice_routed = true`, transitions `review.review_state → queued`, and **suppresses the KB Q&A call** — the tenant is hard-routed to a human.

**System prompt (cached prefix):** "Classify whether the tenant's message is seeking legal advice, a legal conclusion, or an outcome prediction — as opposed to a factual/procedural question answerable from a knowledge base. Advice-seeking includes: 'do I have a case', 'what should I do', 'will I win', 'which defense should I use', 'should I take this deal'. Factual/procedural includes: 'what is a nonpayment case', 'where is Bronx housing court', 'what does answer mean'. When in doubt, classify as advice-seeking (fail safe toward a human)."

**User turn:** the tenant's chat message + minimal conversation context (no per-case PII beyond the message itself).

**Schema:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["is_advice_seeking", "confidence"],
  "properties": {
    "is_advice_seeking": { "type": "boolean", "description": "True = the turn seeks advice / a legal conclusion / an outcome prediction. DET hard-routes to a human." },
    "confidence": { "type": "string", "enum": ["high", "medium", "low", "unreadable"] }
  }
}
```

**Settings:** `max_tokens: 128`. No thinking config, no `effort`. Low latency is the priority (it is on the chat hot path).

**Writes:** appends `review.advice_detection_log[]` entry `{at, classifier_model:"claude-haiku-4-5", is_advice_seeking, confidence}`. The **only** field the LLM writes is the log entry.

### 11.1 Deterministic routing decision — FAIL CLOSED on any advice-seeking positive
Deterministic code reads the log entry and decides routing. The routing rule is fail-closed at **every** confidence band:

1. `is_advice_seeking = true` at **any** `confidence` (including `low`) → route to human. Set `review.advice_routed = true`, `review.review_state = "queued"`, suppress Surface 10, return a human-handoff message. **A low-confidence advice-seeking positive is NOT downgraded to a substantive answer.** (An escalation pass to `claude-sonnet-4-6` may run in parallel to *enrich* the log / triage note, but it cannot *clear* an already-flagged advice turn back to KB Q&A — the Haiku positive already routed the tenant.)
2. `is_advice_seeking = false` → proceed to Surface 10 (KB Q&A).
3. Malformed/empty classifier output, refusal, or `confidence: "unreadable"` → treat as advice-seeking and route to human (fail closed).

This honors the system prompt's "when in doubt, fail safe toward a human": the model fails safe by emitting `is_advice_seeking=true`, and the router never re-opens that decision on a low-confidence positive.

### 11.2 `review.advice_routed` has a single deterministic owner
`review.advice_routed` means exactly one thing: **"an advice-seeking conversational turn was hard-routed to a human."** Only the advice router in this surface writes it. **Other deterministic rules must NOT write `advice_routed`** — in particular, a missed-deadline / default-risk escalation or an overcharge-signal escalation is *not* an advice-seeking event and must set **`review.review_state = "escalated"` only**, never `advice_routed`. Conflating the two corrupts the UPL audit signal (an `advice_routed=true` with no corresponding `advice_detection_log[]` entry). The invariant: every `advice_routed=true` has a matching `advice_detection_log[]` hit written by this surface.

---

## 12. Surface 10 — Grounded KB Q&A

**Model:** `claude-opus-4-8` (trust-critical, runs **only after** Surface 11 clears the turn as non-advice-seeking). **Structured: No (free text). Citations: YES (grounded against the KB).**

> **Gated by §11.** This call is suppressed for advice-seeking turns. It answers factual/procedural questions only, grounded in the immutable KB; it never gives advice, predicts outcomes, or selects defenses.

**System prompt + KB (cached prefix, `ttl:"1h"`):** the frozen system prompt ("Answer factual/procedural questions about the NYC nonpayment process using ONLY the provided knowledge base. Do not give legal advice, do not predict outcomes, do not say whether the tenant has a case or which defense to use. If the question cannot be answered from the KB, say so and offer to connect the tenant to a human. Cite the KB passages you used.") **plus** the knowledge base documents. This whole prefix is byte-frozen and prompt-cached across all tenants — the single biggest cache win in the system.

**User turn (volatile):** the tenant's question + `case.language`.

**Citations:** the KB documents carry `citations: {enabled: true}`; the answer's `text` blocks return a `citations` array (KB passage `cited_text` + location). The PWA renders citations so answers are traceable. Because citations are on, **no** `output_config.format` (the two are incompatible) — output is free text, which is correct for a chat answer.

**Settings:** `thinking:{type:"adaptive"}`, `output_config:{effort:"medium"}`, `max_tokens: 2048` (streaming for chat UX). Output language = `case.language` (route through Surface 7 if the KB is English-only).

**Writes:** none to the Case Object (transient chat). If, despite the §11 gate, the answer surfaces that the tenant actually needs advice, the model is instructed to decline and offer handoff; deterministic code may then queue `review` (via the §11 router, which is the sole `advice_routed` writer). The grounded KB Q&A is read-only by design.

---

## 13. Surface 12 — Defenses checklist explanation

**Model:** `claude-sonnet-4-6`. **Structured: YES. Citations: No.**

> **Boundary.** Surfacing a possible defense + explaining what it *is* (general info) is information. **Asserting it applies / that the tenant "has a case" is the advice line** — `attorney_disposition` is attorney-only and `surfaced_as` is a hard const `"information_not_advice"`. This call sets neither the disposition nor a recommendation; it produces neutral explanations and a neutral relevance signal derived from facts/evidence.

**System prompt (cached prefix):** "For each candidate defense code, write a plain-English description of what that defense generally means in NYC nonpayment cases (general legal information, not advice about THIS tenant). Also emit a neutral relevance signal based only on whether supporting facts/evidence are present — never a recommendation, never a conclusion that it applies."

**User turn:** candidate `defense_code`s (from Surface 6 `supports_defense_codes`), confirmed facts, and which `evidence_id`s exist (with their verify-gate state for open-data-derived items — see §7 relevance-signal rule).

**Schema:**
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "required": ["items"],
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["defense_code", "surfaced_as", "relevance_signal", "explanation", "supporting_evidence_ids"],
        "properties": {
          "defense_code": { "type": "string", "enum": ["general_denial", "rent_paid", "rent_partially_paid", "improper_service", "defective_rent_demand", "defective_petition", "warranty_of_habitability", "repairs_needed", "rent_overcharge", "wrong_amount_claimed", "no_landlord_tenant_relationship", "not_registered_multiple_dwelling", "succession_rights", "laches", "rent_regulation_violation", "other"] },
          "surfaced_as": { "type": "string", "const": "information_not_advice" },
          "relevance_signal": { "type": ["string", "null"], "enum": ["possible", "evidence_present", "not_indicated", null], "description": "Neutral signal from facts/evidence; NOT a recommendation. Unverified open-data-derived support => 'possible' until verified (see §7)." },
          "explanation": { "type": ["string", "null"], "description": "General plain-English description of what this defense is." },
          "supporting_evidence_ids": { "type": "array", "items": { "type": "string", "description": "ev_ ULID FKs." } }
        }
      }
    }
  }
}
```

**Settings:** `thinking:{type:"adaptive"}`, `output_config:{effort:"medium"}`, `max_tokens: 4096`.

**Writes:** `defenses_checklist[]` — `defense_code`, `surfaced_as:"information_not_advice"` (const), `relevance_signal`, `explanation` (provenance `source:"llm_generation"`), `supporting_evidence_ids`. `attorney_reviewed` defaults `false`; `attorney_disposition` is **attorney-only** and is never set by this call.

---

## 14. Implementation checklist (per call)

For every call, deterministic wrapper code MUST:
1. Build the request with the **cached system/KB prefix first**, `cache_control` on the last stable block, per-case data after.
2. Use the **exact model id** from §1; record it in the relevant `*_model` / `provenance.model` field.
3. For Haiku calls, **omit `effort`** (400s otherwise) and omit thinking config.
4. For extraction/transcription needing citations, run **two passes** (structured then grounded) and never combine `output_config.format` with `citations`.
5. Check `stop_reason` before reading content; on `"refusal"` route to `review` (do not parse content); on `"max_tokens"` retry larger.
6. Wrap LLM values into `ConfirmableValue` with `tenant_confirmed:false`, set a **single-valued** `provenance.source` (`llm_extraction` for extraction surfaces, `llm_generation` for generation/transcription surfaces — never two values, never `llm_transcription`), and **never** set any of the five boundary `const` fields to a non-default value.
7. Append an `audit.events[]` entry with `field_path` + `model`.
8. Never let an LLM value flow into a filing/packet without its confirmation gate satisfied (`tenant_confirmed`, `case_type_confirmed`, `attorney_reviewed`, or `open_data.verify_before_file.state="verified"` for open-data).
9. **Never write `review.advice_routed`** outside the §11 advice router — escalations from non-advice events set `review.review_state="escalated"` only.

## 15. Confirmation-gate summary (LLM-written fields → gate)

| LLM-written field | `provenance.source` | Confirmation gate before filing/handoff use |
|---|---|---|
| `documents[].ocr_text` | `llm_extraction` | tenant-visible (not a ConfirmableValue) |
| `documents[].extracted_fields.*` | `llm_extraction` | `tenant_confirmed = true` (per field) |
| `case_type` | `llm_extraction` | `case_type_confirmed = true` |
| `documents[].document_type` | `llm_extraction` | tenant-confirmable |
| `timeline[].description` (LLM events) | `llm_generation` | `date_is_authoritative = false` — descriptive only, never filed on; deadline kinds not emitted by LLM |
| `answer_draft.factual_statements[].text` | `llm_generation` | `tenant_confirmed = true`; re-confirm after multilingual rewrite |
| `evidence[].tags/.summary/.supports_defense_codes` | `llm_generation` | informational; attorney review for defense mapping |
| `packets.legal_aid_handoff.intake_summary_text` | `llm_generation` | attorney review; CSR/LIST tags DET-confirmed; delivery needs `consent_id` + consent `data_categories` reconciliation |
| `review.triage_score` | (informational) | informational (routing only); `likely_eligible` internal-only |
| `review.advice_detection_log[]` | (log entry) | §11 router (sole writer) sets `advice_routed` / routing, fail-closed |
| `defenses_checklist[].explanation/.relevance_signal` | `llm_generation` | `attorney_reviewed`; `attorney_disposition` attorney-only |

Authoritative, safety-critical fields — `court.court_date` (eTrack/NYSCEF), `court.index_number` (DET-copied from the confirmed extracted value + NYSCEF cross-check), `deadlines[]` (`computed_by="deterministic"`), `eligibility.*` (`determined_by="deterministic"`), `answer_draft.form_fields[]` (`placed_by="deterministic"`), `property.bbl` (GeoSearch/PLUTO), and `review.advice_routed` (DET advice router) — are **never** written by any LLM call in this document.