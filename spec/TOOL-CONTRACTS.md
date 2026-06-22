# Deterministic Tool Contracts (Housing Court Copilot, MVP: NYC Nonpayment)

# Deterministic Tool Contracts

**Product:** Housing Court Copilot — legal-aid intake autopilot, NYC nonpayment eviction defense (MVP).
**Scope of this doc:** the deterministic tools the LLM invokes via **tool use** and that the backend exposes as internal services. These tools keep every safety-critical and advice-line computation **out of the model**. The LLM *orchestrates and explains*; the *answers* come from this code.
**Schema authority:** all field names below are exact references to the canonical Case Object (`housing_court_copilot.case` v1, `schema_version = "1.0.0"`). Do not invent conflicting names. Where a tool computes a value that has **no canonical home**, this doc says so explicitly and documents the mapping — it never fabricates a Case Object field.
**Companion docs:** `INTEGRATIONS.md` (endpoints, tokens, caveats), `LLM-ARCHITECTURE.md` (LLM/DET boundary), `RISKS-AND-COMPLIANCE.md` (UPL, 22 NYCRR 130, SHIELD, TCPA), `LEGAL-RULES.md` (**the attorney-validated statutory rule tables and eligibility thresholds that `compute_nonpayment_deadlines` and `screen_eligibility` consume — see §6, §7**), `API-CONTRACTS.md` (state-machine transition guards and confirm-endpoint side-effects this doc cross-references).

---

## 0. Principles that bind every tool

These are non-negotiable and are enforced in code, not by convention.

1. **The LLM never computes a safety-critical value.** Deadlines, eligibility, form-field placement/validation, court-date sourcing, and the advice line are computed by these tools. The schema enforces this with five `const` invariants: `deadlines[].computed_by = "deterministic"`, `eligibility.*.determined_by = "deterministic"`, `answer_draft.form_fields[].placed_by = "deterministic"`, `answer_draft.factual_statements[].transcription_only = true`, `defenses_checklist[].surfaced_as = "information_not_advice"`. A payload that tries to set these otherwise **fails validation**. Tools that write these fields MUST set the const value themselves; they MUST reject any caller-supplied override.

2. **Open data is never authoritative and never auto-filed.** Every value derived from HPD / JustFix / GeoSearch / PLUTO is written to the Case Object wrapped in an `OpenDataAssertion` carrying `dataset`, `dataset_version`, `retrieved_at`, `endpoint`, a human-readable `data_accuracy_disclaimer`, and a `verify_before_file` gate (`VerifyGate`) that starts at `state = "unverified"`. The **tenant** is the filer and bears 22 NYCRR 130 risk. An open-data assertion may enter a packet only when its `verify_before_file.state = "verified"`; `assemble_packet` hard-blocks otherwise (`blocked_by_unverified_open_data = true`), scanning **both** `evidence[].open_data` and `parties.landlord.open_data` (see §9).

3. **No tool sets a legal conclusion or the advice line.** Lookup tools may set neutral fact signals (e.g. `parties.landlord.registration_on_file`) but never an `attorney_disposition`, never `defenses_checklist[].surfaced_as` to anything but `information_not_advice`, and never decide "the tenant has a case." **No deterministic tool ever writes `review.advice_routed`.** That field has exactly one documented meaning — *an advice-seeking conversational turn was hard-routed to a human* — and exactly one writer: the conversational advice-router (see `GUARDRAILS.md` §1.6), in response to the LLM advice-detection classifier logged in `review.advice_detection_log[]`. Tools in this doc that need to flag a case for human attention (e.g. an imminent/missed deadline, an overcharge signal) set `review.review_state = "escalated"` **only**; they MUST NOT touch `advice_routed`, so the UPL audit signal (`advice_routed` ↔ `advice_detection_log[]`) stays uncorrupted and `advice_routed` retains a single deterministic owner.

4. **Every tool call is audited.** Every invocation appends to `audit.events[]` with `actor` (`actor_type = "deterministic_engine"` for the tool, or `"system"`), `action`, `field_path` (JSON pointer of what changed), and `at`. Tools that consume LLM-extracted inputs record the upstream `provenance` so the LLM/DET boundary is reconstructable under subpoena/legal-hold.

5. **Inputs that drive a filing must already be tenant-confirmed.** Form placement and packet assembly consume only values whose `tenant_confirmed = true` (or `tenant_corrected_value` present). Tools reject unconfirmed inputs into safety-critical *filing* paths with `E_UNCONFIRMED_INPUT`. (Deadline computation has a softer rule — it never silently drops a clock; an unconfirmed anchor yields a *provisional* deadline flagged `risk.uncertain_anchor = true`; see §6.)

6. **Idempotency is mandatory.** Every mutating tool accepts an `idempotency_key` (caller-generated, recommended UUIDv4 or a content hash of the inputs). A repeat call with the same key and same inputs returns the prior result without re-executing side effects. Pure-read tools are naturally idempotent and additionally use response caching (see each tool's staleness section).

7. **Tool-use envelope (common to all).** Every tool, when exposed to the model, is a `strict: true` tool. Every tool's I/O is itself JSON-Schema-validated. The common envelope:

```jsonc
// Common request envelope (fields merged into each tool's "input" below)
{
  "case_id": "case_01j9z3k7m2n8p4q6r8s0t2v4w6",   // required on all case-scoped tools
  "idempotency_key": "f1c2...",                    // required on all mutating tools
  "actor": { "actor_type": "deterministic_engine", "actor_id": "tool:resolve_address@1.4.0" },
  "dry_run": false                                  // true = compute + validate, do not persist
}

// Common response envelope
{
  "ok": true,
  "tool": "resolve_address",
  "tool_version": "1.4.0",
  "idempotency_key": "f1c2...",
  "idempotent_replay": false,        // true if served from prior identical call
  "case_object_patch": [ /* RFC-6902 JSON Patch ops applied to the Case Object */ ],
  "warnings": [ { "code": "STALE_DATASET", "message": "..." } ],
  "result": { /* tool-specific typed payload, mirrored below */ }
}

// Common error response
{
  "ok": false,
  "tool": "resolve_address",
  "tool_version": "1.4.0",
  "error": { "code": "E_UPSTREAM_TIMEOUT", "message": "...", "retryable": true, "retry_after_ms": 2000 }
}
```

**Persistence model:** mutating tools return an RFC-6902 `case_object_patch`. The backend applies it transactionally and re-validates the full Case Object against `case.v1.json` before commit. If post-patch validation fails, the patch is rejected (`E_SCHEMA_VIOLATION`) and nothing is written. Because the canonical `Eligibility` object is `additionalProperties: false`, a patch that introduces an undefined eligibility key (e.g. a top-level `erap`) is rejected here — see §7.

8. **Standard error codes (all tools).** `E_BAD_INPUT` (failed input schema), `E_UNCONFIRMED_INPUT`, `E_SCHEMA_VIOLATION` (post-patch), `E_UPSTREAM_TIMEOUT`, `E_UPSTREAM_5XX`, `E_RATE_LIMITED` (HTTP 429 from an upstream; carries `retry_after_ms`), `E_NOT_FOUND`, `E_CONSENT_REQUIRED`, `E_BOUNDARY_VIOLATION` (caller attempted to set a `const`-guarded field, or any tool attempted to write `review.advice_routed`), `E_CONFIG_MISSING` (rule/config version not loadable), `E_IDEMPOTENCY_CONFLICT` (same key, different inputs).

9. **Rate-limit & resiliency posture (all upstreams).** Server-side calls only (never from the PWA client). Per-upstream token-bucket limiter + circuit breaker + exponential backoff with jitter. Responses cached in a `open_data_cache` keyed by `(dataset, query_hash)` with a TTL and a stored `dataset_version`. On upstream outage, tools serve the last cached value **and** raise warning `SERVED_FROM_CACHE` with the stale `retrieved_at` — they never silently invent a value.

---

## Tool index

| Tool | Kind | Writes (Case Object) | Safety class | Gate |
|---|---|---|---|---|
| `resolve_address` | read+derive | `property.bbl`, `property.bbl_resolved_via`, `property.geo_confidence` | open-data join key | none (BBL is DET-resolved; downstream open data is gated) |
| `lookup_hpd_violations` | read | `evidence[]` (open_data), repair-defense signals | open-data | `verify_before_file` |
| `lookup_hpd_complaints` | read | `evidence[]` (open_data) | open-data | `verify_before_file` |
| `lookup_hpd_registration` | read | `parties.landlord.registered_owner_name/registration_on_file`, `parties.landlord.open_data`, `evidence[]`, registration-defense signal | open-data | `verify_before_file` |
| `lookup_who_owns_what` | read | `parties.landlord.wow_landlord_id/registered_owner_name`, `evidence[]` | open-data | `verify_before_file` |
| `compute_nonpayment_deadlines` | **SAFETY-CRITICAL** compute | `deadlines[]`, `timeline[]` (authoritative entries) | deadline/statutory clock | `tenant_confirmed` + `attorney_validated` |
| `screen_eligibility` | compute | `eligibility.{rtc,legal_aid,rental_assistance}`, `eligibility.{config_version,evaluated_at}` | eligibility determination | config-driven, attorney-validated |
| `source_court_date` | read+derive | `court.court_date`, `court.court_date_source`, `court.court_date_verified`, `court.part` | court-date sourcing | DET-verified only via eTrack/NYSCEF |
| `assemble_packet` | assemble | `packets.{court_packet,legal_aid_handoff}`, `answer_draft.form_fields[]` | form placement/validation | `blocked_by_unverified_open_data = false` + required fields `valid` + referenced deadlines `attorney_validated` |

> Not specified here but adjacent: `send_reminder` (scheduling lives in the reminder service; `reminders[].scheduled_for` is DET relative to an authoritative `court.court_date`/`deadlines[].due_date`, gated on a `consent_id` with `scope = "sms_reminders"`). It is referenced where relevant. **The reminder offset cadence (e.g. multi-day pre-court-date sends) is owned by a version-stamped reminder config in `LEGAL-RULES.md`/`API-CONTRACTS.md`, not by this doc** — see the gaps note in §10.

---

## 1. `resolve_address`

**Purpose.** Resolve a free-text premises address (LLM-extracted from the petition, then tenant-confirmed) to a canonical 10-digit **BBL** using **NYC GeoSearch** (`geosearch.planninglabs.nyc`, keyless) joined to **PLUTO/PAD**. The BBL is the join key for every HPD/JustFix lookup. This is the corrected resolver — **do NOT use the legacy Geoclient API** (deprecated; registration retired; not interchangeable).

**Typed input.**

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "address": {                       // PostalAddress; from property.address (LLM) or tenant-entered
    "line1": "123 Main St", "line2": null, "city": "Bronx",
    "state": "NY", "postal_code": "10451"
  },
  "apartment_unit": "4B",            // optional; from property.apartment_unit
  "address_tenant_confirmed": true   // must be true to persist into property.bbl
}
```

**Typed output (`result`) + Case Object writes.**

```jsonc
{
  "bbl": "2023450001",                 // -> property.bbl  (pattern ^[1-5]\d{9}$)
  "bbl_resolved_via": "geosearch_pluto", // -> property.bbl_resolved_via  (geosearch_pluto|geosearch_pad|manual)
  "geo_confidence": "exact",             // -> property.geo_confidence  (exact|approximate|failed)
  "bin": "2001234",                      // returned for downstream DOB joins; NO canonical v1 field (see note)
  "normalized_address": { /* PostalAddress, GeoSearch-canonicalized */ },  // NO canonical field; display/cache only
  "candidates": [ { "label": "...", "bbl": "...", "score": 0.98 } ]  // NO canonical field; returned to API for disambiguation
}
```

`property.bbl` is `x-provenance: deterministic` — set only by this tool. `property.address` and `property.apartment_unit` remain LLM-provenance/tenant-confirmed and are NOT overwritten by GeoSearch normalization (we store the normalized form in cache for display, but the tenant-confirmed address is authoritative on the Case Object).

**Outputs with no canonical Case Object home (documented mapping).** `bin`, `normalized_address`, and `candidates` are **not** persisted to the Case Object (the canonical `Property` $def has no `bin`, no normalized-address, no candidates field). They live in the tool/`open_data_cache` and are returned in the tool `result` so the API layer can surface them transiently:
- `candidates` is consumed by the API `resolve_bbl` job and returned to the PWA to drive the **tenant disambiguation step** required when `geo_confidence != "exact"` (see error mode `AMBIGUOUS_MATCH`). It is a transient API/UX payload, never Case Object state. (This closes the cross-ref gap where the disambiguation UX had no wired-through home.)
- `bin` is cached for potential future DOB joins; it is out of MVP scope and persisted nowhere.

**Error modes.** `E_BAD_INPUT` (no `line1`/`city`); `E_UNCONFIRMED_INPUT` (`address_tenant_confirmed != true`); `E_NOT_FOUND` → write `geo_confidence = "failed"`, `bbl = null`, surface `candidates` for tenant disambiguation; `E_UPSTREAM_TIMEOUT`/`E_UPSTREAM_5XX` (GeoSearch down → serve cache or fail; never guess a BBL); `AMBIGUOUS_MATCH` warning when top candidate score below a configurable threshold → set `geo_confidence = "approximate"`, return `candidates`, and require tenant pick (via the API disambiguation step) before any downstream open-data lookup runs.

**Idempotency.** Pure function of `(address, apartment_unit)`; same inputs → same BBL. Cache keyed by normalized address hash, TTL 30 days (PLUTO refreshes quarterly). `idempotency_key` collapses retries.

**Verify-before-file gate.** BBL itself is deterministic and not a filing assertion, so it carries no `verify_before_file` gate. **But** every dataset that *uses* this BBL (HPD/JustFix) produces gated `OpenDataAssertion`s. If `geo_confidence != "exact"`, downstream lookup tools MUST surface `geo_confidence` in their `data_accuracy_disclaimer` ("address match was approximate; building records may be for the wrong parcel").

**Rate limits / token.** GeoSearch is open and keyless (no app token) — this is a deliberate reason to pin to it. Apply a self-imposed limiter (e.g. 10 req/s) to be a good citizen; cache aggressively.

---

## 2. `lookup_hpd_violations`

**Purpose.** Pull per-building HPD code violations (open/closed, hazard class) from **Socrata `wvxf-dwi5`** keyed by BBL, to build a **repair-defense / warranty-of-habitability** evidence timeline. Class `C` = immediately hazardous.

**Typed input.**

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "bbl": "2023450001",               // from property.bbl (must be resolved first)
  "filters": {
    "status": "open",                // open|closed|all  -> SODA CurrentStatus filter
    "hazard_class": ["B", "C"],      // optional; A|B|C
    "since_date": "2024-01-01"       // optional; limit timeline window
  }
}
```

**Typed output + Case Object writes.** Each returned violation becomes an `EvidenceItem` with `origin = "open_data"`, `evidence_type = "hpd_violation"`, LLM-independent `tags` left empty (the LLM tags later — see Surface 7 of `LLM-SCHEMAS.md`), and a **required** `open_data` block:

```jsonc
{
  "violations": [
    {
      "evidence_id": "ev_...",                 // SYS-minted
      "evidence_type": "hpd_violation",
      "origin": "open_data",
      "summary": null,                          // LLM fills later (evidence tagging); tool leaves null
      "supports_defense_codes": ["warranty_of_habitability", "repairs_needed"], // neutral fact-derived mapping, attorney-reviewed
      "open_data": {
        "dataset": "hpd_violations_wvxf-dwi5",
        "dataset_version": "2026-06-21T03:00:00Z",   // ingest snapshot
        "retrieved_at": "2026-06-22T14:05:00Z",
        "endpoint": "https://data.cityofnewyork.us/resource/wvxf-dwi5.json?$where=bbl='2023450001'",
        "data_accuracy_disclaimer": "HPD open data lags real-world status and includes closed-but-not-updated records. Verify each violation before relying on it in court.",
        "verify_before_file": { "state": "unverified", "verified_at": null, "verified_by": null, "tenant_note": null }
      }
    }
  ],
  "counts": { "open": 7, "class_c_open": 2, "total": 31 }
}
```

**Critical caveat handling.** Per `INTEGRATIONS.md`, `wvxf-dwi5` has known lag, mismatched BBLs, and "closed-but-not-updated" records. An auto-built timeline asserted as evidence can be wrong and harm a pro se filer. Therefore: (a) `data_accuracy_disclaimer` is always populated and tenant-visible; (b) `verify_before_file.state` starts `"unverified"`; (c) `supports_defense_codes` is information-not-advice and is mirrored into `defenses_checklist[]` only as a neutral signal for attorney review — never an assertion the defense applies.

**Relevance-signal convention (consistent across all open-data lookup tools — §2, §3, §4, §5).** When an open-data lookup mirrors a `defenses_checklist[]` entry, it sets `relevance_signal` deterministically by the **canonical** rule below, so sibling tools never disagree:
- `relevance_signal = "evidence_present"` — when the open data returns one or more concrete records that *could* support the defense (e.g. ≥1 open HPD violation → `warranty_of_habitability`/`repairs_needed`).
- `relevance_signal = "possible"` — when the *absence* or *status* of a record is itself the signal and there is no affirmative record to show (e.g. a missing/expired HPD registration → `not_registered_multiple_dwelling`).
- `relevance_signal = "not_indicated"` — when the data affirmatively shows nothing relevant.
In all cases `surfaced_as = "information_not_advice"`, `attorney_reviewed = false`, and `attorney_disposition` is left `null` (attorney-only).

For this tool: ≥1 returned violation → mirror `defense_code ∈ {warranty_of_habitability, repairs_needed}` with `relevance_signal = "evidence_present"`.

**Error modes.** `E_BAD_INPUT` (BBL absent/malformed — caller must run `resolve_address` first); `E_RATE_LIMITED` (HTTP 429 → backoff with `retry_after_ms`; see token below); `E_UPSTREAM_5XX`; `E_NOT_FOUND` → `counts` all zero, no evidence written (a building with zero violations is a valid, meaningful result, not an error).

**Idempotency.** Read-only; idempotent. Re-running replaces the prior open-data `EvidenceItem` set for this dataset+BBL **only if** none of them has `verify_before_file.state = "verified"`; verified items are preserved and the tool emits warning `VERIFIED_ITEMS_PRESERVED` so a stale refresh never silently discards a tenant's verification.

**Staleness.** Cache TTL configurable (default 24h). Response always carries `dataset_version` (the Socrata `:updated_at` / last ingest). If served from cache during an upstream outage → warning `SERVED_FROM_CACHE`.

**Rate limits / Socrata app token.** **Register one free Socrata app token; send it as the `X-App-Token` header** to lift the anonymous limit to ~1000 req/hr and avoid HTTP 429. Dataset IDs are **config, not constants** (HPD sunset legacy complaint datasets `uwyv-629c`/`a2nx-4u46` ~Jan 31 2024) — `wvxf-dwi5` is read from `open_data_config.datasets.hpd_violations`.

---

## 3. `lookup_hpd_complaints`

**Purpose.** Pull tenant-reported conditions/complaints from **Socrata `ygpa-z7cr`** keyed by BBL. Complaint dates cross-referenced against violation dates suggest the landlord had **notice** of conditions — a repair/habitability signal. (Use `ygpa-z7cr`; the legacy `uwyv-629c`/`a2nx-4u46` were sunset.)

**Typed input.**

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "bbl": "2023450001",
  "filters": { "since_date": "2024-01-01", "apartment_unit": "4B" }  // unit optional; HPD complaints are often building-level
}
```

**Typed output + Case Object writes.** Each complaint → `EvidenceItem` with `origin = "open_data"`, `evidence_type = "hpd_complaint"`, required `open_data` block (same shape as §2, `dataset = "hpd_complaints_ygpa-z7cr"`, disclaimer worded for complaint data). If the tool mirrors a `defenses_checklist[]` entry it uses the §2 relevance-signal convention (≥1 complaint corroborating a condition → `evidence_present`). Output also returns a `notice_timeline` (complaint dates) that the LLM may render in the plain-English `timeline[]` as **descriptive, non-authoritative** events: each such `TimelineEvent` MUST have `date_is_authoritative = false` and a descriptive `kind` (never a deadline-typed `kind` such as `answer_due`/`judgment` — those are reserved for DET-created events, see §6.3).

```jsonc
{
  "complaints": [ { "evidence_id": "ev_...", "evidence_type": "hpd_complaint", "origin": "open_data", "open_data": { /* gated */ } } ],
  "notice_timeline": [ { "date": "2025-11-03", "condition": "HEAT/HOT WATER", "status": "CLOSE", "date_is_authoritative": false } ],
  "counts": { "total": 12, "open": 1 }
}
```

**Error modes / idempotency / staleness / token.** Identical posture to `lookup_hpd_violations` (§2): `X-App-Token`, ~1000 req/hr, dataset ID from config, verified-item preservation, `SERVED_FROM_CACHE` on outage, `verify_before_file = "unverified"` on every item.

---

## 4. `lookup_hpd_registration`

**Purpose.** Determine the registered owner/agent and produce the **registration-defense signal**: no current/valid HPD registration generally **bars a nonpayment proceeding**. Two-step Socrata join: BBL → `tesw-yqqr` to get `RegistrationID` → filter `feu5-w2e2` by that ID for HeadOfficer / IndividualOwner / CorporateOwner / Agent names + business addresses.

**Typed input.**

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "bbl": "2023450001"
}
```

**Typed output + Case Object writes.**

```jsonc
{
  "registration_id": "300123",
  "registration_on_file": true,          // -> parties.landlord.registration_on_file (open_data provenance)
  "registration_current": false,         // tool-computed; NO canonical field — see mapping note
  "registered_owner_name": "123 MAIN LLC",  // -> parties.landlord.registered_owner_name (open_data)
  "contacts": [ { "role": "HeadOfficer", "name": "...", "business_address": { /* PostalAddress */ } } ],  // not persisted; informs handoff narrative only
  "registration_defense_signal": "possible",   // possible | not_indicated  -- NEUTRAL fact signal, not advice
  "open_data": {                                // attached to parties.landlord.open_data AND the evidence item's open_data
    "dataset": "hpd_registration_tesw-yqqr",
    "dataset_version": "2026-06-21T03:00:00Z",
    "retrieved_at": "2026-06-22T14:05:00Z",
    "endpoint": "https://data.cityofnewyork.us/resource/tesw-yqqr.json?$where=bbl='2023450001'",
    "data_accuracy_disclaimer": "HPD registration data may be outdated. A missing or expired registration here is information to verify with HPD, not a legal conclusion. Confirm before raising in court.",
    "verify_before_file": { "state": "unverified" }
  }
}
```

**`registration_current` has no canonical field — documented mapping (closes the lost-signal gap).** The canonical `LandlordParty` exposes only `registration_on_file` (boolean) and `registration_on_file` does not distinguish "no registration at all" from "registration on file but expired/lapsed." To avoid silently collapsing an expired registration into `registration_on_file = true` and losing the registration-defense signal, the tool maps as follows:
- `registration_on_file` is set to **`true` only when a registration record exists AND is current** (i.e. `registration_id` found **and** `registration_current = true`). A found-but-expired/lapsed registration sets `registration_on_file = false`, because for the registration-defense signal the legally relevant fact is the absence of a *current/valid* registration. The raw `registration_current` boolean and `registration_id` are retained in the `open_data_cache` and surfaced in the handoff/intake narrative (LLM, information-only) so an attorney can see "registration exists but lapsed on <date>."
- The `data_accuracy_disclaimer` text states whether the situation is "no registration found" vs. "registration found but appears expired/lapsed," so the human reviewer sees the distinction even though the canonical boolean cannot encode it.
- This mapping is the single source of truth for both this tool and `LEGAL-RULES.md` §6.2 (which reads `registration_on_file`); the legal-rules predicate therefore treats `registration_on_file = false` as covering both the "missing" and "expired" cases. (A canonical `registration_status` enum is a recommended v1.1 schema addition; until then this mapping is authoritative.)

**Writes.** `parties.landlord.registered_owner_name`, `parties.landlord.registration_on_file` (both `x-provenance: open_data`), `parties.landlord.open_data` (the `OpenDataAssertion`), and an `EvidenceItem` with `evidence_type = "registration_record"`, `origin = "open_data"` carrying its own `open_data` block. When `registration_on_file = false` (per the mapping above, i.e. missing **or** expired), the tool mirrors a `defenses_checklist[]` entry `defense_code = "not_registered_multiple_dwelling"`, `surfaced_as = "information_not_advice"`, `relevance_signal = "possible"` (per the §2 convention: absence/status is the signal, no affirmative record to show), `attorney_reviewed = false`. **The tool never sets `attorney_disposition`** — whether the defense actually applies is the advice line, attorney-owned.

**Error modes.** `E_BAD_INPUT` (no BBL); `E_NOT_FOUND` on the `tesw-yqqr` step → `registration_on_file = false`, `registration_defense_signal = "possible"` (absence is itself the signal, gated for verification); `E_NOT_FOUND` on the `feu5-w2e2` step but registration found → keep the registration result, empty `contacts`, warning `CONTACTS_MISSING`; standard upstream/rate-limit errors.

**Idempotency / staleness / token.** Read-only and idempotent; verified items preserved on refresh; `X-App-Token`, ~1000 req/hr, both dataset IDs from config (`hpd_registration_tesw-yqqr`, `hpd_contacts_feu5-w2e2`); cache TTL default 24h with stored `dataset_version`.

**Verify-before-file gate.** The registration-defense signal is exactly the kind of stale-data assertion that can sanction a pro se filer under 22 NYCRR 130. It enters NO packet until `parties.landlord.open_data.verify_before_file.state = "verified"`; `assemble_packet` enforces this by scanning `parties.landlord.open_data` (not only `included_evidence_ids`) — see §9.

---

## 5. `lookup_who_owns_what`

**Purpose.** Identify the landlord's portfolio, shell-LLC/owner names, and standing signals via the **JustFix Who Owns What API** (`api.justfix.org`), with **NYCDB self-host** as the durable fallback. This deepens `lookup_hpd_registration` (owner-of-record vs. true portfolio owner → standing / shell-LLC mismatch).

**Verified endpoints (per `INTEGRATIONS.md`, reviewer-verified 2026-06-22).** Use exactly: `/api/address`, `/api/address/wowza`, `/api/address/buildinginfo`, `/api/address/indicatorhistory`. Freshness probe: `/api/dataset/tracker` (confirmed live + unauthenticated). **Do NOT call `/api/address/aggregate`** (stale/invented; removed — use the full path `/api/address/aggregate` consistently in any allow/deny rule so it is unambiguous). Honesty caveat carried into config: only `/api/dataset/tracker` is independently confirmed live/unauthenticated; the building-info/portfolio endpoints were not independently re-confirmed — treat them as provisional and keep the NYCDB fallback ready.

**Typed input.**

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "bbl": "2023450001",
  "want": ["portfolio", "buildinginfo", "indicatorhistory"],  // selects which endpoints to call
  "source_preference": "justfix"   // justfix | nycdb_selfhost | auto (auto = justfix, fall back to nycdb on outage/auth-change)
}
```

**Typed output + Case Object writes.**

```jsonc
{
  "wow_landlord_id": "wow_landlord_88231",  // -> parties.landlord.wow_landlord_id (open_data)
  "registered_owner_name": "JANE DOE (via 123 MAIN LLC)",  // may corroborate parties.landlord.registered_owner_name
  "portfolio": { "building_count": 14, "related_bbls": ["..."], "owner_names": ["..."], "business_addresses": ["..."] },
  "indicator_history": { "hpd_violations_trend": [...], "evictions_filed": [...] },
  "source_used": "justfix",                  // justfix | nycdb_selfhost
  "dataset_tracker": { "wow_data_last_updated": "2026-06-10" },  // from /api/dataset/tracker
  "open_data": {
    "dataset": "justfix_wow",                // or "nycdb_selfhost" when fallback used
    "dataset_version": "2026-06-10",
    "retrieved_at": "2026-06-22T14:05:00Z",
    "endpoint": "/api/address/wowza",
    "data_accuracy_disclaimer": "Ownership/portfolio data from a third-party aggregator. Treat shell-company and standing inferences as leads to verify, not legal conclusions.",
    "verify_before_file": { "state": "unverified" }
  }
}
```

Writes `parties.landlord.wow_landlord_id`, optionally corroborates `parties.landlord.registered_owner_name`, and adds an `EvidenceItem` (`evidence_type = "ownership_record"`, `origin = "open_data"`). Standing/shell-LLC observations are surfaced as information only; they never set `no_landlord_tenant_relationship` as an asserted defense. If a defense entry is mirrored, it uses the §2 relevance-signal convention.

**Error modes.** `E_NOT_FOUND` (BBL not in WoW); `E_UPSTREAM_AUTH_CHANGED` (JustFix added auth/limits without notice — circuit-break to NYCDB fallback, warning `FELL_BACK_TO_NYCDB`); standard timeout/5xx/rate-limit.

**NYCDB fallback & licensing guard.** When `source_used = "nycdb_selfhost"`, `dataset` becomes `"nycdb_selfhost"`. **Licensing invariant:** prebuilt NYCDB dumps are CC BY-NC-SA (non-commercial); commercial deployment MUST load NYCDB from original NYC open-data sources, not the prebuilt dumps. The tool records `nycdb_source = "original_open_data" | "prebuilt_dump"` in the cache and refuses `prebuilt_dump` when `deployment_mode = "commercial"` in config (`E_LICENSE_FORBIDDEN`).

**Idempotency / staleness.** Read-only/idempotent; verified items preserved on refresh; freshness via `/api/dataset/tracker` (poll, store as `dataset_version`); cache TTL default 7 days (WoW updates less often). **No commercial reliance without contacting `support@justfix.org` first** — gated by a config flag `justfix_commercial_clearance: true|false`; tool refuses live JustFix calls in commercial mode until cleared (`E_CLEARANCE_REQUIRED`), forcing NYCDB-from-open-data.

**Verify-before-file gate.** Same as all open-data tools: `verify_before_file.state = "unverified"` until the tenant verifies; never auto-asserted into a filing.

---

## 6. `compute_nonpayment_deadlines`  — **SAFETY-CRITICAL**

**Purpose.** Compute the statutory clocks for a NYC nonpayment case and write `deadlines[]` with `computed_by = "deterministic"`. **A wrong deadline = malpractice-style liability and can directly cause a default** (`RISKS-AND-COMPLIANCE.md` #6). The LLM may EXTRACT the underlying dates and EXPLAIN the result, but it **never computes a deadline as authoritative** — that is this tool's sole job, and the legal rules it applies live in **`LEGAL-RULES.md`** and **must be attorney-validated and version-pinned**.

### 6.1 Inputs — only tenant-confirmed dates

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "case_type": "nonpayment",                   // from case.case_type; tool rejects non-"nonpayment" in MVP
  "anchors": {
    // Each anchor is a {value: Date, tenant_confirmed: bool, source: ...} pulled from documents[].extracted_fields
    "rent_demand_date":    { "value": "2026-05-01", "tenant_confirmed": true,  "source": "document_extracted" },
    "petition_filed_date": { "value": "2026-05-20", "tenant_confirmed": true,  "source": "document_extracted" },
    "service_date":        { "value": "2026-05-22", "tenant_confirmed": false, "source": "document_extracted" },
    "court_date":          { "value": "2026-06-30", "tenant_confirmed": true,  "source": "etrack" }
  },
  "rule_set_version": "nonpayment-rpapl-2026.2"   // pin; resolved against LEGAL-RULES.md ruleset registry
}
```

- **Hard precondition:** every anchor used to compute a `due_date` SHOULD have `tenant_confirmed = true`. An anchor that is `false` does NOT block computation, but the resulting deadline is marked provisional: `risk.uncertain_anchor = true` and `computation_basis.anchor_date` records it. If a *required* anchor for a given `deadline_type` is missing entirely → that deadline is emitted with `risk.uncertain_anchor = true` and an explanatory `explanation`, never silently dropped.
- The tool reads the actual `value` / `tenant_corrected_value` from `documents[].extracted_fields.*` and `court.court_date`; the input above is the resolved view.

### 6.2 Computation — deterministic only

- Rules come from `LEGAL-RULES.md` via the versioned ruleset identified by `rule_set_version`. **This spec does NOT hardcode day-counts** — the statutory windows (answer window, first-appearance timing, OSC-to-vacate-default timing, any hardship/warrant-stay clocks) are attorney-authored data in `LEGAL-RULES.md`, keyed by `statute_rule_id` + `rule_version`. The engine applies them; it does not embed them.
- **Calendar correctness is part of safety:** all dates are computed on the **court-local (America/New_York)** calendar (Case Object `*_date` fields are bare `YYYY-MM-DD`, court-local). For any rule whose `unit = "court_days"` the engine applies weekend roll-forward **and** the court-holiday calendar (`calendars/court_holidays.yaml`, version-stamped, owned and maintained by the deterministic-rules team alongside `LEGAL-RULES.md`); a `business_day` definition and a **conservative buffer** are taken from the ruleset (never extends a deadline past the statutory date; only warns earlier). **The court-holiday calendar is a required input — see the §10 build-blocker note.**
- The engine refuses to run if `rule_set_version` or its referenced court-holiday calendar is not loadable (`E_CONFIG_MISSING`) — it never falls back to an unversioned or hardcoded rule.

### 6.3 Output — `deadlines[]` + authoritative timeline entries

```jsonc
{
  "deadlines": [
    {
      "deadline_id": "dl_...",
      "deadline_type": "answer_due",            // DeadlineType enum
      "due_date": "2026-06-29",                 // DET-computed, court-local
      "computed_by": "deterministic",            // HARD CONST — tool sets it; rejects any other value
      "computation_basis": {
        "anchor_event": "petition_served",
        "anchor_date": "2026-05-22",
        "statute_rule_id": "nonpayment_answer_window",  // CANONICAL id; matches LEGAL-RULES.md §3.5 registry
        "rule_version": "nonpayment-rpapl-2026.2"
      },
      "tenant_confirmed": false,                  // becomes true only on human confirmation
      "attorney_validated": false,                // becomes true only on attorney sign-off of the logic
      "risk": {
        "is_imminent": true,                      // within configurable urgency window
        "is_missed": false,
        "default_risk": true,                     // missing answer_due can cause default
        "uncertain_anchor": true                  // service_date was not tenant_confirmed
      },
      "explanation": "Your answer may be due about this date. This is an estimate the app computed; confirm it with the court — missing it can lead to a default."  // LLM may author this string; it is NOT the computation
    }
  ],
  "timeline_events": [
    { "event_id": "evt_...", "kind": "answer_due", "date": "2026-06-29", "date_is_authoritative": true, "deadline_id": "dl_..." }
  ]
}
```

**Authoritative timeline events are DET-only.** Each computed deadline emits a `TimelineEvent` with `date_is_authoritative = true` and a `deadline_id` FK. **Deadline-typed `kind` values (`answer_due`, `judgment`) are written ONLY here, by this tool, with `date_is_authoritative = true`.** The LLM timeline path is restricted to descriptive, non-statutory `kind`s (e.g. `rent_demand_served`, `petition_filed`, `petition_served`, `court_appearance`, `adjournment`, `other`) with `date_is_authoritative = false`, so an LLM-extracted date can never be displayed or treated as a statutory-clock anchor next to the real DET answer-due event. (This enforcement is mirrored in `LLM-SCHEMAS.md` Surface 4, which bars the LLM from emitting `answer_due`/`judgment`.)

### 6.4 Gates — two-stage human confirmation

This is the only tool with a **double gate**:

1. `deadlines[].tenant_confirmed` — human (tenant) confirmation that the underlying facts/dates are right; the UI shows the explicit "confirm your court date with the court" prompt.
2. `deadlines[].attorney_validated` — the supervising attorney (engaged from Phase 0) validates the *logic* (the ruleset version applied to this fact pattern).

A deadline drives a `reminders[]` send, appears as authoritative in any packet/handoff, **and may be referenced by a court packet at assembly** only when BOTH are true (see §9 validation gate — this is the attorney-validation check `API-CONTRACTS.md` §3.9 requires and that `assemble_packet` now enforces). Until then it is shown as provisional/estimated. The `explanation` field is the only LLM-authored content on a deadline; the model is forbidden from writing `due_date`, `computed_by`, or `computation_basis`.

**Escalation, not advice-routing.** If the engine computes `risk.is_missed = true` or `risk.default_risk = true` on an imminent clock, it sets `review.review_state = "escalated"` so a human picks the case up. It **does NOT** set `review.advice_routed` (a missed-deadline event is not an advice-seeking conversational turn; see §0.3). This keeps the UPL audit signal clean and `advice_routed` single-owner.

### 6.5 "Satisfied" predicate — how `is_missed`/`default_risk` clear

`risk.is_missed` and `risk.default_risk` are DET-computed: `is_missed = (due_date < court-local today) AND NOT satisfied`. Because there is **no e-filing rail** (pro se tenants are statutorily exempt) and no canonical "answer filed" boolean, the engine resolves `satisfied` from the following ordered signals, all of which are existing canonical state — it does **not** invent a filed-marker field:
1. A **court-sourced docket event** indicating the answer/appearance was recorded — surfaced as a `timeline[]` entry with `kind ∈ {answer_due, court_appearance}` and `date_is_authoritative = true` whose `deadline_id` FK points at this deadline (these come only from `source_court_date` / NYSCEF ingest, never the LLM); **OR**
2. The packet path reaching delivery: `answer_draft.status = "finalized"` **AND** the `court_packet` for this case at `packets.court_packet.status = "delivered"` (the closest in-product proxy that the answer was assembled and handed off), **OR** an attorney marking the review `reviewed` with a recorded note that the answer was filed.

When none of these hold and `due_date` is past, `is_missed`/`default_risk` stay `true` and the case stays escalated. **Caveat for engineering (build dependency):** signal (1) requires the NYSCEF/eTrack docket-event ingest contract (undefined today — see §10); until that exists, `satisfied` can only be cleared via signal (2) or an explicit attorney action. This is documented so the engine's "how does default-risk ever clear?" path is not left undefined.

### 6.6 Error modes

`E_BAD_INPUT` (case_type not `"nonpayment"`); `E_UNCONFIRMED_INPUT` is **not** thrown for missing tenant-confirmation (instead → `risk.uncertain_anchor = true`, provisional) but IS thrown if a caller tries to mark a deadline `attorney_validated` without an attorney actor; `E_CONFIG_MISSING` (unknown/unloadable `rule_set_version` or missing court-holiday calendar); `E_BOUNDARY_VIOLATION` (caller attempted to supply `computed_by`, a `due_date` override, to set `computed_by != "deterministic"`, or to write `review.advice_routed`).

### 6.7 Idempotency

Pure function of `(anchors, rule_set_version, court_holiday_calendar_version)`. Recomputation on the same inputs is a no-op replay. **Recomputation on changed inputs** (e.g. tenant corrects `service_date`) produces a *new* deterministic result and **resets `tenant_confirmed` and `attorney_validated` to false** for any affected deadline, appends the change to `audit.events[]`, and (via the reminder service) cancels reminders bound to the stale `deadline_id`. No silent in-place mutation of a confirmed deadline.

---

## 7. `screen_eligibility`

**Purpose.** Deterministic, **config-driven** eligibility determinations for **Right to Counsel (RTC)**, legal-aid/provider intake, and rental assistance. Writes `eligibility.{rtc,legal_aid,rental_assistance}` plus `eligibility.{config_version,evaluated_at}`, each `EligibilityResult` with `determined_by = "deterministic"`. Eligibility is **never** an LLM conclusion.

**Canonical Eligibility object — no extra keys.** The canonical `Eligibility` $def is `additionalProperties: false` and defines exactly `rtc`, `legal_aid`, `rental_assistance`, `config_version`, `evaluated_at`. **There is no `eligibility.erap` field.** ERAP (closed) and CityFHEPS (in litigation) are *programs of rental assistance*, so they are surfaced **inside `eligibility.rental_assistance`** as an `EligibilityResult` whose `program` field names the program. The tool MUST NOT emit a sibling `erap` key — a patch that does is rejected by post-patch validation (`E_SCHEMA_VIOLATION`, see §0.7). This aligns the tool contract with `API-CONTRACTS.md` §3.12 and `LEGAL-RULES.md` §8.

**Config & legal-rules dependency.** RTC is `<= 200% FPL` citywide (a **monitored, versioned** config — geography/income coverage changes), ERAP is **CLOSED**, CityFHEPS is in **active litigation** (toggleable). All thresholds/toggles/FPL multipliers live in config + `LEGAL-RULES.md` ruleset, captured as `eligibility.config_version`. Optionally calls the **NYC Benefits Screening API** (`data_source = "nyc_benefits_screening_api"`, **eligibility only — no submission**) or the self-hosted rules fork (`internal_rules`). **The NYC Benefits Screening API request/response field map, auth, and fallback payload are undefined today — see the §10 build-blocker note.**

**Typed input.** Data-minimized; income/household are opt-in `sensitive.*` fields gated by consent.

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "household_income_cents": 3600000,    // from sensitive.household_income_cents (opt-in)
  "household_size": 3,                   // from sensitive.household_size (opt-in)
  "borough": "bronx",                    // from court.borough ONLY (Borough enum, lowercase). property has no borough field.
  "zip": "10451",                        // from contact.mailing_address / property.address postal_code
  "programs": ["rtc", "legal_aid", "one_shot_deal", "cityfheps"],  // erap is always surfaced under rental_assistance as program_unavailable
  "data_source_preference": "internal_rules",  // internal_rules | nyc_benefits_screening_api
  "config_version": "elig-2026.06"       // pinned ruleset; -> eligibility.config_version
}
```

> **Sourcing note (corrected):** `borough` is read from `court.borough` (the canonical Borough enum, lowercase snake_case) — **not** from `property` (which has no borough field). The court county (mixed-case, `Court.county`) is a separate field and is not the eligibility input.

**Typed output + Case Object writes.** RTC and legal-aid each map to one `EligibilityResult`; **all rental-assistance programs (CityFHEPS, One-Shot Deal, and the closed ERAP) are represented within the single `eligibility.rental_assistance` slot.** Because the canonical `rental_assistance` is one `EligibilityResult`, the tool selects the **primary applicable rental-assistance program** for that slot and records the others as structured `reasons` codes on it (and in the handoff intake summary as information). ERAP, being closed, is reflected as `program_unavailable`:

```jsonc
{
  "rtc": {
    "program": "rtc",
    "determination": "eligible",          // eligible|ineligible|likely_eligible|insufficient_data|program_unavailable
    "determined_by": "deterministic",      // HARD CONST
    "rule_ids": ["rtc_income_200fpl_2026", "rtc_geo_citywide_2026"],
    "reasons": ["income_at_or_below_200_fpl", "geography_covered"],  // structured reason codes, NOT advice
    "data_source": "internal_rules",
    "config_toggle_state": null
  },
  "legal_aid": {
    "program": "legal_aid",
    "determination": "likely_eligible",
    "determined_by": "deterministic",
    "rule_ids": ["legal_aid_intake_2026"],
    "reasons": ["income_within_provider_band"],
    "data_source": "internal_rules"
  },
  "rental_assistance": {
    "program": "cityfheps",                // primary applicable rental-assistance program for the slot
    "determination": "program_unavailable",
    "determined_by": "deterministic",
    "config_toggle_state": "disabled",     // CityFHEPS toggled off pending litigation
    "rule_ids": ["cityfheps_toggle_2026", "erap_closed_2026", "one_shot_deal_2026"],
    "reasons": [
      "cityfheps_toggled_off_pending_litigation",
      "erap_program_closed",                // ERAP surfaced HERE, inside rental_assistance — never as a sibling key
      "one_shot_deal_insufficient_data"
    ]
  },
  "config_version": "elig-2026.06",       // -> eligibility.config_version
  "evaluated_at": "2026-06-22T14:05:00Z"  // -> eligibility.evaluated_at
}
```

**Toggles & monitored config.** CityFHEPS yields `program_unavailable` with `config_toggle_state = "disabled"` while disabled in config; flipping the toggle is a config change (version bumps), not a code change. ERAP is always reflected as closed (reason code `erap_program_closed`) inside `rental_assistance`. RTC thresholds/geography are versioned monitored config; every determination carries the `config_version` that produced it for auditability.

**`likely_eligible` display rule (UPL guardrail).** The tool may *emit* `determination = "likely_eligible"` (it is a DET, config-driven value). But surfacing "you likely qualify for a free lawyer" directly to a tenant edges toward an advice-adjacent conclusion. **Display policy (owned jointly with `GUARDRAILS.md`):** `likely_eligible` for RTC/legal-aid is used as an **internal provider-triage/routing signal** and is **not** rendered to the tenant as a standalone eligibility statement; the tenant-facing surface shows a neutral, non-conclusory message ("you may qualify — a legal-aid provider will confirm") and routes to human handoff. `eligible`/`ineligible`/`program_unavailable`/`insufficient_data` may be shown with their standard disclaimers. The tool emits the determination; the *display gate* is enforced at the presentation layer.

**Insufficient data.** Missing opt-in income/household → `determination = "insufficient_data"` (never a guess, never `ineligible`). The tool does not coerce the tenant to provide sensitive data; absence yields `insufficient_data`.

**Error modes.** `E_CONFIG_MISSING` (unknown `config_version`); `E_CONSENT_REQUIRED` only if a `data_source` that shares data externally is requested without the matching consent (the NYC Benefits Screening API is eligibility-only and does not submit, but any external share still requires `scope = "benefits_screening_share"` consent); `E_UPSTREAM_*` if `nyc_benefits_screening_api` is selected and unavailable → fall back to `internal_rules` with warning `FELL_BACK_TO_INTERNAL_RULES`; `E_BOUNDARY_VIOLATION` (caller tried to set `determined_by != "deterministic"` or to write `review.advice_routed`); `E_SCHEMA_VIOLATION` (post-patch — e.g. an attempt to write a non-canonical `eligibility.*` key).

**Idempotency.** Pure function of `(inputs, config_version)`. Same inputs + same config → same result (replay). A `config_version` bump or input change recomputes and re-stamps `evaluated_at` + `config_version`.

**Gate.** Eligibility is informational routing, not a filing — no `verify_before_file` gate. But determinations feed provider triage/handoff and are config-driven + attorney-validated (the ruleset is reviewed). The NYC Benefits Screening API never submits an application; any benefits packet ends in a tenant-performed manual upload (no submission API exists).

---

## 8. `source_court_date`

**Purpose.** Source the **authoritative** `court.court_date` from **eTrack email ingest** and the **NYSCEF public docket** — never from an LLM document extraction. Writes `court.court_date`, `court.court_date_source`, `court.court_date_verified`, `court.part`. A mis-sourced date can cause a default, so authority here is strictly gated to the two sanctioned channels. **Do NOT scrape the live eCourts/WebCivil portal** (Cloudflare + CAPTCHA + ToS bot prohibition). **The eTrack mailbox parse schema and the NYSCEF public-docket query/response contract are undefined today — see the §10 build-blocker note;** this section specifies the Case-Object-facing behavior only.

**Typed input.**

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "index_number": "LT-012345-26/BX",   // from court.index_number (LLM-extracted, tenant-confirmed)
  "county": "Bronx",                    // court.county (legal mixed-case enum)
  "borough": "bronx",                   // court.borough (Borough enum, lowercase)
  "channels": ["etrack", "nyscef"]      // try both; NYSCEF authoritative for the e-filed subset
}
```

**Typed output + Case Object writes.**

```jsonc
{
  "court_date": "2026-06-30",                  // -> court.court_date  (null if neither channel yields one)
  "court_date_source": "nyscef",               // etrack | nyscef | document_extracted_unverified | tenant_entered
  "court_date_verified": true,                 // -> court.court_date_verified  (TRUE only for etrack|nyscef)
  "part": "Part C",                            // -> court.part (if available)
  "discrepancy": null                          // populated if etrack and nyscef disagree; surfaced to a human, never auto-resolved
}
```

**Authority rule.** `court.court_date_verified = true` **only** when `court_date_source ∈ {etrack, nyscef}`. A date the LLM read off the document is recorded (if nothing better exists) as `court_date_source = "document_extracted_unverified"`, `court_date_verified = false`, and is explicitly NON-authoritative — it may NOT drive a reminder send or be presented as confirmed. For the post-Feb-2026 e-filed subset, NYSCEF case-level data is treated as **more authoritative than eTrack**; on conflict the tool sets `discrepancy` with both values, prefers neither silently, sets `review.review_state = "escalated"` (NOT `advice_routed`), and raises warning `COURT_DATE_DISCREPANCY` for human review.

**Reminder coupling.** `reminders[].scheduled_for` is DET-computed relative to an authoritative `court.court_date` (offset cadence from version-stamped reminder config — see §10). The reminder service refuses to schedule a `court_date` reminder unless `court.court_date_verified = true` — closing the "reminder with the wrong date causes a default" risk.

**Error modes.** `E_NOT_FOUND` (index number not trackable on either channel) → write nothing authoritative, surface to tenant to confirm with the court; `E_UPSTREAM_*` (eTrack delivers email only — no API/webhook; ingest is via a mailbox parser, and adding a case is a Cloudflare-protected web form, so `ETRACK_REGISTRATION_REQUIRED` warning when the case isn't yet registered); `COURT_DATE_DISCREPANCY` warning (see above).

**Idempotency.** Read/derive; idempotent per `(index_number, channels)`. A newly ingested eTrack email or NYSCEF docket update that changes the date triggers recomputation: updates `court.court_date`, appends to `audit.events[]`, and reschedules dependent `reminders[]` (cancels stale, creates new) — never a silent overwrite of a confirmed date without an audit entry.

**Index-number propagation note (cross-ref).** `source_court_date` reads `court.index_number`. Per `LLM-SCHEMAS.md` Surface 2, the deterministic confirm-step propagates the tenant-confirmed `documents[].extracted_fields.index_number` into `court.index_number`; this side-effect is also listed in `API-CONTRACTS.md` §3.5 confirm-endpoint side-effects so the value is never stranded on `documents[].extracted_fields`. This tool assumes that propagation has run; if `court.index_number` is null it returns `E_BAD_INPUT`.

**Staleness.** Court dates change (adjournments). NYSCEF/eTrack are polled/ingested on a schedule; `court.court_date` carries no `dataset_version` but the `audit` trail records each sourcing event with `at`.

---

## 9. `assemble_packet`

**Purpose.** Deterministically assemble court-ready and provider-handoff outputs: place confirmed facts into **official NY fillable PDF** form fields via self-hosted **docassemble + Suffolk AssemblyLine**, emit **PDF/A**, and produce the one-page **CSR/LIST-tagged** legal-aid intake summary. Writes `answer_draft.form_fields[]` (`placed_by = "deterministic"`) and `packets.{court_packet,legal_aid_handoff}`. **Form-field placement/validation is deterministic** — a wrong field on a court paper is a real-world default risk. **The concrete AcroForm/AssemblyLine variable map between confirmed Case Object facts and the official NY fillable-PDF field ids does not yet exist** (the `form_field_id` strings below are illustrative); the version-pinned field map is a build dependency — see §10.

**Typed input.**

```jsonc
{
  "case_id": "case_...",
  "idempotency_key": "uuid",
  "packet_kind": "court_packet",          // court_packet | legal_aid_handoff
  "form_template_version": "ny-lt-answer-2025.1",  // version-pinned AcroForm field map (field names change on form revisions)
  "include_evidence_ids": ["ev_...", "ev_..."],    // candidate evidence to attach
  "include_open_data": true                // whether open-data evidence may be included (still gated below)
}
```

**Deterministic placement.** The tool reads only **tenant-confirmed** facts: `answer_draft.factual_statements[]` where `tenant_confirmed = true` (faithful transcription, `transcription_only = true`), `answer_draft.general_denial` (tenant selection), confirmed `documents[].extracted_fields.*`, and DET-validated `court.*`. It maps them to AcroForm/AssemblyLine variables, sets each `answer_draft.form_fields[].placed_by = "deterministic"`, and computes `validation_state ∈ {valid, invalid, missing_required, pending}`. The LLM does NOT place or validate fields; it may only have authored the narrative `intake_summary_text` upstream.

**Hard block: unverified open data (scans landlord assertion too).** Before assembling, the tool scans **every** open-data assertion it would surface: every candidate `EvidenceItem` with `origin = "open_data"` **and** `parties.landlord.open_data` (the landlord registration/ownership assertion). If ANY has `verify_before_file.state != "verified"`, the tool sets `packets.<kind>.blocked_by_unverified_open_data = true`, `status = "blocked"`, refuses to emit a filing-ready output, and returns the list of blocking `evidence_id`s (and a `blocking_landlord_open_data: true` flag when the landlord assertion is the blocker). This closes the enforcement gap where a handoff/court packet could otherwise carry an unverified landlord-registration assertion. This is the machine enforcement of "open-data assertions are never auto-asserted into a filing; the tenant bears 22 NYCRR 130 risk" — and it applies to **both** `court_packet` and `legal_aid_handoff`.

**Typed output + Case Object writes.**

```jsonc
{
  "packet_id": "pkt_...",
  "kind": "court_packet",
  "status": "ready",                       // DocumentAssemblyStatus: not_started|assembling|ready|blocked|delivered|error
  "blocked_by_unverified_open_data": false,
  "blocking_evidence_ids": [],             // populated when blocked
  "blocking_landlord_open_data": false,    // true when parties.landlord.open_data is the unverified blocker
  "storage_ref": { "uri": "s3://.../packet.pdf", "format": "pdf_a", "content_hash_sha256": "ab..." },
  "form_fields": [
    { "form_field_id": "answer.general_denial", "value": true, "placed_by": "deterministic", "validation_state": "valid", "validation_message": null },
    { "form_field_id": "answer.tenant_name",   "value": "...", "placed_by": "deterministic", "validation_state": "missing_required", "validation_message": "Respondent name not confirmed" }
  ],
  "included_evidence_ids": ["ev_..."],
  "generated_by_model": "claude-opus-4-8",  // for NARRATIVE sections only (e.g. intake_summary_text); placement is deterministic
  "generated_at": "2026-06-22T14:05:00Z"
}
```

For `packet_kind = "legal_aid_handoff"` the output additionally carries `csr_tags` (LSC CSR codes), `list_tags` (LIST codes), `intake_summary_text` (LLM-generated one-page summary — information; attorney reviews), and a `delivery` (`ProviderHandoff`). **The authoritative CSR/LIST code set and the deterministic rules that assign tags are not yet enumerated** (the LLM proposes; a DET tagging layer + attorney confirm the authoritative `csr_tags`/`list_tags`) — see §10. **Delivery requires a matching per-recipient `consent_id`** (`scope = "handoff_to_provider"`, `recipient_type = "legal_aid_provider"`, `granted = true`, not expired/revoked); `method ∈ {legalserver_trigger_xml, pdf_packet_fallback}`. The tool refuses to deliver without it (`E_CONSENT_REQUIRED`). Tenant data is **never** furnished to a landlord/agent (no such `recipient_type` exists; FCRA bar).

**Consent-scope ↔ packet-contents reconciliation (delivery-time check).** The `legal_aid_handoff` packet may include eligibility-derived content and CSR/LIST tags. At delivery, the tool reconciles the packet's content categories against the matching consent's `data_categories[]`: it MUST NOT deliver a category the consent does not cover. Specifically — if the packet contains eligibility results but the consent `data_categories[]` omits `eligibility`, the tool either (a) **redacts** the eligibility section from the delivered packet, or (b) refuses delivery with `E_CONSENT_SCOPE_INSUFFICIENT` and surfaces which category is missing so the tenant can grant it. The same per-category reconciliation applies to `arrears`, `documents`, `evidence`, `immigration_status`, and `benefits_enrollment` (immigration is additionally redacted unless `immigration_status` is explicitly in `data_categories[]`). This closes the gap where a handoff packet's contents could exceed the consent scope at delivery time.

**Validation gate (now includes attorney-validated deadlines).** A `court_packet` is filing-ready (`status = "ready"`) only when ALL of:
1. `blocked_by_unverified_open_data = false` (no unverified open-data assertion, including `parties.landlord.open_data`); AND
2. every required `form_fields[].validation_state = "valid"` (any `missing_required`/`invalid` → not ready); AND
3. **every `deadlines[]` entry referenced for filing has `attorney_validated = true`** (and `tenant_confirmed = true`). This is the deadline attorney-validation gate that `API-CONTRACTS.md` §3.9 requires; it is enforced **here at assembly** (as a hard gate for `court_packet`), reconciling the prior disagreement where `assemble_packet` checked only open-data + field validation. If a referenced deadline is not attorney-validated, `status` stays `"blocked"` with a `validation_message` naming the deadline, and the tool returns `blocking_deadline_ids`.

Any failed condition → `status` stays `"blocked"`/`"error"` with messages; the tool never emits a half-filled or under-validated court form as ready.

**Error modes.** `E_CONFIG_MISSING` (unknown `form_template_version` — field maps are version-pinned, re-validate on form revisions); `E_BLOCKED_UNVERIFIED_OPEN_DATA` (returned when `include_open_data = true` but blocking items exist and a ready packet was requested with `dry_run = false`); `E_BLOCKED_DEADLINE_NOT_VALIDATED` (a referenced filing deadline is not `attorney_validated`); `E_CONSENT_REQUIRED` (handoff delivery without consent); `E_CONSENT_SCOPE_INSUFFICIENT` (packet contents exceed the consent's `data_categories[]` and redaction was not requested); `E_BOUNDARY_VIOLATION` (caller tried to set `placed_by != "deterministic"`); `E_UPSTREAM_5XX` (docassemble service down — packet `status = "error"`, retryable).

**Idempotency.** Pure function of `(confirmed inputs, form_template_version, include_*, referenced deadline validation state, consent scope)`. Re-assembly with identical inputs returns the same `packet_id` + `content_hash_sha256` (replay). Any change to a confirmed input, a newly verified open-data item, or a newly attorney-validated deadline produces a new content hash and bumps `generated_at`; a delivered packet (`delivery_state ∈ {sent, acknowledged}`) is immutable — re-assembly produces a new `packet_id` rather than mutating a delivered one.

---

## 10. Cross-tool invariants summary (implementation checklist)

| Invariant | Enforced by |
|---|---|
| LLM never authors a deadline/eligibility/placement/transcription/defense-assertion value | five schema `const`s; tools set them; `E_BOUNDARY_VIOLATION` on override |
| **No deterministic tool ever writes `review.advice_routed`**; escalation uses `review.review_state = "escalated"` only | §0.3, §6.4, §8; `E_BOUNDARY_VIOLATION` if attempted — preserves single-owner UPL audit signal |
| Eligibility writes only canonical keys (`rtc`/`legal_aid`/`rental_assistance`/`config_version`/`evaluated_at`); ERAP lives inside `rental_assistance` | §7; post-patch `E_SCHEMA_VIOLATION` on any extra key (`additionalProperties:false`) |
| Open data carries disclaimer + `verify_before_file` and never auto-files | `OpenDataAssertion` required on every open-data write; `assemble_packet` hard block scans evidence **and** `parties.landlord.open_data` |
| Consistent open-data relevance-signal semantics across sibling lookups | §2 convention applied in §2–§5 (`evidence_present` for affirmative records, `possible` for absence/status) |
| Socrata calls send `X-App-Token`, ~1000 req/hr, dataset IDs from config | §2–§4 limiter + `open_data_config` |
| GeoSearch is keyless; do not use legacy Geoclient | §1 |
| JustFix uses only the four verified endpoints (+ `/api/dataset/tracker`); never `/api/address/aggregate`; NYCDB fallback; non-commercial dump guard | §5 |
| Deadlines are double-gated (`tenant_confirmed` + `attorney_validated`), use the canonical `statute_rule_id` (`nonpayment_answer_window`), and rules are version-pinned from `LEGAL-RULES.md` | §6 |
| Deadline-typed timeline `kind`s (`answer_due`/`judgment`) are DET-only; LLM timeline is descriptive + `date_is_authoritative=false` | §6.3 |
| `is_missed`/`default_risk` clear only via a court-sourced docket event OR delivered+finalized answer OR attorney action (no e-filing rail; no filed-marker field) | §6.5 |
| Court date authoritative only from eTrack/NYSCEF (`court_date_verified`); discrepancy escalates, never auto-resolves | §8 |
| Reminders schedule only off verified court dates / validated deadlines, with `scope = "sms_reminders"` consent | §6.4, §8 reminder coupling |
| Packet assembly hard-gates on: open-data verified + required fields valid + referenced deadlines `attorney_validated` | §9 validation gate (reconciles `API-CONTRACTS.md` §3.9) |
| Provider handoff requires per-recipient consent AND packet contents ≤ consent `data_categories[]` at delivery; never to a landlord | §9 |
| Every mutation is audited; every mutating tool is idempotent via `idempotency_key` | §0.4, §0.6 |
| Recomputation on changed safety-critical inputs resets confirmation/validation gates and reschedules dependent reminders | §6.7, §8 |

### Open implementation dependencies (Phase-0/1 BLOCKERS)

These are acknowledged, named, and unresolved. The deadline and eligibility engines, court-date sourcing, and packet assembly **must not ship** until the corresponding artifact exists, is attorney-validated where noted, and is wired to the version registries referenced above.

1. **`LEGAL-RULES.md` is unpopulated by design** (all windows `null`, `attorney_validated_config: false`). `compute_nonpayment_deadlines` (§6) and `screen_eligibility` (§7) have no anchor/window/FPL-multiplier values to implement against. This is the single biggest blocker; both engines refuse to run on an unloadable/unvalidated ruleset (`E_CONFIG_MISSING`).
2. **Court-holiday calendar** (`calendars/court_holidays.yaml`, §6.2) — contents, source, and maintenance owner must be defined and version-stamped before any `unit = court_days` rule can be implemented.
3. **"Satisfied" / answer-filed signal** (§6.5) — there is no canonical filed-marker field and no e-filing rail. Until the NYSCEF/eTrack docket-event ingest contract exists, `is_missed`/`default_risk` can clear only via a delivered+finalized answer or an explicit attorney action. Define the docket-event ingest to enable signal (1).
4. **NYC Benefits Screening API contract** (§7) — request/response field map, auth, and fallback payload shape are undefined; `data_source = "nyc_benefits_screening_api"` cannot be integrated until specified (tool falls back to `internal_rules` meanwhile).
5. **eTrack mailbox parse schema + NYSCEF public-docket query/response contract + discrepancy-surfacing path** (§8) — undefined; `source_court_date` is specified only at the Case-Object boundary until these exist.
6. **NY fillable-PDF AcroForm/AssemblyLine field map** for `form_template_version` (§9) — the `form_field_id` values are illustrative; the real version-pinned variable map must exist before packet assembly is buildable.
7. **CSR (LSC) code set + LIST taxonomy mapping** and the deterministic tagging rules (§9) — the `legal_aid_handoff` packet cannot be tagged to spec until enumerated.
8. **Reminder offset cadence config** — the version-stamped pre-court-date/pre-deadline send schedule (referenced in §8 reminder coupling) is owned by reminder config in `LEGAL-RULES.md`/`API-CONTRACTS.md`, not this doc, and is not yet populated.
9. **Verify-before-file staleness window** — the config window after which a `verified` `VerifyGate` reverts to `unverified` (and its config key name) has no default value; without it a `verified` open-data assertion never expires. Define `open_data_config.verify_gate_staleness` before relying on re-verification.
