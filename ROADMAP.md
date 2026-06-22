# Housing Court Copilot — Prioritized Feature Roadmap

_"What else can and should we add?" — grounded in the review's gaps, the competitive moat, and what isn't built yet. Date: 2026-06-22._

---

## The strategic frame: what is the moat?

A generic out-of-box LLM can already explain housing law, draft a sympathetic narrative, and chat in Spanish. **What it cannot do** — and therefore what this product must double down on — is exactly the four things `LLM-ARCHITECTURE.md` and `COMPETITIVE-LANDSCAPE.md` identify:

1. **Local, live, authoritative data** — your court date from eTrack/NYSCEF, your building's HPD violations, who really owns your building. A generic LLM hallucinates these; we fetch them.
2. **Deterministic actions with a human confirm** — computing the actual answer deadline, assembling a court-ready packet, scheduling a reminder. A generic LLM gives advice; we do the safe, mechanical thing and route the rest to a person.
3. **Reach the target population can actually use** — phone-first, multilingual end-to-end, low-literacy, low-bandwidth, on a borrowed phone. A generic chatbot assumes a literate English-speaking user with a stable account.
4. **A real, warm human handoff** to a funded RTC provider. A generic LLM is a dead end; the whole UPL-safe posture is "package facts, hand to a lawyer."

The competitive whitespace (per COMPETITIVE-LANDSCAPE.md) is *the only full NYC eviction-case copilot for low-income tenants* — NYC-specific + free + ingests papers + organizes facts/evidence + assembles packets + warm-hands-off. Everything below is ranked by how much it widens that moat per unit of effort, and by whether it unblocks a review-confirmed risk.

**Reality checks baked in:** (a) pro se tenants are statutorily exempt from mandatory NYSCEF e-filing, so "assisted e-filing" is narrower than packet-assembly; (b) the funded-provider partner is a Phase-0 dependency, not a later add-on; (c) eTrack/NYSCEF have no public API — sourcing is scraping/partnership, which carries ToS and reliability risk.

---

## TIER 1 — NEXT (high value-per-effort, build now)

These are the smallest set of things that turn the current "unsafe to show a tenant" state into a defensible, safe MVP. Several are review-blockers, not features — but they *are* what to build next.

### ★ 1. Tenant ownership/session layer + boundary hardening — **[BUILD NEXT]**
- **What:** Promote the existing OTP/`case_owners` infrastructure into an actual authorization layer for `/api/cases/[id]`; gate read/write on a verified-owner session or per-case capability token; add Cloudflare **Turnstile** + a KV/D1 **rate-limiter** on every public endpoint; cap OTP sends per-phone/per-IP. Add the `CourtSchema` superRefine and field-level stripping of safety-owned fields.
- **Why it beats a generic LLM:** it's not an LLM feature — it's the precondition for ever exposing one to a real, vulnerable user. Without it, the IDOR/cost-DoS/SMS-bomb/Invariant-2-forge findings make the deploy a liability.
- **Effort:** **M** (the primitives exist; this is wiring + Turnstile + a token bucket). **Dependencies:** Cloudflare Turnstile (free, same account); KV namespace. **External account:** Turnstile (Cloudflare, free).

### ★ 2. Server-authoritative persistence for safety signals + court date fix — **[BUILD NEXT]**
- **What:** Make `/api/chat` the single writer of `review.advice_routed` + the audit event (load the Case server-side, `patchCase`). Fix the court-date persistence bug (pass raw ISO, not rendered display). Append `audit.events[]` inside `patchCase` so the subpoena trail is actually populated.
- **Why it beats a generic LLM:** durability + auditability of the human-handoff signal is the accountability backbone of a UPL-safe tool; a generic LLM has no persisted, attributable escalation trail.
- **Effort:** **S–M.** **Dependencies:** D1 (already live). **External account:** none.

### ★ 3. End-to-end multilingual (the promise we're already making) — **[BUILD NEXT]**
- **What:** Visible language selector on `/copilot`; persist `language` onto the Case; thread it through every fetch (intake/defenses/answer/chat); localize disclaimers, step labels, confirm prompts, and error copy for the top NYC housing-court languages (es, zh-Hant, ht, ru, ko, bn). The backend already accepts `language` — this is mostly UI + a localization pass.
- **Why it beats a generic LLM:** reach is a moat dimension. The backend grounding + Opus translation of *factual* strings (with human review of legal terms per LLM-ARCH #8) is something a tenant cannot get from a raw chatbot, and the target population is disproportionately limited-English.
- **Effort:** **M.** **Dependencies:** none new (Opus already in use). **External account:** ideally a human language-access partner for the highest-risk legal strings (not a blocker for shipping non-legal UI strings).

> Why these three: #1 and #2 close the confirmed High-severity boundary + safety-persistence + court-date-save findings (you literally cannot pilot without them), and #3 closes the single biggest *reach* gap while honoring a promise the landing page already makes. All three are S/M effort with no hard external dependency.

### 4. Data retention, deletion & encryption posture
- **What:** Cloudflare **Cron Trigger** to purge closed/inactive cases per `data_retention_class`; a tenant-initiated delete path; envelope-encryption of the PII subset with a Worker secret; honor `legal_hold` (suspend purge); document D1 region limits in `DATA-SECURITY.md`.
- **Why it beats a generic LLM:** the SHIELD/immigration-subpoena posture *is* the product's trust story; minimizing the standing PII trove is differentiating for this population.
- **Effort:** **M.** **Dependencies:** Cron Triggers, a KMS/secret for the DEK. **External account:** none (Cloudflare-native).

### 5. Deploy/operational safety
- **What:** `db:migrate:remote` chained into `deploy` (or a post-deploy `SELECT cases` health check); `[observability] enabled = true`; drop the `maxDuration` reliance and add `[limits]` if needed.
- **Why:** prevents the "deploys green, breaks on first write" footgun and gives visibility into the D1 errors the other fixes might surface.
- **Effort:** **S.** **Dependencies:** none. **External account:** none.

### ★ 5b. "Your case" dashboard — anonymous-first, optional phone resume — **[BUILT — 2026-06-22]**
- **Status:** **Built and locally verified.** New `app/case/page.tsx` is the persistent "your case" home (court-date countdown gated on confirmation, single next-step CTA, then Timeline / Evidence / Documents & packet / Reminders / Free-legal-help sections). Same-device auth uses the per-case capability token minted at `POST /api/cases` (returned once, stored in `localStorage` as `hcc_case_token`, sent `Authorization: Bearer …`); cross-device resume uses the optional SMS-OTP → owner-session path (`x-owner-session`). Shared client auth/storage contract factored into `lib/caseClient.ts` and reused by `/copilot`. Verified against a local D1-bound preview (gating real, not dev-open): same-device create→read→write = 200; unauth/wrong-token = 403; OTP verify issues an owner session that authorizes ONLY that phone's case (cross-tenant = 403); anonymous create = 201 and `/copilot` has no login wall; the four safety backstops held (a spoofed `court_date_verified:true` PATCH was stripped to `false`). `typecheck` + `next build` + `opennextjs-cloudflare build` all green; corruption scan clean. **Deferred / needs operator:** richest dashboard value (live lawyer responses / provider status) still waits on a provider partner (Phase-0); live court-date verification still waits on Tier-2 #6 (until then the countdown honestly labels tenant-entered dates as not court-confirmed). Production behavior (real token gating, OTP SMS) requires redeploy + secrets — not exercised here.
- **What:** Evolve the one-shot stepped `/copilot` flow into a persistent **"your case" home** a tenant can return to: next step + deadline countdown front-and-center, then timeline, evidence locker, document/packet status, reminders, and handoff status. Entry stays **anonymous and frictionless** — no account, no wall. Offer an **optional, passwordless "save my case to my phone"** resume built on the SMS-OTP + ownership session from #1; the persisted `case_id` ties to a verified phone **only on opt-in**, never as a gate.
- **Why it beats a generic LLM:** an eviction case is multi-step over weeks (court date, answer deadline, evidence, adjournments, stipulation, lawyer response) — a place to *come back to*, grounded in the tenant's real case state and deadlines, is exactly what a stateless chatbot cannot be. Done anonymous-first, it adds the return-visit value **without** the login-wall friction and privacy/subpoena cost that would lose scared, low-literacy, possibly-undocumented, shared-device users (per the data-minimization posture in `RISKS-AND-COMPLIANCE.md`).
- **Effort:** **M** (the ownership/session layer from #1, persistence, and SMS-OTP already exist — this is a dashboard view + making optional resume prominent, not a re-architecture). **Dependencies:** Tier-1 #1 (ownership/session) must land first; the *richest* dashboard value (lawyer responses, status updates) needs a provider partner (Phase-0). **External account:** none.

---

## TIER 2 — SOON (high value, more effort or a dependency)

### 6. Live court-date sourcing (eTrack / NYSCEF) — ★ *built (connector + adapters); channels staged by legitimacy*
- **What:** A deterministic connector (`lib/court-source/index.ts`) + 3 adapters (`lib/court-source/adapters/{etrack-email,nyscef,vendor}.ts`) that pull the authoritative court date + index # from **legitimate channels only** and set `court_date_verified=true` via `lib/court-date.setCourtDate` — the **only** way Invariant #2 is satisfied. Wired in priority order (eTrack-email > NYSCEF > vendor), each self-gating/default-off; a Worker `email()` handler ingests sanctioned eTrack reminder emails; a discrepancy with the tenant's date **escalates** (never overwrites); a verified date re-arms reminders and lights up the `/case` countdown as court-confirmed. In-app register-in-eTrack affordance added to the court-date confirm step.
- **Why it beats a generic LLM:** this is the textbook "local data + action" moat. A generic LLM *cannot* know your real court date; a mis-read date causes a default judgment. Verified sourcing is the single highest-trust feature in the product.
- **Status:** **Built and locally verified.** `npm run typecheck` (both targets) + `npm run build` + `npx opennextjs-cloudflare build` all green from a clean state; corruption scan clean; the `email()` handler confirmed present in the wrangler-bundled Worker (dry-run); migration `0004_court_source.sql` applied to local D1; Invariant #2 re-verified behaviorally (12/12 checks: authoritative→verified, tenant/model→unverified, discrepancy→escalated-not-overwritten, vendor default-deny, schema floor rejects spoofed verified).
- **LIVE-capable now vs needs operator/partner:**
  - **eTrack email — LIVE-capable** once the operator configures Cloudflare Email Routing → Worker (no code change). *Caveat:* the parsed eTrack format is UNVERIFIED best-effort until a real reminder email is captured and the sender/label/date patterns confirmed.
  - **NYSCEF — scaffolded, OFF.** No documented sanctioned JSON API exists; deliberately refuses to scrape the portal. Needs a sanctioned endpoint (vendor proxy / open-data export / UCS data agreement) + flags. Also covers only the e-filed L&T subset (pro se tenants exempt → often absent).
  - **Vendor — scaffolded, OFF.** A request/response template; needs a contracted court-data partner (fit `buildVendorRequest`/`mapVendorResponse`), a URL + secret key, and an attorney sign-off to flip `COURT_DATA_VENDOR_AUTHORITATIVE` (default-deny; otherwise a vendor hit is a cross-check only).
- **Effort:** **L** (no public API — sanctioned email ingest + partnership; ToS-sensitive; needs monitoring). **Dependencies:** Cloudflare Email Routing (eTrack); a sanctioned data path or court-data partner (NYSCEF/vendor); index # from intake. **External account/partner:** Email Routing config for eTrack; a court-data access arrangement for NYSCEF/vendor; legal sign-off on ToS + vendor accuracy SLA. Runbook: `web/docs/COURT-DATE-SOURCING.md`.

### 7. Court-packet PDF assembly via docassemble
- **What:** Fork the Suffolk LIT Lab **docassemble / ALDocumentBundle** *engine* (not the MA legal logic) to assemble NYC court-ready PDFs (Answer, Order to Show Cause to vacate default, restore-to-calendar) from the Case Object. Persist onto the now-missing `case.packets` field. Pair with NY Courts DIY Forms as the zero-liability backend where possible.
- **Why it beats a generic LLM:** generative PDFs from an LLM are a UPL/hallucination minefield (cf. the Block sanction). A deterministic, form-version-pinned assembler over tenant-confirmed facts is the safe, defensible path — and the "assembly" step is the documented whitespace.
- **Effort:** **L.** **Dependencies:** docassemble hosting (a separate service or container), NYC form schemas, the `packets` schema (review finding), legal review of each form. **External account/partner:** docassemble host; ideally a provider/clinic to validate forms.

### 8. KB embeddings retrieval via Vectorize + Workers AI
- **What:** Replace the keyword KB retrieval with semantic search: embed the validated KB with **Workers AI**, store/query in **Vectorize**, keep Citations for provenance. Grounds the know-your-rights Q&A (the Roxanne model) more reliably.
- **Why it beats a generic LLM:** grounded, cited answers from a *validated* NYC KB is the whole point of #12 in LLM-ARCH — a generic LLM answers from training data with no provenance and no NYC scoping.
- **Effort:** **M.** **Dependencies:** Vectorize, Workers AI bindings, a curated/validated KB. **External account:** none (Cloudflare-native); KB curation is the real work.

### 9. AI Gateway in front of all Anthropic calls
- **What:** Route every Anthropic request through Cloudflare **AI Gateway** for caching, per-route rate limiting, spend caps, logging, and fallback. Complements the Tier-1 rate limiter at the LLM layer specifically.
- **Why:** directly mitigates the cost-DoS finding and gives observability into model spend/latency.
- **Effort:** **S–M.** **Dependencies:** AI Gateway. **External account:** none (Cloudflare).

### 10. Evidence locker → R2-backed uploads
- **What:** Move evidence/document uploads to **R2** (object storage) with signed URLs and lifecycle/retention rules, instead of holding blobs in-flight. Tie retention to the Tier-1 purge job.
- **Why it beats a generic LLM:** organizing and OCR-tagging a tenant's real receipts/texts/repair photos into a packet is an action a generic LLM can't take.
- **Effort:** **M.** **Dependencies:** R2 bucket, the encryption/retention posture (#4). **External account:** none.

### 11. Eligibility engine (RTC / legal-aid / rental-assistance)
- **What:** Implement the fully-specified-but-unbuilt deterministic eligibility module (LEGAL-RULES §8), writing the three canonical slots with `determined_by='deterministic'`; config-driven (CityFHEPS toggle, ERAP closed). Powers warm referral to the *right* provider.
- **Why it beats a generic LLM:** eligibility is a deterministic legal determination, not a guess — and it's the input to a real referral action.
- **Effort:** **M.** **Dependencies:** the config registry; provider intake taxonomy. **External account:** none.

### 12. Provider GET redaction + state-machine conformance
- **What:** Apply the consent-`data_categories` projection on the provider read; gate attorney-only fields; fix `accept` to `referred→represented` per §4.4; add Idempotency-Key/ETag/If-Match on mutating routes.
- **Why:** privacy on a live deploy + the handoff state machine the whole referral flow depends on. (Confirmed Medium findings.)
- **Effort:** **M.** **Dependencies:** the `packets` schema. **External account:** none.

---

## TIER 3 — LATER (real value, but sequence after the moat is solid)

### 13. Voice / SMS-first channel
- **What:** A conversational intake + reminder channel over SMS (and eventually voice via Twilio), so a tenant with a feature phone or no app comfort can still use the core flow.
- **Why it beats a generic LLM:** maximum reach for the lowest-digital-literacy users; a generic LLM has no telephony, no scheduling, no NYC grounding.
- **Effort:** **L.** **Dependencies:** Twilio live (also unblocks reminders); the rate-limiter/OTP hardening (Tier 1) must land first or this becomes a toll-fraud surface. **External account/partner:** Twilio (paid).

### 14. Outcome tracking
- **What:** Anonymized, consented tracking of case outcomes (default avoided / answer filed / represented / dismissed) to measure impact, tune triage, and report to funders.
- **Why:** the funding/impact story and the eval rubric (Stanford Legal Design Lab partnership) — not something a generic LLM provides.
- **Effort:** **M.** **Dependencies:** retention/consent posture; provider feedback loop. **External account:** none (a Stanford eval-rubric partnership would strengthen it).

### 15. Rent-overcharge / DHCR rent-history
- **What:** Pull DHCR rent-registration history; flag potential rent-stabilization overcharge or improper deregulation as *information* (never a legal conclusion) feeding the provider handoff.
- **Why it beats a generic LLM:** live DHCR data + a deterministic flag is local-data moat; complements JustFix Rent History.
- **Effort:** **L.** **Dependencies:** DHCR data access (request-based, slow), legal framing review. **External account/partner:** DHCR data request process.

### 16. Deeper open-data + HP-action module
- **What:** Extend building intelligence (311 complaints, ECB/DOB violations) and add a repairs/HP-action path — coordinated with HCA's "Roxanne" (their stated complementary gap).
- **Why:** widens the local-data moat and opens a partnership lane.
- **Effort:** **M.** **Dependencies:** existing open-data plumbing. **External account/partner:** HCA partnership ideal.

### 17. Provider directory / referral integration
- **What:** Structured warm-referral into RTC/HRA-OCJ and LawHelpNY's 600+ provider directory; align taxonomy with the NYC Tenant Resource Portal.
- **Why:** the warm-handoff endpoint of the whole funnel; needs the eligibility engine (#11) to route to the *right* provider.
- **Effort:** **M–L.** **Dependencies:** #11; no public directory API exists (manual/partnership). **External account/partner:** provider partnerships (Phase-0 anchor partner already required).

---

## At-a-glance priority

| Tier | Feature | Effort | Moat dimension | External need |
|---|---|---|---|---|
| **Next ★** | Ownership/session + rate-limit + Turnstile | M | safe action | Turnstile |
| **Next ★** | Server-side safety persistence + court-date fix | S–M | action/audit | — |
| **Next ★** | End-to-end multilingual | M | reach | language partner (soft) |
| Next | Retention/deletion/encryption | M | trust/SHIELD | — |
| Next | Deploy/observability hardening | S | reliability | — |
| **Next ★** | "Your case" dashboard (anonymous-first + optional phone resume) | M | reach/retention | — |
| Soon | Live court-date (eTrack/NYSCEF) | L | local data | court-data partner |
| Soon | docassemble packet assembly | L | action | docassemble host |
| Soon | Vectorize + Workers AI KB | M | local data | — |
| Soon | AI Gateway | S–M | cost/observability | — |
| Soon | R2 evidence locker | M | action | — |
| Soon | Eligibility engine | M | action | — |
| Soon | Provider redaction + state machine | M | trust | — |
| Later | Voice/SMS-first channel | L | reach | Twilio |
| Later | Outcome tracking | M | impact | — |
| Later | Rent-overcharge / DHCR | L | local data | DHCR |
| Later | Open-data + HP-action | M | local data | HCA (soft) |
| Later | Provider directory referral | M–L | handoff | partnerships |

**The three to build next (★):** tenant ownership/boundary hardening, server-authoritative safety persistence + court-date fix, and end-to-end multilingual. They close the confirmed High-severity risks, are all S/M effort, and each advances a distinct moat dimension (safe action, accountability, reach) — turning the current "do not show a tenant" state into a pilot-ready, defensible MVP. **Live court-date sourcing (eTrack/NYSCEF)** is the most valuable *new* feature after that, but it's an L-effort, partnership-dependent build, so it leads Tier 2 rather than Tier 1.
