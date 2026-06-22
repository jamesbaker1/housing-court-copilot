# Housing Court Copilot

An open-source, mobile-first **AI copilot for tenants facing eviction in NYC** (MVP: nonpayment cases). It helps a tenant photograph their court papers, understand them in plain language, confirm the key facts, surface possible defenses to raise *with a lawyer*, draft a factual answer, look up their building's housing-code/landlord record, and not miss their court date — then hands a clean, consented intake to a legal-aid provider.

> ⚠️ **This is information, not legal advice, and it is not a lawyer.** It is designed to *inform, organize, and route to real help* — not to replace an attorney. It is conservative on legal conclusions: advice-seeking questions are routed to a human, court dates are tenant-confirmed, and open-data findings must be verified before they're relied on. See `RISKS-AND-COMPLIANCE.md`.

## What's in here

| Path | What it is |
|------|-----------|
| `web/` | The Next.js app (App Router, TypeScript, Tailwind, Anthropic SDK, deployable to Cloudflare Workers) |
| `PLAN.md` | Product plan and the "legal-aid intake autopilot" positioning |
| `spec/` | The full engineering spec — canonical Case Object, LLM call schemas, deterministic tool contracts, NYC nonpayment legal rules, API + state machine, guardrails, data security |
| `COMPETITIVE-LANDSCAPE.md`, `POSITIONING.md`, `INTEGRATIONS.md`, `LLM-ARCHITECTURE.md`, `RISKS-AND-COMPLIANCE.md`, `SOURCES.md` | Strategy, integration, and compliance docs |
| `DEPLOY-CLOUDFLARE.md` | The all-Cloudflare deploy runbook (Workers + D1 + Access) |

## Design principles

- **TurboTax for surviving a housing case, not "ChatGPT for legal advice."** The AI classifies, explains, transcribes the tenant's own facts, assembles packets, and routes to humans.
- **Two safety backstops that an LLM alone can't provide:** the court date / deadline is deterministic code + tenant-confirmed (never trusted from the model), and advice-seeking turns are hard-routed to a person (fail-closed).
- **Grounded, not hallucinated:** building/landlord facts come from NYC Open Data + JustFix Who Owns What (each behind a "verify before you file" gate), and the copilot is grounded in a citable knowledge base.
- **Privacy by minimization:** immigration status is not collected unless a specific defense requires it; consent for any handoff is per-recipient and severable.

## Quick start (local)

```bash
cd web
npm install
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env.local   # required for the LLM features
npm run dev        # http://localhost:3000/copilot
```

Optional env: `TWILIO_*` (live SMS reminders/OTP; dry-runs without it), `SOCRATA_APP_TOKEN` (NYC open-data rate limits). See `web/.env.example`.

## Deploy (Cloudflare)

One platform: Next.js on **Workers** (via `@opennextjs/cloudflare`), **D1** for state, **Cloudflare Access** gating the `/provider` console. Full account-gated runbook in `DEPLOY-CLOUDFLARE.md` (`wrangler login` → `wrangler d1 create` → set secrets → configure Access → `npm run deploy`).

## Status (honest)

This is a **v1 skeleton with real LLM wiring** — it builds clean and the safety backstops are enforced in code, but it is **not production-ready for real tenants**:

- The deterministic **deadline/eligibility rules are unpopulated** and must be filled in and validated by a NY-licensed attorney (the Phase-0 gate).
- Court-date sourcing (eTrack/NYSCEF), and a funded legal-aid provider partner for the handoff, are not yet wired/secured.
- LLM behavior has not been evaluated against the live API at scale.

Going live for real tenants requires a supervising attorney and a provider partner. See `RISKS-AND-COMPLIANCE.md` for the UPL, data-security, and liability posture.

## License

[MIT](./LICENSE).
