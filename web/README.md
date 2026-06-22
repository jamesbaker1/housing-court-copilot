# Housing Court Copilot

An ambitious, LLM-liberal AI eviction-defense **copilot** for NYC tenants. MVP
scope: **nonpayment** cases. This is a **guide, not a lawyer** — it gives
information, never legal advice, and is never marketed as an "AI lawyer."

The product uses the LLM liberally (document explainer, conversational copilot,
defense-spotting, answer drafting) and wraps every LLM output in clear,
contextual "verify this / not legal advice / check with a lawyer" UX —
disclaimers are a trust feature, not a footer.

## Two non-negotiable backstops

1. **Court date / countdown is code-backed and tenant-confirmed.** The
   authoritative `court.court_date` is deterministic (eTrack/NYSCEF-sourced) and
   only `court_date_verified` when so sourced — never trusted from the model. A
   wrong date can cause a default judgment.
2. **Advice-seeking turns are hard-routed to a human.** Questions like "should
   I…", "do I have a case", "which defense", or outcome prediction are detected
   and routed to a person + free-help hotline, never answered substantively
   (`review.advice_routed`).

## Stack

- **Next.js** (App Router) + **TypeScript** (strict) + **Tailwind CSS**
- **LLM:** official Anthropic TypeScript SDK (`@anthropic-ai/sdk`)
- **Schemas / validation:** `zod`
- **Hosting:** Cloudflare Workers via `@opennextjs/cloudflare` (one app, one platform)
- **State:** Cloudflare **D1** (serverless SQLite) in production; the store falls
  back to a local file store when no `DB` binding is present (plain `next dev`/tests)
- **Auth:** Cloudflare **Access** gates `/provider` (JWT verified with `jose`);
  optional D1-backed **SMS-OTP** lets a tenant resume a case on another device

Models (exact ids, no date suffix): `claude-opus-4-8` (default; quality/safety
surfaces), `claude-haiku-4-5` (cheap advice-detection classifier),
`claude-sonnet-4-6` (middle tier).

## Project layout

```
web/
  app/
    layout.tsx     # mobile-first; persistent "guide, not a lawyer" banner; imports globals.css
    globals.css    # Tailwind directives + base/component styles (calm, trustworthy theme)
    page.tsx       # foundation placeholder home page
  app/
    copilot/page.tsx   # the 7-step tenant flow (entry point for all features)
    provider/          # legal-aid triage console (consent-gated, NO AUTH in v1)
    api/               # intake, chat, defenses, answer, evidence, handoff,
                       #   cases, cases/[id], building, reminders, stipulation,
                       #   kb, provider/*
  lib/
    case.ts        # SHARED v1 Case Object — Zod schemas + inferred types (the spine)
    anthropic.ts   # Anthropic client + typed helpers (structured-extract, streaming-chat, model consts)
    disclaimers.ts # disclaimer copy + contexts + "talk to a person / free help" CTA
    store.ts       # dual-mode Case store (D1 when bound, else local file) — same interface
    auth/          # access.ts (Cloudflare Access JWT verify) + otp.ts (SMS-OTP resume)
    court-date.ts  # the ONLY writer of court_date_verified (etrack/nyscef => true)
    opendata/      # GeoSearch + HPD + JustFix WoW lookups + orchestrator
    sms/twilio.ts  # env-gated SMS sender (dry-run without creds, never throws)
    kb/            # curated citation corpus + offline TF-IDF retrieval
    llm/           # advice-classifier, copilot (RAG), extract, stip-review
  components/      # Disclaimer, ConfirmField, ChatPanel, BuildingIntel,
                   #   StipReview, ResourceList, provider/TriageList, ...
```

### Shared imports (conventions)

```ts
import { CaseSchema, type Case } from "@/lib/case";
import { structuredExtract, streamChat, OPUS, HAIKU, SONNET } from "@/lib/anthropic";
import { DISCLAIMERS, DisclaimerContext, TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";
```

`lib/anthropic.ts` is **server-only** (it reads `ANTHROPIC_API_KEY` and is
marked as a server external package). Never import it into a client component.

## Setup & run

```bash
cd /Users/jamesbaker/Desktop/housing-court-copilot/web

# 1. Install dependencies (needs network access to registry.npmjs.org).
npm install

# 2. Configure the one required secret.
cp .env.example .env.local
#    then edit .env.local and set a real key:
#    ANTHROPIC_API_KEY=sk-ant-...

# 3. Run the dev server.
npm run dev                 # http://localhost:3000  →  open /copilot for the flow
```

The app boots and the UI renders **without** an API key, but every LLM-backed
step (intake/extraction, the explainer, chat, defense-spotting, answer drafting,
settlement review) will return a 502/error until `ANTHROPIC_API_KEY` is set.
Persistence, open-data lookups, and the (dry-run) reminders work without an
Anthropic key. There is no other *required* config for v1 — see "Environment"
for the optional keys that unlock open-data rate limits and live SMS.

Other scripts:

```bash
npm run build      # production build (clears need: rm -rf .next if a stale
                   # cache reports a spurious "module not found")
npm run start      # serve the production build
npm run typecheck  # tsc --noEmit (strict)
```

## Cloudflare — local (no account) and deploy (your account)

This app deploys as a single Cloudflare Worker (`@opennextjs/cloudflare`) with state
in D1. **D1 has a local (miniflare) mode that needs no Cloudflare account**, so you can
develop and build the full stack offline.

```bash
# Local D1 (miniflare) — create/apply the schema with NO account:
npm run db:migrate:local       # = wrangler d1 migrations apply housing-court-copilot --local

# Build the Worker bundle (also needs no account):
npx opennextjs-cloudflare build   # emits .open-next/worker.js + assets
                                  # rm -rf .next .open-next first if a stale cache errors

# Inspect / smoke-test the local D1 directly:
npx wrangler d1 execute housing-court-copilot --local \
  --command "SELECT case_id, status, court_date FROM cases ORDER BY updated_at DESC LIMIT 5;"
```

In plain `next dev` the store uses the **local file store**; `initOpenNextCloudflareForDev()`
(in `next.config.mjs`) exposes the `DB` binding when present so the D1 path is exercised
under the Workers runtime.

**Going live needs your Cloudflare account.** The full operator runbook
(`wrangler login` → `wrangler d1 create` → paste `database_id` into `wrangler.toml` →
`wrangler d1 migrations apply --remote` → `wrangler secret put ...` → configure the
Access app over `/provider` → `npm run deploy`) lives in
[`../DEPLOY-CLOUDFLARE.md`](../DEPLOY-CLOUDFLARE.md). Provider-auth specifics are in
[`docs/PROVIDER-AUTH.md`](docs/PROVIDER-AUTH.md). **Do not run `wrangler deploy` or the
remote `wrangler d1 create` without confirming first** — those are account-gated.

## Features

Beyond the core 7-step `/copilot` flow, v1 ships:

- **Persistence** — a dual-mode Case store (`@/lib/store`): **Cloudflare D1** when
  the `DB` binding is present, else a local file store (default `<cwd>/.data/cases`),
  same interface either way. The `/copilot` page mints/restores a real `case_id`
  (localStorage `hcc_case_id`) and PATCHes confirmed fields, chat review
  updates, open-data evidence, and reminder consent back onto the Case. Every
  read/write re-validates the full Case with `CaseSchema` regardless of backend.
- **Optional "resume on another device"** (reminders step) — a collapsed,
  opt-in `ResumeByPhone` affordance lets a tenant link this case to a verified
  phone via SMS-OTP (`POST /api/auth/otp/request` + `/verify`). It is **never a
  login wall** — the copilot works fully without it; tenants stay anonymous by default.
- **Landlord & Building Intelligence** ("Look up my building", on the summary
  step) — joins NYC open data: GeoSearch (address→BBL), HPD
  violations/complaints/registration, and JustFix Who Owns What. Every item
  becomes open-data **evidence with a `verify_before_file` gate that starts
  `unverified`**; the tenant taps "I checked this against my records" to verify.
  Nothing is ever auto-filed.
- **SMS court-date reminders** (reminders step → `POST /api/reminders`) —
  consent-gated (TCPA), records an `sms_reminders` Consent + phone, and
  deterministically schedules 7/3/1-day reminders **only off an authoritative
  (eTrack/NYSCEF-verified) court date**. Until that date is verified it saves
  consent but schedules nothing, and the UI says so. Sending runs in **dry-run**
  unless Twilio creds are present.
- **Settlement / stipulation reviewer** ("Review a settlement offer", on the
  chat step → `POST /api/stipulation`) — uploads a stip/settlement and returns a
  neutral, term-by-term breakdown. The schema is **structurally incapable** of a
  sign/don't-sign recommendation; a fixed "do not sign before a lawyer reviews
  this" banner is always shown; anything needing judgment routes to a human.
- **Citation knowledge base** — a curated, offline NYC nonpayment-basics corpus
  (`@/lib/kb`) grounds the copilot, and a sources panel on the chat step
  (`POST /api/kb`) shows the vetted public pages behind the answers. Corpus is
  **seed data pending attorney review** (`CORPUS_REVIEW_STATUS`).
- **Provider console** (`/provider`, linked from `/copilot` as "Legal-aid
  provider view") — a separate, consent-gated triage queue + case detail with
  accept/refer/decline actions. **No auth in v1** (see stubbed list).

## What works vs. what's stubbed (honest status)

Verified locally in this environment: `npm run typecheck` (tsc --noEmit) exits
**0**, and a clean `npm run build` compiles **5 pages + 11 API routes (16 routes
total)** with no type or webpack errors. **Nothing here was exercised against
live external services in this session** — no Anthropic API key, no Twilio
creds, and no live calls to NYC GeoSearch / Socrata (HPD) / JustFix were made.
The code paths are wired and type-correct; treat any "it works" below as
"compiles + contracts aligned," not "ran against production."

**Works (code-complete, compiles, contracts aligned):**

- **The 7-step `/copilot` flow** — upload → confirm fields → plain-English
  summary (+ "Look up my building") → chat (+ sources + "Review a settlement
  offer") → possible issues → draft answer → reminders/hotline.
- **Persistence is real.** `POST /api/cases`, `GET|PATCH /api/cases/[id]`, and a
  file-based store with atomic writes, `CaseSchema` validation, and
  path-traversal rejection. The page rehydrates a prior session.
- **Backstop #2 (advice routing) is genuinely wired before the copilot.** The
  `/api/chat` route runs the advice classifier (`screenTurn`) *first*; an
  advice-seeking turn is hard-routed (model suppressed, fixed non-advice
  response + "talk to a person" CTA) and the screen **fails closed** to
  route-to-human on any error. `review.advice_routed` is written **only** when a
  schema-valid full `Case` is supplied (single-writer invariant respected).
- **Backstop #1 (court-date gate) holds end-to-end.** The confirm step blocks
  advancing until the tenant confirms the court date. `court_date_verified=true`
  is set **only** by `lib/court-date.setCourtDate` for `etrack`/`nyscef`
  sources; the tenant-entry path in the page hardcodes `false`, and the model
  never sets it. Reminders refuse to anchor off an unverified date.
- **Open-data verify gate holds.** Building-intel evidence is built via
  `buildOpenDataAssertion` (`verify_before_file.state = "unverified"`); the
  building route only PATCHes evidence/parties/property and never touches
  filing/status — nothing is auto-filed.
- **Document intake/explainer** (`/api/intake`), **defense-spotting**
  (`/api/defenses`), **answer transcription** (`/api/answer`), **evidence**
  (`/api/evidence`), **handoff** (`/api/handoff`), **KB** (`/api/kb`),
  **stipulation review** (`/api/stipulation`), **building** (`/api/building`),
  **reminders** (`/api/reminders`), **provider** (`/api/provider/*`) — all
  implemented; request/response shapes match what the frontend sends and reads.
- **Disclaimers everywhere** LLM output is shown; the persistent "guide, not a
  lawyer" banner; the free-help hotline / "talk to a person" CTA.

**Stubbed / not yet built / unverified (v1 boundaries — be honest):**

- **eTrack / NYSCEF court-date sourcing is a non-networked stub**
  (`lib/court-source.ts` → `lookupCourtDate` returns `found:false`). The
  verified-write SINK is correct, but there is no live producer, so in v1 a
  court date is tenant-entered/**unverified** and reminders will not arm off it.
  **Do not rely on any date here to avoid a default — confirm against the
  official court papers.**
- **SMS is dry-run by default.** With `TWILIO_*` absent the pipeline schedules +
  logs but never sends. Live sending also needs an approved A2P 10DLC
  brand/campaign. The STOP/opt-out ledger is **in-memory** (resets on restart)
  and there is no inbound-STOP webhook yet. `sendDueReminders()` exists but is
  not yet invoked by any scheduler/cron.
- **Open-data lookups were not run live here.** GeoSearch/Socrata/JustFix are
  called live at request time (no cache / rate-limiter / circuit-breaker in v1);
  the orchestrator degrades gracefully (never throws) but the exact upstream
  response shapes (esp. JustFix WoW) are parsed defensively and **not
  independently re-confirmed against the live APIs in this session**.
- **KB corpus is seed data pending attorney review.** Every entry and source URL
  needs attorney sign-off + live-URL verification before relying on it. Retrieval
  is keyword/TF-IDF only (no embeddings).
- **Provider console has NO auth/authz (v1 blocker).** `/provider` and
  `/api/provider/*` are gated by consent only, not by a provider principal;
  there is no per-provider scoping or `data_categories` redaction. A visible
  in-product warning says so. Must not be exposed to real data as-is.
- **Attorney-validated deadline config is intentionally empty.**
  `UNVALIDATED_DEADLINE_CONFIG` / `UNVALIDATED_REMINDER_CONFIG` have all
  legally-operative values nulled and marked "ATTORNEY MUST VALIDATE," so the
  generic deadline engine schedules nothing until a lawyer populates the rules.
  (The court-date reminder config is separate and active, but still gated on a
  verified date as above.)
- **LegalServer handoff delivery** is not implemented. `lib/handoff.ts` builds a
  typed packet + plain-text summary only; no Trigger-XML/PDF assembly or
  delivery call.
- **Citations** (Surface 2 Pass B) are skipped for v1 (incompatible with
  structured parsing), so extraction provenance `locator` is unset.
- **SDK pin deviation:** `@anthropic-ai/sdk@0.69.0` does not expose
  `messages.parse` + `zodOutputFormat` or adaptive thinking/`effort`. The
  foundation `lib/anthropic.ts` therefore uses the **beta** parse surface and
  maps `hardReasoning` to extended thinking (`thinking:{type:"enabled"}`). The
  house-style snippet below documents the *intended* API for when the SDK is
  upgraded; the shipped helpers already encapsulate the working calls.

## Environment

See `.env.example`. Secrets live in env only — never hardcoded, never committed.

| Variable | Required? | Used by | Effect if absent |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | **Required** for LLM steps | intake, chat, defenses, answer, stipulation | LLM steps error; non-LLM features still work |
| `SOCRATA_APP_TOKEN` | Optional | building intel (HPD lookups) | Works at low volume (anonymous rate limit) |
| `TWILIO_ACCOUNT_SID` | Optional | SMS reminders | Reminders run in **dry-run** (schedule + log, never send) |
| `TWILIO_AUTH_TOKEN` | Optional | SMS reminders | as above |
| `TWILIO_FROM` | Optional | SMS reminders | as above |
| `HCC_DATA_DIR` | Optional | Case store | Defaults to `<cwd>/.data/cases` |

NYC GeoSearch (address→BBL) and JustFix Who Owns What are **keyless** — no env
needed. Live SMS additionally requires an approved A2P 10DLC brand/campaign.

## House-style notes for module engineers

- Structured outputs: `messages.parse` + `zodOutputFormat` → read
  `parsed_output` (null-guard it). Do **not** use the deprecated top-level
  `output_format`.
- Hard reasoning (defense-spotting, answer draft): `thinking: { type: "adaptive" }`
  + `output_config: { effort: "high" }`. **Never** `budget_tokens`.
- Chat/copilot: `messages.stream(...)`, stream deltas, `await stream.finalMessage()`.
- Vision/PDF: image/document block **before** the text block (see the helpers in
  `lib/anthropic.ts`).
- Citations are incompatible with `output_config.format` — never combine in one
  call. For v1 extraction, do the structured pass only.
- Add a clear, friendly disclaimer wherever LLM output is shown
  (`@/lib/disclaimers`).
- The five LLM/DETERMINISTIC boundary invariants are enforced as Zod `literal`
  constants in `lib/case.ts` (`computed_by`, `determined_by`, `placed_by`,
  `transcription_only`, `surfaced_as`) — do not work around them.

> Foundation-owned files (do not modify): `package.json`, `tsconfig.json`,
> `next.config.mjs`, `postcss.config.mjs`, `tailwind.config.ts`,
> `app/layout.tsx`, `app/globals.css`, `lib/case.ts`, `lib/anthropic.ts`,
> `lib/disclaimers.ts`.
