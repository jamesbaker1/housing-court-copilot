# Deploy Plan — All-Cloudflare (staged; run after the current build verifies)

**Goal:** publish the whole app on one Cloudflare account/dashboard — Workers + D1 + Cloudflare-native auth — so everything fits together with no third-party services. This is the runbook for the next workflow (per "use workflows for everything"); it does **not** run until the moat-features build is verified green.

## Target architecture (one platform)
- **App → Cloudflare Workers** via `@opennextjs/cloudflare` (the one Next.js app deploys as a single unit; App Router, API routes, and the NDJSON streaming chat all run on Workers with `nodejs_compat`).
- **State → Cloudflare D1** (serverless SQLite) — replaces the local file store.
- **Uploaded documents (optional) → R2** — only if/when we persist raw uploads server-side; v1 passes base64 through requests, so R2 is a later add, not required for first deploy.
- **Auth → Cloudflare Access** on `/provider` (zero auth code); **optional SMS-OTP tenant resume** (D1-backed) — tenants stay anonymous by default (no login wall for the low-literacy/undocumented users).
- **Secrets + bindings** via `wrangler.toml` + `wrangler secret put` (`ANTHROPIC_API_KEY`, `TWILIO_*`, `SOCRATA_APP_TOKEN`, D1 binding).

## The one real migration: file store → D1
The store is behind an interface (`createCase/getCase/patchCase/saveCase/listCases`), so this is a contained swap of `lib/store.ts` — the rest of the app is untouched.

Proposed D1 schema (JSON-blob + indexed columns, matching our model):
```sql
CREATE TABLE cases (
  case_id              TEXT PRIMARY KEY,
  doc                  TEXT NOT NULL,        -- the full Case Object as JSON
  status               TEXT NOT NULL,
  case_type            TEXT,
  court_date           TEXT,                 -- for urgency sort
  updated_at           TEXT NOT NULL,
  has_provider_consent INTEGER DEFAULT 0,    -- for the provider queue
  advice_routed        INTEGER DEFAULT 0
);
CREATE INDEX idx_cases_provider ON cases (has_provider_consent, court_date);
CREATE INDEX idx_cases_updated  ON cases (updated_at);
```
- `getCase`/`createCase`/`patchCase` read-modify-write the `doc` JSON; on write, re-derive the indexed columns from the Case. `listCases` queries the indexed columns (fast provider queue) without parsing every blob.
- Optionally **Drizzle ORM** for typed access; raw D1 SQL is fine given the blob model.

## The workflow we'll run (after build verifies)
1. **Phase 1 — Store→D1 + bindings (serial):** rewrite `lib/store.ts` to D1; add `wrangler.toml`, the D1 migration/schema, and the binding; add `@opennextjs/cloudflare` + build scripts; keep the store interface identical so nothing else changes. Owns `package.json`/`wrangler.toml`/config.
2. **Phase 2 — Auth (parallel where safe):** Cloudflare Access policy + middleware gate on `/provider`; optional SMS-OTP tenant-resume (mint/lookup case ownership in D1, ties `case_id` to a verified phone only on opt-in). Don't force tenant login.
3. **Phase 3 — Build + deploy dry-run + verify:** `opennextjs-cloudflare build`, local `wrangler dev` against D1, smoke-test vision intake, streaming chat, D1 read/write, the advice guardrail, and the court-date gate. Honest what-works/what's-stubbed.

## Watch-items (so "fits perfectly" stays honest)
- **`nodejs_compat`** for the Anthropic SDK + streaming — smoke-test first; should work, won't claim until seen.
- **No filesystem on Workers** — the reason the store must be D1 (handled in Phase 1).
- **Secrets** move out of `.env` to Cloudflare secrets in prod.
- **`case_id` ownership:** today it's an anonymous `localStorage` id; once SMS-OTP resume exists, ownership ties to the verified phone (still optional).

---

# OPERATOR RUNBOOK — remote deploy (the steps that need YOUR Cloudflare account)

The migration below is **DONE and locally verified** (no account used). The numbered
steps after it are **YOURS** — they require `wrangler login` (a Cloudflare account/token)
and are the only things left to go live.

## Already done (local, verified green — nothing for you to do here)
- `lib/store.ts` is dual-mode: **Cloudflare D1** when the `DB` binding is present
  (read via `getCloudflareContext`), **local file store** otherwise. Same interface
  (`createCase/getCase/patchCase/saveCase/listCases`), all 8 callers unchanged.
- `wrangler.toml` — `main=".open-next/worker.js"`, `compatibility_date="2026-06-20"`,
  `compatibility_flags=["nodejs_compat"]`, `[assets]` binding, and the `[[d1_databases]]`
  `DB` binding (with a **placeholder `database_id`** you replace in step 2).
- `open-next.config.ts`, `next.config.mjs` (`initOpenNextCloudflareForDev()`).
- D1 migrations: `migrations/0001_init.sql` (cases) + `migrations/0002_auth.sql`
  (tenant_phones / case_owners / otp_codes) + `migrations/0003_security.sql` +
  `migrations/0004_court_source.sql` (optional `court_index_map` acceleration table
  for court-date sourcing — additive, safe to leave unused). **Applied to a LOCAL
  D1 and smoke-tested.**
- Court-date sourcing (ROADMAP Tier-2 #6): connector + 3 adapters wired in priority
  order (eTrack-email > NYSCEF > vendor), the Worker `email()` eTrack-ingest handler,
  and the in-app register-in-eTrack affordance. **eTrack is live-capable once you do
  the Email Routing setup (step 8 below); NYSCEF + vendor are scaffolded and stay off
  until you supply a sanctioned endpoint / vendor contract.** Full runbook:
  `web/docs/COURT-DATE-SOURCING.md`.
- `/provider` Cloudflare Access gate (`middleware.ts` + `lib/auth/access.ts`, jose JWT verify).
- Optional SMS-OTP tenant resume (`lib/auth/otp.ts`, `app/api/auth/otp/*`,
  `components/ResumeByPhone.tsx`, wired into `app/copilot/page.tsx`).
- Verified locally: `npm run typecheck`, `npm run build`, `npx opennextjs-cloudflare build`
  all green; local-D1 round-trip (insert / select doc / upsert) confirmed.

## Your steps (account-gated — run these to deploy). All from `web/`.

1. **Log in** (opens a browser; needs your Cloudflare account):
   ```bash
   wrangler login
   ```

2. **Create the remote D1 database**, then paste the returned id into `wrangler.toml`:
   ```bash
   wrangler d1 create housing-court-copilot
   # -> prints: database_id = "xxxxxxxx-xxxx-..."
   ```
   Open `web/wrangler.toml` and replace the placeholder
   `database_id = "00000000-0000-0000-0000-000000000000"` (marked
   `TODO(operator, deploy-time)`) with the real id. The `database_name` and `DB`
   binding already match — do not change them.

3. **Apply the migrations to the REMOTE D1** (note: NO `--local` flag this time):
   ```bash
   wrangler d1 migrations apply housing-court-copilot --remote
   ```
   This runs `0001_init.sql` → `0002_auth.sql` → `0003_security.sql` →
   `0004_court_source.sql` on the real database (the last is the optional, additive
   court-date-sourcing acceleration table).

4. **Set secrets** (these are prompted; values never go in the repo). `ANTHROPIC_API_KEY`
   is required; the rest are optional per feature:
   ```bash
   wrangler secret put ANTHROPIC_API_KEY      # required — the copilot LLM
   wrangler secret put TWILIO_ACCOUNT_SID     # optional — live OTP/reminder SMS
   wrangler secret put TWILIO_AUTH_TOKEN      # optional
   wrangler secret put TWILIO_FROM            # optional — your Twilio sending number
   wrangler secret put SOCRATA_APP_TOKEN      # optional — NYC open-data rate limits
   wrangler secret put CF_ACCESS_TEAM_DOMAIN  # required to gate /provider (e.g. myteam.cloudflareaccess.com)
   wrangler secret put CF_ACCESS_AUD          # required to gate /provider (the Access app Audience tag)
   ```
   If `TWILIO_*` are unset, SMS dry-runs (logs, never sends); the copilot still works.
   If `CF_ACCESS_*` are unset in production, `/provider` **fails closed** (403).

5. **Configure the Cloudflare Access application over `/provider`** (Zero Trust dashboard):
   - Zero Trust → Access → Applications → Add → **Self-hosted**.
   - Application domain = your Worker's hostname, **path = `/provider`** (cover
     `/provider/*` and `/api/provider/*`).
   - Add an identity provider + a policy allowing only your legal-aid reviewers
     (e.g. allow specific emails / an email domain).
   - Copy the application's **Audience (AUD) tag** → that's `CF_ACCESS_AUD` (step 4).
     Your team domain (`*.cloudflareaccess.com`) → `CF_ACCESS_TEAM_DOMAIN`.
   - Details and local-dev bypass notes: `web/docs/PROVIDER-AUTH.md`.

6. **Deploy** (builds the OpenNext bundle and publishes the Worker):
   ```bash
   npm run deploy   # = opennextjs-cloudflare build && opennextjs-cloudflare deploy
   ```

7. **Post-deploy smoke check (yours):** open the deployed URL, run a copilot intake,
   confirm the court-date gate + disclaimers show, hit `/provider` (should challenge
   via Access), and confirm a case round-trips in the remote D1
   (`wrangler d1 execute housing-court-copilot --remote --command "SELECT case_id, status FROM cases LIMIT 5;"`).

8. **(Optional) Enable court-date sourcing (ROADMAP Tier-2 #6).** Full runbook +
   compliance boundary: `web/docs/COURT-DATE-SOURCING.md`. Summary:
   - **eTrack email (live-capable):** Dashboard → your domain → **Email Routing**:
     enable it, create a route address (e.g. `etrack-ingest@yourdomain`) with action
     **"Send to a Worker" → `housing-court-copilot`**. Set
     `NEXT_PUBLIC_ETRACK_INGEST_ADDRESS` in `wrangler.toml [vars]` so the in-app
     "register in eTrack" affordance shows it. Confirm `ETRACK_SENDER_DOMAINS`
     (`lib/court-source/adapters/etrack-email.ts`) matches the real eTrack sender.
     Tenants add their case in eTrack by index # and point notifications at that
     address; eTrack then emails reminders the Worker ingests.
   - **NYSCEF (off by default):** only enable with a **sanctioned** data endpoint —
     never the interactive portal. Set `COURT_SOURCE_NYSCEF_ENABLED="true"` +
     `COURT_SOURCE_NYSCEF_ENDPOINT` + `COURT_SOURCE_NYSCEF_USER_AGENT`.
   - **Vendor (off by default):** set `COURT_DATA_VENDOR_URL`,
     `wrangler secret put COURT_DATA_VENDOR_KEY`, and fit
     `lib/court-source/adapters/vendor.ts` to the vendor contract. Keep
     `COURT_DATA_VENDOR_AUTHORITATIVE="false"` until an attorney signs off on the
     vendor's accuracy SLA.
   - **DO NOT** scrape the live UCS eCourts / WebCivilLocal / eTrack web portals
     (ToS prohibits bots; CAPTCHA/Cloudflare-walled). Only the three sanctioned
     channels above.

> **Which is which:** steps 1–8 above are **yours** (account-gated). Everything in
> "Already done" is complete and was verified using D1's **local (miniflare) mode** —
> no Cloudflare account, no remote calls, no `wrangler deploy`.

## Pre-launch gates (before pointing at real tenants)
- Attorney-validated deadline config populated (the Phase-0 gate) and a real legal-aid provider partner for the handoff.
- **Publishing is outward-facing:** I'll connect to your Cloudflare account / API token and **confirm with you before any actual deploy.** Deploying the skeleton to a test environment is fine; going live with real users waits on the gates above.
