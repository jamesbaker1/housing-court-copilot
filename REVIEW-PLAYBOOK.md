# Review Playbook — Housing Court Copilot

_A self-contained kit to comprehensively re-review this whole project at any time, optimized for running with **Claude Fable 5** (`claude-fable-5`), Anthropic's most capable model. The first such review (2026-06-22) produced `REVIEW.md`; this playbook lets you repeat it — deeper — on demand._

> **On "when Fable comes out":** `claude-fable-5` is already a current model id, so you can run this now. If a newer Fable lands later, everything below still applies — just swap the model id. The playbook is model-agnostic but tuned for Fable's strengths (huge context + strong adversarial reasoning).

---

## 0. How to run the review with Claude Fable 5

**Model:** `claude-fable-5`. In Claude Code, set the session model to it (or pass `model: "claude-fable-5"` to the `Workflow` agents). Use **`effort: "high"`** for most dimensions and **`"xhigh"` / `"max"`** for the safety + security passes.

**Fable operating notes that matter for a reviewer (from the Claude API reference):**
- **Thinking is always on.** Do *not* set a `thinking` budget (`budget_tokens` 400s; an explicit `thinking:{type:"disabled"}` 400s too). Omit `thinking` or use `{type:"adaptive"}`; control depth with `output_config.effort`.
- **1M context** — Fable can hold large slices of the codebase at once. Still **fan out by dimension** for depth (one focused reviewer beats one giant prompt).
- **Refusal + fallbacks (important here).** This codebase is security- and legal-adjacent (auth, rate-limiting, a court-data *no-scrape* boundary, "cyber"-shaped topics). Fable's safety classifiers can occasionally false-positive on benign security-review work. **Opt into server-side fallbacks** — `betas:["server-side-fallback-2026-06-01"]` + `fallbacks:[{model:"claude-opus-4-8"}]` — so a declined turn is transparently rescued. (Running the review through Claude Code's Workflow tool handles this for you.)
- **30-day data retention required** — Fable is not available under zero-data-retention. Confirm the org/setting allows it before the run.
- **Prompt style:** Fable prefers a clear **goal + constraints** over prescriptive step-by-step. Give it the dimension + the red-lines and let it investigate; over-scripting *reduces* quality.

**Recommended shape:** fan out reviewers by dimension → **adversarially verify** every high/critical finding (try to *refute* it against the source) → synthesize. This is exactly how `REVIEW.md` was produced. A ready-to-run Workflow outline + a paste-ready prompt are in §5.

---

## 1. What you're reviewing (project map)

**Docs (repo root + `spec/`):** `PLAN.md` (product + the "legal-aid intake autopilot" positioning), `POSITIONING.md`, `COMPETITIVE-LANDSCAPE.md`, `INTEGRATIONS.md`, `LLM-ARCHITECTURE.md`, `RISKS-AND-COMPLIANCE.md`, `SOURCES.md`, `DEPLOY-CLOUDFLARE.md`, `DATA-SECURITY.md`, `REVIEW.md` (last review), `ROADMAP.md` (ranked features), and `spec/` (`CASE-OBJECT.md`, `LLM-SCHEMAS.md`, `TOOL-CONTRACTS.md`, `LEGAL-RULES.md`, `API-CONTRACTS.md`, `GUARDRAILS-SPEC.md`, `DATA-SECURITY.md`).

**App (`web/`):**
- Routes: `app/copilot/` (stepped intake flow), `app/case/` (the "your case" dashboard), `app/provider/` (Access-gated triage console), `app/api/*` (cases, chat, intake, defenses, answer, evidence, handoff, kb, reminders, stipulation, building, provider, auth/otp, cases/[id]).
- Core libs: `lib/case.ts` (the **canonical Case Object** + the machine-checkable safety consts), `lib/store.ts` (dual-mode D1/file store), `lib/anthropic.ts` (LLM helpers), `lib/auth/session.ts` + `lib/auth/otp.ts` (ownership/session + SMS-OTP), `lib/ratelimit.ts`, `lib/turnstile.ts`, `lib/crypto-field.ts` (PII encryption), `lib/retention.ts` (purge), `lib/court-date.ts` (`setCourtDate` — the only writer of `court_date_verified`), `lib/court-source/*` (the court-date sourcing connector + adapters), `lib/deadlines.ts`, `lib/opendata/*` (HPD/WoW/GeoSearch), `lib/kb/*`, `lib/llm/*`, `lib/caseClient.ts` (client auth/storage contract).
- `middleware.ts` (Access gate + matcher), `worker-entry.ts` (Cloudflare worker: `fetch` + `scheduled` cron + `email` handler), `wrangler.toml`, `migrations/`.

**Deploy/repo:** Cloudflare Workers (via `@opennextjs/cloudflare`) + D1 + Cloudflare Access (`/provider`) + a daily PII-purge Cron + Email Routing (court-source). Live: `housing-court-copilot.james-baker1628.workers.dev`. Public repo: `github.com/jamesbaker1/housing-court-copilot`.

---

## 2. Invariants & red-lines (check every review)

1. **Advice classifier runs before any authoring LLM call and fails closed** (any error → route-to-human; model suppressed). Applies to `/api/chat`, `/api/answer`, `/api/defenses`.
2. **`court.court_date_verified === true` only via `lib/court-date.setCourtDate` with `source ∈ {etrack, nyscef, court_data_vendor*}`** — never tenant/model/client. `CourtSchema.superRefine` + `stripSafetyOwnedFields` enforce it at the API boundary. *(\*vendor source is an ops/attorney call — see court-source.)*
3. **Open-data items carry `verify_before_file="unverified"` and never auto-file.**
4. **`review.advice_routed` / `deadlines[].computed_by` / `eligibility.*.determined_by` / `answer_draft.form_fields[].placed_by` are written only by server-side deterministic code on a schema-valid Case** — never by an unauthenticated/client patch.
- **UPL / FTC / S7263:** no individualized legal advice in any output; never marketed as "a lawyer"; the chatbot-proprietor liability (S7263) means architecture, not just disclaimers, must keep outputs on the information side.
- **No live-portal scraping** of eCourts/WebCivilLocal/eTrack (ToS/CAPTCHA/CFAA). Court-date sourcing uses only sanctioned channels (eTrack email ingest, opt-in NYSCEF docket, configured vendor).
- **Data minimization / SHIELD / immigration:** immigration status not collected unless a defense requires it; PII encrypted (`CASE_PII_KEY`); retention purge + tenant delete; per-recipient, severable consent; never furnish to landlords (FCRA).
- **Boundary auth:** `/api/cases/[id]` ownership-gated; rate-limited; Turnstile on public entry points.
- **Phase-0 gates before real tenants:** a NY-licensed attorney must populate/validate the deadline + eligibility config; a funded legal-aid provider partner for the handoff. Until both, it's pilot/demo only.

---

## 3. Review dimensions + per-dimension checklist

Run one reviewer per dimension. For each: read the cited files, find real issues, cite `file:line`, assign severity + confidence.

| Dimension | Check | Key files |
|---|---|---|
| **Correctness/bugs** | logic errors, edge cases, races, broken route↔client contracts, D1 read-modify-write + index derivation | `lib/store.ts`, `lib/llm/*`, `lib/deadlines.ts`, `lib/court-source/*`, `app/api/*` |
| **Safety invariants & UPL** | verify all four invariants hold at every write path; no LLM-authored deadline/eligibility/advice; outbound scanner coverage; disclaimer presence | `app/api/chat\|answer\|defenses`, `lib/llm/advice-classifier.ts`, `lib/court-date.ts`, `lib/case.ts` consts |
| **Security / secrets / PII** | re-scan the **public** repo for committed secrets/PII; Access JWT verify not bypassable in prod; OTP rate-limit/hash/non-enumerable; rate-limit + Turnstile on every public route; PII encryption + retention actually wired | `middleware.ts`, `lib/auth/*`, `lib/ratelimit.ts`, `lib/turnstile.ts`, `lib/crypto-field.ts`, `lib/retention.ts`, `wrangler.toml`, `.gitignore` |
| **Cloudflare / D1 / Workers runtime** | `nodejs_compat`; dual-mode store D1 path; migrations; Worker CPU/streaming limits; `node:*` that won't run on Workers; the `email()`/`scheduled()` handlers in the bundle | `wrangler.toml`, `next.config.mjs`, `open-next.config.ts`, `worker-entry.ts`, `lib/store.ts` |
| **Spec ↔ code alignment** | code matches `spec/CASE-OBJECT.md` + the spec contracts; deadline engine vs `LEGAL-RULES.md` (note unpopulated attorney config); provider state machine | `lib/case.ts` vs `spec/*`, `app/api/*` vs `spec/API-CONTRACTS.md` |
| **UX / accessibility / reach** | mobile-first, low-literacy copy; court-date gate UX; **multilingual end-to-end** (selector + persisted language + localized strings); anonymous-first preserved; a11y | `app/copilot/page.tsx`, `app/case/page.tsx`, `components/*`, `lib/i18n*` |
| **Court-date sourcing (new)** | the **no-scrape boundary** is honored; verified writes route through `setCourtDate`; discrepancy → escalate (not overwrite); adapters degrade safely; vendor/NYSCEF gated off by default | `lib/court-source/*`, `worker-entry.ts` `email()`, `docs/COURT-DATE-SOURCING.md` |
| **Auth/session & dashboard (new)** | same-device capability-token round-trip works; unauth = 403 (no existence oracle); OTP→owner-session cross-device read; cross-tenant denied; no login wall | `lib/auth/session.ts`, `lib/caseClient.ts`, `app/case/page.tsx`, `app/api/cases/[id]/route.ts` |

**Adversarial verify** every critical/high finding: a second pass that tries to *refute* it against the source before it's reported (kills false alarms — e.g., the first review refuted a "silent data loss on Workers" claim).

---

## 4. Independent verification commands (so a reviewer verifies, not just reads)

From `web/`:
```bash
# Clean build chain (deploy target)
rm -rf .next .open-next tsconfig.tsbuildinfo
npm run typecheck && npm run build && npx opennextjs-cloudflare build

# Corruption scan — REAL corruption only (size>0 AND 0 allocated blocks; ignore 0-byte files like client-only/index.js)
while IFS= read -r f; do [ "$(stat -f %b "$f")" = 0 ] && echo "CORRUPT: $f"; done < <(find .open-next .next -type f -size +0c)

# Local D1 (no Cloudflare account needed — miniflare)
npx wrangler d1 migrations apply housing-court-copilot --local

# Live auth probes against a real local-D1 preview (gating is REAL, not dev-open):
npx opennextjs-cloudflare preview   # then: POST /api/cases (expect 201 + case_token);
#   GET /api/cases/<id> with Bearer <token> → 200; no token / bogus token → 403;
#   PATCH court_date_verified:true,source:"nyscef" with a client token → response shows verified:false (stripped)

# Public-repo secret re-scan
git ls-files | xargs grep -nIE 'sk-ant-|gho_|ghp_|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY-----' 2>/dev/null
```

---

## 5. Ready-to-run review (Fable)

**Workflow shape** (Claude Code `Workflow` tool, `model: "claude-fable-5"`):
1. **Review** — `parallel` over the 8 dimensions in §3, each a reviewer agent (`effort:"high"`, structured findings: title/severity/confidence/`file:line`/fix).
2. **Verify** — `parallel` over the critical/high findings, each an agent that tries to **refute** it against the source (`effort:"xhigh"`).
3. **Synthesize** — one agent writes an updated `REVIEW.md` (confirmed findings, "top fixes before real tenants") + refreshes `ROADMAP.md`.

**Paste-ready reviewer prompt (per dimension):**
> You are reviewing the Housing Court Copilot (read `REVIEW-PLAYBOOK.md` §1–2 for the map + the invariants). Review the **<DIMENSION>** dimension only. Read the cited files. Your goal: find real, confirmable issues that matter for putting a vulnerable tenant in front of this — and verify the §2 invariants/red-lines hold. Cite `file:line`, assign severity (critical/high/medium/low/nit) + confidence, and give a concrete fix. Be adversarial; no false alarms — mark anything uncertain low-confidence. Do not modify code.

**Then, before trusting any high finding:**
> Adversarially verify this finding by reading the actual code. Try to *refute* it — is it really exploitable, or already mitigated / a false alarm? Default to skepticism; return is_real + adjusted severity + why.

---

## 6. Known open items / where new risk hides

- **From the last `REVIEW.md`:** the confirmed High findings (boundary IDOR, no rate-limit, forgeable `advice_routed`, court-date save bug, PII retention) were **fixed + redeployed** — re-confirm they're still closed and weren't regressed.
- **Newest surfaces (most likely to hide new bugs):** the court-date sourcing connector + the `email()` Worker handler + the no-scrape boundary; the `/case` dashboard auth (capability token + OTP resume); the hardening primitives (`ratelimit`, `turnstile`, `crypto-field`, `retention`).
- **Still deferred / out of scope (don't re-flag as new):** live court-date coverage is partial (eTrack email-ingest + opt-in NYSCEF + a vendor hook — no magic "fetch any date"); the attorney-validated deadline/eligibility config is unpopulated; the funded provider partner isn't secured. These are the Phase-0 gates, tracked in `ROADMAP.md` / `REVIEW.md`.
- **Operator-config-dependent (verify behavior, not code):** the live app needs `ANTHROPIC_API_KEY`, `TURNSTILE_*`, `CASE_PII_KEY`, `CF_ACCESS_*` set; until then some paths fail closed by design.
