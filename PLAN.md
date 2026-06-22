# Housing Court Copilot — Build Plan

**One-line:** A **legal-aid intake autopilot for eviction defense**. A mobile-first tool where a low-income NYC tenant uploads their court papers and the product classifies the case, finds deadlines, gathers tenant-verified evidence, assembles court-ready and legal-aid-handoff packets, screens for assistance, and routes to a human attorney — making each tenant *easy for a funded provider to help*.

**Not** "AI lawyer for tenants." The AI classifies, explains generally, checklists, faithfully transcribes the tenant's own factual narrative, assembles packets, and routes to humans. It is conservative on legal conclusions and ends in a human handoff. (See `POSITIONING.md` for why this wedge beats "AI lawyer," and `RISKS-AND-COMPLIANCE.md` for the UPL red lines this framing is built around.)

---

## Related documents

| Doc | What's in it |
|-----|--------------|
| **`POSITIONING.md`** | The "intake autopilot" wedge, why it beats "AI lawyer," and the proof metrics |
| **`COMPETITIVE-LANDSCAPE.md`** | Verified (June 2026) competitor table with compete/integrate/refer calls + "the open lane" |
| **`INTEGRATIONS.md`** | Prioritized integration matrix (34 targets) + per-target "how we'd integrate" detail |
| **`RISKS-AND-COMPLIANCE.md`** | UPL, S7263 chatbot-proprietor liability, court-data ToS, stale-data filer liability, SHIELD/FCRA/immigration, TCPA — with red lines |
| **`SOURCES.md`** | All source URLs, grouped, with re-verification flags |

> These were produced by a multi-agent research pass that verified the landscape against current 2026 facts and ran an adversarial critique. Several load-bearing claims carry **re-verification flags** (marked inline) — treat flagged figures as "re-source before external use," not as settled.

---

## The Phase-0 gate (read first)

Two relationships must be in place **before any fact-classification or defense-checklist output ships**:

1. A named **design-partner provider** (a funded RTC/legal-aid org) that agrees the provider-side ROI metrics matter and defines "complete / consented / categorized = accepted without re-work." *Without a signed provider, the core proof metric is self-defined and unfalsifiable.*
2. A **supervising attorney in the loop** who reviews work product. *The UPL posture and the "selection-of-facts" exposure both depend on this relationship existing at launch, not arriving later.*

Roxanne/HCA and the RTC-provider relationship are also long-lead — start outreach **before** engineering.

---

## Why this wedge

- Housing is urgent, high-volume, deadline-driven; losing means homelessness.
- NYC FY24: ~**126,236** residential eviction petitions; ~**295,548** people named as respondents. *(Original brief figures — confirm against the OCJ FY24/FY25 reports, which 403'd automated fetch.)*
- NYC full-representation rates fell sharply post-pandemic — roughly **71% (FY21) → ~42% (FY24)** ([Comptroller](https://comptroller.nyc.gov/reports/evictions-up-representation-down/)). The bottleneck is provider **capacity, not demand** — which is exactly what an intake autopilot multiplies.
- Forms and DIY tools exist (NY Courts DIY) but are *print-and-file*, not e-fileable. The product's value is making the process **intelligible and assembled**, not replacing the forms.

**Measurable outcomes:** Did the tenant appear? Avoid default? File the right papers? Reach counsel *with a usable file*? Get rental assistance? Preserve housing?

**Unfair advantage:** build *both* sides — a compassionate tenant-facing app **and** a legal-aid/provider-facing triage system. The provider side is where the leverage compounds.

---

## MVP scope — NYC nonpayment eviction defense

Ship this first. Nothing else.

| # | Capability | Definition of done |
|---|-----------|--------------------|
| 1 | Upload summons / petition / rent demand | Photo or PDF, multi-page, mobile camera flow |
| 2 | Extract key fields | Court date, borough, index number, claimed arrears, landlord, case type = nonpayment — **every extracted field tenant-confirmed before it drives a deadline or document** |
| 3 | Plain-English case timeline | "You have court on X. You may need to file an answer by Y. Default risk if you miss it." (deadline computation treated as safety-critical — see Risks #6) |
| 4 | Answer prep + checklist | Guided answer drafting (faithful transcription of the tenant's own facts), defenses checklist, what to attach, where/how to file — **attorney-reviewed** |
| 5 | Evidence packet | Lease, receipts, texts, repair photos, HPD complaints, payment records, subsidy letters, stips → assembled court packet, each open-data assertion behind a **verify-before-file gate** |
| 6 | Screening | Right-to-Counsel eligibility, legal aid, rental assistance |
| 7 | Legal aid intake summary | One-page structured handoff object (CSR/LIST-tagged) from the tenant's facts |
| 8 | SMS reminders | Before court dates and filing deadlines (opt-in, TCPA-compliant) |

**Explicitly out of MVP:** holdover, HP/repair actions, Town & Village courts, fair hearings, debt vacatur, programmatic e-filing, live chat with a lawyer.

---

## Key strategic corrections from research

The landscape inverts several default assumptions; the adversarial critique surfaced two strategy-level corrections that reshape sequencing.

0. **Provider + supervising attorney FIRST.** Not a Phase-3 item — a precondition (see Phase-0 gate).
1. **Don't build form-generation from scratch — adopt the docassemble + Suffolk AssemblyLine *engine* (MIT, ~$10–40/mo).** But scope MADE realistically: only the *scaffolding* is reusable; MADE's Massachusetts legal branching is **not** a head-start — the NY legal interview is rebuilt from scratch with attorney review. Keep deterministic assembly on the filing step to minimize hallucination/UPL risk.
2. **Lead with the provider intake handoff — and pin the funding model.** Reconcile the LSC-TIG hole: only Legal Services NYC is LSC-funded in NYC, and LSC grantees can't serve undocumented tenants (a large share of the population) even with non-LSC funds. Decide explicitly between (a) LSC-TIG + Legal Services NYC for the documented subset with **non-LSC funding/partners** for the undocumented-inclusive build, or (b) LSC-TIG as one leg, not the spine. Name the provider and the population each source covers.
3. **Embed JustFix Who Owns What for landlord ID — corrected endpoints + self-hosted fallback.** Use the verified client endpoints; **drop the stale `/aggregate` path**. "Verified live" is confirmed only for `/dataset/tracker` until the portfolio endpoints are re-checked. Scope NYCDB self-hosting (loaded from original open-data sources for commercial use) so a single undocumented nonprofit API is never a single point of failure.
4. **Ground evidence in NYC Open Data from Phase 1 — with a verify-before-file gate.** HPD Violations/Complaints/Registration are high-feasibility and license-clean. Build the resolver as **GeoSearch + PLUTO/PAD (not the deprecated Geoclient)**. Because the *tenant* files the data, every auto-built assertion needs a data-accuracy disclaimer + tenant verification gate (a wrong "open violation" that was actually cured can expose the tenant to 22 NYCRR 130 / credibility consequences).
5. **Re-examine the e-filing premise — the funnel is narrower than assumed.** **Pro se tenants are statutorily EXEMPT from mandatory e-filing**; the L&T e-filing mandate compels landlords/attorneys, not tenants, so it does **not** widen the tenant opt-in funnel. **Also re-verify whether the mandate actually took effect as a final order** (sources are internally inconsistent). There is **no programmatic e-filing API** (NYSCEF is proprietary; ECF 4/EFSP does not apply — removed from roadmap). MVP output stays a print-ready / NYSCEF-uploadable **PDF/A** plus a guided *opt-in* checklist (Phase 4–5, narrow).
6. **Court-date reminders: build the SMS layer, source dates from two channels** (eTrack email ingest + NYSCEF public docket for e-filed cases) — explicitly **not** by scraping the live portal. **Don't advertise a borrowed FTA-reduction magnitude** (the criminal-summons RCT figures don't transfer). Treat wrong-date delivery as a substantive liability vector.
7. **Add a rental-assistance/benefits track — but don't over-promise.** **ERAP is closed** (don't build toward it). One Shot Deal is discretionary, carries recoupment conditions, and often doesn't cover market arrears — not a clean ERAP substitute. Scope a broader arrears menu (CityFHEPS arrears, NYCHA programs, SOTA/shelter-diversion, One Shot Deal), routed by eligibility. No submission API exists — every packet ends in a tenant-performed manual upload to ACCESS HRA.
8. **Make legal rules config-driven, not hardcoded.** **CityFHEPS is in active litigation** (Court of Appeals, Mar 2026) — ship a rules toggle and sequence CityFHEPS-dependent logic *after* the appeal resolves. RTC geography, e-filing coverage, and dataset IDs are all monitored configuration.
9. **Partnership sequencing.** Roxanne/HCA (eviction module is *their* deliberate gap) and a funded RTC provider are **Phase-0 dependencies** — they unlock the legal posture, the proof metrics, and the funding. Choose the RTC partner to match the population (LSC vs non-LSC).

---

## Revised phased roadmap

- **Phase 0 — Relationships gate:** signed design-partner provider (metric definitions + "accepted without re-work"); supervising attorney engaged; Roxanne/HCA outreach; funding-model decision (LSC vs non-LSC; population coverage).
- **Phase 1 — Evidence + assembly spine:** GeoSearch+PLUTO/PAD resolver; HPD Violations/Complaints/Registration with verify-before-file gate; official fillable PDFs; docassemble/AssemblyLine engine (scaffolding-only MADE reference); NY DIY deep-link fallback; UPL firewall + disclaimers; attorney review of any fact-classification/checklist output.
- **Phase 2 — Intake intelligence + reach:** Who Owns What (verified endpoints); Benefits Screening API (screening only); CSR/LIST tagging; Twilio SMS + consent; dual-channel date sourcing (eTrack + NYSCEF docket); language-access/translation layer.
- **Phase 3 — Handoff + deployment:** LegalServer Online Intake; Brooklyn OCJ pilot; broader assistance menu (manual ACCESS HRA upload); DOB/311 evidence.
- **Phase 4 — Deeper defenses:** rent-stabilization signals → DHCR rent-history request (manual, human-in-loop parse); ACRIS standing; Good Cause computation; OCA analytics; LegalServer Premium API.
- **Phase 5 — Narrow filing convenience:** NYSCEF assisted opt-in upload (no programmatic rail; ECF 4/EFSP removed).

*Original case-type expansion (still valid as a parallel axis):* Phase 1 NYC nonpayment → Phase 2 holdover + default-vacate + repair/HP → Phase 3 NYS Town & Village Court mode → Phase 4 public-benefits fair hearings → Phase 5 consumer-debt default-judgment vacatur.

---

## Product architecture

Two surfaces over one shared case object.

### Tenant-facing (mobile-first PWA)
Camera/upload intake → OCR → field extraction (tenant-confirmed) → case timeline + danger detection → guided answer + checklist → evidence locker (verify-before-file) → resource routing → SMS reminders. Multilingual (heavily LEP population — ES first, then ZH/RU/BN/HT).

### Provider-facing (legal-aid / triage console)
Inbox of structured, consented, CSR/LIST-tagged intake objects → triage by urgency / eligibility / case type → accept / refer / decline → updates tenant status. This is the fundable core: manufacturing "easy-to-help" clients.

### The shared Case Object (the core asset)
```
Case {
  id, tenant_contact
  documents[]            // raw uploads + OCR text + extracted fields (+ confidence, confirmed flag)
  case_type              // nonpayment | holdover | illegal_lockout | HP | harassment
  court: { county/borough, court_date, index_number }
  parties: { landlord, tenant }
  claimed_arrears
  deadlines[]            // derived, safety-critical, with risk flags + tenant confirmation
  evidence[]             // typed, tagged, open-data items behind verify-before-file gate
  answer_draft           // faithful transcription of tenant's own facts; attorney-reviewed
  defenses_checklist[]   // information-not-advice; attorney-reviewed
  eligibility: { RTC, legal_aid, rental_assistance }
  packets: { court_packet, legal_aid_handoff }  // CSR/LIST-tagged
  reminders[]            // opt-in, consent-logged
  consent: { per_recipient, time_limited, severable }
  status                 // intake -> prepared -> referred -> represented -> resolved
}
```

---

## Tech stack (proposed)

- **Frontend:** mobile-first PWA (React/Next.js). Camera capture, offline-tolerant upload, low-literacy-friendly, multilingual.
- **Backend:** API + job queue for OCR/extraction; encrypted store (SHIELD-compliant — written security program, encryption, minimization, retention limits, RBAC, breach plan, subpoena/legal-hold plan).
- **OCR + extraction:** OCR engine → LLM extraction into the Case schema. Surface confidence; tenant confirms/corrects every field. Never auto-file.
- **Document assembly:** self-hosted **docassemble + Suffolk AssemblyLine** (MIT) mapping confirmed facts onto official NY Courts fillable PDFs → print-ready / NYSCEF-uploadable **PDF/A**.
- **Data layer:** NYC Open Data (Socrata, app token) via a GeoSearch+PLUTO/PAD resolver; JustFix Who Owns What with NYCDB self-host fallback.
- **SMS:** Twilio A2P 10DLC; opt-in, STOP handling, consent records.
- **LLM (Claude):** classification, plain-English explanation, faithful factual transcription, packet assembly, triage summarization. Latest Claude models. Guardrails per `RISKS-AND-COMPLIANCE.md`.

---

## AI guardrails (non-negotiable — full detail in `RISKS-AND-COMPLIANCE.md`)

- **No legal conclusions / no legal advice.** Detect advice-seeking turns ("should I…", "do I have a case", "which defense") and hard-route to a human.
- **Scrivener line:** faithful transcription of the tenant's *own* words only — do not let the tool *characterize* which facts are legally favorable without attorney review.
- **Human-in-the-loop on every extracted field** before it drives a deadline or document; deadlines are safety-critical.
- **Verify-before-file gate** on every open-data-derived assertion (stale data → filer's 22 NYCRR 130 risk).
- **Never market as a lawyer** (FTC §5 / DoNotPay). Persistent "legal information, not legal advice" disclaimer.
- **Privacy by minimization:** don't collect immigration status unless a specific defense requires it; granular, per-recipient, time-limited consent for handoff; never furnish tenant data *to landlords*.

---

## Immediate next steps

1. **Recruit the Phase-0 design-partner provider + supervising attorney** (the gate). Open Roxanne/HCA and RTC-provider conversations now.
2. **Decide the funding model** (LSC subset vs non-LSC-funded undocumented-inclusive build) and name the population each source covers.
3. Collect real (redacted) nonpayment petition/summons/rent-demand samples to build the extractor against.
4. Map the exact NYC nonpayment answer + filing workflow with the partner; confirm the e-filing final-order status and pro-se exemption.
5. Build the intake → confirm → timeline → verify-before-file slice as a clickable prototype on docassemble/AssemblyLine.
6. Validate with 5–10 real tenants before writing the broader form-generation layer.
7. **Re-verify the flagged claims in `SOURCES.md`** before any external/funder-facing materials.
