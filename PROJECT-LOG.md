# Project Log — Housing Court Copilot

_A complete, honest record of what we built and did. Newest concerns at the bottom (§9–10). Last updated 2026-06-23._

## What it is
An open-source, mobile-first AI copilot for NYC tenants facing eviction (MVP: nonpayment). Thesis: **a "legal-aid intake autopilot," not an "AI lawyer"** — it classifies, explains, transcribes the tenant's own facts, assembles packets, and routes to a human; it's conservative on legal conclusions. Built with strong safety guardrails because the failure mode is someone losing their home.

---

## 1. Strategy & research (docs at repo root)
- **`PLAN.md`** — the product plan + "intake autopilot" positioning.
- Research workflow (verified against 2026 facts + adversarially critiqued) → **`COMPETITIVE-LANDSCAPE.md`**, **`POSITIONING.md`**, **`INTEGRATIONS.md`** (prioritized integration matrix), **`RISKS-AND-COMPLIANCE.md`** (UPL/S7263, SHIELD, FCRA, no-scrape), **`SOURCES.md`**.
- **`LLM-ARCHITECTURE.md`** — where LLMs help vs. where deterministic code is mandatory (the boundary).

## 2. Engineering spec (`spec/`)
A spec workflow produced the canonical design, then a reconciliation pass fixed cross-file inconsistencies (ERAP placement, `advice_routed` ownership, registration mapping, rent-demand input, answer-filed predicate):
- `spec/CASE-OBJECT.md` (the canonical Case Object + machine-checkable safety consts), `LLM-SCHEMAS.md`, `TOOL-CONTRACTS.md`, `LEGAL-RULES.md` (attorney-validate scaffold), `API-CONTRACTS.md`, `GUARDRAILS-SPEC.md`, `DATA-SECURITY.md`.

## 3. The app (`web/`) — built via workflows
- **v1 build:** Next.js 15 + TS + Tailwind + Anthropic SDK. Vision intake + extraction + plain-English explainer, copilot chat with a **fail-closed advice-detection guardrail**, defense-spotting, answer-draft (faithful transcription), evidence, resources/handoff, disclaimer/verify UX, and a **deterministic court-date backstop**.
- **Moat features:** persistence + `case_id` (dual-mode store), **building intelligence** (HPD violations/complaints/registration + JustFix Who Owns What via GeoSearch BBL), reminders (Twilio dry-run), citation KB, **provider triage console** (`/provider`), stipulation reviewer, SMS-OTP. (Caught a `node:crypto` client-bundle bug.)

## 4. Four safety invariants (enforced + repeatedly re-verified)
1. Advice classifier runs before any authoring LLM call and **fails closed**.
2. `court_date_verified=true` only via `setCourtDate` with an authoritative source (eTrack/NYSCEF) — never tenant/model/client.
3. Open-data items carry `verify_before_file="unverified"` and never auto-file.
4. `advice_routed`/deadlines/eligibility written only by server-side deterministic code on a schema-valid Case.

## 5. Open source
Published **public** to GitHub under **MIT**: **https://github.com/jamesbaker1/housing-court-copilot** (after a secret scrub + `.gitignore` + `LICENSE` + README; fixed an SSH/HTTPS two-account mismatch by pushing via the `gh` credential helper).

## 6. Cloudflare (all-Cloudflare stack)
- Migration workflow: store → **Cloudflare D1** (dual-mode), **@opennextjs/cloudflare** for Workers, **Cloudflare Access** on `/provider`, SMS-OTP resume, `wrangler.toml`, migrations. (Caught/fixed two disk-corrupted source files.)
- **Deployed:** `https://housing-court-copilot.james-baker1628.workers.dev`, remote D1 created + migrated, daily PII-purge Cron.

## 7. Review → hardening → dashboard → court-date
- **Review+roadmap workflow** → `REVIEW.md` (found an unauthenticated IDOR, no rate-limiting, a silent court-date save bug, PII gaps) + `ROADMAP.md`.
- **Boundary-hardening workflow** → fixed all confirmed High findings (ownership gate, rate-limit, **Turnstile**, server-authoritative `advice_routed`, court-date save, PII retention/encryption module, repo hygiene). Verified + **redeployed** (worker version `34daba78`).
- **"Your case" dashboard workflow** → `/case` persistent **anonymous-first** dashboard + optional passwordless phone resume. Verified + **redeployed** (worker version `139894b8`).
- **Court-date sourcing workflow** → legitimate, **no-scrape** connector: eTrack email-ingest (Cloudflare Email Worker), NYSCEF + vendor adapters (gated off by default), Invariant #2 held (12/12 harness). Committed to GitHub (`f49c9fc`).
- **`REVIEW-PLAYBOOK.md`** — a Fable-optimized kit to re-review everything on demand.

## 8. Production-readiness review
- **Production-readiness workflow** (8 dimensions incl. UI/UX, a11y, reliability, ops, perf, testing/CI) → **`PRODUCTION-READINESS.md`**: **verdict: NOT production-ready** (76 findings, 26 high). Key blockers/gaps:
  - **M1 [BLOCKER]:** chat/defenses/answer/stipulation verify a Turnstile token server-side and **403 in prod**, but the client never sends one → app dead-ends past step 3.
  - **M8:** PII stored as **plaintext** in D1 (the encryption module isn't wired into the store).
  - **M11:** `/api/reminders` + `/api/building` not ownership-gated/rate-limited.
  - **Zero automated tests / no CI**; no health check/monitoring; a11y + multilingual gaps.

---

## 9. ⚠️ Current state (honest, as of this writing)
- **GitHub (public):** up to date at commit **`f49c9fc`** (includes court-date sourcing + the playbook).
- **Cloudflare (live):** worker version **`139894b8`** — the **hardened build + dashboard**. NOTE: this is *behind* GitHub — **court-date sourcing was committed but NOT deployed** (it's inert without Email Routing setup anyway).
- **Secrets not set** (`ANTHROPIC_API_KEY`, `TURNSTILE_*`, `CASE_PII_KEY`, `CF_ACCESS_*`) → the live app is **not functional yet**, and because of M1 it would 403 past step 3 in prod config until fixed.
- **The MUST-fix work is NOT applied.** The production fix workflow **failed twice** — first on a session limit, then the agents **stalled for ~9 hours**. **None of M1–M12 are fixed.** The working tree in `web/` may contain **partial, unverified edits** from those failed runs that I had not yet assessed (the assessment command was interrupted). **Last known-good committed state is `f49c9fc`.**

## 10. Open work
- **MUST tier (software, from `PRODUCTION-READINESS.md`):** M1 Turnstile token threading (blocker), M8 wire PII encryption, M11 gate reminders/building, M12 LLM spend ceiling, M4 health endpoint, M5 cron alerting, M6/M7 client timeouts + localized error UX, M9 a11y, M10 localize disclaimers, M2/M3 tests + CI. **Lesson learned:** the monolithic xhigh fix workflow is unreliable — do these in small, directly-verified increments instead.
- **SHOULD / NICE:** see `PRODUCTION-READINESS.md` and `ROADMAP.md`.
- **Non-code Phase-0 gates (the real bottleneck to helping anyone):** a NY-licensed attorney to populate/validate the `LEGAL-RULES` config; a funded legal-aid/RTC provider partner for the handoff; distribution/trust to reach the actual population. Production-grade software is necessary but **not sufficient** without these.
