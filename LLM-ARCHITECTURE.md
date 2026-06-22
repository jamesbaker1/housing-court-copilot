# LLM Architecture — Where Claude Does the Work (and Where It Must Not)

**Principle (from `POSITIONING.md` / `RISKS-AND-COMPLIANCE.md`):** the LLM **classifies, explains, transcribes, drafts factual text, summarizes, and routes**. It does **not** decide deadlines, eligibility, or which defense applies. Anything that, if wrong, causes a default or a bad filing is **deterministic code with a human confirm** — not a model output.

**Default model:** Claude **Opus 4.8** (`claude-opus-4-8`, $5/$25 per Mtok) for everything safety- or quality-sensitive. **Haiku 4.5** (`claude-haiku-4-5`, $1/$5) for cheap high-volume mechanical calls. **Sonnet 4.6** (`claude-sonnet-4-6`, $3/$15) as the middle tier. **Fable 5** (`claude-fable-5`, $10/$50) only for the hardest reasoning if budget allows — Opus 4.8 is the right default for this product.

---

## The map: product surface → LLM job → Claude feature → model → guardrail

| # | Surface (from PLAN.md) | What the LLM does | Claude feature | Model | Guardrail |
|---|------------------------|-------------------|----------------|-------|-----------|
| 1 | **Paperwork intake** | Read a photographed/scanned summons, petition, rent demand | **Vision (image input)** + **PDF document input**; high-res image support (Opus 4.7+) handles bad phone photos | Opus 4.8 | Show confidence; nothing auto-asserted |
| 2 | **Field extraction** | Pull court date, index #, borough, arrears, landlord, case type into the Case schema | **Structured outputs** (`output_config.format` / `messages.parse()`, strict JSON schema) — guarantees schema-valid JSON, no parsing | Opus 4.8 | **Every field tenant-confirmed** before it drives anything |
| 3 | **Provenance** | "This court date came from *here* on the page" | **Citations** (`citations:{enabled:true}` on the document) — links each value to source text | Opus 4.8 | Builds the verify-before-file trust loop; see note below |
| 4 | **Case-type classification** | nonpayment / holdover / illegal lockout / HP / harassment | **Structured output with `enum`** (or strict tool with enum) | Haiku 4.5 or Sonnet 4.6 | Information, not a legal conclusion |
| 5 | **Plain-English timeline** | Turn confirmed facts + computed deadlines into readable, calm language | Plain generation; **prompt caching** for the explanation style/KB | Opus 4.8 | LLM *explains* deadlines; **does not compute them** (see "Not the LLM") |
| 6 | **Answer drafting** | Transcribe the tenant's *own* narrative into the answer form's factual fields | **Structured output / strict tool** to fill form-field JSON | Opus 4.8 | **Faithful transcription only** — no characterizing which facts are legally favorable; attorney-reviewed |
| 7 | **Evidence locker** | OCR + tag uploaded receipts/texts/repair photos; build the packet | **Vision** + structured tagging | Sonnet 4.6 (Haiku for simple tags) | Surfaces raw, tenant-verified data — does not assert legal salience |
| 8 | **Multilingual / literacy** | Translate + simplify UI and document strings (ES, ZH, RU, BN, HT) | Plain generation; pair with a **human language-access partner** for legal strings | Opus 4.8 | Machine translation of legal terms is itself a risk — human review on the highest-risk content |
| 9 | **Legal-aid intake summary** | Compress the Case Object into the one-page, CSR/LIST-tagged handoff | Summarization + structured output (codes as enums) | Opus 4.8 | The fundable core — packages facts, doesn't advise |
| 10 | **Provider triage** | Rank/triage incoming intakes by urgency, eligibility, completeness | Summarization + **LLM-as-judge** scoring | Sonnet 4.6 | Assists a human triager; doesn't auto-accept/decline |
| 11 | **SMS reminder copy** | Generate plain, multilingual reminder text | Plain generation (template + fill) | Haiku 4.5 | **Date comes from deterministic code**, never the model |
| 12 | **Know-your-rights Q&A** | Grounded answers from a validated KB (the Roxanne model) | **RAG** + **Citations**; **tool use** to fetch KB passages | Opus 4.8 | Conservative; cites sources; advice-seeking turns hard-routed to a human (#13) |
| 13 | **Safety classifier** | Detect "should I…/do I have a case/which defense" and route to a human | Cheap **classification call** on every conversational turn | Haiku 4.5 | This is the UPL firewall — runs in front of #12 |

---

## Two features that carry most of the quality

1. **Structured outputs** (`output_config.format` with a JSON Schema, or `messages.parse()` with Pydantic/Zod, or `strict: true` tool use). Extraction (#2), classification (#4), form-filling (#6), and the intake summary (#9) all produce **schema-validated JSON** — the model literally cannot return a malformed Case Object, and you never hand-parse text. This is the single biggest reliability lever for a TurboTax-style flow.

2. **Tool use → keep legal computation out of the model.** Define deterministic tools the model *calls* instead of computing itself:
   - `compute_deadlines(case_type, court_date, service_date)` → the rules engine (safety-critical)
   - `lookup_hpd(bbl)` / `lookup_who_owns_what(bbl)` → NYC Open Data + JustFix (see `INTEGRATIONS.md`)
   - `screen_eligibility(income, household, zip)` → the RTC/benefits rules engine
   - `assemble_packet(case_id)` → docassemble
   The model orchestrates and explains; the *answers* come from code. **Programmatic tool calling** lets it compose several of these in one script when a case needs many lookups, without dumping every intermediate result into context.

**Citations caveat:** citations and `output_config.format` are **incompatible in one call**. So run extraction as two passes — a structured-output pass for the Case fields, and a citations pass to surface "where on the page" for the verify-before-file UI — rather than trying to get both from a single request.

---

## Cost & latency levers

- **Prompt caching** (`cache_control: {type: "ephemeral"}`): the legal-info KB, form-field maps, jurisdiction rules, and the long system prompt are a stable prefix shared across every request — cache it once and reads cost ~0.1×. Keep volatile content (the specific case, the timestamp) *after* the last cache breakpoint, or you silently invalidate the cache.
- **Model tiering:** route #4/#11/#13 to **Haiku 4.5**, #7/#10 to **Sonnet 4.6**, and reserve **Opus 4.8** for #1/#2/#5/#6/#9/#12. Don't downgrade the safety-critical or trust-critical paths to save money.
- **Adaptive thinking + effort:** use `thinking: {type: "adaptive"}` with `output_config: {effort: "high"}` for answer drafting and triage; drop to `effort: "low"` for mechanical extraction/classification.
- **Batch API** (50% cheaper, async): provider-side analytics, overnight re-processing of open-data refreshes, bulk re-tagging — anything not latency-sensitive.

---

## NOT the LLM (deterministic code, every time)

These are where a wrong answer causes the exact harm the product exists to prevent (see `RISKS-AND-COMPLIANCE.md` #5, #6):

- **Deadline / statutory-clock computation.** The answer window, OSC timing, default risk — a rules engine over tenant-*confirmed* dates. The LLM extracts and explains; it never does the date math as authoritative.
- **Eligibility determinations.** RTC income/zip, CityFHEPS, One Shot Deal — a rules engine, config-driven (CityFHEPS is in active litigation; ship a toggle).
- **Form-field validation / placement.** A wrong field on a court paper is a real-world default risk — deterministic mapping + version-pinned form schemas.
- **Court-date sourcing.** From eTrack/NYSCEF docket via code, not model guesses (a mis-parsed date can cause a default).
- **The advice line.** No model output may state which defense to raise, whether the tenant has a case, or predict an outcome. The #13 classifier enforces this; the supervising attorney (Phase-0) reviews any fact-characterization.

---

## Privacy note

The Case Object holds immigration status, benefits, and financial data. Per `RISKS-AND-COMPLIANCE.md` #8: **data-minimize before sending to the model** (don't include immigration status in a prompt unless a specific defense requires it), and keep model calls inside the SHIELD-compliant boundary. Confirm the data-handling terms of whatever inference path you use before going to production.

---

## Recommended build order for the LLM layer

1. **Structured extraction (#2)** on real redacted petitions — this is the spine; get the schema and confidence/confirm UX right first.
2. **Vision intake (#1)** feeding it, with the tenant-confirm gate.
3. **Tool use for deadlines + open data (#5 + integrations)** — wire the deterministic tools so the model never computes a deadline.
4. **Answer drafting (#6)** as faithful transcription, behind attorney review.
5. **Intake summary (#9)** — the provider-handoff payoff.
6. **Safety classifier (#13)** before any conversational surface (#12) ships.
