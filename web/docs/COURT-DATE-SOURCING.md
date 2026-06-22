# Court-date sourcing — operator runbook (ROADMAP Tier-2 #6)

Live court-date sourcing pulls the **authoritative** court date for a case from a
**legitimate** channel and verifies it through the one deterministic sink
(`lib/court-date.setCourtDate`). It is the only way `court.court_date_verified`
becomes `true` (Invariant #2). A tenant-typed or model-extracted date always
stays unverified.

> **Non-negotiable boundary.** We do **not** scrape the live UCS eCourts /
> WebCivilLocal / eTrack web portals. They are CAPTCHA/Cloudflare-protected and
> the UCS Terms of Service prohibit bots/crawlers (CFAA + contract risk). No
> headless-browser portal scraping, no CAPTCHA bypass — anywhere. The three
> channels below are the only sanctioned producers.

## Architecture at a glance

```
                         ┌─────────────────────────────────────────────┐
 inbound eTrack email ──▶│ worker-entry.ts  email()                     │
 (Cloudflare Email       │   guard sender → parseEtrackEmail →          │
  Routing → Worker)      │   ingestSourcedCourtDate                     │
                         └───────────────┬─────────────────────────────┘
                                         │
 poll (future/manual) ──▶ sourceCourtDate(case) ──┐
                                         │         │
                         lib/court-source/index.ts │  resolveHit (INVARIANT #2)
                           defaultAdapters() in     ▼
                           PRIORITY ORDER:   ┌──────────────────────────┐
                            1 etrack-email   │ setCourtDate(authoritative│
                            2 nyscef         │   → verified=true)        │
                            3 court_data_    │ discrepancy → escalate    │
                              vendor         │   (never overwrite)       │
                                             └──────────────────────────┘
```

- **Adapters** (`lib/court-source/adapters/*`) implement `CourtDateSourceAdapter`
  and only *report* a hit (`{found, date, source, confidence}`). They never set
  `court_date_verified`.
- **Orchestrator** (`lib/court-source/index.ts`) routes a confident hit through
  `setCourtDate`. On a date that disagrees with the tenant's entry it records both
  and sets `review.review_state="escalated"` — it never silently overwrites.
- **Sink** (`lib/court-date.setCourtDate`) is the only place that flips
  `court_date_verified=true`, and only for an authoritative source.

Each adapter is **self-gating** and **default-off** (except eTrack, which is
push-only and simply waits for email). An unconfigured channel returns
`{found:false}`, so the connector is inert until you opt a channel in.

---

## Channel 1 — eTrack appointment-reminder email (LIVE-capable now)

eTrack emails the registrant when their case is calendared/adjourned. We ingest
that **sanctioned email**; we never log into eTrack.

### Operator setup (Cloudflare Email Routing → Worker)

Inbound Email Routing has **no `wrangler.toml` binding** — configure it in the
Cloudflare dashboard:

1. **Enable Email Routing** on a domain you control in this Cloudflare account
   (Dashboard → your domain → Email → Email Routing).
2. **Create a route address** (e.g. `etrack-ingest@yourdomain`) whose action is
   **"Send to a Worker"** → this Worker (`housing-court-copilot`). The Worker's
   `email()` handler (`worker-entry.ts`) receives it.
3. **Surface the address to tenants (optional but recommended):** set the public
   var so the in-app "register in eTrack" affordance can show it:
   ```toml
   # wrangler.toml [vars]
   NEXT_PUBLIC_ETRACK_INGEST_ADDRESS = "etrack-ingest@yourdomain"
   ```
4. **Confirm the allowed sender domain(s)** in
   `lib/court-source/adapters/etrack-email.ts` (`ETRACK_SENDER_DOMAINS`) match the
   real eTrack sender. The handler **rejects mail from any other sender**.

### How a case gets registered + routed in

1. The tenant (or operator) creates a free eTrack account at
   `https://iapps.courts.state.ny.us/webetrack/` and adds the case by **index
   number** (from the court papers). The in-app affordance
   (`components/RegisterInEtrack.tsx`, shown on the court-date confirm step)
   walks them through this.
2. They set the eTrack **notification email** to your route address (or
   auto-forward eTrack reminders there).
3. eTrack emails reminders → Email Routing → the Worker `email()` handler →
   `parseEtrackEmail` → `ingestSourcedCourtDate`, which finds the case by index
   number and routes the date through `setCourtDate`.

### Reliability flag (READ BEFORE TRUSTING)

The assumed eTrack email format (sender domains, field labels, index/date forms)
in `etrack-email.ts` is a **best-effort guess and UNVERIFIED**. Before
production: capture a genuine eTrack reminder (PII redacted), confirm/correct
`ETRACK_SENDER_DOMAINS` and the label/format patterns, and only then trust a
`confidence:"high"` hit. The orchestrator only acts on `high`; the
authoritative-source gate is the safety net against a mis-parse.

---

## Channel 2 — NYSCEF public docket (scaffolded; needs a sanctioned data path)

NYSCEF covers the **e-filed L&T subset only** — pro se tenants (a large share of
this app's users) are exempt from e-filing, so their paper-filed cases never
appear. A `{found:false}` from NYSCEF means "not on NYSCEF," not "no court date."

The adapter (`lib/court-source/adapters/nyscef.ts`) is **disabled by default** and
ships in a deliberately non-operational posture: NYSCEF publishes no documented,
openly-licensed JSON appearance-date API sanctioned for automated polling. The
only public read surface is the human-facing portal the ToS prohibits crawling —
so we refuse to scrape it.

To enable, the operator must provide a **genuinely sanctioned** endpoint (a
court-data vendor proxy, a documented open-data export, or a UCS/NYSCEF data
agreement) and set:

```toml
# wrangler.toml [vars]
COURT_SOURCE_NYSCEF_ENABLED  = "true"
COURT_SOURCE_NYSCEF_ENDPOINT = "https://sanctioned.example/nyscef?index={index}"
COURT_SOURCE_NYSCEF_USER_AGENT = "HousingCourtCopilot/1.0 (ops@yourdomain)"
```

Built-in safety gates (in order): master flag → index_number present → sanctioned
endpoint configured → defensive refusal if the endpoint *is* the interactive UCS
portal (host/path denylist incl. `iapps.courts.state.ny.us`, `nycourts.gov`,
`/webcivil`, `/nyscef/`, `/etrack`) → back-off window → rate-limit floor → one
bounded GET, no retries. A `403/429/503` or non-JSON body (likely a challenge
page) triggers a 30-minute back-off. CAPTCHAs are never solved or bypassed.

---

## Channel 3 — court-data vendor / partner API (scaffolded; needs a contract)

A configured court-data partner can be authoritative — but **whether** a given
vendor counts as authoritative is an **ops/attorney decision**, not a code fact.

The adapter (`lib/court-source/adapters/vendor.ts`) is **disabled by default** and
is a **template**: `buildVendorRequest` + `mapVendorResponse` assume a generic
REST shape and **must be fitted** to the contracted vendor's actual contract
(path, auth scheme, response schema). Set:

```toml
# wrangler.toml [vars]
COURT_DATA_VENDOR_URL = "https://api.vendor.example"
# Authority gate — default-deny. Only flip to "true" after an attorney signs off
# on a specific vendor's accuracy SLA.
COURT_DATA_VENDOR_AUTHORITATIVE = "false"
```
```bash
# The key is a SECRET — never a plaintext var:
wrangler secret put COURT_DATA_VENDOR_KEY     # (alias COURT_DATA_VENDOR_API_KEY also accepted)
```

Authority is gated **separately** from the adapter
(`lib/court-date.isVendorTreatedAsAuthoritative`, default-deny). With
`COURT_DATA_VENDOR_AUTHORITATIVE="false"` a high-confidence vendor hit lands as
`found_unverified` (a cross-check that surfaces discrepancies for human review)
and does **not** flip `court_date_verified`. OCA-aggregated calendar data can lag
the live calendar (adjournments, part reassignments, same-day changes), and a
wrong/stale date can cause a default judgment — keep this default-denied until an
attorney signs off.

---

## What happens to the rest of the app when a verified date lands

- **`court_date_verified=true`** is set only by `setCourtDate` via an
  authoritative source (Invariant #2).
- **Reminders re-arm:** `ingestSourcedCourtDate` re-schedules the 7/3/1-day SMS
  reminders off the new verified date **iff the tenant already opted in** (valid
  SMS consent + `safe_to_text`). It only schedules; the env-gated batch sender
  does the actual texting (dry-run unless Twilio creds are present).
- **Dashboard (`/case`)** shows the countdown as court-confirmed; a tenant-entered
  date is labeled "this is the date you entered… we only treat a date as confirmed
  when it comes from the court system." A **discrepancy** surfaces a "we need to
  double-check your court date" banner and routes to a person.
- **Deadline engine (`lib/deadlines.ts`)** anchors the answer-window clock on the
  served/filed dates and flags a trusted court-verified date as authoritative;
  it never fabricates a number and stays attorney-config-gated.

## Optional acceleration table

`migrations/0004_court_source.sql` adds an additive, idempotent `court_index_map`
(index → case_id) to turn the connector's current O(n) store scan into an O(1)
lookup. It is **safe to apply and leave unused** — `findCaseByIndexNumber` works
without it. Apply locally with `npm run db:migrate:local`; apply remotely with
`wrangler d1 migrations apply housing-court-copilot --remote`.

## Invariant #2 — how it is enforced (defense in depth)

1. **Sink:** `setCourtDate` sets `verified=true` IFF
   `isAuthoritativeSource(source)` (etrack/nyscef/court_data_vendor).
2. **Connector:** never assigns `court_date_verified`; always routes through the
   sink. Vendor authority is config-gated; untrusted vendor hits are recorded with
   verified=false.
3. **Discrepancy:** sourced date ≠ existing unverified tenant/extracted date →
   `review.review_state="escalated"`, both dates recorded, nothing overwritten,
   `advice_routed` untouched.
4. **Schema floor:** `CourtSchema` rejects any persisted Case with `verified=true`
   whose source is not authoritative; the store re-validates on every write.
5. **Tenant patch strip:** `stripSafetyOwnedFields` deletes
   `court_date_verified`/`court_date_source` from any client PATCH, so a tenant can
   never self-verify.
