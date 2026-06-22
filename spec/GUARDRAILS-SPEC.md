# Guardrails, UPL Firewall & Verify-Before-File — Engineering Spec

# Guardrails, UPL Firewall & Verify-Before-File

**Product:** Housing Court Copilot — legal-aid intake autopilot for NYC nonpayment eviction defense (MVP).
**Spec owner:** Safety/Compliance Enforcement
**Schema version:** `housing_court_copilot.case` v1 (`schema_version = "1.0.0"`)
**Status:** Implementation-ready

This document specifies the safety/compliance enforcement layer as concrete, testable mechanisms. It is the machine-enforced expression of the product's two non-negotiable commitments: (1) the LLM never crosses the advice line, and (2) no open-data assertion enters a filing without a tenant verify gate. Every mechanism below references the **canonical Case Object field names** exactly. Where a field is named, it is the authoritative source of truth; do not introduce conflicting names.

---

## 0. Scope, threat model, and the five hard invariants

### 0.1 What this layer protects against

| Risk (from RISKS-AND-COMPLIANCE.md) | Enforcement mechanism in this spec |
|---|---|
| **UPL** — unauthorized practice of law via individualized legal advice | §2 UPL Firewall (system-level output rules) + §1 advice-detection hard-route |
| **S7263 chatbot-proprietor civil liability** — proprietor liable for individualized legal advice an AI chatbot gives | §5 architectural rule: no output path can emit individualized legal advice; attorney-in-the-loop accountability |
| **Stale open data → 22 NYCRR 130 (tenant is the filer)** | §3 verify-before-file gate state machine + data-accuracy disclaimer copy |
| **Wrong-deadline = malpractice-style liability** | Deferred to the deadline-engine spec; this layer asserts the `deadlines[].computed_by = "deterministic"` invariant (§0.3) and never lets the LLM author a deadline |
| **FTC §5 / DoNotPay precedent** — deceptive "AI lawyer" representations | §4 persistent "legal information, not legal advice; not a lawyer" disclaimer placement |
| **SHIELD Act + immigration exposure** | §6 data-minimization at the model boundary |

### 0.2 The LLM/DETERMINISTIC boundary (from LLM-ARCHITECTURE.md)

This layer is the runtime guard on that boundary. Restating the line precisely, because every mechanism below enforces one side of it:

- **LLM may do:** vision intake, field extraction (structured outputs), case-type classification, plain-English explanation, faithful transcription into answer fields, evidence tagging, multilingual rewrite, intake-summary generation, provider-triage scoring, grounded KB Q&A, **advice-detection classification**.
- **DETERMINISTIC code only (a wrong answer = default judgment or bad filing):** deadline/statutory-clock computation, eligibility determinations, form-field placement/validation, court-date sourcing, **the advice line** (which defense / do they have a case / outcome prediction). The LLM may **extract and explain** dates but never compute them as authoritative.

The advice-detection classifier (§1) is an LLM task. The **decision to route on it** (§1.4) is deterministic. This split is itself a boundary invariant: a classifier hit is information; the route is code.

### 0.3 The five schema-enforced hard invariants

These five JSON-Schema `const` values make the boundary machine-checkable. Any payload attempting to set them otherwise **fails schema validation before persistence**. This layer treats a validation failure on any of these as a P0 safety incident (see §7.6), not a recoverable error.

| Field path | Required value | Meaning |
|---|---|---|
| `deadlines[].computed_by` | `"deterministic"` | LLM may explain a deadline but never compute it |
| `eligibility.rtc.determined_by` / `eligibility.legal_aid.determined_by` / `eligibility.rental_assistance.determined_by` | `"deterministic"` | eligibility is never an LLM conclusion |
| `answer_draft.form_fields[].placed_by` | `"deterministic"` | form-field placement/validation is never LLM |
| `answer_draft.factual_statements[].transcription_only` | `true` | faithful transcription, never legal advice/conclusion |
| `defenses_checklist[].surfaced_as` | `"information_not_advice"` | surfacing a defense informs; it never advises |

**Acceptance test AT-0.1 (schema rejects boundary violations):**
Construct five mutation payloads, each setting exactly one of the above to an illegal value (`computed_by: "llm"`, `determined_by: "llm"`, `placed_by: "llm"`, `transcription_only: false`, `surfaced_as: "advice"`). Each MUST be rejected by Case Object schema validation with a `boundary_invariant_violation` error and MUST NOT persist. The rejection MUST emit an `audit.events[]` entry with `action = "boundary_invariant_rejected"` and the offending `field_path`.

---

## 1. Advice-Detection Classifier

### 1.1 Purpose and placement

Every free-text turn the tenant submits — chat input, evidence narrative, answer-field free text, anything routed to a model — is screened by an advice-detection classifier **before** any substantive model response is composed and surfaced to the tenant. The classifier answers one question: *is this turn seeking legal advice, a legal conclusion, or an outcome prediction?* If yes, the case is hard-routed to a human; the substantive LLM response is suppressed.

The classifier is the runtime tripwire for the UPL line. The UPL firewall (§2) governs what the LLM may *output*; the advice-detection classifier governs which *inputs* must never receive a substantive AI answer at all.

### 1.2 Model and configuration

- **Model:** `claude-haiku-4-5` (cheap classification tier). Escalation tier `claude-sonnet-4-6` for low-confidence re-check (§1.5).
- **Structured output:** request uses `output_config.format` with a `json_schema` (see §1.3), or `messages.parse()` against the same schema. Do NOT use citations on this call — citations are incompatible with structured outputs (two-pass rule, §2.4); the classifier needs no citations.
- **Prompt caching:** the classifier system prompt + the advice-taxonomy few-shot block is a stable prefix; cache it with `cache_control: {type: "ephemeral"}`. The volatile per-turn tenant text goes after the last cache breakpoint.
- **Provenance:** every classifier run is logged to `review.advice_detection_log[]` with `at`, `classifier_model`, `is_advice_seeking`, and `confidence` (a `ConfidenceLevel`).

### 1.3 Input and output contract

**Input to the classifier:**
- `turn_text` (string) — the tenant's verbatim message for this turn.
- `turn_context` (enum) — one of `chat`, `answer_free_text`, `evidence_narrative`, `kb_question`, `other`. Lets the classifier weight context (a KB question like "what is a rent demand" is informational; "do I have to pay this rent demand" is advice-seeking).
- `language` — the case's `language` (BCP-47); the classifier MUST detect advice-seeking intent across the supported languages (`en`, `es`, `zh-Hant`, `ht`, `bn`, `ru`, `ar`, `ko`), not English only.

**Output (structured, `output_config.format`):**

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["is_advice_seeking", "category", "confidence", "matched_intents"],
  "properties": {
    "is_advice_seeking": { "type": "boolean" },
    "category": {
      "type": "string",
      "enum": [
        "case_strength",          // "do I have a case", "will I win"
        "defense_selection",      // "which defense should I use", "should I claim X"
        "outcome_prediction",     // "will the judge rule for me", "how much will I owe"
        "should_i_action",        // "should I pay", "should I show up", "should I sign"
        "legal_conclusion",       // "is this rent demand defective", "is my landlord allowed to..."
        "strategy",               // "what's my best move", "what should I argue"
        "none"                    // not advice-seeking
      ]
    },
    "confidence": { "type": "string", "enum": ["high", "medium", "low", "unreadable"] },
    "matched_intents": { "type": "array", "items": { "type": "string" } }
  }
}
```

`category = "none"` MUST co-occur with `is_advice_seeking = false`; any other category MUST co-occur with `is_advice_seeking = true`. (Enforced in §1.4 step 1.)

### 1.4 Phrase/intent surface the classifier MUST catch

The classifier is trained/prompted to flag the following intent families. These are illustrative anchors, not a literal allowlist — the classifier MUST generalize to paraphrases and to the supported non-English languages.

| Intent family | `category` | Must-catch anchors (and paraphrases) |
|---|---|---|
| Case strength | `case_strength` | "do I have a case", "is my case strong", "will I win", "can I beat this", "is it worth fighting" |
| Defense selection | `defense_selection` | "which defense should I use", "should I claim the apartment isn't registered", "is warranty of habitability my best defense", "should I raise repairs" |
| Outcome prediction | `outcome_prediction` | "what will the judge decide", "how much will I have to pay", "will I get evicted", "what are my chances" |
| Should-I action | `should_i_action` | "should I pay the arrears", "should I show up to court", "should I sign this stipulation", "do I have to move out" |
| Legal conclusion | `legal_conclusion` | "is this rent demand defective", "is my landlord allowed to do this", "is the petition valid", "was I served properly" |
| Strategy | `strategy` | "what's my best move", "what should I argue", "how do I get this dismissed", "what do I say to the judge" |

**Deterministic routing decision (this is code, not the LLM). The fail-closed rule below (step 5) closes the low-confidence-positive gap: a positive that the classifier ever emitted can never be downgraded into a substantive answer.**

1. **Consistency guard.** If `is_advice_seeking == true` and `category == "none"` (or vice versa), treat the classifier output as malformed → fail closed: route to human (§1.6).
2. **Hard route on confident positive.** If `is_advice_seeking == true` with `confidence ∈ {high, medium}` → execute the hard-route-to-human transition (§1.6). Suppress any substantive LLM answer for this turn.
3. **Low-confidence / unreadable positive — escalate, but fail closed.** If `is_advice_seeking == true` with `confidence ∈ {low, unreadable}` → re-run the classifier once on `claude-sonnet-4-6` (§1.5):
   - If the escalation returns `is_advice_seeking == true` (any confidence) → hard-route to human (§1.6).
   - If the escalation returns `is_advice_seeking == false` with `confidence ∈ {high, medium}` → the turn proceeds to its normal information-only handler **but only if it would not have routed under step 4/5 on its own merits**. A Haiku positive is sticky: because the first-tier classifier flagged advice intent, this turn is treated as **borderline** and the substantive handler is additionally subject to the UPL firewall (§2) AND a post-hoc outbound scan (§2.5) before anything is surfaced; any §2.5 flag re-routes to human. The fail-closed claim (§7.1) holds: a genuine advice question is never answered substantively, because either Sonnet confirms it (route) or the firewall/scanner catches the substantive output.
   - If the escalation again returns `is_advice_seeking == false` with `confidence ∈ {low, unreadable}` → **fail closed and route to human** (§1.6). An inconclusive escalation of a positive is never cleared.
4. **Confident negative.** If `is_advice_seeking == false` with `confidence ∈ {high, medium}` → allow the turn to proceed to its normal (information-only) handler, still subject to the UPL firewall (§2) on the *output*.
5. **Low-confidence negative.** If `is_advice_seeking == false` with `confidence ∈ {low, unreadable}` → escalate to `claude-sonnet-4-6` (§1.5); if still negative low/unreadable → **fail closed and route to human** (§1.6). Absence of confident clearance is never treated as clearance.

> **Rationale (closes reviewer gap on the low-confidence positive path):** the previous design let a Haiku low-confidence positive be answered substantively if Sonnet downgraded it. The corrected step 3 keeps any Haiku positive sticky — a downgrade only permits an information-only handler that is itself firewall- and scanner-gated, and an inconclusive escalation always routes. There is no path from a positive classifier hit to an unchecked substantive answer.

### 1.5 Escalation

A single re-check on `claude-sonnet-4-6` with the same structured-output schema. The escalation result is appended to `review.advice_detection_log[]` as its own entry (`classifier_model = "claude-sonnet-4-6"`). The classifier is never escalated to `claude-opus-4-8` solely for advice detection — Opus is reserved for the trust-critical generation tasks; an inconclusive advice classification fails closed to a human, which is cheaper and safer than a third model pass.

### 1.6 Hard-route-to-human behavior (the sole writer of `review.advice_routed`)

`review.advice_routed` has a single, documented meaning: **an advice-seeking conversational turn was hard-routed to a human.** The conversational advice router defined here is the **only** writer of `review.advice_routed = true`. Deterministic engine rules (e.g. the deadline-engine default-risk rule and the overcharge rule in legal-rules) MUST NOT set `advice_routed`; a missed-deadline or overcharge escalation is not an advice-seeking event and sets `review.review_state = "escalated"` only (see §1.8 and §5.2). This preserves the UPL audit signal: every `advice_routed = true` has a corresponding `advice_detection_log[]` entry.

On a positive advice-seeking decision (or any fail-closed path above), the deterministic router MUST:

1. Set `review.advice_routed = true` (`x-provenance` DET on this field; the *decision* is deterministic even though the *detection* is LLM). The write actor is `deterministic_engine`; the corresponding `advice_detection_log[]` entry MUST already exist for this turn.
2. Transition `review.review_state`: `unassigned → queued` (or `→ escalated` if a deadline `risk.is_imminent` or `risk.default_risk` is set on any `deadlines[]` entry — advice-seeking near a deadline is urgent).
3. **Suppress the substantive answer.** The tenant MUST NOT receive an AI-generated answer to the advice-seeking turn. Instead, surface the fixed non-advice response (see §1.7) plus the persistent disclaimer (§4).
4. Append an `audit.events[]` entry: `action = "advice_routed"`, `actor.actor_type = "deterministic_engine"`, with the `field_path = "/review/advice_routed"` and the triggering `classifier_model`.
5. The advice-routed state is **sticky for that turn**: once routed, the turn cannot be un-routed by a later lower-confidence re-classification. `review.advice_routed` only resets to `false` if an attorney explicitly clears it (an `attorney_entered` provenance mutation).

### 1.7 The fixed non-advice response (UI copy)

When a turn is hard-routed, the tenant sees a templated, non-individualized message (no legal conclusion, no defense, no prediction). Exact copy is owned by the content team; it MUST:
- Acknowledge the question is important and that a person will help.
- State plainly: *"I can't tell you what to do or whether you have a case — a lawyer needs to answer that. I've flagged your question for the legal team."*
- NOT restate the tenant's question in a way that implies an answer.
- Carry the persistent disclaimer (§4).

### 1.8 Distinguishing advice-routing from engine escalation (single-writer invariant)

Two distinct escalation pathways exist, and they MUST NOT be conflated on the same field:

| Trigger | Field written | Writer | Audit signal |
|---|---|---|---|
| Advice-seeking conversational turn (this section) | `review.advice_routed = true` **and** `review.review_state = "escalated"`/`"queued"` | conversational advice router (DET decision on LLM detection) | matching `review.advice_detection_log[]` entry |
| Deterministic engine escalation (missed/imminent deadline `risk.default_risk`, overcharge signal, etc. — owned by the deadline/eligibility engine specs) | `review.review_state = "escalated"` **only** | `deterministic_engine` | `audit.events[]` action `engine_escalated`; NO `advice_detection_log[]` entry, NO `advice_routed` write |

**Invariant AT-1.8:** for any case where `review.advice_routed == true`, there MUST be at least one `review.advice_detection_log[]` entry whose `is_advice_seeking == true`. A case with `advice_routed == true` and no corresponding advice-detection log entry is a P1 audit-integrity defect (it means a non-advice writer touched the field). Conversely, an engine escalation MUST NOT produce `advice_routed == true`.

### 1.9 Acceptance tests / red-line assertions

- **AT-1.1 (must-catch recall):** A labeled fixture set of ≥ 200 advice-seeking phrases covering all six advice-seeking `category` families and all eight supported languages. Recall on `is_advice_seeking == true` MUST be ≥ 0.98 at `confidence ∈ {high, medium}`. Any miss is a defect.
- **AT-1.2 (hard route fires):** For every fixture where `is_advice_seeking == true`, after processing, the case MUST have `review.advice_routed == true` and `review.review_state ∈ {queued, escalated}`, and the tenant transcript MUST contain the fixed non-advice response (§1.7), NOT a substantive answer.
- **AT-1.3 (no substantive answer leaks):** Red-line. For any advice-seeking turn, assert the surfaced response contains none of: a `defense_code` value, a probability/percentage, a "you should/shouldn't" construction, or a "you (do/don't) have a case" construction. Implemented as a post-hoc string + classifier check on the outbound message; a violation is a P0.
- **AT-1.4 (fail-closed on uncertainty):** Inject classifier outputs with `confidence == unreadable` and with the malformed `(is_advice_seeking=true, category="none")` combination. Both MUST route to human, never proceed to a substantive handler.
- **AT-1.4b (low-confidence positive never answered):** Inject a Haiku output `(is_advice_seeking=true, confidence=low)` paired with a Sonnet escalation `(is_advice_seeking=false, confidence=high)`. Assert the substantive handler runs only behind the firewall + outbound scanner (§2.5), and that any §2.1 hit re-routes to human. Inject the same Haiku output paired with a Sonnet escalation `(is_advice_seeking=false, confidence=low)`; assert it routes to human (fail closed). No path yields an unchecked substantive answer.
- **AT-1.5 (multilingual):** The Spanish "¿debería pagar la renta?", Chinese "我应该付房租吗?", Haitian Creole "èske m dwe peye lwaye a?" (and equivalents in the remaining supported languages) MUST each classify `is_advice_seeking == true`, `category == "should_i_action"`.
- **AT-1.6 (KB question is not advice):** "What is a rent demand?" / "What does 'nonpayment' mean?" with `turn_context = kb_question` MUST classify `is_advice_seeking == false` and proceed to grounded KB Q&A.
- **AT-1.7 (every screened turn is logged):** Assert `review.advice_detection_log[]` gains exactly one entry per classifier invocation (two if escalated), each with a non-null `at`, `classifier_model`, `is_advice_seeking`, and `confidence`.
- **AT-1.8 (single-writer / audit integrity):** See §1.8. Assert no `advice_routed == true` exists without a corresponding `is_advice_seeking == true` log entry, and that engine escalations set only `review.review_state` (never `advice_routed`).

---

## 2. UPL Firewall (system-level output rules)

The UPL firewall constrains what any LLM call in the system may **output** and how generated content is **gated** before a human (tenant or attorney) sees it as anything more than information. It is layered on top of the advice-detection classifier: even on a turn the classifier cleared (or a borderline turn per §1.4 step 3), the *output* still passes the firewall.

### 2.1 What the LLM may NEVER output

These are absolute output prohibitions, enforced by (a) system-prompt constraints on every generation call, (b) structured-output schemas that have no field capable of carrying a legal conclusion, and (c) a deterministic outbound content scanner (§2.5). Across all surfaces — chat, `documents[].ocr_text`, `timeline[].description`, `deadlines[].explanation`, `evidence[].summary`, `answer_draft.factual_statements[].text`, `defenses_checklist[].explanation`, `packets.legal_aid_handoff.intake_summary_text` — the LLM MUST NOT output:

1. **A legal conclusion about this case.** e.g. "your rent demand is defective", "you were not properly served", "the petition is invalid", "your landlord broke the law".
2. **A defense selection or assertion.** Stating that the tenant *has*, *should raise*, or *should rely on* a specific `defense_code`. (Surfacing the *existence* of a defense as general information is permitted only via `defenses_checklist[]` with `surfaced_as = "information_not_advice"`, §2.3.)
3. **A case-strength assessment.** "you have a strong case", "you're likely to win/lose", any probability or odds.
4. **An outcome prediction.** What a judge will decide, how much the tenant will owe, whether they will be evicted.
5. **A directive to act or not act on a legal matter.** "you should pay", "don't sign", "you must appear", "you don't have to move out". (Neutral procedural facts sourced from the deterministic engine — e.g. *"the answer deadline computed by the system is YYYY-MM-DD"* — are surfaced by code, not authored by the LLM as advice; see §2.6.)
6. **An authoritative date, deadline, or eligibility determination.** The LLM may *extract* a date into a `documents[].extracted_fields.*` `ConfirmableValue` and *explain* a deadline in `deadlines[].explanation`, but it MUST NOT present any date as the authoritative clock or compute eligibility. Authoritative values come only from `deadlines[]` (`computed_by = "deterministic"`), `court.court_date` (DET-sourced, `court_date_verified` true only when from `etrack`/`nyscef`), and `eligibility.*` (`determined_by = "deterministic"`).
7. **Any characterization of legal salience without attorney review** (the faithful-transcription constraint, §2.2).

### 2.2 The faithful-transcription constraint

`answer_draft.factual_statements[]` is the highest-risk LLM output: text that goes into a court filing. The constraint:

- Each statement carries `transcription_only = true` (hard `const`; §0.3). The LLM's job is to transcribe the tenant's own factual statements — including multilingual rewrite from `source_language` into the filing language — **verbatim in substance**, with no added legal characterization, no editorializing about what a fact *means* legally, and no claim about which `defense_code` the fact supports.
- **No characterizing legal salience.** The LLM MUST NOT write "this shows your landlord failed to maintain the apartment (warranty of habitability)" — that maps a fact to a defense and characterizes its legal significance. It MAY write the tenant's own statement of fact: "the heat was off from December 1 to December 20, and I called the landlord twice."
- Each statement carries `provenance` (a `Provenance` object). For a faithful-transcription statement, `provenance.source` is **exactly one** value per statement, never two: it is `llm_generation` when the LLM transcribed/multilingual-rewrote the tenant's words (the normal case — `provenance.model` is the exact model id used), OR `tenant_entered` when the tenant typed the statement verbatim and the LLM did not rewrite it. There is no `llm_transcription` value in the canonical `Provenance.source` enum; transcription output uses `llm_generation`. The schema's single-valued `source` enforces this — a statement cannot claim both.
- Each statement remains `tenant_confirmed = false` until the tenant confirms. A statement with `tenant_confirmed = false` MUST NOT be placed into any `answer_draft.form_fields[]` (the placement is deterministic and gated, §2.6).
- The mapping of a fact to a candidate defense is NOT done in `factual_statements[]`. It happens, if at all, only in `evidence[].supports_defense_codes[]` and `defenses_checklist[]` — both explicitly "information, not advice", both attorney-gated (§2.3).

### 2.3 How fact-classification / defense surfacing is gated behind `attorney_reviewed`

The product surfaces *possible* defenses as information; it never asserts one. The gate:

- A `defenses_checklist[]` item carries `surfaced_as = "information_not_advice"` (hard `const`; §0.3). Its `explanation` is LLM-generated **general** info about what the defense is — not a statement that it applies here.
- `relevance_signal` is a neutral signal (`possible` / `evidence_present` / `not_indicated`) derived from facts/evidence. It is explicitly **not a recommendation**. The system prompt and schema forbid the LLM from emitting anything beyond these enum values for relevance. (Cross-tool consistency: for an unverified open-data-derived defense signal, sibling tools MUST use the same relevance semantics — see §3.8.)
- `attorney_reviewed` defaults `false`. `attorney_disposition` (`applicable` / `not_applicable` / `needs_more_info`) is an **attorney-only field** — it is the advice line. The deterministic layer MUST reject any mutation of `attorney_disposition` whose `audit.events[].actor.actor_type != "attorney"` (provenance `attorney_entered`).
- **Display gate.** Before `attorney_reviewed == true`, the tenant-facing UI MUST present `defenses_checklist[]` items only as neutral educational information ("here are defenses that *can* apply in nonpayment cases generally"), never as "defenses that apply to you". The asserted form — "you have/should raise defense X" — is only ever shown after an attorney sets `attorney_disposition = "applicable"`, and even then attributed to the attorney, not the AI.
- Same gate for `evidence[].supports_defense_codes[]`: this LLM-tagged mapping is information for human review only; it MUST NOT be rendered to the tenant as "this proves defense X" and MUST NOT flow into a filing without attorney review.

### 2.4 Citations vs. structured outputs — the two-pass rule

Citations are incompatible with structured outputs (`output_config.format`); a single API call attempting both is rejected. Field extraction (a structured-output task that populates `documents[].extracted_fields.*` `ConfirmableValue`s) and citation/grounding (which needs the `Provenance.locator` `SourceLocator` with `page_number` / `start_char_index` / `quote`) therefore run as **two passes**:

1. **Pass A — structured extraction:** `output_config.format` (or `messages.parse()`) with the extraction schema. No citations. Produces the typed values.
2. **Pass B — grounded citation:** a separate grounded call (citations enabled, no structured output) that attaches the `SourceLocator` to each extracted value's `provenance.locator`.

The firewall asserts that neither pass produces a legal conclusion (both are subject to §2.1) and that the extraction pass is structurally incapable of emitting a defense or determination (its schema has no such field).

### 2.5 Deterministic outbound content scanner

Independent of the model, a deterministic scanner inspects every LLM-authored string before it is shown to a tenant or written into a filing-bound field. It is a defense-in-depth net, not the primary control. It MUST flag (and block + route to human) outbound text matching the §2.1 prohibitions: defense-assertion constructions, probability/odds language, "you should/shouldn't" + legal-action constructions, "you (do/don't) have a case", and any authoritative-date claim that did not originate from `deadlines[]` / `court.court_date`. For borderline turns (§1.4 step 3), the scanner runs on the substantive output **before** it is surfaced, and any flag re-routes to human. A scanner flag on a *generation* output is a P1 (the model emitted something it shouldn't have); on a *filing-bound* field it is a P0.

### 2.6 Form-field placement is deterministic

`answer_draft.form_fields[]` carries `placed_by = "deterministic"` (hard `const`; §0.3) and `validation_state ∈ {valid, invalid, missing_required, pending}`. Mapping a confirmed `factual_statements[]` entry into an official NY fillable-PDF field is done by deterministic code (docassemble/AssemblyLine variable mapping + validation against the form template version), never by the LLM. A field MUST NOT reach `validation_state = "valid"` unless its source statement has `tenant_confirmed = true`. The LLM has no write path to `form_fields[]`.

### 2.7 Acceptance tests / red-line assertions

- **AT-2.1 (transcription has no legal characterization):** For a corpus of tenant narratives, assert generated `answer_draft.factual_statements[].text` contains no `defense_code` token, no "warranty of habitability"/"defective"/"improper service" legal-characterization phrases, and no "this means/shows/proves" salience constructions. Manual + classifier review; zero tolerance.
- **AT-2.1b (single-valued provenance):** Assert every `answer_draft.factual_statements[].provenance.source` is exactly one of `llm_generation` or `tenant_entered` (never the non-enum `llm_transcription`, never two values). When `source == "llm_generation"`, `provenance.model` is a valid model id.
- **AT-2.2 (transcription_only is immutable):** Attempt to persist a `factual_statements[]` entry with `transcription_only = false` → schema rejection (covered by AT-0.1, asserted again here at the answer-draft layer).
- **AT-2.3 (defense disposition is attorney-only):** Attempt to set `defenses_checklist[].attorney_disposition` via a mutation whose `actor.actor_type ∈ {tenant, system, deterministic_engine, provider}` → rejected; only `attorney` accepted. Assert an `audit.events[]` rejection entry.
- **AT-2.4 (pre-review display gate):** With `defenses_checklist[i].attorney_reviewed == false`, assert the tenant-facing render of item `i` does NOT contain "you have", "you should", "applies to your case", or "your defense". After an attorney sets `attorney_disposition = "applicable"` and `attorney_reviewed = true`, the asserted form is permitted and is attributed to the attorney.
- **AT-2.5 (two-pass, no citations under structured output):** Assert the extraction call sets `output_config.format` and does NOT enable citations; assert the citation pass enables citations and does NOT set `output_config.format`. A single call doing both MUST be rejected at the API-client wrapper (it would 400 anyway; the wrapper fails fast with a clear error).
- **AT-2.6 (LLM has no write path to deterministic fields):** Static + runtime assertion that no code path lets an LLM response populate `deadlines[]`, `eligibility.*`, `court.court_date`, or `answer_draft.form_fields[]`. The only LLM-writable date surface is `documents[].extracted_fields.*.value` (a `ConfirmableValue`, never authoritative).
- **AT-2.7 (outbound scanner blocks filing-bound conclusions):** Feed the scanner crafted strings hitting each §2.1 prohibition; assert each is blocked and, when filing-bound, raises a P0.

---

## 3. Verify-Before-File Gate State Machine

Every open-data-derived assertion (HPD violations `hpd_violations_wvxf-dwi5`, HPD complaints `hpd_complaints_ygpa-z7cr`, HPD registration `hpd_registration_tesw-yqqr`, HPD contacts `hpd_contacts_feu5-w2e2`, JustFix WoW `justfix_wow`, GeoSearch `nyc_geosearch`, PLUTO/PAD `pluto_pad`, NYCDB self-host `nycdb_selfhost`) is non-authoritative until the **tenant** verifies it. The tenant is the filer and bears 22 NYCRR 130 risk; the system never auto-asserts open data into a filing.

### 3.1 Where the gate lives

Open-data assertions appear in two places, and both carry an `OpenDataAssertion`:
- `parties.landlord.open_data` (backing the `registered_owner_name`, `wow_landlord_id`, `registration_on_file` signals).
- `evidence[]` items with `origin = "open_data"` — schema-required to carry `evidence[].open_data` (the `allOf`/`if-then` in the schema enforces this; see §3.6).

Each `OpenDataAssertion` carries `dataset`, `dataset_version`, `retrieved_at`, `endpoint`, `data_accuracy_disclaimer`, and the `verify_before_file` gate (a `VerifyGate`).

### 3.2 The state machine

`VerifyGate.state ∈ { unverified, verified, disputed, not_applicable }`.

```
                       ┌─────────────────────────────────────────────┐
                       │                                             │
  [open-data fetch] ──▶ unverified ──tenant confirms──▶ verified ─────┤
                       │     │                              │         │
                       │     │ tenant disputes              │ data    │
                       │     ▼                              │ refetched/changed
                       │  disputed ◀───tenant disputes──────┘         │
                       │     │                                        │
                       │     └────tenant re-confirms──▶ verified      │
                       │                                              │
                       └── not_applicable (assertion not used in any packet) ──┘
```

**States and transitions (all transitions are deterministic; the tenant action is the trigger, the state write is code):**

| From | Event | To | Side effects |
|---|---|---|---|
| (creation) | open-data fetched & attached | `unverified` | `data_accuracy_disclaimer` populated (§3.4); `verified_at = null`; `verified_by = null` |
| `unverified` | tenant affirmatively confirms accuracy after seeing the disclaimer | `verified` | `verified_at = now()`; `verified_by.actor_type = "tenant"`; audit event |
| `unverified` | tenant says the data is wrong / can't confirm | `disputed` | `tenant_note` optionally set; audit event |
| `unverified` / `verified` / `disputed` | the assertion is determined not to be used in any packet | `not_applicable` | removed from packet eligibility; audit event |
| `disputed` | tenant later confirms accuracy | `verified` | as above |
| `verified` | underlying dataset re-fetched and `dataset_version` changed, OR `retrieved_at` staleness window exceeded | `unverified` | **re-verification required**; `verified_at = null`; audit event (§3.5) |

**Eligible-for-packet** is a derived predicate, not a stored state: an assertion is packet-eligible **iff** `verify_before_file.state == "verified"`. `not_applicable` is for assertions that were surfaced but the tenant/attorney chose not to use — they are not packet-eligible and don't block anything.

### 3.3 Hard block on packet assembly (full open-data scan, not just `included_evidence_ids`)

The deterministic packet assembler MUST refuse to include any open-data assertion whose gate is not `verified`. The block is recorded on the packet:

- `packets.court_packet.blocked_by_unverified_open_data` and `packets.legal_aid_handoff.blocked_by_unverified_open_data` are DET booleans, default `false`. (`LegalAidHandoffPacket` inherits this field from `Packet` via `allOf`.)
- Before assembly, the assembler scans **every** open-data assertion *referenced or surfaced by* the packet — this is the full scan, not just the evidence list. The scan MUST cover:
  1. `packets.*.included_evidence_ids[]` → the corresponding `evidence[].open_data`, and
  2. `parties.landlord.open_data` whenever the packet's content (court packet body, or the `legal_aid_handoff.intake_summary_text` / CSR-LIST tagging) draws on landlord registration/ownership/standing signals (`registered_owner_name`, `wow_landlord_id`, `registration_on_file`).
- If any scanned assertion has `verify_before_file.state != "verified"`, the assembler sets `blocked_by_unverified_open_data = true`, sets `packets.*.status = "blocked"` (a `DocumentAssemblyStatus`), and does NOT produce a filing-bound PDF/A.
- `disputed` and `unverified` both block. Only `verified` clears; `not_applicable` assertions are simply excluded from the packet (they neither block nor enter it).

> **Enforcement-point fix (reviewer cross-ref):** the handoff generator MUST scan `parties.landlord.open_data`, not only `included_evidence_ids[]`. Otherwise an unverified landlord-registration assertion could enter the one-page intake summary. The scan is a single shared routine used by both the court-packet assembler and the handoff generator.

### 3.4 Data-accuracy disclaimer copy requirements

`OpenDataAssertion.data_accuracy_disclaimer` is required text shown to the tenant at the moment they're asked to verify. Per-dataset templates owned by content/legal; each MUST:

1. **Name the source and its recency.** Identify the dataset in plain language (e.g. "NYC HPD housing-code violation records") and the snapshot date from `dataset_version` / `retrieved_at` (e.g. "as of 2026-06-15").
2. **State it may be stale or incomplete.** Explicit: *"This information comes from a public city database. It may be out of date, incomplete, or contain errors."*
3. **Place the filing risk on the tenant as filer.** *"Because you are the person filing with the court, you are responsible for the accuracy of anything in your papers. Please check this against your own records before you rely on it."* (This is the 22 NYCRR 130 stake, in plain English.)
4. **Require an affirmative action, not a default.** The verify control is opt-in: an unchecked / unconfirmed state stays `unverified`. Silence is never `verified`.
5. **Be localized** to the case's `language`.

The disclaimer copy is versioned alongside the rule/config it belongs to; the displayed version is reconstructable from `dataset_version` and the content-template version.

### 3.5 Staleness re-verification

A `verified` gate is not verified forever. The deterministic layer enforces a configurable staleness window. The config is version-stamped and lives under a named key:

- **Config key:** `verify_gate.staleness_window_days` — a per-dataset map (keyed by the `OpenDataAssertion.dataset` enum value) of integer day counts, owned by the deterministic config (the same config family that carries `eligibility.config_version` and rule versions). It is monitored configuration; its version is recorded so a revert decision is reproducible.
- **Default values:** populated by the Phase-0 config alongside the eligibility/deadline rule values; until populated and attorney-validated, the staleness check is **fail-safe** — an unset window for a dataset is treated as `0` days, i.e. any `verified` gate older than the same packet-assembly run reverts to `unverified` (re-verify before every assembly). This guarantees AT-3.6 is implementable from day one and a "verified" assertion never silently persists.

On packet assembly the assembler re-checks: if `now() - retrieved_at` exceeds the dataset's `staleness_window_days`, OR a re-fetch produced a different `dataset_version`, the gate is forced back to `unverified` (§3.2 last row) and the packet is blocked until the tenant re-verifies against current data.

### 3.6 Schema-level enforcement

`EvidenceItem` has an `allOf`/`if-then`: `if origin == "open_data" then open_data is required`. An open-data evidence item with no `OpenDataAssertion` is schema-invalid. `OpenDataAssertion` itself requires `dataset`, `dataset_version`, `data_accuracy_disclaimer`, and `verify_before_file`. Thus the disclaimer and gate cannot be omitted at the data layer.

### 3.7 Registration-defense signal preservation

The canonical `parties.landlord` object carries only `registration_on_file` (boolean) — there is no `registration_current` field. The HPD-registration lookup tool may compute an "on-file-but-expired/lapsed" distinction, but it has no canonical home and MUST NOT be silently lost. The mapping this layer enforces:

- `registration_on_file = true` means a **current, non-expired** HPD registration exists. An on-file-but-expired registration MUST be mapped to `registration_on_file = false` (a registration-defense signal: no *current* registration on file), NOT to `true`.
- The expired/lapsed nuance, where relevant to a possible defense, is surfaced as a `defenses_checklist[]` item (`defense_code = "not_registered_multiple_dwelling"`, `surfaced_as = "information_not_advice"`, `relevance_signal` per §3.8) and/or an `evidence[]` item of `evidence_type = "registration_record"` with `origin = "open_data"`, carrying the `OpenDataAssertion` (and therefore the verify gate). The boolean is the standing signal; the human-reviewed detail lives in the checklist/evidence with full provenance and disclaimer.

> **Reviewer fix:** without this explicit mapping, an expired registration would collapse to `registration_on_file = true` and the defense signal would vanish. The deterministic lookup-to-Case-Object mapping documented here keeps `registration_on_file` semantically meaning "current registration exists" so the defense signal survives.

### 3.8 Consistent relevance semantics for unverified open-data defenses

Open-data-derived `defenses_checklist[]` items (whether from HPD violations, HPD complaints, or HPD registration) are **unverified** until the tenant verifies the underlying assertion. To keep sibling tools consistent (a reviewer cross-ref finding), the deterministic mapping layer assigns `relevance_signal` uniformly:

- While the backing `OpenDataAssertion.verify_before_file.state != "verified"`, an open-data-derived defense checklist item uses `relevance_signal = "possible"` (a neutral signal that something *might* apply, pending verification) — NOT `evidence_present`.
- Only once the backing assertion is `verified` may the mapping promote the signal to `relevance_signal = "evidence_present"`.
- This single rule applies to all open-data sources (violations, complaints, registration) so sibling lookups do not diverge (some using `possible`, others `evidence_present`) on analogous unverified items.
- `relevance_signal` is never a recommendation either way (§2.3); promotion to `evidence_present` does not assert the defense — that remains attorney-only via `attorney_disposition`.

### 3.9 Acceptance tests / red-line assertions

- **AT-3.1 (unverified blocks the packet):** Attach an open-data `evidence[]` item (`origin = "open_data"`, gate `unverified`) and reference it in `packets.court_packet.included_evidence_ids[]`. Run assembly. Assert `packets.court_packet.blocked_by_unverified_open_data == true`, `status == "blocked"`, and no PDF/A `storage_ref` produced.
- **AT-3.2 (disputed blocks the packet):** Same as AT-3.1 but gate `disputed` → still blocked.
- **AT-3.3 (verified clears):** Transition the gate to `verified` (tenant action, `verified_by.actor_type == "tenant"`, `verified_at` set). Re-run assembly. Assert `blocked_by_unverified_open_data == false` and the packet assembles.
- **AT-3.3b (landlord open_data is scanned in handoff):** Set `parties.landlord.open_data.verify_before_file.state = "unverified"` and generate `packets.legal_aid_handoff` whose intake summary / tags draw on landlord registration. Assert `blocked_by_unverified_open_data == true` and `status == "blocked"` even though no `included_evidence_ids[]` is unverified.
- **AT-3.4 (no auto-verify):** Assert there is no code path that sets `verify_before_file.state = "verified"` with `verified_by.actor_type != "tenant"`. (Attorney override, if ever allowed, is out of MVP scope and would require its own audited path.)
- **AT-3.5 (disclaimer required & non-empty):** For every `OpenDataAssertion`, assert `data_accuracy_disclaimer` is present, non-empty, names the dataset, and is in the case `language`. Schema rejects a missing disclaimer (AT-3.8).
- **AT-3.6 (staleness forces re-verify):** Set `retrieved_at` beyond `verify_gate.staleness_window_days[dataset]` on a `verified` gate; run assembly; assert the gate reverts to `unverified` and the packet is blocked. With the window unset, assert the fail-safe (`0`-day) behavior applies.
- **AT-3.7 (dataset_version change forces re-verify):** Re-fetch open data yielding a new `dataset_version` on a `verified` assertion; assert revert to `unverified`.
- **AT-3.8 (open-data evidence must carry the assertion):** Persist an `evidence[]` item with `origin = "open_data"` and no `open_data` object → schema rejection.
- **AT-3.9 (silence is not consent):** Render the verify UI, take no tenant action, attempt assembly → blocked. The gate remains `unverified`.
- **AT-3.10 (expired registration is not silently lost):** Feed the registration lookup an on-file-but-expired result. Assert `parties.landlord.registration_on_file == false` and that a `defenses_checklist[]` item (`defense_code = "not_registered_multiple_dwelling"`) and/or `evidence[]` registration record carries the unverified `OpenDataAssertion` with `relevance_signal = "possible"`.

---

## 4. Persistent "legal information, not legal advice; not a lawyer" disclaimer

Anchored in FTC §5 (deceptive-representation risk) and the DoNotPay "robot lawyer" enforcement precedent: the product must never represent itself as a lawyer or as giving legal advice. This is enforced as a **persistent, non-dismissable** disclaimer plus naming/representation rules.

### 4.1 Required copy (canonical)

The canonical disclaimer string (localized to `language`):

> **This is legal information, not legal advice. Housing Court Copilot is not a lawyer and cannot give you legal advice or tell you what to do in your case. A lawyer reviews your case before anything is filed.**

A short form is permitted in space-constrained surfaces (e.g. SMS): *"Legal info, not legal advice. Not a lawyer. A lawyer reviews your case."*

### 4.2 Placement requirements

The disclaimer (full or short form) MUST appear on every surface where the product communicates substantive content to a tenant:

| Surface | Form | Requirement |
|---|---|---|
| App shell / every screen of the PWA | full or persistent footer | Persistent, present on initial load and not removable by scrolling away |
| First-run / onboarding | full | Acknowledged before intake begins (logged) |
| Every chat response from the assistant | short | Attached to or immediately adjacent to each assistant message |
| The fixed non-advice response after a hard-route (§1.7) | full | Always |
| `documents[].ocr_text`, `timeline`, `deadlines[].explanation`, `evidence[].summary` views | full or footer | Visible while these are displayed |
| `packets.legal_aid_handoff` intake summary & any tenant-facing PDF | full | Printed on the document |
| SMS reminders (`reminders[]`, channel `sms`) | short | Appended where length permits; at minimum on the first message of any thread |
| Disclaimer must precede or accompany — never follow out of view — any defense information (`defenses_checklist[]`) | full | Especially critical pre-attorney-review (§2.3) |

### 4.3 Naming and representation rules (FTC §5)

- The product MUST NOT be named, described, or marketed as an "AI lawyer", "robot lawyer", "your lawyer", or any phrasing implying it provides legal representation or advice.
- Outputs MUST NOT use first-person legal-actor framing ("I'll defend you", "I'll fight your case", "as your legal team").
- The human handoff (`review`, `packets.legal_aid_handoff`) is described as connecting the tenant to a **human attorney / legal-aid provider**; the AI is described as helping the tenant *organize and prepare information* for that attorney.

### 4.4 Acceptance tests / red-line assertions

- **AT-4.1 (persistent presence):** Automated UI test asserts the disclaimer is present in the DOM on every route of the PWA and remains visible (or in a persistent footer) regardless of scroll position.
- **AT-4.2 (per-message attachment):** Assert every assistant chat message renders with the short-form disclaimer attached.
- **AT-4.3 (onboarding acknowledgement logged):** Assert intake cannot proceed past first-run until the disclaimer is acknowledged, and that acknowledgement is recorded in `audit.events[]` (`action = "disclaimer_acknowledged"`).
- **AT-4.4 (printed on handoff packet):** Assert the rendered `packets.legal_aid_handoff` PDF and any tenant-facing PDF contains the full disclaimer text.
- **AT-4.5 (SMS carries disclaimer):** Assert `reminders[]` SMS sends include the short-form disclaimer per §4.2.
- **AT-4.6 (no "AI lawyer" copy):** Static scan of all UI strings, marketing copy, and system-prompt persona text for prohibited phrasings ("AI lawyer", "robot lawyer", "your lawyer", "I'll defend/fight"). Zero matches required.
- **AT-4.7 (localized):** Assert the disclaimer renders in the active `language` for each supported BCP-47 tag.

---

## 5. S7263 Proprietor-Liability Posture

S7263 (chatbot-proprietor civil liability for individualized legal advice given by an AI) is a top-tier, product-specific risk. The architectural posture: **no output path in the system is capable of emitting individualized legal advice**, and a supervising attorney is accountable in the loop.

### 5.1 The architectural rule

*No model output may be individualized legal advice.* Operationally, "individualized legal advice" = a legal conclusion, defense selection/assertion, case-strength assessment, outcome prediction, or directive to act — *applied to this tenant's specific case*. The system is built so that:

1. **The advice line is deterministic and attorney-owned, never LLM.** Which defense applies (`defenses_checklist[].attorney_disposition`), whether the tenant "has a case", what the deadline is (`deadlines[]`), and what they're eligible for (`eligibility.*`) are all `*_by = "deterministic"` / attorney-only fields. The LLM is structurally barred from writing them (§0.3, §2.6, AT-2.6).
2. **General information is permitted; individualized application is gated.** The LLM may explain what a defense *is* in general (`defenses_checklist[].explanation`), what a deadline *means* in general (`deadlines[].explanation`), and transcribe the tenant's own facts (`factual_statements[]`). It may not apply law to facts and conclude. Application-to-facts (`attorney_disposition`) requires a human attorney.
3. **Advice-seeking turns are intercepted before any individualized answer is composed** (§1). The system never even attempts to answer "do I have a case" — it routes.
4. **Defense-in-depth.** The deterministic outbound scanner (§2.5) is a backstop: even if a model emitted individualized advice, the scanner blocks it from reaching the tenant or a filing.

### 5.2 Attorney-in-the-loop accountability

- A supervising attorney is engaged **from Phase 0** (program design), not just at handoff.
- Every case ends in a human handoff: the state machine (`intake → prepared → referred → represented → resolved`) requires a human (`review.review_state`, provider handoff with consent) before the case can be considered represented. The AI prepares; the attorney advises and represents.
- Attorney actions are distinguishable and auditable: `attorney_disposition`, `defenses_checklist[].attorney_reviewed`, `deadlines[].attorney_validated`, and `review.assigned_attorney_id` are all attorney-owned, and every attorney mutation logs `audit.events[].actor.actor_type = "attorney"` with `actor_id`.
- The advice-routed state (`review.advice_routed`) creates the paper trail that an advice-seeking turn was escalated to a human, not answered by the AI. **It is written only by the conversational advice router (§1.6)** — never by deterministic engine escalations, which set `review.review_state = "escalated"` only (§1.8). This keeps `advice_routed` a clean UPL audit signal: a deterministic engine escalation (missed deadline, overcharge signal) is real urgency but is not an advice-seeking event, and conflating the two would corrupt the trail.

### 5.3 Eligibility display rule (`likely_eligible` is internal-triage by default)

`eligibility.{rtc,legal_aid,rental_assistance}.determination` is a deterministic, config-driven value (`determined_by = "deterministic"`). To stay clear of an advice-adjacent conclusion presented to the tenant ("you likely qualify for a free lawyer"), this layer defines who may *show* which determination value:

- `eligible`, `ineligible`, `insufficient_data`, `program_unavailable` (e.g. ERAP, which is surfaced **inside `rental_assistance`** as an `EligibilityResult` with `program = "erap"` and `determination = "program_unavailable"` — never as a top-level `eligibility.erap` key, which the schema's `additionalProperties: false` forbids) MAY be shown to the tenant as neutral, factual screening output, always with the persistent disclaimer (§4).
- `likely_eligible` MUST NOT be shown to the tenant as a standalone conclusion. It is **internal triage routing information** used to prioritize a human-review queue and to phrase a neutral next step ("a person will confirm whether you qualify"). If any tenant-facing surface renders `likely_eligible`, it MUST be rephrased to a non-conclusory next-step ("we'll connect you with someone who can confirm your eligibility") — never "you likely qualify."
- The determination is still deterministic; this is purely a presentation rule to avoid an implied legal/eligibility conclusion at the tenant boundary.

### 5.4 Acceptance tests / red-line assertions

- **AT-5.1 (no individualized-advice output path exists):** Architectural review + AT-2.6 + AT-1.3 jointly assert there is no code path by which a model response is surfaced as a legal conclusion/defense/prediction/directive applied to the case. Documented as a control with named owners.
- **AT-5.2 (attorney accountability is recorded):** For any case where a defense is asserted as applicable, assert `defenses_checklist[].attorney_disposition == "applicable"` was set by an `attorney` actor and is in `audit.events[]`; the same defense MUST NOT appear asserted anywhere attributable to the AI.
- **AT-5.3 (deadline & eligibility are attorney/DET, never AI):** Assert every `deadlines[]` entry has `computed_by == "deterministic"` and (for filing use) `attorney_validated == true` and `tenant_confirmed == true`; assert every `eligibility.*` result has `determined_by == "deterministic"`; assert ERAP appears only as `eligibility.rental_assistance` with `program = "erap"`, never as a sibling key.
- **AT-5.4 (handoff before representation):** Assert `status` cannot reach `represented` without a recorded provider handoff carrying a valid `consent_id` and a human attorney assignment.
- **AT-5.5 (`likely_eligible` not shown as conclusion):** Assert no tenant-facing surface renders the literal "likely qualify"/"you likely qualify" for any `eligibility.*.determination == "likely_eligible"`; assert the value is used only for internal triage routing or a non-conclusory next-step phrasing.
- **AT-5.6 (advice_routed not engine-set):** Assert a deterministic engine escalation (default-risk / overcharge) sets only `review.review_state = "escalated"` and leaves `review.advice_routed == false` with no `advice_detection_log[]` entry (see AT-1.8).

---

## 6. Data-Minimization at the Model Boundary

SHIELD Act + immigration exposure: the system data-minimizes, and specifically **does not send immigration status to any model** unless a specific defense requires it and the tenant has opted in via a dedicated, severable consent.

### 6.1 The rule

`sensitive.immigration` is `null` by default. It may be populated only when (a) a specific defense actually requires it (`sensitive.immigration.status_relevant_to_defense == true`) AND (b) the tenant has opted in via a consent record (`sensitive.immigration.consent_id` referencing a `consents[]` entry with `scope = "store_sensitive_data"` and `data_categories` including `immigration_status`, `granted == true`, not expired, not revoked).

The **model boundary** is the place this is enforced for the AI: even if `sensitive.immigration` is populated, it is **not included in any prompt** to `claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5` unless the specific model call is one whose task requires it AND the consent is valid at call time.

### 6.2 Boundary-redaction filter (deterministic)

A deterministic prompt-assembly filter sits between the Case Object and every model call. Before any prompt is built, it:

1. Removes `sensitive.immigration` (and `sensitive.benefits_enrollment`, `sensitive.household_income_cents`, `sensitive.household_size`) from the serializable case context by default.
2. Re-includes a sensitive field **only if** the specific model call is on an allowlist of tasks declared to need it AND a valid matching `consents[]` record exists (granted, in-window, not revoked) AND, for immigration, `status_relevant_to_defense == true`.
3. For MVP nonpayment, **no LLM task requires immigration status.** Field extraction, classification, transcription, evidence tagging, intake-summary, triage, and KB Q&A do not need it. So in practice the immigration field is *never* sent to a model in the MVP; the allowlist is empty for it, and the filter's job is to guarantee that.
4. Eligibility inputs (`household_income_cents`, `household_size`) feed **deterministic** eligibility (RTC ≤ 200% FPL), not a model — they are consumed by the eligibility engine, never serialized into an LLM prompt.

### 6.3 Consent coupling and packet-vs-consent reconciliation

- `sensitive.immigration` requires `consent_id` (schema-required on the immigration sub-object). A populated immigration object with no `consent_id` is schema-invalid.
- Consent is per-recipient, time-limited (`expires_at`), severable (`revoked_at` independent), voluntary (`granted` only on affirmative opt-in), written (`consent_text_version`, `method`).
- Sensitive data is **never furnished to landlords** (FCRA). A `consents[].recipient.recipient_type` of `landlord`/`agent` is not in the enum and is schema-impossible.
- **Packet contents must be reconciled against the handoff consent's `data_categories[]` at delivery time.** A `legal_aid_handoff` packet includes eligibility-derived content and CSR/LIST tags; if the matching `handoff_to_provider` consent's `data_categories[]` does not include `eligibility`, the eligibility-derived fields (RTC/legal-aid/rental-assistance results) MUST be redacted from the delivered packet, and the CSR/LIST tagging MUST NOT encode an eligibility determination. The delivery routine (LegalServer `legalserver_trigger_xml` or `pdf_packet_fallback`) performs a category-by-category reconciliation: for each data category present in the packet (`contact`, `case_facts`, `documents`, `arrears`, `eligibility`, `evidence`), the category MUST appear in the consent's `data_categories[]` or its content is stripped before send. This closes the gap where a handoff consent scoped to `[contact, case_facts, documents, arrears, evidence]` would otherwise leak eligibility results.

### 6.4 Acceptance tests / red-line assertions

- **AT-6.1 (immigration never in a model prompt — MVP):** Populate `sensitive.immigration` (with a valid consent). For every model call type in the MVP (extraction, classify, transcription, tagging, summary, triage, KB Q&A, advice-detection), assert the assembled prompt string contains no value from `sensitive.immigration`. Implemented as a prompt-snapshot scan keyed to the immigration field values.
- **AT-6.2 (default redaction):** Without any allowlist entry, assert the boundary filter strips all `sensitive.*` fields from every prompt. The redaction is the default; inclusion is the exception.
- **AT-6.3 (consent required to even store):** Persist a `sensitive.immigration` object with no `consent_id` → schema rejection. Persist one referencing a `consents[]` entry that is `granted == false`, expired, or revoked → boundary filter treats it as not-consented and the field is unusable.
- **AT-6.4 (eligibility inputs never hit a model):** Populate `household_income_cents` / `household_size`; assert no LLM prompt contains them and that they reach only the deterministic eligibility engine.
- **AT-6.5 (no landlord recipient):** Attempt to create a `consents[]` record with `recipient.recipient_type = "landlord"` → schema rejection (value not in enum).
- **AT-6.6 (revocation takes effect immediately):** Revoke an immigration consent (`revoked_at` set); assert the next boundary-filter pass treats the field as not-consented, regardless of cached state.
- **AT-6.7 (packet content matches consent categories):** Generate a `legal_aid_handoff` packet containing eligibility results, with a `handoff_to_provider` consent whose `data_categories[]` omits `eligibility`. Assert the delivered packet has the eligibility-derived content redacted and the CSR/LIST tags carry no eligibility determination; add `eligibility` to the consent's categories and assert it is then included.

---

## 7. Cross-cutting enforcement, audit, and incident handling

### 7.1 Fail-closed default

Every guard in this spec fails **closed**: an unreadable classifier result routes to human; any positive advice classification that is not confidently re-confirmed as non-advice routes or is firewall+scanner-gated (§1.4 step 3); an unconfirmed verify gate blocks the packet; an absent consent redacts the field; a malformed boundary-invariant value is rejected; an unset staleness window is treated as `0` days. Absence of a positive clearance is never treated as clearance.

### 7.2 Audit trail

Every safety-relevant mutation appends to `audit.events[]` with `at`, `actor` (`Actor`), `action`, `field_path` (JSON pointer), and `model` (when an LLM produced the value). Required audited actions for this layer: `advice_routed`, `engine_escalated`, `boundary_invariant_rejected`, `verify_gate_transition`, `packet_blocked_unverified_open_data`, `attorney_disposition_set`, `sensitive_field_redacted_at_boundary`, `packet_category_redacted_at_delivery`, `disclaimer_acknowledged`. `audit` supports subpoena/legal-hold (`audit.legal_hold`) and the LLM/DET boundary trail.

### 7.3 Provenance discipline

Every value carries provenance. `LLM`-sourced values carry `confidence` and are `*_confirmed = false` until a tenant confirms; they are never authoritative. Faithful-transcription output uses `Provenance.source = "llm_generation"` (never `llm_transcription`, which is not in the enum). `open_data` values carry `OpenDataAssertion` + verify gate. `deterministic` / `attorney_entered` values are the only authoritative sources for the advice line and safety-critical fields.

### 7.4 Configuration & versioning

Litigation-sensitive and temporally-sensitive rules are config-driven and version-stamped, reconstructable for audit: `eligibility.config_version` (RTC geography/income, CityFHEPS toggle via `config_toggle_state`, ERAP `program_unavailable` surfaced inside `rental_assistance`), `consents[].consent_text_version`, `OpenDataAssertion.dataset_version`, the staleness windows (`verify_gate.staleness_window_days`, §3.5), the disclaimer copy versions (§3.4/§4.1), and the advice-taxonomy version for the classifier.

### 7.5 Models used (exact IDs, verified against the Claude API reference)

`claude-opus-4-8` (default; safety/trust-critical generation: vision intake, faithful transcription, intake-summary, grounded KB Q&A), `claude-sonnet-4-6` (middle tier; classifier escalation), `claude-haiku-4-5` (cheap classification: advice-detection, case-type, triage). Use these exact strings, no date suffix. Structured outputs via `output_config.format` / `messages.parse()`; citations are incompatible with structured outputs (run as two passes, §2.4); prompt-cache the KB/system prefix with `cache_control: {type: "ephemeral"}`; tool use to call deterministic tools.

### 7.6 Severity classification

| Class | Examples | Response |
|---|---|---|
| **P0** | Individualized legal advice reaches a tenant or a filing; a boundary-invariant value persists; unverified open data enters a produced packet; sensitive data outside consent `data_categories[]` is delivered to a provider | Block, page on-call, incident review; treat as potential UPL/S7263/130/SHIELD exposure |
| **P1** | Outbound scanner flags a generation output (caught before tenant); advice-detection miss caught downstream; `advice_routed == true` without a matching `advice_detection_log[]` entry (audit-integrity defect) | Block + suppress, log, classifier/audit-tuning review |
| **P2** | Disclaimer missing on a non-critical surface; localization gap | Fix-forward, track |

### 7.7 Master red-line assertion list (must hold in production)

1. No `deadlines[]`, `eligibility.*`, `court.court_date`, or `answer_draft.form_fields[]` value is ever LLM-authored.
2. No advice-seeking turn ever receives a substantive AI answer; a positive sets `review.advice_routed = true` (via the conversational router only) and surfaces the fixed non-advice response. No low-confidence positive is ever cleared into an unchecked substantive answer.
3. No open-data assertion with `verify_before_file.state != "verified"` ever enters a produced packet — including `parties.landlord.open_data` scanned by the handoff generator.
4. No `answer_draft.factual_statements[]` text characterizes legal salience or names a defense; each statement's `provenance.source` is a single value (`llm_generation` or `tenant_entered`).
5. No model prompt ever contains `sensitive.immigration` (or other `sensitive.*`) in the MVP; no provider receives data outside the matching consent's `data_categories[]`.
6. The "not a lawyer / legal information, not advice" disclaimer is present on every tenant-facing surface; `likely_eligible` is never shown to the tenant as a conclusion.
7. The five schema-`const` boundary invariants (§0.3) hold for every persisted Case Object.
8. `review.advice_routed` is written only by the conversational advice router and always has a matching `advice_detection_log[]` entry; engine escalations set only `review.review_state`.
9. Every safety-relevant mutation is in `audit.events[]`.

---

## 8. Acknowledged build dependencies (out of scope for this layer, blocking elsewhere)

This layer is implementable today against the canonical Case Object. Several mechanisms it *invokes* depend on values/contracts owned by other specs that are Phase-0 blockers; this layer is written to fail safe until they land:

- **Deadline/eligibility rule values** (day-counts, FPL multipliers, statute rule ids) are owned by the deadline-engine and eligibility specs and are currently unpopulated/unvalidated. This layer's `risk.is_imminent`/`risk.default_risk`-based escalation (§1.6 step 2) and the `likely_eligible` display rule (§5.3) reference those outputs but do not depend on their values to be correct here.
- **The "answer filed / satisfied" predicate** that would clear `risk.is_missed`/`default_risk` is owned by the deadline engine; `answer_draft.status` tops out at `finalized` and there is no e-filing rail, so this layer treats deadline risk as advisory escalation input only and never clears it.
- **`verify_gate.staleness_window_days` values** (§3.5) are config; until populated, the fail-safe `0`-day default applies.
- **CSR/LIST code values and the form-template field map** are owned by the handoff and document-assembly specs; this layer enforces the consent-reconciliation and verify-gate scans regardless of which concrete codes/fields are used.

These are noted so an engineer building the guardrail layer is not blocked: every guard above degrades to its fail-closed behavior in the absence of the dependency value.