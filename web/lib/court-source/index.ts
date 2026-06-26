/**
 * Court-date SOURCING CONNECTOR + orchestrator (Foundation-owned).
 *
 * ROADMAP Tier-2 #6: live court-date sourcing. This is the producer side that
 * resolves an AUTHORITATIVE `court.court_date` from LEGITIMATE channels and
 * routes it through the deterministic sink in `@/lib/court-date` (setCourtDate),
 * which alone may flip `court_date_verified = true`.
 *
 * ============================================================================
 * NON-NEGOTIABLE BOUNDARY (RISKS-AND-COMPLIANCE.md, INTEGRATIONS.md §court-data)
 * ============================================================================
 * We DO NOT scrape the live UCS eCourts / WebCivilLocal / eTrack web portals.
 * They are CAPTCHA/Cloudflare-protected and the UCS ToS prohibits bots/crawlers
 * (CFAA/contract risk). NO headless-browser portal scraping, NO CAPTCHA bypass.
 *
 * LEGITIMATE channels ONLY (each implemented by an adapter under ./adapters):
 *   1) eTrack APPOINTMENT-REMINDER EMAIL ingest (sanctioned — eTrack emails the
 *      registrant; we parse the inbound email).  source = "etrack"
 *   2) NYSCEF PUBLIC DOCKET for the e-filed L&T subset (opt-in, polite,
 *      documented).                               source = "nyscef"
 *   3) a configured court-data VENDOR/partner API (operator provides the key).
 *      source = "court_data_vendor" — authoritative ONLY when the operator has
 *      opted in (lib/court-date.isVendorTreatedAsAuthoritative).
 *
 * ============================================================================
 * INVARIANT #2 (must hold)
 * ============================================================================
 *   - court_date_verified = true ONLY via lib/court-date.setCourtDate with an
 *     authoritative source. This connector NEVER sets court_date_verified
 *     directly — it always routes through setCourtDate.
 *   - A tenant-entered/model date stays verified = false.
 *   - On a source/tenant DISCREPANCY, we record BOTH dates + set
 *     review.review_state = "escalated". We NEVER silently overwrite, and NEVER
 *     touch review.advice_routed.
 *
 * This module NEVER throws to the caller: any adapter error degrades to
 * `{ found: false }` for that adapter, and the orchestrator returns a structured
 * result.
 */

import type { Case, Court, AttorneyReview } from "@/lib/case";
import {
  setCourtDate,
  isAuthoritativeSource,
  isVendorTreatedAsAuthoritative,
  type CourtDateSource,
} from "@/lib/court-date";
// Real adapters (each is self-gating: eTrack is push-only, NYSCEF + vendor are
// DISABLED unless their env config is present, so importing them here is inert
// until the operator configures the corresponding channel). Imported at the
// bottom of the module-eval order via these statements; `defaultAdapters()` is
// only ever called at request time, so the index<->adapter import cycle (the
// adapters import this module's TYPES) is already resolved by then.
import { createEtrackEmailAdapter } from "@/lib/court-source/adapters/etrack-email";
import { createNyscefAdapter } from "@/lib/court-source/adapters/nyscef";
import { createVendorAdapter } from "@/lib/court-source/adapters/vendor";

// ---------------------------------------------------------------------------
// Adapter contract (adapters live under ./adapters and own their own files)
// ---------------------------------------------------------------------------

/**
 * What an adapter is given to perform a lookup. A subset of the Case — adapters
 * MUST NOT depend on the whole Case Object (keeps the data surface minimal and
 * the adapters independently testable).
 */
export interface CourtSourceInput {
  /** Court index number (the primary join key for NYSCEF/vendor lookups). */
  index_number?: string | null;
  county?: NonNullable<Court["county"]>;
  borough?: NonNullable<Court["borough"]>;
  /**
   * Raw inbound material for email-driven adapters (the eTrack reminder email).
   * Opaque to the orchestrator; the adapter parses it. Present only on the
   * email-ingest path (see worker-entry.ts `email()`), absent for polling.
   */
  rawEmail?: {
    from: string;
    /** Raw RFC-822 message (headers + body), or a pre-extracted text/plain part. */
    raw: string;
    subject?: string | null;
  } | null;
}

/**
 * The outcome of asking a single adapter for a court date.
 *  - `found: false` — adapter had nothing (or degraded on error). Never throws.
 *  - `found: true`  — adapter resolved a candidate date. `source` records the
 *    provenance; `confidence` lets the orchestrator decide whether to act. The
 *    orchestrator (not the adapter) decides verification via setCourtDate.
 */
export type CourtSourceResult =
  | { found: false; source: CourtSourceName; note?: string }
  | {
      found: true;
      date: string;
      source: CourtSourceName;
      part?: string | null;
      index_number?: string | null;
      /**
       * Adapter's confidence the date is correct. The orchestrator only ACTS on
       * "high" (a confident authoritative hit); "low"/"medium" are surfaced as
       * informational and never flip verified.
       */
      confidence: "high" | "medium" | "low";
    };

/** Stable adapter identifiers, in default priority order. */
export type CourtSourceName = "etrack-email" | "nyscef" | "court_data_vendor";

/**
 * Parsed shape the eTrack email adapter (Adapters phase, under ./adapters)
 * returns from an inbound reminder email. Defined HERE so the email Worker
 * handler can type the boundary now; the adapter implements the parse.
 *
 * `parsed: false` means "this was not a recognizable eTrack reminder" (or the
 * sender failed the domain guard) — the handler drops it without touching any
 * Case. The parser MUST NOT throw.
 */
export type ParsedEtrackEmail =
  | { parsed: false; reason: string }
  | {
      parsed: true;
      index_number: string;
      court_date: string; // YYYY-MM-DD (validated downstream by setCourtDate)
      part?: string | null;
      confidence: "high" | "medium" | "low";
    };

/**
 * The module contract the Adapters phase exposes from
 * `lib/court-source/adapters/etrack-email`. The email Worker handler imports it
 * dynamically; until it exists the handler degrades to a no-op (logs + returns).
 */
export interface EtrackEmailAdapterModule {
  /** Sender domain(s) the operator expects eTrack reminders from (guard). */
  readonly ETRACK_SENDER_DOMAINS: readonly string[];
  /** True if `fromAddress` is from an allowed eTrack sender domain. */
  isAllowedEtrackSender(fromAddress: string): boolean;
  /** Parse a raw inbound email into a court-date hit. MUST NOT throw. */
  parseEtrackEmail(input: {
    from: string;
    raw: string;
    subject?: string | null;
  }): ParsedEtrackEmail;
}

/**
 * A pluggable court-date source. Adapters implement this under ./adapters and
 * register themselves with the orchestrator. `trySource` MUST NOT throw — it
 * resolves to `{ found: false }` on any error (the orchestrator wraps it too as
 * a belt-and-suspenders guard).
 */
export interface CourtDateSourceAdapter {
  /** Stable identifier — also selects the provenance enum value. */
  readonly name: CourtSourceName;
  /** Attempt to resolve a court date from this channel. Never throws. */
  trySource(input: CourtSourceInput): Promise<CourtSourceResult>;
}

/**
 * Map an adapter name to the canonical `court_date_source` provenance value.
 * Centralized so the enum and the adapter ids never drift.
 */
function provenanceFor(name: CourtSourceName): CourtDateSource {
  switch (name) {
    case "etrack-email":
      return "etrack";
    case "nyscef":
      return "nyscef";
    case "court_data_vendor":
      return "court_data_vendor";
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Config threaded into the orchestrator (test-injectable; defaults sane). */
export interface SourceCourtDateConfig {
  /** Adapters to try, in priority order. Defaults to the registered set. */
  adapters?: CourtDateSourceAdapter[];
  /**
   * Ops/attorney gate: treat the court-data vendor as authoritative on this
   * deployment? Forwarded to lib/court-date.isVendorTreatedAsAuthoritative.
   * Undefined => fall back to env (COURT_DATA_VENDOR_AUTHORITATIVE).
   */
  vendorAuthoritative?: boolean | null;
}

/** A discrepancy between a sourced date and the existing tenant/extracted date. */
export interface CourtDateDiscrepancy {
  /** The date currently on the Case (tenant-entered / document-extracted). */
  existing_date: string;
  existing_source: CourtDateSource | null;
  /** The newly sourced date that disagrees. */
  sourced_date: string;
  sourced_source: CourtDateSource;
  detected_at: string;
}

/**
 * The result of orchestrating all sources for one Case. The caller persists
 * `court` (and, on discrepancy, `review`) and writes the audit event. This
 * function is PURE w.r.t. persistence — it returns patches, it does not save.
 */
export type SourceCourtDateOutcome =
  | {
      /** No adapter produced a confident hit; leave the Case untouched. */
      status: "not_found";
      tried: CourtSourceName[];
      note: string;
    }
  | {
      /** A confident authoritative date was set/confirmed. */
      status: "verified";
      court: Court;
      source: CourtSourceName;
      /** True if this matched (rather than changed) the existing date. */
      agreed_with_existing: boolean;
    }
  | {
      /** Sourced confidently but NOT authoritative (e.g. vendor not trusted). */
      status: "found_unverified";
      court: Court;
      source: CourtSourceName;
    }
  | {
      /**
       * A sourced date DISAGREES with the existing tenant/extracted date. We do
       * NOT overwrite: caller records BOTH + escalates for human review.
       */
      status: "discrepancy";
      discrepancy: CourtDateDiscrepancy;
      /** Pre-built review patch: review_state="escalated" (advice_routed untouched). */
      review: AttorneyReview;
      /** Human-readable warning to surface for review. */
      warning: string;
    };

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Build the escalation review patch WITHOUT touching advice_routed / its log.
 * Preserves any existing review fields; only forces review_state="escalated".
 */
function escalateReview(existing: AttorneyReview | undefined): AttorneyReview {
  return {
    review_state: "escalated",
    // Preserve — NEVER fabricate or flip the advice-routing decision here.
    advice_routed: existing?.advice_routed ?? false,
    advice_detection_log: existing?.advice_detection_log ?? [],
    assigned_attorney_id: existing?.assigned_attorney_id,
    triage_score: existing?.triage_score,
  };
}

/**
 * Try adapters in priority order and resolve an authoritative court date for a
 * Case, enforcing INVARIANT #2. Never throws — degrades to `not_found`.
 *
 * Decision flow per the first CONFIDENT (`confidence:"high"`) hit:
 *   1) If it DISAGREES with an existing tenant/extracted date => `discrepancy`
 *      (record both, escalate, do not overwrite).
 *   2) Else route through setCourtDate:
 *        - authoritative provenance (etrack/nyscef, or vendor when the operator
 *          opted in) => `verified` (court_date_verified flips true via the sink).
 *        - vendor NOT trusted => downgrade provenance is NOT authoritative, so
 *          setCourtDate yields verified=false => `found_unverified`.
 */
export async function sourceCourtDate(
  c: Case,
  config: SourceCourtDateConfig = {},
): Promise<SourceCourtDateOutcome> {
  const adapters = config.adapters ?? defaultAdapters();
  const tried: CourtSourceName[] = [];

  const input: CourtSourceInput = {
    index_number: c.court?.index_number ?? null,
    county: c.court?.county ?? undefined,
    borough: c.court?.borough ?? undefined,
    rawEmail: null,
  };

  const existingDate = c.court?.court_date ?? null;
  const existingSource = c.court?.court_date_source ?? null;
  const existingVerified = c.court?.court_date_verified === true;

  for (const adapter of adapters) {
    tried.push(adapter.name);

    // Belt-and-suspenders: adapters promise not to throw, but the orchestrator
    // must NEVER throw to the caller, so we wrap regardless.
    let res: CourtSourceResult;
    try {
      res = await adapter.trySource(input);
    } catch (err) {
      console.error(`[court-source] adapter ${adapter.name} threw:`, err);
      continue;
    }

    if (!res.found) continue;
    // Only ACT on confident hits. Low/medium are not enough to set a date that
    // can cause a default judgment if wrong.
    if (res.confidence !== "high") continue;

    return resolveHit({
      hit: res,
      existingCourt: c.court,
      existingDate,
      existingSource,
      existingVerified,
      review: c.review,
      vendorAuthoritative: config.vendorAuthoritative,
    });
  }

  return {
    status: "not_found",
    tried,
    note:
      "no legitimate court-data source produced a confident court date " +
      "(eTrack email cache / NYSCEF docket / vendor). Existing date (if any) " +
      "left untouched.",
  };
}

/**
 * Resolve a single confident hit into an outcome. Split out so the email-ingest
 * path (which already has a parsed hit) can reuse the exact same invariant logic
 * without re-running every adapter.
 */
export function resolveHit(args: {
  hit: Extract<CourtSourceResult, { found: true }>;
  existingCourt: Court | undefined;
  existingDate: string | null;
  existingSource: CourtDateSource | null;
  existingVerified: boolean;
  review: AttorneyReview | undefined;
  vendorAuthoritative?: boolean | null;
}): SourceCourtDateOutcome {
  const {
    hit,
    existingCourt,
    existingDate,
    existingSource,
    existingVerified,
    review,
    vendorAuthoritative,
  } = args;

  const provenance = provenanceFor(hit.source);

  // 0) CONFIDENCE GATE (INVARIANT #2): only ever ACT on a CONFIDENT hit. The
  // polling orchestrator gates this before calling us, but the eTrack email-
  // ingest path invokes resolveHit DIRECTLY — without this guard a medium/low
  // confidence parse of a reminder email could flip court_date_verified or
  // overwrite a date. A non-"high" hit does nothing.
  if (hit.confidence !== "high") {
    return {
      status: "not_found",
      tried: [hit.source],
      note: `ignored ${hit.confidence}-confidence ${hit.source} hit (only high-confidence hits act)`,
    };
  }

  // 1) DISCREPANCY: a sourced date that disagrees with an existing
  // tenant-entered / document-extracted (unverified) date. NEVER silently
  // overwrite — record both + escalate for human review.
  const existingIsUnverifiedTenantOrDoc =
    existingDate != null &&
    !existingVerified &&
    (existingSource === "tenant_entered" ||
      existingSource === "document_extracted_unverified" ||
      existingSource === null);

  if (existingIsUnverifiedTenantOrDoc && existingDate !== hit.date) {
    const discrepancy: CourtDateDiscrepancy = {
      existing_date: existingDate as string,
      existing_source: existingSource,
      sourced_date: hit.date,
      sourced_source: provenance,
      detected_at: nowIso(),
    };
    return {
      status: "discrepancy",
      discrepancy,
      review: escalateReview(review),
      warning:
        `Court-date discrepancy: the ${hit.source} source reports ${hit.date}, ` +
        `but the case currently has ${existingDate} ` +
        `(${existingSource ?? "unknown source"}). Both dates recorded; ` +
        `routed to a human for review. The existing date was NOT overwritten.`,
    };
  }

  // 2a) AUTHORITATIVE provenance => verify via the sink. For the vendor channel,
  // authority is gated by ops/attorney config: if NOT trusted, we downgrade so
  // the sink leaves court_date_verified = false.
  const vendorTrusted = isVendorTreatedAsAuthoritative({ vendorAuthoritative });
  const treatAsAuthoritative =
    provenance === "court_data_vendor"
      ? vendorTrusted
      : isAuthoritativeSource(provenance);

  if (treatAsAuthoritative) {
    const set = setCourtDate(existingCourt, {
      court_date: hit.date,
      source: provenance,
    });
    if (!set.ok) {
      // A malformed sourced date is a soft failure — never throw.
      return {
        status: "not_found",
        tried: [hit.source],
        note: `sourced date rejected by setCourtDate: ${set.reason}`,
      };
    }
    return {
      status: "verified",
      court: withPart(set.court, hit.part),
      source: hit.source,
      agreed_with_existing: existingDate === hit.date,
    };
  }

  // 2a-guard) PROTECT A VERIFIED DATE (INVARIANT #2): an UNTRUSTED (non-
  // authoritative) hit must NEVER downgrade or silently overwrite a date that is
  // already court-CONFIRMED (eTrack/NYSCEF-verified). If the untrusted hit AGREES
  // with the verified date, do nothing (stay verified). If it DISAGREES, record a
  // discrepancy and escalate — never clobber the verified date.
  if (existingVerified && existingDate != null) {
    if (existingDate === hit.date) {
      return {
        status: "not_found",
        tried: [hit.source],
        note: "untrusted hit agrees with the verified date; left unchanged",
      };
    }
    const discrepancy: CourtDateDiscrepancy = {
      existing_date: existingDate,
      existing_source: existingSource,
      sourced_date: hit.date,
      sourced_source: provenance,
      detected_at: nowIso(),
    };
    return {
      status: "discrepancy",
      discrepancy,
      review: escalateReview(review),
      warning:
        `Court-date discrepancy: the ${hit.source} source reports ${hit.date}, ` +
        `but the case has a VERIFIED date ${existingDate} ` +
        `(${existingSource ?? "unknown source"}). The verified date was NOT ` +
        `overwritten by the untrusted source; routed to a human for review.`,
    };
  }

  // 2b) Vendor NOT trusted as authoritative on this deployment: record the date
  // as document_extracted_unverified-grade provenance via the vendor enum value
  // but with verified = false (the sink enforces this because we pass a source
  // the sink does not treat as authoritative). We keep the vendor provenance so
  // the origin is auditable, but court_date_verified stays false.
  const set = setCourtDate(existingCourt, {
    court_date: hit.date,
    // Provenance stays "court_data_vendor"; setCourtDate verifies IFF the source
    // is in AUTHORITATIVE_COURT_DATE_SOURCES. Since the OPS gate said "no", we
    // must not let it verify — so we record under the unverified tenant grade.
    source: "tenant_entered",
  });
  if (!set.ok) {
    return {
      status: "not_found",
      tried: [hit.source],
      note: `sourced (vendor, untrusted) date rejected: ${set.reason}`,
    };
  }
  return {
    status: "found_unverified",
    court: withPart(set.court, hit.part),
    source: hit.source,
  };
}

/** Carry a part/room through onto the resolved Court object (optional field). */
function withPart(court: Court, part?: string | null): Court {
  if (part == null || part === "") return court;
  return { ...court, part };
}

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

/**
 * The default adapter set, in PRIORITY ORDER:
 *   eTrack email  →  NYSCEF docket  →  court-data vendor.
 *
 * Each adapter is SELF-GATING by its own config, so this registry is safe to use
 * everywhere; an unconfigured channel simply returns `{ found: false }`:
 *   - eTrack-email: PUSH-only. On the orchestrator's poll path (no `rawEmail`)
 *     it returns not-found; it only resolves a date when fed an inbound reminder
 *     email by the Worker `email()` handler. Always "on" because nothing to gate.
 *   - NYSCEF: DISABLED unless COURT_SOURCE_NYSCEF_ENABLED=true AND a SANCTIONED
 *     COURT_SOURCE_NYSCEF_ENDPOINT is set. Never scrapes the interactive portal.
 *   - vendor: DISABLED unless COURT_DATA_VENDOR_URL + COURT_DATA_VENDOR_KEY are
 *     set. Authoritative ONLY when the operator also opts in via
 *     COURT_DATA_VENDOR_AUTHORITATIVE (gated downstream in resolveHit).
 *
 * Reads config from `process.env` (OpenNext exposes Worker vars/secrets there).
 * Tests can bypass this entirely by passing `config.adapters`.
 */
export function defaultAdapters(): CourtDateSourceAdapter[] {
  return [
    createEtrackEmailAdapter(),
    createNyscefAdapter(),
    createVendorAdapter(),
  ];
}

/**
 * A safe no-op adapter the orchestrator uses until a real adapter is registered.
 * ALWAYS returns not-found (never scrapes, never fabricates). The Adapters phase
 * swaps these out in {@link defaultAdapters}.
 */
export function notFoundStub(name: CourtSourceName): CourtDateSourceAdapter {
  return {
    name,
    async trySource(): Promise<CourtSourceResult> {
      return {
        found: false,
        source: name,
        note: `${name} adapter not yet wired (Adapters phase)`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Case lookup + persistence (composes the PUBLIC store API only)
// ---------------------------------------------------------------------------

/**
 * Find the Case whose `court.index_number` matches `indexNumber`. Composes the
 * public store API (listCases + getCase) — no new store internals. The store
 * does not index index_number, so this is an O(n) scan; fine for v1 volumes and
 * the email-ingest path (one lookup per inbound reminder). Never throws.
 *
 * Matching is exact on the trimmed index string. Returns the first match (index
 * numbers are unique per case in practice), or null.
 */
export async function findCaseByIndexNumber(
  indexNumber: string,
): Promise<Case | null> {
  const target = indexNumber.trim();
  if (!target) return null;
  try {
    const store = await import("@/lib/store");
    const summaries = await store.listCases();
    for (const s of summaries) {
      const full = await store.getCase(s.case_id);
      if (full?.court?.index_number?.trim() === target) return full;
    }
    return null;
  } catch (err) {
    console.error("[court-source] findCaseByIndexNumber failed:", err);
    return null;
  }
}

/**
 * End-to-end ingest of ONE already-parsed authoritative hit for a given index
 * number: find the Case, apply INVARIANT-#2 logic via {@link resolveHit}, and
 * persist the resulting `court` (+ `review` on discrepancy) through the public
 * store. Used by the eTrack email Worker handler. NEVER throws.
 *
 * Returns the outcome (plus the case_id when one matched) so the caller can log
 * a PII-free summary. On `discrepancy` the existing date is preserved and review
 * is escalated; on `verified`/`found_unverified` the court patch is saved.
 */
export async function ingestSourcedCourtDate(args: {
  index_number: string;
  hit: Extract<CourtSourceResult, { found: true }>;
  vendorAuthoritative?: boolean | null;
}): Promise<
  | { matched: false; note: string }
  | { matched: true; case_id: string; outcome: SourceCourtDateOutcome }
> {
  try {
    const c = await findCaseByIndexNumber(args.index_number);
    if (!c) {
      return {
        matched: false,
        note: `no case found for index_number ${args.index_number}`,
      };
    }

    const outcome = resolveHit({
      hit: args.hit,
      existingCourt: c.court,
      existingDate: c.court?.court_date ?? null,
      existingSource: c.court?.court_date_source ?? null,
      existingVerified: c.court?.court_date_verified === true,
      review: c.review,
      vendorAuthoritative: args.vendorAuthoritative,
    });

    const store = await import("@/lib/store");
    if (outcome.status === "verified" || outcome.status === "found_unverified") {
      // Persist the (re)sourced court date first.
      const patched = await store.patchCase(c.case_id, { court: outcome.court });

      // RE-ARM reminders when a VERIFIED (authoritative) court date lands and the
      // tenant has already opted into SMS reminders. Without this, a tenant who
      // consented BEFORE the verified date arrived would never get reminders
      // (scheduleCourtDateReminders refuses to arm off an unverified date). We
      // never SEND here — only schedule; the batch sender is env-gated.
      if (outcome.status === "verified" && patched) {
        await rearmCourtDateReminders(c.case_id, patched, store);
      }
    } else if (outcome.status === "discrepancy") {
      // Record both dates (warning carries both) + escalate. We do NOT change
      // court.court_date (the existing tenant/extracted value is preserved).
      await store.patchCase(c.case_id, { review: outcome.review });
    }

    return { matched: true, case_id: c.case_id, outcome };
  } catch (err) {
    console.error("[court-source] ingestSourcedCourtDate failed:", err);
    return { matched: false, note: "ingest failed (degraded; see logs)" };
  }
}

/**
 * Re-schedule court-date SMS reminders after a VERIFIED court date lands, IFF the
 * tenant has already opted in (valid SMS consent + safe_to_text). Idempotent:
 * drops any previously-scheduled (still-pending) `court_date` reminders and
 * replaces them with a fresh 7/3/1-day schedule anchored on the new verified
 * date, so a court-sourced date CHANGE re-arms reminders correctly. Already-sent
 * reminders and non-court reminders are preserved. NEVER throws (best-effort).
 *
 * This NEVER sends — it only writes the schedule; the env-gated batch sender does
 * the actual texting (dry-run unless Twilio creds are present).
 */
async function rearmCourtDateReminders(
  caseId: string,
  current: Case,
  store: typeof import("@/lib/store"),
): Promise<void> {
  try {
    const reminders = await import("@/lib/reminders");
    const ids = await import("@/lib/ids");
    const now = nowIso();

    // Only arm if the tenant has a valid SMS consent on file. (schedule
    // CourtDateReminders also re-checks consent + safe_to_text + authoritative
    // date internally, so this is a fast pre-check, not the gate.)
    const consent = reminders.findValidSmsConsent(current, now);
    if (!consent) return;

    const schedule = reminders.scheduleCourtDateReminders(
      current,
      now,
      undefined,
      () => ids.newId("rem"),
    );
    if (schedule.reminders.length === 0) return;

    // Replace pending court_date reminders; keep sent ones + other types.
    const kept = current.reminders.filter(
      (r) => !(r.reminder_type === "court_date" && r.state === "scheduled"),
    );
    await store.patchCase(caseId, {
      reminders: [...kept, ...schedule.reminders],
    });
  } catch (err) {
    console.error("[court-source] rearmCourtDateReminders failed:", err);
  }
}
