# NYC Nonpayment Legal Rules (Attorney-Validated)

# NYC Nonpayment Legal Rules (Attorney-Validated)

**Spec ID:** `spec.nyc-nonpayment-legal-rules.v1`
**Scope:** Housing Court Copilot MVP — NYC **nonpayment** eviction defense only (`case.case_type = "nonpayment"`).
**Owner of rule VALUES:** A NY-licensed supervising attorney (engaged from Phase 0).
**Owner of rule ENGINE:** Engineering (deterministic rules service).
**Status:** Spec scaffold for implementation.
**Canonical references:** `housing_court_copilot.case` v1 (`schema_version = "1.0.0"`), `LLM-ARCHITECTURE.md`, `RISKS-AND-COMPLIANCE.md`, `tool-contracts`, `api-contracts`, `guardrails`, `llm-schemas`, `data-security`.

---

## 0. CRITICAL NOTICES — READ FIRST

> **THIS IS A SPEC SCAFFOLD, NOT LEGAL ADVICE.**
> This document defines the *structure and wiring* of a deterministic rules engine. It deliberately does **NOT** assert authoritative day-counts, statutory thresholds, or legal conclusions. Every legally-operative number, window, and predicate is expressed as a **named config key** that **MUST be populated and signed off by a NY-licensed attorney before production.** Until then, the corresponding rule is inert (see §1.3).

> **NO LLM ON THE ADVICE LINE.** Per `LLM-ARCHITECTURE.md` and the Case Object boundary invariants, all logic in this spec is **`DET` (deterministic code only)**. Every `deadlines[]` entry has `computed_by = "deterministic"`; every `eligibility.*` result has `determined_by = "deterministic"`; every `defenses_checklist[]` item has `surfaced_as = "information_not_advice"`. The LLM may **extract** and **explain** dates and signals, but it **never computes a deadline, determines eligibility, or asserts a defense** as authoritative.

> **`review.advice_routed` IS NOT OWNED BY THIS ENGINE.** Per the canonical schema, `review.advice_routed` means *"an advice-seeking conversational turn was hard-routed to a human"* — it is the DET decision made by the **conversational advice router** (`guardrails`) in response to the **LLM advice-detection classifier** (`review.advice_detection_log[]`). **No rule in this spec writes `review.advice_routed`.** When a deterministic rule needs to escalate a case to a human (imminent/missed default, overcharge/stabilization signal), it sets **`review.review_state = "escalated"`** only. This keeps the UPL audit signal clean: every `advice_routed = true` has a corresponding `advice_detection_log[]` entry, and a missed-deadline escalation is never miscounted as an advice-seeking event. See §0.1 (ownership table) and §4.4/§7.3.

> **EVERY RULE BELOW IS FLAGGED `ATTORNEY MUST VALIDATE before production`.** A rule with unvalidated config (`attorney_validated_config = false`) is **disabled** and produces nothing that can enter a filing.

> **THE TENANT IS THE FILER.** Per `RISKS-AND-COMPLIANCE.md`, the tenant bears 22 NYCRR 130 risk. No open-data assertion and no engine output is ever auto-asserted into a filing. Wrong-deadline = malpractice-style liability — deadline computation is safety-critical, human-confirmed (`deadlines[].tenant_confirmed`) AND attorney-validated (`deadlines[].attorney_validated`).

> **UPL GUARDRAIL.** This engine surfaces *information* and *computes clocks*. It never tells a tenant which defense to raise, whether they "have a case," or predicts an outcome. Those are attorney-only fields (`defenses_checklist[].attorney_disposition`).

### 0.1 Single-writer ownership of escalation/routing fields

To eliminate uncoordinated writers (a UPL-audit risk), each escalation-adjacent field has exactly one deterministic owner:

| Field | Sole writer | Trigger | Meaning |
|---|---|---|---|
| `review.advice_routed` | Conversational advice router (`guardrails`), **not this engine** | LLM advice-detection classifier flags an advice-seeking *turn* (logged in `review.advice_detection_log[]`) | A tenant's advice-seeking question hard-routed the case to a human. |
| `review.review_state` | This engine **and** the advice router may set it to `"escalated"`; status-guard owns other transitions | This engine: imminent/missed default risk (§4.4), overcharge/stabilization signal (§7.3). Router: any hard-route. | Human-review queue state. `"escalated"` = needs prompt attorney attention. |
| `deadlines[].risk.*` | This engine only | §4 default-risk computation | Factual clock state, not advice. |

> **Invariant:** `review.advice_routed` has zero writers in this engine. Searching the rules service for any write to `advice_routed` MUST return no hits (enforced by AT-LR-7 in §10.4).

---

## 1. Architecture: config-driven deterministic rules

### 1.1 Design principles

1. **No magic numbers in code.** Every threshold, day-count, window, FPL multiplier, and ZIP/borough set is a **named config value** loaded from a versioned ruleset. Code reads config keys; it never hard-codes a number that is legally operative.
2. **Versioned & reproducible.** Every output stamps the config version that produced it, so any value can be reproduced and audited. Config versions map to:
   - `deadlines[].computation_basis.statute_rule_id` + `deadlines[].computation_basis.rule_version`
   - `eligibility.config_version`
   - `reminders[]` send-offset config (see §4.5) is version-stamped via the emitting rule's `rule_version`.
3. **Attorney-gated activation.** Each rule carries an `attorney_validated_config` flag in config. When `false`, the rule is inert (computes nothing authoritative).
4. **Monitored config.** Litigation/temporally-sensitive values (RTC geography/income, CityFHEPS toggle, e-filing coverage, statutory clocks, court-holiday calendar) are flagged `monitored: true` and surfaced on an ops dashboard with a `review_by` date and a named owner.
5. **Court-local calendar.** All `*_date` math is performed on the **America/New_York** calendar (bare `YYYY-MM-DD`, no time component), consistent with the `Date` type. `*_at` timestamps remain RFC-3339 UTC `Z`.

### 1.2 Where config lives

```
ruleset/
  nonpayment/
    ruleset.meta.yaml          # ruleset_version, effective_from, attorney_signoff
    deadlines.config.yaml      # answer/response windows, anchors, court-day rules
    default_risk.config.yaml   # default-risk detection thresholds + reminder offsets
    rent_demand.config.yaml    # rent-demand predicate windows/requirements
    registration.config.yaml   # HPD registration defense triggers
    overcharge_signal.config.yaml  # stabilization/overcharge flag-only signals
    eligibility.config.yaml    # RTC income/zip, CityFHEPS toggle, program toggles
    efiling.config.yaml        # e-filing coverage (monitored; pro se exempt)
    calendars/
      court_holidays.yaml      # observed court-closed dates (for court-day counting)
```

#### 1.2.1 Court-holiday calendar (`calendars/court_holidays.yaml`) — source, owner, format

`court_days` counting (§3.3, §4.3, §5.3) is impossible without this file. To unblock the deadline engine it is fully specified here:

```yaml
court_holidays:
  meta:
    calendar_id: nyc_housing_court_holidays
    calendar_version: "0.0.0-UNVALIDATED"   # SemVer; bump on any edit
    monitored: true
    owner: "ops:court-calendar"             # named maintenance owner
    source: "<ATTORNEY/OPS POPULATES — official NY Unified Court System holiday schedule>"
    review_by: null                         # MUST be re-checked annually + on emergency closures
    coverage_from: null                     # earliest date the list is authoritative for
    coverage_until: null                    # latest date covered (engine refuses court_days math past this)
  observed: []                              # list of { date: YYYY-MM-DD, label: string }
```

> **Owner & cadence:** the `ops:court-calendar` owner re-validates annually before `coverage_until` and on any emergency court closure. **The engine refuses `court_days` math for any window whose computed span would cross `coverage_until`** — it falls back to provisional output (§3.4) and raises `RiskFlags.uncertain_anchor = true` rather than silently under-counting holidays. `calendar_version` is recorded alongside `rule_version` in `computation_basis` (see §3.5, `calendar_version` note).

### 1.3 Common config envelope (every rule)

Every rule's config block carries this metadata envelope. **These are the keys an attorney populates and signs.**

| Config key | Type | Meaning |
|---|---|---|
| `rule_id` | string | Stable id, also written to `deadlines[].computation_basis.statute_rule_id`. |
| `rule_version` | string (SemVer) | Bumped on any value change; written to `rule_version`. |
| `attorney_validated_config` | boolean | **MUST be `true` to run.** Default `false`. |
| `attorney_validator_id` | string (`atty_` ULID) | Who signed off (audit). |
| `validated_at` | timestamp | When signed off. |
| `statute_citation` | string | Human-readable citation the attorney is attesting to (e.g., the RPAPL section name). **Attorney supplies; spec does not assert it.** |
| `effective_from` / `effective_until` | date / null | Temporal validity of these values. |
| `monitored` | boolean | If true, appears on monitored-config dashboard. |
| `review_by` | date / null | When the value must be re-checked. |
| `notes` | string | Attorney free-text. |

> **Engineering invariant:** the rules service refuses to emit any authoritative output from a rule whose `attorney_validated_config != true`. A disabled rule may still emit *provisional* timeline/explanation content flagged non-authoritative (see §3.4), but never a `deadlines[]` entry the UI treats as a real clock.

### 1.4 Canonical `statute_rule_id` registry (rule-id source of truth)

This spec **owns** the deterministic rule registry. The following `statute_rule_id` strings are canonical; any other spec (notably `tool-contracts`) MUST emit these exact ids. In particular, the answer-window rule id is **`nonpayment_answer_window`** — the string `rpapl_answer_window` seen in some draft tool contracts is **non-canonical and must be reconciled to `nonpayment_answer_window`**.

| Rule | Canonical `rule_id` / `statute_rule_id` | Writes to |
|---|---|---|
| A — Answer/response window | `nonpayment_answer_window` | `deadlines[].computation_basis.statute_rule_id` |
| B — Default-risk detection | `nonpayment_default_risk` | `deadlines[].risk.*`, `reminders[]`, `review.review_state` |
| C — Rent-demand predicate | `nonpayment_rent_demand_predicate` | `defenses_checklist[]` |
| D — Registration defense | `nonpayment_registration_defense` | `defenses_checklist[]`, `evidence[]` |
| E — Overcharge/stabilization signal | `nonpayment_overcharge_signal` | `defenses_checklist[]`, `review.review_state` |
| RTC | `rtc_eligibility` | `eligibility.rtc` |
| Legal-aid | `legal_aid_eligibility` | `eligibility.legal_aid` |
| CityFHEPS | `cityfheps_eligibility` | `eligibility.rental_assistance` |
| ERAP | `erap_eligibility` | `eligibility.rental_assistance` |
| Other rental assistance | `rental_assistance_eligibility` | `eligibility.rental_assistance` |
| E-filing coverage | `efiling_coverage` | operational config only (no Case Object write) |

> **ERAP/CityFHEPS/other rental-assistance all write the SAME canonical slot `eligibility.rental_assistance`** (an `EligibilityResult`). The canonical `Eligibility` object is `additionalProperties: false` and defines only `rtc`, `legal_aid`, `rental_assistance`, `config_version`, `evaluated_at` — **there is no `eligibility.erap` or `eligibility.cityfheps` key.** See §8.

---

## 2. Rule Engine I/O contract (Case Object fields)

### 2.1 Inputs the engine reads (all from the Case Object)

The engine is a pure function of confirmed Case Object facts. It reads:

| Input | Case Object path | Provenance gate the engine enforces |
|---|---|---|
| Case type | `case.case_type` | Must equal `"nonpayment"` and `case.case_type_confirmed = true` to run end-to-end. |
| Rent demand served date | `case.documents[].extracted_fields.rent_demand_date` | LLM-extracted; engine uses the `tenant_corrected_value` if present, else `value`, and reads `confidence` + `tenant_confirmed`. |
| Petition filed date | `case.documents[].extracted_fields.petition_filed_date` | same confirmable rules. |
| Petition/notice served date | `case.documents[].extracted_fields.service_date` | same. |
| Court date (extracted) | `case.documents[].extracted_fields.court_date` | **Non-authoritative** — extraction only. |
| Court date (authoritative) | `case.court.court_date` + `case.court.court_date_source` + `case.court.court_date_verified` | Authoritative only when `court_date_verified = true` (sourced `etrack`/`nyscef`). |
| Borough/county | `case.court.borough` / `case.court.county` | DET-validated. |
| Claimed arrears | `case.claimed_arrears` (Money cents) | LLM-extracted + tenant-confirmed. |
| Monthly rent | `case.documents[].extracted_fields.monthly_rent` | confirmable. |
| Rent-demand amount | `case.documents[].extracted_fields.claimed_arrears` **on the `document_type = "rent_demand"` document** | confirmable. See §2.1.1 — the amount-consistency check (§5) compares this to the petition's `case.claimed_arrears`. |
| Premises BBL | `case.property.bbl` + `case.property.geo_confidence` | DET (GeoSearch/PLUTO/PAD). |
| HPD registration signal | `case.parties.landlord.registration_on_file` + `registered_owner_name` + `wow_landlord_id` + `open_data` | open-data; carries `verify_before_file` gate. See §6.2.1 for the on-file-vs-current mapping. |
| Household income/size | `case.sensitive.household_income_cents` / `household_size` | opt-in only; null by default. |
| RTC inputs (geo) | `case.property.address.postal_code` / `case.court.borough` | for RTC ZIP/borough coverage check. |
| Answer-filed signal | see §4.3.1 (`answer_draft.status` + court-sourced docket event) | for the "satisfied" predicate. |

#### 2.1.1 Rent-demand amount input (cross-ref reconciliation)

The rent-demand predicate (§5) must compare *the amount stated on the rent demand* against the petition's `case.claimed_arrears`. The canonical `extracted_fields` set is identical across all document types, so the demand amount is captured as **`claimed_arrears` on the rent-demand document itself**: `case.documents[<rent_demand doc>].extracted_fields.claimed_arrears` (a `ConfirmableValue` whose `value` is `Money`). This is distinct from the top-level `case.claimed_arrears`, which is the **petition's** claimed arrears (extracted from the `summons_petition` document and confirmed).

> No new schema field is introduced. The mapping is: **demand amount = `extracted_fields.claimed_arrears` on the rent-demand doc; petition amount = top-level `case.claimed_arrears`.** If the rent-demand document's `claimed_arrears` was not extractable (`confidence = "unreadable"` or absent), the amount-consistency check is **skipped** (not failed) and the predicate notes the input was unavailable.

### 2.2 Outputs the engine writes

| Output | Case Object path | Notes |
|---|---|---|
| Statutory clocks | `case.deadlines[]` (each `Deadline`) | `computed_by = "deterministic"` (const). |
| Timeline anchoring | `case.timeline[]` (each `TimelineEvent`) | `date_is_authoritative` set true only for DET/court-sourced dates. The engine emits only **statutory-clock** timeline kinds (`answer_due`); see §3.3 step 7 and the LLM-vs-DET timeline split in §2.2.1. |
| Candidate defenses | `case.defenses_checklist[]` (each `DefenseChecklistItem`) | `surfaced_as = "information_not_advice"` (const). |
| Eligibility | `case.eligibility.{rtc,legal_aid,rental_assistance}` | `determined_by = "deterministic"` (const). ERAP/CityFHEPS/other → `rental_assistance` (§8). |
| Open-data evidence | `case.evidence[]` (open-data items) | required `OpenDataAssertion` with disclaimer + `verify_before_file`. |
| Escalation | `case.review.review_state = "escalated"` | DET escalation. **Never** `review.advice_routed` (§0). |
| Reminders | `case.reminders[]` | DET `scheduled_for`; consent + `safe_to_text` gated (§4.5). |
| Audit | `case.audit.events[]` | append-only; `actor.actor_type = "deterministic_engine"`. |

#### 2.2.1 Timeline authorship split (DET vs LLM)

The `timeline[]` array is co-authored: the LLM proposes **descriptive** events (`date_is_authoritative = false`), and this engine creates **statutory-clock** events (`date_is_authoritative = true` once attorney-validated). To prevent collisions and to stop an LLM-extracted date being mistaken for a real clock:

- **The LLM is barred from emitting deadline-typed timeline `kind`s** (`answer_due`). Per the reconciled `llm-schemas` Surface 4, the LLM's permitted `kind` set is descriptive only: `rent_demand_served`, `petition_filed`, `petition_served`, `court_appearance`, `adjournment`, `other`. (`judgment` is likewise reserved for court-sourced events, not LLM extraction.)
- **Only this engine emits `kind = "answer_due"`**, always with a non-null `deadline_id` FK. A timeline event with `kind = "answer_due"` and `deadline_id = null` is invalid and rejected.
- If both an LLM descriptive petition-service event and the DET answer-due event reference the same anchor, they coexist without collision because they carry different `kind`s and the answer-due event is the only one linked to a `Deadline`.

### 2.3 Determinism & idempotency

- The engine is **idempotent**: same confirmed inputs + same `ruleset_version` ⇒ byte-identical outputs (modulo SYS ids/timestamps).
- Re-running on changed inputs **never deletes** prior `deadlines[]`/`defenses_checklist[]` silently — it supersedes by id and logs the change in `case.audit.events[]` with `field_path`.
- The engine **never** sets `case.status`; status transitions are guarded separately (`api-contracts §6.1`). The engine emits signals (e.g., default risk, escalation) that the status guard may consume.

---

## 3. RULE A — Answer Deadline / Response Window

**`rule_id: nonpayment_answer_window`** · **ATTORNEY MUST VALIDATE before production.**

### 3.1 Purpose
Compute the authoritative deadline by which the tenant must respond/answer the nonpayment petition, and flag default risk. Output a `Deadline` with `deadline_type = "answer_due"` (and, where the framework has a separate first-appearance construct, `deadline_type = "first_appearance"`).

> **NYC nonpayment specifics the attorney must encode (NOT asserted here):** NYC Housing Court nonpayment practice differs from the generic RPAPL summary-proceeding answer rule — the response/answer mechanic, whether the answer may be oral at the clerk's window, and the appearance/answer interplay vary by court and may have changed. The attorney populates the exact mechanic and windows; the engine only wires anchors → window → due date.

### 3.2 What event starts the clock (the anchor)

The clock anchor is **selected deterministically** from confirmed Case Object dates in a configured priority order. The window is then added to the anchor.

Config: `deadlines.config.yaml`

```yaml
nonpayment_answer_window:
  # --- envelope (see §1.3) ---
  rule_id: nonpayment_answer_window         # CANONICAL (not rpapl_answer_window)
  rule_version: "0.0.0-UNVALIDATED"
  attorney_validated_config: false          # <-- ATTORNEY sets true
  statute_citation: "<ATTORNEY POPULATES — RPAPL summary proceeding framework>"

  # --- anchor selection (which event starts the clock) ---
  anchor_priority:                           # first available & usable wins
    - event: petition_served                 # maps Case Object service_date
      case_field: "documents[].extracted_fields.service_date"
    - event: petition_filed
      case_field: "documents[].extracted_fields.petition_filed_date"
    # ATTORNEY confirms correct anchor & ordering for NYC nonpayment

  # --- the window (NAMED, attorney-populated; DO NOT assume a number) ---
  answer_window:
    count: null                              # <-- ATTORNEY POPULATES integer
    unit: null                               # <-- "calendar_days" | "court_days"
    counting_basis: null                     # <-- "from_anchor_exclusive" | "from_anchor_inclusive"
    weekend_holiday_rule: null               # <-- "roll_forward_to_next_court_day" | "none"
  first_appearance_window:                   # if framework treats appearance separately
    enabled: false                           # <-- ATTORNEY toggles
    count: null
    unit: null

  # --- service-method adjustments (e.g., additional days for certain service) ---
  service_method_adjustments:                # optional named add-ons
    # service_method_code: { extra_days: <int>, unit: <...> }
    {}                                       # <-- ATTORNEY POPULATES if applicable

  # --- uncertainty handling ---
  require_verified_anchor_for_authoritative: true
  min_anchor_confidence: medium              # ConfidenceLevel below which clock is provisional
  court_calendar_id: nyc_housing_court_holidays   # links §1.2.1 calendar for court_days
```

### 3.3 Computation (deterministic procedure)

1. **Gate.** If `case.case_type != "nonpayment"` or not confirmed → do not run; route to triage.
2. **Gate.** If `attorney_validated_config != true` → emit provisional only (§3.4), set `RiskFlags.uncertain_anchor = true`, **stop** producing an authoritative clock.
3. **Select anchor.** Walk `anchor_priority`; pick the first event whose Case Object date resolves. Record `anchor_event` and `anchor_date` in `Deadline.computation_basis`.
4. **Assess anchor trust.**
   - If the chosen anchor date came only from LLM extraction (not court-verified) **or** its `confidence` < `min_anchor_confidence` **or** `tenant_confirmed = false` → set `RiskFlags.uncertain_anchor = true` and treat the clock as **provisional** (still computed, but flagged).
5. **Compute due date.** `due_date = applyWindow(anchor_date, answer_window)`:
   - Add `count` of `unit` per `counting_basis`.
   - If `unit = court_days`, skip weekends and dates in `calendars/court_holidays.yaml`. If the computed span would cross the calendar's `coverage_until` (§1.2.1), **do not produce an authoritative date** — emit provisional (§3.4) with `uncertain_anchor = true`.
   - Apply `weekend_holiday_rule` (e.g., roll a due date that lands on a weekend/holiday forward to the next court day) — exactly as the attorney configured.
   - Apply any `service_method_adjustments` if the service method is known.
6. **Emit `Deadline`** (see §3.5).
7. **Emit/refresh `TimelineEvent`** with `kind = "answer_due"`, `deadline_id` FK (non-null), `date = due_date`, and `date_is_authoritative = (not uncertain_anchor and attorney_validated_config)`. This is the **only** authoritative `answer_due` timeline event; the LLM is barred from emitting `kind = "answer_due"` (§2.2.1).

### 3.4 Provisional output when unvalidated/uncertain
When the rule cannot produce an authoritative clock, it still helps the tenant *understand* (LLM explanation allowed) but **must not** present a fileable deadline:
- `Deadline.due_date` may be computed but `attorney_validated = false`, `tenant_confirmed = false`, `RiskFlags.uncertain_anchor = true`.
- `TimelineEvent.date_is_authoritative = false`.
- UI copy: "Estimated only — not confirmed. A lawyer must verify this date before you rely on it."

### 3.5 Output → `deadlines[]`

```jsonc
{
  "deadline_id": "dl_<ULID>",                 // SYS
  "deadline_type": "answer_due",              // or "first_appearance"
  "due_date": "<computed YYYY-MM-DD>",        // DET, court-local
  "computed_by": "deterministic",             // const invariant
  "computation_basis": {
    "anchor_event": "petition_served",
    "anchor_date": "<anchor YYYY-MM-DD>",
    "statute_rule_id": "nonpayment_answer_window",   // CANONICAL id (§1.4)
    "rule_version": "<config rule_version>"          // includes court_calendar_id+calendar_version in notes when court_days used
  },
  "tenant_confirmed": false,                   // human-confirm gate (must flip true)
  "attorney_validated": false,                 // attorney-validated gate (must flip true)
  "risk": {
    "is_imminent": false,                      // §4
    "is_missed": false,                        // §4
    "default_risk": false,                     // §4
    "uncertain_anchor": false                  // set true when anchor unverified/low-conf
  },
  "explanation": "<LLM plain-English: what this deadline is>"  // explanation only, never the computation
}
```

> The pair `tenant_confirmed` + `attorney_validated` are **both** required before any downstream use treats `due_date` as fileable. Absence of confirmation is never confirmation.
>
> **Calendar provenance:** when `unit = court_days`, the engine records the `court_calendar_id` and `calendar_version` (from §1.2.1) in `computation_basis.rule_version` as a compound stamp (e.g., `"nonpayment_answer_window@1.2.0+cal:nyc_housing_court_holidays@2026.1"`) so the count is fully reproducible.

---

## 4. RULE B — Default-Risk Detection

**`rule_id: nonpayment_default_risk`** · **ATTORNEY MUST VALIDATE before production.**

### 4.1 Purpose
Deterministically flag deadlines whose miss could cause a **default judgment**, and surface urgency. Drives `RiskFlags`, reminder scheduling, triage urgency, and (optionally) status-guard escalation. This is detection of a *factual clock state*, not advice.

### 4.2 Config: `default_risk.config.yaml`

```yaml
nonpayment_default_risk:
  rule_id: nonpayment_default_risk
  rule_version: "0.0.0-UNVALIDATED"
  attorney_validated_config: false
  statute_citation: "<ATTORNEY POPULATES>"

  imminent_window:
    count: null                 # <-- ATTORNEY POPULATES (e.g., N days before due_date)
    unit: null                  # "calendar_days" | "court_days"
  missed_grace:
    count: null                 # <-- grace after due_date before treating as missed, if any
    unit: null
  default_risk_deadline_types:  # which deadline types carry default risk
    - answer_due                # <-- ATTORNEY confirms set
    - first_appearance
  default_risk_requires_unsatisfied: true   # only risky if not yet satisfied/answered

  # --- escalation (sets review.review_state ONLY; never advice_routed — see §0) ---
  escalate_to_attorney_on_imminent: true
  escalate_to_attorney_on_missed: true

  # --- reminder send-offset schedule (§4.5; version-stamped via rule_version) ---
  reminder_offsets:             # <-- ATTORNEY/OPS POPULATE; e.g. [7, 3, 1] days before due_date
    offsets: []                 # list of integers
    unit: null                  # "calendar_days" | "court_days"
    send_local_time: null       # "HH:MM" America/New_York send time
```

### 4.3 Computation (per active `Deadline`)
Evaluated against "today" in America/New_York (`now_court_local`):

- `is_imminent = (attorney_validated_config) and ((due_date - now) <= imminent_window) and not satisfied`
- `is_missed = (now > due_date + missed_grace) and not satisfied`
- `default_risk = (deadline_type ∈ default_risk_deadline_types) and (is_imminent or is_missed) and (default_risk_requires_unsatisfied ⇒ not satisfied)`

#### 4.3.1 The "satisfied" predicate (concrete — closes the resolution gap)

The MVP has **no programmatic e-filing rail** and `answer_draft.status` tops out at `finalized` (drafted, not filed). To let `is_missed`/`default_risk` ever resolve to `false`, the satisfaction predicate is defined deterministically as the disjunction of:

1. **Court-sourced docket event** — a `timeline[]` event with `kind ∈ {answer_due (satisfied marker), court_appearance, adjournment}` whose `date_is_authoritative = true` and whose `court_date_source ∈ {etrack, nyscef}` indicates the answer/appearance occurred (e.g., NYSCEF docket shows an answer filed, or an appearance/adjournment was recorded). This is the authoritative satisfier.
2. **Tenant-attested filing marker** — the tenant affirmatively marks the answer as filed via the dedicated PWA action. This is recorded as a `timeline[]` event `kind = "other"` with `date_is_authoritative = false` and a structured tag `answer_filed_attested`, plus `answer_draft.status = "finalized"`. Because it is tenant-attested (not court-verified), it **down-grades** but does not fully clear default risk: `is_missed` is cleared to `false`, but the engine keeps a soft advisory ("we've recorded you filed — confirm on the docket") until a court-sourced event (predicate 1) confirms.

> **No new canonical field is introduced** — the filing marker rides on the existing `timeline[]` (`kind = "other"` + structured tag + `date_is_authoritative` flag) and `answer_draft.status = "finalized"`. The attorney/eng confirm the tag vocabulary in `default_risk.config.yaml` (`satisfaction_signals`). **Default = not satisfied** (fail-safe toward flagging risk) whenever neither predicate holds.

```yaml
  satisfaction_signals:
    court_sourced_kinds: [court_appearance, adjournment]     # <-- ATTORNEY confirms which clear risk
    tenant_attested_tag: answer_filed_attested               # timeline kind=other structured tag
    tenant_attested_clears_missed: true                      # down-grade only; soft advisory retained
```

### 4.4 Outputs
- Writes `risk.is_imminent`, `risk.is_missed`, `risk.default_risk` on the relevant `deadlines[]` entries.
- When `escalate_to_attorney_on_imminent`/`_missed` and the condition holds → set **`case.review.review_state = "escalated"`** (and, if currently `unassigned`, also `"queued"` is a valid intermediate per the status machine) and append an audit event with `action = "escalate_review"`. **The engine does NOT set `review.advice_routed`** — a missed/imminent deadline is not an advice-seeking conversational turn (§0, §0.1).
- Feeds reminder scheduling (§4.5).

> **Fail-safe direction:** when inputs are uncertain, prefer flagging risk (over-warn) rather than under-warn. A false "imminent" is recoverable; a missed answer is not.

### 4.5 Reminder scheduling (DET, version-stamped)

The reminder cadence is **no longer left as an example** — it is config-driven and version-stamped:

- For each active default-risk deadline, the engine creates `reminders[]` entries from `reminder_offsets`:
  - `reminder_type = "answer_deadline"` (for `answer_due`/`first_appearance` deadlines) or `"court_date"` (when the related authoritative event is `court.court_date`).
  - `related_deadline_id` = the `Deadline` FK.
  - `scheduled_for` = `due_date` minus each offset (in `unit`, applying court-day skipping when `unit = court_days`), at `send_local_time` America/New_York, serialized as an RFC-3339 UTC `Z` instant.
  - `channel` defaults to `sms`; `state = "scheduled"`.
- **Send gate (hard):** a reminder is only sent when there is a `consents[]` record with `scope = "sms_reminders"`, `granted = true`, not expired/revoked, AND `contact.safe_to_text = true`. The `reminder.consent_id` FK is required (canonical). If no valid consent, the reminder is created in state `"scheduled"` but suppressed at send time (or not created, per ops config).
- **Version stamp:** the offset schedule that produced a reminder is reproducible via the emitting rule's `rule_version` (the `reminder_offsets` block lives inside `nonpayment_default_risk` config), recorded in the audit event for the reminder write.

---

## 5. RULE C — Rent-Demand Predicate

**`rule_id: nonpayment_rent_demand_predicate`** · **ATTORNEY MUST VALIDATE before production.**

### 5.1 Purpose
A valid statutory rent demand is a **predicate** to a nonpayment proceeding. This rule deterministically checks the **presence and facial regularity** of the demand and surfaces a *candidate* defective-rent-demand defense as **information only**. It does **NOT** conclude the demand is legally defective — that is the attorney's call (`attorney_disposition`).

### 5.2 Config: `rent_demand.config.yaml`

```yaml
nonpayment_rent_demand_predicate:
  rule_id: nonpayment_rent_demand_predicate
  rule_version: "0.0.0-UNVALIDATED"
  attorney_validated_config: false
  statute_citation: "<ATTORNEY POPULATES — rent demand predicate authority>"

  demand_required: true                  # <-- ATTORNEY confirms a demand is required
  demand_notice_window:                  # required notice period before petition
    count: null                          # <-- ATTORNEY POPULATES
    unit: null                           # "calendar_days" | "court_days"
    counting_basis: null
  demand_to_petition_ordering:           # demand must precede petition by the window
    enforce: true
  required_demand_facets:                # facial-regularity checks (presence-only)
    - has_rent_demand_document           # a document classified rent_demand exists
    - has_rent_demand_date               # rent_demand_date extracted
    - has_amount_demanded                # demand-doc extracted_fields.claimed_arrears present (§2.1.1)
    - amount_matches_claimed_arrears_tolerance  # see tolerance below
  amount_match_tolerance_cents: null     # <-- ATTORNEY/eng POPULATE (0 = exact)
  surfaced_defense_code: defective_rent_demand
```

### 5.3 Computation
1. Locate a `documents[]` entry with confirmed `document_type = "rent_demand"`. If none → emit `defenses_checklist` item with `relevance_signal = "possible"` (demand may be missing) and set `review.review_state = "escalated"`; do **not** conclude.
2. If a demand exists, compute facial checks (presence-only, never legal sufficiency):
   - **Timing:** if `demand_notice_window` configured and both `rent_demand_date` and `petition_filed_date`/`service_date` are present → check the demand preceded the petition by ≥ window. A shortfall sets `relevance_signal = "possible"` (timing may be defective).
   - **Amount consistency:** compare the **demand amount** (`extracted_fields.claimed_arrears` on the rent-demand doc, §2.1.1) vs the petition's `case.claimed_arrears` within `amount_match_tolerance_cents`. If the demand amount input is unavailable/`unreadable`, **skip** this check (note it; do not fail). A mismatch is a neutral signal (may map to `wrong_amount_claimed` and/or `defective_rent_demand`).
3. Set neutral `relevance_signal` per the **unified open-data/unverified semantics in §5.5**.

### 5.4 Outputs → `defenses_checklist[]`
```jsonc
{
  "defense_code": "defective_rent_demand",      // and/or "wrong_amount_claimed"
  "surfaced_as": "information_not_advice",       // const invariant
  "relevance_signal": "possible",                // neutral signal, NOT a recommendation
  "supporting_evidence_ids": ["ev_<ULID>"],      // e.g., the rent_demand document mapped to evidence
  "explanation": "<LLM plain-English: what a rent demand is and why it matters — general info>",
  "attorney_reviewed": false,
  "attorney_disposition": null                   // attorney-only: applicable/not_applicable/needs_more_info
}
```
> The engine **never** sets `attorney_disposition`. Surfacing "possible" is information; concluding the demand is defective (or that the tenant "has a defense") is the **advice line** and is attorney-owned.

### 5.5 Unified `relevance_signal` semantics (cross-tool consistency)

To remove the sibling-rule inconsistency between defense surfacing across this engine and `tool-contracts`, the following **single mapping is canonical** and applies to RULE C, RULE D, and any open-data-derived defense surfaced by deterministic tools:

| Condition | `relevance_signal` |
|---|---|
| A facial check **failed** or a required element is **missing/unknown** (candidate defense is plausible) | `possible` |
| Tenant-uploaded, tenant-confirmed evidence directly supports the element (e.g., a confirmed rent receipt for `rent_paid`) | `evidence_present` |
| Facts/lookups affirmatively indicate the defense does **not** apply | `not_indicated` |
| Insufficient signal either way | `possible` (fail-safe toward surfacing for human review) |

> **Key rule:** an **unverified open-data-derived** signal (e.g., HPD registration absence, HPD violations not yet `verify_before_file = verified`) is **always `possible`, never `evidence_present`.** `evidence_present` is reserved for tenant-confirmed, in-hand evidence — open data is provisional until the tenant verifies it. This reconciles the prior divergence where one tool used `evidence_present` for unverified open-data items and another used `possible`.

---

## 6. RULE D — Registration Defense (HPD Registration)

**`rule_id: nonpayment_registration_defense`** · **ATTORNEY MUST VALIDATE before production.**

### 6.1 Purpose
For covered multiple dwellings, a current/valid HPD registration is generally required to maintain a nonpayment proceeding; absence is a recognized defense/bar. This rule deterministically derives a **registration-on-file signal** from the open-data lookup and surfaces a *candidate* defense — **information only, never asserted into a filing.**

> **The defense trigger is defined here from the registration lookup; the LEGAL effect (whether it bars the proceeding, for which buildings, with what exceptions) is attorney-owned config, not asserted by this spec.**

### 6.2 Input: `lookup_hpd_registration` (deterministic tool)
A deterministic tool that resolves the building and queries HPD Registration+Contacts. Contract:

**Input:** `case.property.bbl` (preferred; resolved via GeoSearch + PLUTO/PAD), with `case.property.address` fallback.

**Output (written into the Case Object, all open-data-gated):**
- `case.parties.landlord.registration_on_file` (boolean | null) — see §6.2.1 for how on-file-vs-current is encoded.
- `case.parties.landlord.registered_owner_name` (string | null).
- `case.parties.landlord.wow_landlord_id` (string | null) — from JustFix WoW cross-reference using only the **verified** endpoints `/api/address`, `/api/address/wowza`, `/api/address/buildinginfo`, `/api/address/indicatorhistory`. **Never `/api/address/aggregate`** (full path — not an `/aggregate` shorthand).
- `case.parties.landlord.open_data` → `OpenDataAssertion` carrying:
  - `dataset = "hpd_registration_tesw-yqqr"` (and `hpd_contacts_feu5-w2e2` for contacts; `justfix_wow` for ownership cross-ref),
  - `dataset_version`, `retrieved_at`, `endpoint`,
  - `data_accuracy_disclaimer` (REQUIRED),
  - `verify_before_file` (`VerifyGate`, default `state = "unverified"`).

> **Stale-data risk:** registration status from open data may be stale/incomplete. The tenant bears 22 NYCRR 130 risk. This signal is **never auto-asserted into a filing**; it must reach `verify_before_file.state = "verified"` to enter any packet, and `Packet.blocked_by_unverified_open_data` hard-blocks assembly otherwise.

#### 6.2.1 Mapping "expired/lapsed but on file" → canonical fields (closes the lost-signal gap)

The canonical `parties.landlord` exposes only a boolean `registration_on_file` — there is **no** `registration_current` field. A registration that exists on the HPD record but is **expired/lapsed** is a meaningfully different (and defense-relevant) state from "no registration at all," and must not silently collapse to `registration_on_file = true`. The canonical mapping is:

| HPD record state | `registration_on_file` | Where the expiry/lapse distinction lives (no new field) |
|---|---|---|
| Current, valid registration on file | `true` | `parties.landlord.open_data.data_accuracy_disclaimer` notes "current"; no defense surfaced (`not_indicated`). |
| Registration exists but **expired/lapsed** | **`false`** | Treated as **not validly on file** for the defense trigger. The expired-vs-absent nuance is carried in (a) the surfaced `defenses_checklist[]` item's LLM `explanation` ("a registration record exists but appears expired/lapsed as of `dataset_version`"), and (b) the `evidence[]` open-data item's `summary` + `OpenDataAssertion.data_accuracy_disclaimer`. |
| No registration found | `false` | As above; explanation notes "no registration record found." |
| Lookup failed / unknown | `null` | Surface `possible`; explanation notes "registration status could not be confirmed." |

> **Decision:** `registration_on_file = true` means **current and valid**. Expired/lapsed maps to `false` so the registration-defense signal is preserved, and the *reason* (expired vs absent vs unknown) is preserved in the human-readable `explanation`/`summary`/disclaimer rather than a new boolean. The attorney owns the legal effect via `attorney_disposition`. This mapping is documented so the deterministic tool and this rule agree.

### 6.3 Config: `registration.config.yaml`

```yaml
nonpayment_registration_defense:
  rule_id: nonpayment_registration_defense
  rule_version: "0.0.0-UNVALIDATED"
  attorney_validated_config: false
  statute_citation: "<ATTORNEY POPULATES — HPD registration / MDL framework>"

  applies_to_building_classes: null      # <-- ATTORNEY POPULATES coverage (e.g., multiple dwellings)
  coverage_signal_source:                # how we judge the building is in scope
    use_pluto_unit_count: true
    multiple_dwelling_min_units: null    # <-- ATTORNEY/eng POPULATE threshold
  trigger:
    # The defense is SURFACED (information) when the registration signal indicates absence.
    surface_when_registration_on_file_is: false   # absence/expired (per §6.2.1) triggers surfacing
    also_surface_when_null: true                   # unknown/lookup-failed => surface as "possible"
  require_verified_before_packet: true   # open-data verify gate must be verified to file
  surfaced_defense_code: not_registered_multiple_dwelling
```

### 6.4 Computation (deterministic)
1. Ensure `case.property.bbl` resolved (`geo_confidence` ∈ {`exact`,`approximate`}); if `failed`, surface `relevance_signal = "possible"` with note "could not confirm building" and set `review.review_state = "escalated"`.
2. Determine coverage signal (e.g., unit count from PLUTO ≥ `multiple_dwelling_min_units`). Coverage is itself open-data → also disclaimer/verify-gated.
3. Read `case.parties.landlord.registration_on_file` (interpreted per §6.2.1):
   - `false` (matches `surface_when_registration_on_file_is`) → surface defense, `relevance_signal = "possible"` (per §5.5 — open-data-derived, unverified ⇒ always `possible`).
   - `null` and `also_surface_when_null` → surface defense, `relevance_signal = "possible"`, note "registration status unknown."
   - `true` → `relevance_signal = "not_indicated"` (registration appears current and on file) — still attorney-reviewable.
4. Create/attach an `evidence[]` item, `origin = "open_data"`, `evidence_type = "registration_record"`, with the **required** `open_data` `OpenDataAssertion` (disclaimer + `verify_before_file`). Map its `ev_` id into `supporting_evidence_ids`.

### 6.5 Outputs
- `defenses_checklist[]` item with `defense_code = "not_registered_multiple_dwelling"`, `surfaced_as = "information_not_advice"`, neutral `relevance_signal` (per §5.5), `attorney_reviewed = false`, `attorney_disposition = null`.
- `evidence[]` open-data item (registration record) with `verify_before_file.state = "unverified"` until the tenant verifies.
- **Hard block:** if this evidence is included in a packet while unverified, `packets.*.blocked_by_unverified_open_data = true` blocks assembly. **The block scope includes `parties.landlord.open_data`**, not just `included_evidence_ids` — see §10.5.

> The registration *signal* is deterministic; whether it actually bars the proceeding is the **advice line** (attorney `attorney_disposition`). The engine surfaces, the attorney concludes.

---

## 7. RULE E — Rent-Overcharge / Stabilization Signal (FLAG-ONLY)

**`rule_id: nonpayment_overcharge_signal`** · **ATTORNEY MUST VALIDATE before production.**

### 7.1 Purpose
Rent stabilization status and overcharge are **complex, fact- and history-intensive** legal questions. This rule is **flag-only**: it surfaces neutral signals that the matter *may* involve a regulated tenancy or overcharge, and **escalates to attorney**. It performs **no** rent calculation, no legal-regulated-rent determination, and no overcharge conclusion.

### 7.2 Config: `overcharge_signal.config.yaml`

```yaml
nonpayment_overcharge_signal:
  rule_id: nonpayment_overcharge_signal
  rule_version: "0.0.0-UNVALIDATED"
  attorney_validated_config: false
  statute_citation: "<ATTORNEY POPULATES — RSL / overcharge framework>"

  flag_only: true                        # HARD: never computes a regulated rent
  signals:                               # neutral indicators that MAY suggest regulation/overcharge
    building_age_built_before_year: null # <-- ATTORNEY/eng POPULATE (era signal)
    use_pluto_unit_count: true
    regulated_unit_count_min: null       # <-- POPULATE
    tax_benefit_indicators_enabled: false # e.g., program-linked regulation (open-data, if added)
    rent_history_mismatch_enabled: false  # surface only; no calculation
  escalate_to_attorney_on_any_signal: true  # any hit => review.review_state = "escalated"
  surfaced_defense_codes:
    - rent_overcharge
    - rent_regulation_violation
```

### 7.3 Computation
1. Evaluate configured neutral signals from open data / extracted facts (building era, unit count, etc.). **No arithmetic on rent legality.**
2. If any signal hits and `escalate_to_attorney_on_any_signal` → set **`case.review.review_state = "escalated"`** and append an audit event with `action = "escalate_review"`. **The engine does NOT set `review.advice_routed`** (§0, §0.1) — an overcharge signal is a deterministic flag, not an advice-seeking conversational turn.
3. Surface `defenses_checklist[]` items (`rent_overcharge`, `rent_regulation_violation`) with `surfaced_as = "information_not_advice"`, `relevance_signal = "possible"` (per §5.5; open-data-derived signals are never `evidence_present`).

### 7.4 Outputs
- `defenses_checklist[]` flag-only items (attorney-owned disposition).
- `case.review.review_state = "escalated"` when any signal hits.
- Any open-data inputs carry `OpenDataAssertion` (disclaimer + verify gate).

> **Hard invariant:** `flag_only: true` — the engine must not emit any regulated-rent number, overcharge amount, or eligibility-style conclusion for this rule. It only flags + escalates.

---

## 8. Eligibility & monitored-config rules (RTC, CityFHEPS, e-filing)

These produce `case.eligibility.*` (`determined_by = "deterministic"`) and/or operational config; all are **monitored** and **attorney/policy-owned**.

> **Canonical slotting (additionalProperties:false enforced):** the only eligibility slots are `eligibility.rtc`, `eligibility.legal_aid`, and `eligibility.rental_assistance`. **ERAP, CityFHEPS, One-Shot Deal, OFA emergency grant, SNAP, and any other rental-assistance program ALL write `eligibility.rental_assistance`** (an `EligibilityResult` whose `program` field names the specific program). There is **no** `eligibility.erap` / `eligibility.cityfheps` key — emitting one is a schema violation. When multiple rental-assistance programs are evaluated, the engine writes the single most relevant `EligibilityResult` to `eligibility.rental_assistance` and records the others in that result's `reasons[]`/`rule_ids[]`, or selects per the ops-configured precedence; it never invents sibling keys.

### 8.1 RTC (Right to Counsel) — income + geography

**`rule_id: rtc_eligibility`** · **ATTORNEY/POLICY MUST VALIDATE; monitored config.**

```yaml
rtc_eligibility:
  rule_id: rtc_eligibility
  rule_version: "0.0.0-UNVALIDATED"
  attorney_validated_config: false
  monitored: true
  review_by: null                         # <-- POPULATE (coverage changes over time)

  income:
    fpl_multiplier_pct: null              # <-- POPULATE (RTC ≤ 200% FPL per scope; do not assume)
    fpl_table_version: null               # versioned FPL table id
    income_field: "sensitive.household_income_cents"
    household_size_field: "sensitive.household_size"
  geography:
    mode: null                            # "citywide" | "zip_list" | "borough_list"
    covered_zips: []                      # <-- POPULATE if zip-gated (monitored)
    covered_boroughs: []                  # <-- POPULATE if borough-gated
    zip_field: "property.address.postal_code"
    borough_field: "court.borough"        # NOTE: borough is read from court.borough (property has no borough)
  data_source: nyc_benefits_screening_api  # eligibility-only, NO submission (contract §8.6)
  display_rule: internal_triage_only       # see §8.7 — likely_eligible is NOT shown as a conclusion
```

**Computation:**
- If `sensitive.household_income_cents`/`household_size` are null (opt-in not provided) → `determination = "insufficient_data"`.
- Else compare income to `fpl_multiplier_pct` × FPL(size) from `fpl_table_version`; check geography per `mode`. Borough is sourced from `court.borough` (the canonical `property` object has no borough field).
- Output `EligibilityResult` into `case.eligibility.rtc`: `determination ∈ {eligible, likely_eligible, ineligible, insufficient_data}`, `determined_by = "deterministic"`, `rule_ids`, `reasons[]` (structured codes, not advice), `data_source`. Stamp `case.eligibility.config_version` + `evaluated_at`.

> **Monitored:** RTC income thresholds and ZIP/borough coverage change. `covered_zips`/`fpl_multiplier_pct`/`review_by` live on the monitored-config dashboard. The spec does **not** assert the multiplier or ZIP list.

### 8.2 CityFHEPS — active litigation → toggleable (writes `rental_assistance`)

**`rule_id: cityfheps_eligibility`** · **monitored; litigation-sensitive.**

```yaml
cityfheps_eligibility:
  rule_id: cityfheps_eligibility
  attorney_validated_config: false
  monitored: true
  config_toggle_state: disabled           # <-- "enabled" | "disabled" (active litigation)
  rules_version: null
```
**Computation:**
- If `config_toggle_state = "disabled"` → write `case.eligibility.rental_assistance` = `EligibilityResult { program: "cityfheps", determination: "program_unavailable", determined_by: "deterministic", config_toggle_state: "disabled" }`.
- If `enabled` → run config-driven rules; write `case.eligibility.rental_assistance` = `EligibilityResult { program: "cityfheps", determination: <...>, determined_by: "deterministic", config_toggle_state: "enabled" }`.

### 8.3 ERAP — CLOSED (writes `rental_assistance`)

**`rule_id: erap_eligibility`** — Hard config: ERAP is closed.
- Always write `case.eligibility.rental_assistance` = `EligibilityResult { program: "erap", determination: "program_unavailable", determined_by: "deterministic" }`. No income/eligibility math.
- **There is no `eligibility.erap` key.** ERAP lives in the `rental_assistance` slot per §8 and §1.4 — this reconciles the prior drift in tool-contracts/legal-rules that implied a top-level ERAP key.

### 8.4 Other rental assistance (One-Shot Deal, OFA emergency grant, SNAP)
- **`rule_id: rental_assistance_eligibility`.** Config-driven, toggleable per `EligibilityProgram` enum. Each emits an `EligibilityResult` written to `case.eligibility.rental_assistance` with `program` set, `determined_by = "deterministic"`, `data_source ∈ {nyc_benefits_screening_api, internal_rules}`. Benefits API is **eligibility-only — no submission.** When several apply, see §8 precedence note.

### 8.5 E-filing coverage — monitored config (no programmatic rail)

**`rule_id: efiling_coverage`** · **monitored config; informational only.**

```yaml
efiling_coverage:
  rule_id: efiling_coverage
  monitored: true
  review_by: null
  pro_se_tenant_mandatory_efiling_exempt: true   # statutory exemption — DO NOT build an e-filing rail
  nyscef_coverage_by_county: {}                   # <-- POPULATE (which counties live; monitored)
  court_date_sources_enabled: [etrack, nyscef]    # how court.court_date is sourced
```
- **No programmatic e-filing rail.** Pro se tenants are statutorily exempt from mandatory e-filing; the product never e-files. Court date is sourced via **eTrack email ingest** / **NYSCEF public docket** (sets `court.court_date_source` and `court.court_date_verified`). **Never scrape the live eCourts portal.**
- This rule writes **no Case Object field**; it only informs UI/ops and gates whether `court.court_date_verified` can be set from NYSCEF for a given county.

### 8.6 NYC Benefits Screening API binding (eligibility-only)

`data_source = nyc_benefits_screening_api` is **eligibility-only — never submits an application**. The deterministic eligibility rules call it as an input oracle:

- **Request:** household composition + `sensitive.household_income_cents` + `household_size` + ZIP/borough (from `court.borough`). No PII beyond what the matching consent's `data_categories[]` permits (`eligibility` category required; see §10.6).
- **Response:** per-program eligibility booleans/codes mapped into `EligibilityResult.reasons[]` (structured reason codes) and `determination`.
- **Fallback:** if the API is unavailable, the engine falls back to `data_source = "internal_rules"` config and, if inputs are insufficient, emits `determination = "insufficient_data"`. The exact field map and auth are owned by the integrations spec; this rule depends only on the mapped `determination` + `reasons[]`.

### 8.7 Display rule for `likely_eligible` (UPL clearance)

`likely_eligible` is a valid DET `determination`, but showing a tenant "you likely qualify for a free lawyer" edges toward advice-adjacent messaging. Canonical display rule:

- `likely_eligible` is **internal triage only** (`display_rule: internal_triage_only`). It MAY drive routing, attorney queue prioritization, and the legal-aid handoff summary (attorney-reviewed), but the **tenant-facing UI must not render `likely_eligible` as a conclusion**. To the tenant, `likely_eligible` is presented as neutral, non-conclusory information: "You may qualify — a lawyer will confirm," with no implied guarantee.
- Only `eligible` / `ineligible` / `program_unavailable` / `insufficient_data` may be shown to the tenant as plain status, and even `eligible` is framed as "based on what you told us; confirmed by a lawyer." This keeps the determination clear of implied legal advice.

---

## 9. Monitored-config register (single source of truth)

Every value here is surfaced on a dashboard with `monitored: true`, an owner, and a `review_by` date. The spec lists the **keys**, not the values.

| Config key | Rule | Owner | Why monitored |
|---|---|---|---|
| `nonpayment_answer_window.answer_window.{count,unit,counting_basis,weekend_holiday_rule}` | A | Supervising attorney | Statutory clock; malpractice-critical. |
| `nonpayment_answer_window.anchor_priority` | A | Supervising attorney | Which event starts the clock. |
| `nonpayment_default_risk.{imminent_window,missed_grace}` | B | Supervising attorney | Drives default-risk warnings. |
| `nonpayment_default_risk.reminder_offsets.{offsets,unit,send_local_time}` | B | Ops + attorney | Reminder cadence (version-stamped). |
| `nonpayment_default_risk.satisfaction_signals` | B | Supervising attorney | Defines when default risk clears. |
| `nonpayment_rent_demand_predicate.demand_notice_window` | C | Supervising attorney | Predicate timing. |
| `nonpayment_rent_demand_predicate.amount_match_tolerance_cents` | C | Supervising attorney/eng | Amount-consistency tolerance. |
| `nonpayment_registration_defense.{applies_to_building_classes,multiple_dwelling_min_units,trigger}` | D | Supervising attorney | Coverage + trigger. |
| `nonpayment_overcharge_signal.signals.*` | E | Supervising attorney | Stabilization signals (flag-only). |
| `rtc_eligibility.income.fpl_multiplier_pct` + `fpl_table_version` | 8.1 | Policy + attorney | RTC income threshold (≤200% FPL per scope). |
| `rtc_eligibility.geography.{mode,covered_zips,covered_boroughs}` | 8.1 | Policy + ops | RTC ZIP/borough coverage. |
| `cityfheps_eligibility.config_toggle_state` | 8.2 | Policy + attorney | Active litigation. |
| `efiling_coverage.nyscef_coverage_by_county` | 8.5 | Ops | NYSCEF rollout; pro se exemption. |
| `calendars/court_holidays.yaml` (`calendar_version`, `coverage_until`, `observed`) | A/B | `ops:court-calendar` | Court-day counting (annual + emergency closures). |
| `verify_before_file` staleness window (`open_data_verify_ttl`) | global | Ops + attorney | A `verified` gate reverts to `unverified` past TTL (§10.7). |

---

## 10. Execution order, gating, and audit

### 10.1 Pipeline order (deterministic)
1. **Preconditions:** `case_type = "nonpayment"` & `case_type_confirmed`; required confirmable inputs present.
2. **Resolve property/BBL** (GeoSearch + PLUTO/PAD) → `case.property.bbl`.
3. **Open-data lookups** (HPD registration via `lookup_hpd_registration`, WoW) → write open-data-gated fields/evidence.
4. **Rule A** (answer window) → `deadlines[]` + `timeline[]`.
5. **Rule B** (default risk) → `risk` flags, reminders, escalation (`review_state`).
6. **Rule C** (rent-demand predicate) → `defenses_checklist[]`.
7. **Rule D** (registration defense) → `defenses_checklist[]` + open-data `evidence[]`.
8. **Rule E** (overcharge/stabilization) → flag-only `defenses_checklist[]` + escalation (`review_state`).
9. **Eligibility** (RTC → `eligibility.rtc`; legal-aid → `eligibility.legal_aid`; CityFHEPS/ERAP/other → `eligibility.rental_assistance`; e-filing coverage → ops only) → `eligibility.*`.
10. **Audit** every write.

### 10.2 Per-rule hard gates (all must hold to emit authoritative output)
- `attorney_validated_config == true` for that rule.
- Inputs satisfy provenance gates (confirmed where required; open-data verify gate respected for filings).
- Boundary invariants set as schema constants:
  - `deadlines[].computed_by = "deterministic"`
  - `eligibility.*.determined_by = "deterministic"`
  - `defenses_checklist[].surfaced_as = "information_not_advice"`
  - (downstream) `answer_draft.form_fields[].placed_by = "deterministic"`, `answer_draft.factual_statements[].transcription_only = true`

### 10.3 Audit (every engine write)
Append to `case.audit.events[]`:
```jsonc
{
  "at": "<RFC3339 Z>",
  "actor": { "actor_type": "deterministic_engine", "actor_id": "rules:<rule_id>@<rule_version>" },
  "action": "compute_deadline | surface_defense | determine_eligibility | escalate_review | schedule_reminder",
  "field_path": "/deadlines/0 | /defenses_checklist/2 | /eligibility/rtc | /eligibility/rental_assistance | /review/review_state | /reminders/1",
  "model": null
}
```
`model` is always `null` for engine writes (no LLM on the advice/clock line). Note `action` has **no `route_advice` value** — this engine does not route advice; `review.advice_routed` is owned by the conversational router (§0.1). Supports SHIELD/legal-hold and the LLM/DET boundary trail.

### 10.4 Acceptance tests (machine-checkable)

| ID | Assertion |
|---|---|
| AT-LR-1 | Every emitted `deadlines[].computed_by == "deterministic"`. |
| AT-LR-2 | Every emitted `eligibility.*.determined_by == "deterministic"`. |
| AT-LR-3 | Every emitted `defenses_checklist[].surfaced_as == "information_not_advice"`. |
| AT-LR-4 | No emitted timeline event has `kind == "answer_due"` with `deadline_id == null`; the LLM-authorship path cannot emit `kind == "answer_due"` (§2.2.1). |
| AT-LR-5 | No `EligibilityResult` is written outside `{eligibility.rtc, eligibility.legal_aid, eligibility.rental_assistance}`; payload never contains an `eligibility.erap`/`eligibility.cityfheps` key. |
| AT-LR-6 | A rule with `attorney_validated_config == false` emits no authoritative `deadlines[]`/`eligibility.*` (provisional only, `attorney_validated == false`). |
| AT-LR-7 | The rules service contains **zero** writes to `review.advice_routed`; escalation writes only `review.review_state == "escalated"`. |
| AT-LR-8 | Every open-data-derived defense surfaced by this engine uses `relevance_signal == "possible"` (never `evidence_present`) while its `verify_before_file.state != "verified"` (§5.5). |
| AT-LR-9 | An expired/lapsed-but-on-file registration yields `registration_on_file == false` and a surfaced registration defense whose `explanation` records the expired-vs-absent distinction (§6.2.1). |
| AT-LR-10 | `court_days` math past `court_holidays.coverage_until` produces provisional output with `uncertain_anchor == true`, never an authoritative `due_date`. |

### 10.5 Packet-assembly gating this engine relies on (cross-ref reconciliation)

The engine itself does not assemble packets, but it produces the gates the assembler MUST enforce. To reconcile the prior tool-contracts/api-contracts disagreement, the canonical packet-assembly preconditions (which the `assemble_packet` deterministic tool MUST check) are:

1. **`Packet.blocked_by_unverified_open_data == false`.** This MUST be computed by scanning **all** referenced open-data assertions — both `included_evidence_ids[]` items' `open_data.verify_before_file` AND **`parties.landlord.open_data.verify_before_file`** (registration/ownership). An unverified landlord-registration assertion blocks assembly even if it is not in `included_evidence_ids[]`. The handoff generator MUST apply the same scan so an unverified registration assertion cannot enter the intake summary.
2. **All required `answer_draft.form_fields[].validation_state == "valid"`.**
3. **Every `deadlines[]` entry referenced for filing has `attorney_validated == true`.** This is a **hard gate at the `referred` transition** and at minimum a surfaced warning at court-packet build. `assemble_packet` MUST include this deadline-validation check (reconciling it with the api-contracts gate, which previously diverged from the tool-contracts gate that omitted it).

### 10.6 Consent ↔ packet-contents reconciliation at delivery (cross-ref)

A `legal_aid_handoff` packet includes eligibility-derived content and CSR/LIST tags. Delivery MUST NOT exceed the matching `handoff_to_provider` consent's `data_categories[]`. Canonical rule:

- The handoff delivery step verifies that every data category present in the packet is covered by the consent's `data_categories[]`. If the packet includes eligibility results, the consent MUST include `eligibility`; if it includes evidence, it MUST include `evidence`; etc.
- If a required category is missing from the consent, delivery is **blocked** until the tenant grants the additional severable category (or the offending content is redacted from the packet). No eligibility content is delivered under a consent whose `data_categories[]` omits `eligibility`.

> This engine flags the dependency by ensuring eligibility results carry the `eligibility` data-category requirement; the delivery enforcement point is owned by `api-contracts`/`data-security`, but the requirement is stated here so eligibility outputs are never silently delivered out of scope.

### 10.7 Verify-before-file staleness window (closes AT-3.6 gap)

A `verify_before_file.state = "verified"` open-data assertion does not stay verified forever. Canonical config key: **`open_data_verify_ttl`** (in `eligibility.config.yaml`/global ops config), with a default that the attorney/ops MUST populate:

```yaml
open_data_verify_ttl:
  count: null            # <-- OPS/ATTORNEY POPULATE (e.g., N days)
  unit: null             # "calendar_days"
  monitored: true
  review_by: null
```

- A gate whose `verified_at` is older than `now - open_data_verify_ttl` deterministically reverts to `state = "unverified"` (logged in audit), which re-arms `blocked_by_unverified_open_data` for any packet referencing it. This makes a "verified" assertion expire, satisfying the staleness requirement. Until populated, the TTL config is treated as unset and the ops dashboard flags it as a production blocker.

---

## 11. Open questions the attorney must close before production

Each is a **blocking** item; until resolved the corresponding rule's `attorney_validated_config` stays `false`. **This is the single biggest build blocker: every legally-operative value below is currently `null` / `0.0.0-UNVALIDATED` by design.**

1. **Anchor + window for the nonpayment answer/response** — exact starting event(s), `count`/`unit`/`counting_basis`, weekend/holiday roll, any service-method add-days; whether first-appearance is a separate `first_appearance` deadline. *(Rule A)*
2. **Court-holiday calendar** — official source, annual + emergency-closure maintenance owner (`ops:court-calendar`), `coverage_from`/`coverage_until`, populated `observed[]`. *(§1.2.1; blocks all `court_days` math)*
3. **Default-risk windows + satisfaction predicate** — `imminent_window`, `missed_grace`, the `satisfaction_signals` vocabulary, and confirmation that the tenant-attested filing marker (timeline `kind=other` + tag) is acceptable to down-grade risk. *(Rule B, §4.3.1)*
4. **Reminder cadence** — `reminder_offsets.{offsets,unit,send_local_time}`. *(Rule B, §4.5)*
5. **Rent-demand predicate** — whether/what demand is required, `demand_notice_window`, facial-regularity facets, `amount_match_tolerance_cents`; confirm demand amount input mapping (§2.1.1). *(Rule C)*
6. **Registration defense** — covered building classes, unit threshold, exact trigger semantics, the legal effect of absence, and confirmation of the expired-vs-absent → `registration_on_file=false` mapping. *(Rule D, §6.2.1)*
7. **Overcharge/stabilization signals** — which neutral indicators are appropriate as flags; confirm flag-only (no calculation). *(Rule E)*
8. **RTC** — `fpl_multiplier_pct`, FPL table version, geography mode + ZIP/borough coverage; confirm `likely_eligible` internal-triage-only display rule (§8.7). *(8.1)*
9. **CityFHEPS** — current `config_toggle_state` given litigation posture. *(8.2)*
10. **Other rental assistance** — which programs are evaluated and the precedence when several apply to the single `rental_assistance` slot. *(8.4, §8 precedence)*
11. **E-filing coverage** — per-county NYSCEF coverage; reaffirm pro se exemption / no e-filing rail. *(8.5)*
12. **NYC Benefits Screening API** — confirm eligibility-only usage and the mapped `determination`/`reasons[]` contract; fallback to `internal_rules`. *(8.6)*
13. **`open_data_verify_ttl`** — staleness window value after which a `verified` gate reverts to `unverified`. *(§10.7)*

> **Adjacent build dependencies owned by other specs (not by this attorney) but required before the engine can ship end-to-end:** the eTrack email-ingest parse schema and NYSCEF public-docket query/response contract (court-date sourcing + discrepancy surfacing), the official NY fillable-PDF AcroForm/AssemblyLine field map (`form_template_version`, `answer_draft.form_fields[].form_field_id`), and the CSR (LSC) + LIST taxonomy code set for the legal-aid handoff. These are flagged here so the legal-rules engine is not mistaken for the sole blocker.

---

## 12. Summary of Case Object fields written by this engine

- `deadlines[]` — `deadline_id`, `deadline_type` (`answer_due`/`first_appearance`/…), `due_date`, `computed_by="deterministic"`, `computation_basis.{anchor_event,anchor_date,statute_rule_id (canonical, §1.4),rule_version (+calendar stamp when court_days)}`, `tenant_confirmed`, `attorney_validated`, `risk.{is_imminent,is_missed,default_risk,uncertain_anchor}`, `explanation` (LLM, explanation only).
- `timeline[]` — `event_id`, `kind` (engine emits only `answer_due` with non-null `deadline_id`; LLM emits descriptive kinds only, §2.2.1), `date`, `date_is_authoritative`, `description`, `deadline_id`.
- `defenses_checklist[]` — `defense_code` (`defective_rent_demand`, `wrong_amount_claimed`, `not_registered_multiple_dwelling`, `rent_overcharge`, `rent_regulation_violation`, …), `surfaced_as="information_not_advice"`, `relevance_signal` (per unified §5.5 semantics), `supporting_evidence_ids`, `explanation`, `attorney_reviewed`, `attorney_disposition` (attorney-only).
- `evidence[]` — open-data items (`registration_record`/`ownership_record`) with required `open_data` `OpenDataAssertion` (`dataset`, `dataset_version`, `data_accuracy_disclaimer`, `verify_before_file`).
- `eligibility.{rtc,legal_aid,rental_assistance}` — `EligibilityResult` (`program`, `determination`, `determined_by="deterministic"`, `rule_ids`, `reasons`, `data_source`, `config_toggle_state`), plus `eligibility.config_version` + `evaluated_at`. **ERAP/CityFHEPS/other → `rental_assistance` only; no sibling keys (§8).**
- `review.review_state = "escalated"` — DET escalation on imminent/missed default risk (§4.4) and overcharge/stabilization signal (§7.3). **The engine never writes `review.advice_routed` (§0, §0.1).**
- `reminders[]` — `answer_deadline`/`court_date` reminders, `related_deadline_id`, `scheduled_for` (DET, from version-stamped `reminder_offsets`), gated by `consent_id` (scope `sms_reminders`) and `contact.safe_to_text` (§4.5).
- `audit.events[]` — append-only, `actor.actor_type="deterministic_engine"`, `model=null`, no `route_advice` action.

---

*End of spec scaffold. No value in this document is legal advice or an authoritative legal computation. A NY-licensed attorney owns and must validate every rule value before production.*
