# DATA-SECURITY — operational posture (as deployed)

**Audience:** the operator running the live Cloudflare Workers + D1 deployment.
**Relationship to `spec/DATA-SECURITY.md`:** that file is the *target* policy spec
(per-case DEKs, KMS/HSM, full RBAC tiers). **This file documents what is actually
implemented in the v1 deploy**, where it diverges from the spec, and the exact
operator steps to close each gap. Where this file and the spec disagree, the spec
is the goal and this file is the current truth; every gap below is called out.

Governing threat model (from `RISKS-AND-COMPLIANCE.md`): NY SHIELD Act private-
information security; **immigration / SHIELD subpoena exposure** (the system may
hold `sensitive.immigration` and benefits/financial data, which is directly
responsive to landlord discovery and to government/ICE subpoenas); the FCRA red
line (never furnish tenant data to a landlord). The operative principle for this
file: **hold the least PII, for the least time, in the least-readable form, and
have a fail-closed legal-hold + purge story.**

---

## 1. Where the data lives + region / data-residency limits

- **Primary store:** Cloudflare **D1** (SQLite), bound as `env.DB`. The full Case
  Object is one row in `cases` (`doc` = JSON), with derived index columns
  (`status`, `case_type`, `court_date`, `updated_at`, `has_provider_consent`,
  `advice_routed`). Auth/limiter tables: `case_tokens`, `owner_sessions`,
  `case_owners`, `tenant_phones`, `otp_codes`, `rate_limits`.
- **Encryption in transit:** all client/Worker traffic is TLS (Cloudflare edge).
  Worker→Anthropic and Worker→Twilio are HTTPS.
- **Encryption at rest (platform):** Cloudflare encrypts D1 at rest at the storage
  layer (AES-256) by default. This is the "Base AES-256" tier of spec §3 and is
  not operator-configurable.

### Data-residency / region limits (IMPORTANT, SHIELD-relevant)

- **D1 does not currently offer hard jurisdictional pinning** the way an
  RDS-in-a-region deployment does. A D1 database has a primary location chosen at
  creation (influenced by where it is first written from) and Cloudflare may place
  read replicas / process queries across its global network. **You cannot assume
  all tenant PII is physically confined to the United States.** For a population
  with immigration exposure this is a material consideration.
- **Operator actions / mitigations:**
  - Treat the *contents* as the control, not the location: the field-level
    encryption hook (§3) means the bytes at rest are AES-GCM ciphertext once
    `CASE_PII_KEY` is set, so physical placement matters far less.
  - When Cloudflare exposes a binding-level **location/jurisdiction hint** for D1
    (e.g. a `location`/jurisdiction restriction at `d1 create` time), set it to a
    US/EU jurisdiction per counsel's guidance and record the choice here.
  - Document the actual primary region in the runbook once the remote DB is
    created (`wrangler d1 info housing-court-copilot`).
- **Logs:** Workers Logs (`[observability] enabled = true` in `wrangler.toml`)
  may transit/store log lines globally. **No PII is written to logs by design** —
  the cron purge logs counts only (`scanned/purged/held/kept/unparseable`), never
  case contents or ids beyond what the app already treats as a loggable locator.

---

## 2. Retention + automatic purge (implemented)

**Implemented:** `lib/retention.ts` + a Cloudflare **Cron Trigger** (`wrangler.toml`
`[triggers] crons = ["10 7 * * *"]`, daily ~03:10 ET) wired through
`worker-entry.ts` `scheduled()`. The handler runs `runRetentionPurge(env.DB)` then
`sweepEphemeral(env.DB)`.

### Policy (the single config constant: `RETENTION_CONFIG` in `lib/retention.ts`)

| Class (`audit.data_retention_class`) | Window after last activity (`updated_at`) | Rationale |
|---|---|---|
| `sensitive` (any C2 field populated) | **90 days** | Shortest window — minimize immigration/benefits/financial exposure (spec §5.1 "shortest viable"). |
| `standard` (default) | **365 days** | Matter lifecycle + a legal-defensibility window. |
| `minimized` | 365 days | (Note: see gap G2 — spec wants 30-day idle for guests.) |
| Abandoned intake floor (any non-terminal status) | **180 days** of inactivity | Catches half-started intakes that never reached a terminal status but still hold entered PII. |

- **Terminal status:** `resolved` is the only terminal status in the v1 schema; a
  `resolved` case past its class window is purged. Non-terminal cases are only
  purged by the abandoned-intake floor.
- **Legal hold beats everything (fail-closed toward keeping):** a case with
  `audit.legal_hold === true` is **never** purged, at any age. Verified by a
  decision-table probe (`decidePurge`): the 999-day legal-held intake is kept.
- **Fail-closed toward not-purging on uncertainty:** a doc we cannot parse, or one
  with no valid `updated_at`, is **left in place** (counted `unparseable`) rather
  than destroyed or silently kept-forever — surfaced for human review. A scan
  query failure aborts the run (purges nothing).
- **Cascade:** purging a case also deletes its `case_tokens` and `case_owners`
  rows, so no auth pointer to purged PII survives.
- **Bounded:** ≤ `maxScanPerRun` (500) oldest-touched rows per daily run; the
  backlog drains across runs and stays well under Workers CPU/subrequest ceilings.
- **Ephemeral sweep:** `sweepEphemeral` drops expired `rate_limits`, expired
  `case_tokens`, expired `owner_sessions`, and expired `otp_codes`.

### Gaps vs. spec (tracked, not yet implemented)
- **G1 — C0 skeleton retention (spec §5.2):** v1 purge is a *full row delete*
  (`DELETE FROM cases`), not "delete C1/C2 values, retain a C0 skeleton +
  `consents[]`/`audit.events[]` for defensibility." Full delete is privacy-safer
  (nothing retained) but loses the audit skeleton. If counsel requires the
  skeleton, change `runRetentionPurge` to rewrite `doc` to a stripped skeleton
  instead of deleting the row.
- **G2 — guest `minimized` 30-day idle (spec §5.1/§5.4):** the schema has no
  `tenant_account_id`-vs-guest distinction wired to a 30-day clock yet, so
  `minimized` currently follows the standard window. The 180-day abandoned-intake
  floor partially covers this.
- **G3 — `retention_config_version` stamping (spec §5.1):** windows are a code
  constant, versioned by git, not a stamped `retention_config_version` on the
  Case. Acceptable for v1; promote to a stamped config if windows become tunable
  at runtime.

---

## 3. Field-level encryption of the PII subset (hook implemented)

**Implemented:** `lib/crypto-field.ts` — WebCrypto **AES-256-GCM** seal/open of the
PII subtree, with a key from `env.CASE_PII_KEY` (a Wrangler **secret**, base64 of
a 32-byte key). Verified by round-trip probe: seals hide PII, decrypt restores
exact bytes, wrong key is rejected (GCM auth tag), and **no key = no-op
passthrough** (so local/file-mode dev still works).

- **Sealed subtree (`PII_FIELD_PATHS`):** `contact`, `sensitive`, `parties`,
  `claimed_arrears` — the C1/C2 fields. Non-PII structure (`status`, `court`,
  `deadlines`, `audit`, ids, `updated_at`) stays plaintext so the derived-column
  projection and the retention scan keep working **without** the key.
- **Wire format:** each sealed value becomes `{"v":1,"alg":"A256GCM","iv":…,"ct":…}`.
  `openCasePii` reverses it **before** `CaseSchema.parse`, so the validated Case
  the app sees is byte-identical to the unencrypted path — **CaseSchema validation
  is not weakened.** Legacy/unsealed values pass through unchanged (backward
  compatible).
- **Why a hook, not yet inline in the store:** the store interface
  (`lib/store.ts`, backend-owned) is intentionally untouched this phase. Wiring is
  one change on each side of persistence: call `sealCasePii(doc, key)` right before
  the `INSERT … doc` write and `openCasePii(parsed, key)` right after reading
  `row.doc` and before `CaseSchema.parse`.

### Operator: enabling field-level encryption (do this before real tenants)
1. Generate a key: `head -c 32 /dev/urandom | base64`.
2. `wrangler secret put CASE_PII_KEY` (paste the base64). **Never** put it in
   `wrangler.toml` or `.dev.vars` committed to git.
3. Wire `sealCasePii`/`openCasePii` into `lib/store.ts` (see above) and deploy.
4. **Migration note:** existing rows are plaintext; they read fine (passthrough)
   and become sealed on their next write. A one-time re-seal pass can be added to
   the cron if eager migration is required.

### Gaps vs. spec §3 (tracked)
- **G4 — single shared key, not per-case DEK + KMS KEK:** v1 uses one
  `CASE_PII_KEY` for all cases (a Wrangler secret), not a per-case DEK wrapped by a
  KMS/HSM KEK. This gives **coarse** crypto-shred (see §4) and no KMS-grant-based
  C2 access control. Per-case DEKs are the documented next step; they require a key
  store Workers can reach (Cloudflare KMS or an external HSM/KMS via a binding).

---

## 4. Secure deletion, crypto-shred, and the legal-hold plan

- **Tenant-initiated delete:** `DELETE /api/cases/[id]` (owner-gated by capability
  token / OTP owner session via `lib/auth/session.ts`) hard-deletes the row and
  revokes the case's capability tokens. This is the tenant "delete my data" path.
- **Scheduled delete:** the cron purge (§2). True row deletion on D1 (not a soft
  flag).
- **Crypto-shred (current):** because all PII is sealed under the single
  `CASE_PII_KEY`, **destroying/rotating that key renders all PII ciphertext
  unrecoverable** — a coarse but real break-glass shred (e.g. on a confirmed
  breach). It is all-or-nothing in v1; per-case shred needs per-case DEKs (G4).
- **Legal hold (fail-closed):** `audit.legal_hold = true` exempts a case from
  **all** automatic purge, at any age, enforced in `decidePurge` (rule 1, before
  any age check). Setting/clearing the flag is an authorized-admin action recorded
  in `audit.events[]` (write path is the deterministic/admin layer, never a tenant
  PATCH — `legal_hold` lives under `audit`, which the boundary strips/ignores on
  tenant patches).
- **Subpoena / immigration-demand response (operational, mirrors spec §8.2):**
  1. On any subpoena/court order/agency demand, **immediately set
     `audit.legal_hold = true`** on the affected case(s) (stops the cron from
     purging — anti-spoliation) and route to the supervising attorney.
  2. No production before attorney review of validity/scope; immigration demands
     (`sensitive.immigration`) get heightened scrutiny and are never produced
     absent a valid, specific, enforceable order; tenant notified where lawful.
  3. Scoped production uses the field-class map (spec §0) + `audit.events[]`;
     purged/crypto-shredded data is reported as unrecoverable.
  4. **Never to a landlord** (FCRA red line; `Consent.recipient.recipient_type`
     cannot be a landlord by schema).

---

## 5. Access control at the boundary (implemented, summary)

Documented fully in the backend phase; summarized here for the data-lifecycle
picture:
- `/api/cases/[id]` GET/PATCH/DELETE require **proof of ownership** (per-case
  capability token or OTP-verified owner session); the URL `case_id` is a loggable
  *locator*, not an authenticator. Unauthorized → uniform `403` (no existence
  oracle).
- Tenant PATCH **strips safety-owned fields** (`court.court_date_verified/source`,
  `review.advice_routed/advice_detection_log`, `deadlines[].computed_by`,
  `eligibility.*.determined_by`, `answer_draft.form_fields[].placed_by`) so a
  tenant can never forge a safety invariant. `audit.*` (incl. `legal_hold`,
  `data_retention_class`) is server/deterministic-owned.
- Public endpoints are rate-limited + Turnstile-gated (`lib/ratelimit.ts`,
  `lib/turnstile.ts`); OTP send is per-phone + per-IP + global-daily capped.

---

## 6. Repo hygiene (this phase)

- `wrangler.toml`: owner's personal email scrubbed from the comment ("the
  operator's Cloudflare account"); `database_id` documented as a non-secret
  resource id; **no inline secrets** — all secrets (`ANTHROPIC_API_KEY`,
  `TWILIO_*`, `CF_ACCESS_*`, `TURNSTILE_SECRET_KEY`, `CASE_PII_KEY`) are set via
  `wrangler secret put`.
- `.gitignore` (root **and** `web/`): ignore `.dev.vars`, `.dev.vars.*`,
  `*.dev.vars`, and the local file-store `.data/`. Verified only `.env.example`
  is tracked; no `.dev.vars`/secret files are in git.

---

## 7. Quick operator checklist before real tenants

- [ ] `wrangler secret put CASE_PII_KEY` (32-byte base64) **and** wire
      `sealCasePii`/`openCasePii` into `lib/store.ts` (closes the plaintext-at-rest
      gap; G4 remains for per-case shred).
- [ ] Confirm the D1 primary region (`wrangler d1 info`) and record it here;
      apply a jurisdiction hint if/when available (§1).
- [ ] Confirm the Cron Trigger is live (`wrangler deployments` / dashboard) and
      tail one run (`wrangler tail`) to see the PII-free purge summary.
- [ ] Set all other secrets (`ANTHROPIC_API_KEY`, `TWILIO_*`, `CF_ACCESS_*`,
      `TURNSTILE_SECRET_KEY`); confirm `wrangler.toml` has none inline.
- [ ] Decide G1 (full delete vs. C0-skeleton retention) with counsel and adjust
      `runRetentionPurge` accordingly.
