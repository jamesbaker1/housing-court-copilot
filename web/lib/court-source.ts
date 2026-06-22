/**
 * Court-date SOURCING — the appearance-driver's authoritative producer.
 *
 * BACKSTOP #1 (LEGAL-RULES §2.1, §8.5; API-CONTRACTS §3.9): the authoritative
 * `court.court_date` is sourced from **eTrack email ingest** and the **NYSCEF
 * public docket** — and is verified ONLY for those two sources. We NEVER scrape
 * the live eCourts portal, and the model is NEVER trusted for the date.
 *
 * This module is the LOOKUP side (the producer). The deterministic SINK that
 * actually stamps `court.court_date_verified` lives in `@/lib/court-date`
 * (`sourceCourtDateFromCourtSystem`, which only verifies etrack/nyscef). We
 * compose with it so there is one place that enforces the verified invariant.
 *
 * v1 STATUS: this is a clearly-marked best-effort STUB. The lookup returns
 * `{ found: false, source: null }` — there is no live integration yet, by
 * design (do NOT scrape). When a real eTrack/NYSCEF source is wired, it returns
 * `{ found: true, court_date, source }` and `applySourcedCourtDate` promotes it
 * onto the Court object as VERIFIED. A tenant-entered date stays unverified.
 */

import type { Court } from "@/lib/case";
import {
  AUTHORITATIVE_COURT_DATE_SOURCES,
  setCourtDate,
  type SetCourtDateResult,
} from "@/lib/court-date";

/** What we know to query a court source by. All optional; more is better. */
export interface CourtLookupQuery {
  index_number?: string | null;
  /** "New York" | "Bronx" | "Kings" | "Queens" | "Richmond" — NY county name. */
  county?: string | null;
  borough?: string | null;
}

/** The two authoritative court-date sources (eTrack / NYSCEF). */
export type AuthoritativeCourtSource =
  (typeof AUTHORITATIVE_COURT_DATE_SOURCES)[number];

/**
 * Result of a court-source lookup. On `found`, the date is authoritative — the
 * caller passes it straight into {@link applySourcedCourtDate}, which verifies.
 */
export type CourtLookupResult =
  | { found: false; source: null; note: string }
  | { found: true; court_date: string; source: AuthoritativeCourtSource };

/**
 * Look up an authoritative court date from the court system.
 *
 * ============================================================================
 * v1 STUB — DO NOT SCRAPE THE LIVE PORTAL.
 * ============================================================================
 * Returns `{ found: false }`. There is intentionally NO network call here.
 *
 * TODO(integration): wire the two authoritative producers (each owned by its
 * own contract; see API-CONTRACTS §3.9, LEGAL-RULES §8.5):
 *   - eTrack EMAIL INGEST: parse a forwarded NY Courts eTrack notification
 *     email -> { court_date, source: "etrack" }.
 *   - NYSCEF PUBLIC DOCKET: query the e-filed public docket for a calendared
 *     appearance by index number -> { court_date, source: "nyscef" }, and
 *     cross-check `court.index_number`.
 * Both must surface any discrepancy vs. a previously-confirmed tenant/extracted
 * date for human review rather than silently overwriting it. Until wired, this
 * returns not-found so the UI keeps relying on the tenant-confirmed (unverified)
 * date and never claims a verification it doesn't have.
 * ============================================================================
 */
export async function lookupCourtDate(
  _query: CourtLookupQuery,
): Promise<CourtLookupResult> {
  // No live integration in v1. Never scrape; never fabricate a date.
  return {
    found: false,
    source: null,
    note:
      "court-date sourcing not yet integrated (eTrack ingest + NYSCEF docket); " +
      "no authoritative date available — keep the tenant-confirmed value (unverified)",
  };
}

/**
 * Apply an authoritative sourced date onto a Court object. Delegates to the
 * deterministic sink in `@/lib/court-date`, which sets
 * `court_date_verified = true` ONLY for etrack/nyscef. Pure: returns a new
 * Court, does not mutate. The caller persists + writes the audit event.
 */
export function applySourcedCourtDate(
  court: Court | undefined,
  found: Extract<CourtLookupResult, { found: true }>,
): SetCourtDateResult {
  return setCourtDate(court, {
    court_date: found.court_date,
    source: found.source,
  });
}

/**
 * Convenience: look up an authoritative court date and, if found, return the
 * verified Court patch. If not found, returns `{ updated: false }` and the
 * caller leaves the existing (tenant-entered / unverified) date untouched.
 */
export async function sourceAndApplyCourtDate(
  court: Court | undefined,
  query: CourtLookupQuery,
): Promise<
  { updated: false; note: string } | { updated: true; court: Court }
> {
  const found = await lookupCourtDate(query);
  if (!found.found) {
    return { updated: false, note: found.note };
  }
  const applied = applySourcedCourtDate(court, found);
  if (!applied.ok) {
    return { updated: false, note: applied.reason };
  }
  return { updated: true, court: applied.court };
}
