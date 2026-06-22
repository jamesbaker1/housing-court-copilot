/**
 * BACKSTOP #1 — code-backed, tenant-confirmed court date.
 *
 * THE COURT DATE IS NEVER TRUSTED FROM THE MODEL. A wrong court date causes a
 * default judgment (the tenant loses automatically), so this module is the
 * deterministic gate that owns `case.court.court_date` + `court_date_source` +
 * `court_date_verified`.
 *
 * Provenance rules (mirrors lib/case.ts CourtSchema + LEGAL-RULES §2.1):
 *   - `court_date_verified = true` ONLY when sourced from eTrack / NYSCEF.
 *   - An LLM-extracted court date is ALWAYS `document_extracted_unverified` and
 *     NEVER verified. It lives on the document, and is only promoted onto
 *     `court` here as an *unverified* working value the tenant must confirm.
 *   - A tenant-typed date is `tenant_entered` and unverified (the tenant
 *     confirming what they read off their own papers is not court-sourcing).
 *
 * This file is PURE deterministic TypeScript. No LLM, no I/O. It returns a new
 * Court object (it does not mutate); the caller stitches it into the Case and
 * writes the audit event.
 */
import type { Court } from "@/lib/case";
import { CourtSchema, DateSchema } from "@/lib/case";

/**
 * How a court date arrived. Maps 1:1 onto `Court.court_date_source`.
 *
 * Only `etrack` / `nyscef` are authoritative sources — they set
 * `court_date_verified = true`. Everything else is a working value the tenant
 * must still confirm and a lawyer/court must still verify.
 */
export type CourtDateSource = NonNullable<Court["court_date_source"]>;

/** The two — and only two — sources that make a court date authoritative. */
export const AUTHORITATIVE_COURT_DATE_SOURCES = [
  "etrack",
  "nyscef",
] as const satisfies readonly CourtDateSource[];

/** Type guard: is this an authoritative (court-sourced) provenance? */
export function isAuthoritativeSource(
  source: CourtDateSource,
): source is (typeof AUTHORITATIVE_COURT_DATE_SOURCES)[number] {
  return (AUTHORITATIVE_COURT_DATE_SOURCES as readonly string[]).includes(
    source,
  );
}

/** Result of validating a candidate court-date string. */
export type DateValidationResult =
  | { ok: true; date: string }
  | { ok: false; reason: string };

/**
 * Validate a court-date string deterministically.
 *
 * Enforces the canonical bare-calendar-date shape (YYYY-MM-DD, America/New_York
 * calendar — no time component) AND that it is a real calendar date (rejects
 * 2026-02-30, 2026-13-01, etc., which the regex alone would let through).
 *
 * This does NOT judge whether the date is "correct" for the case — only that it
 * is a well-formed real date. Correctness is the tenant-confirm + court-source
 * job, never a format check.
 */
export function validateCourtDateString(input: string): DateValidationResult {
  const trimmed = input.trim();

  // Shape gate: same DateSchema the Case Object uses (YYYY-MM-DD).
  const shape = DateSchema.safeParse(trimmed);
  if (!shape.success) {
    return {
      ok: false,
      reason:
        "Court date must be a calendar date in YYYY-MM-DD form (no time).",
    };
  }

  // Real-calendar-date gate. Parse the parts and round-trip through a UTC Date
  // so that overflow (e.g. month 13, day 32, Feb 30) is rejected rather than
  // silently normalized.
  const parts = trimmed.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  const asUtc = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day;

  if (!roundTrips) {
    return { ok: false, reason: "That is not a real calendar date." };
  }

  return { ok: true, date: trimmed };
}

/** Input to {@link setCourtDate}. */
export interface SetCourtDateInput {
  /** The candidate date (validated here; rejected if malformed). */
  court_date: string;
  /** Where the date came from. Determines whether it can be verified. */
  source: CourtDateSource;
  /**
   * Tenant has confirmed this date against their official court papers. Note
   * this is independent of `court_date_verified`: a tenant can confirm an
   * unverified (e.g. document-extracted) date, and a court-sourced date can be
   * verified before the tenant has separately confirmed it. Both signals are
   * tracked; downstream filing gates require BOTH the verified/authoritative
   * provenance AND tenant confirmation.
   */
  tenant_confirmed?: boolean;
}

/** Outcome of a set/confirm operation. */
export type SetCourtDateResult =
  | { ok: true; court: Court }
  | { ok: false; reason: string };

/**
 * Set the court date on a Court object with an explicit source.
 *
 * Deterministically enforces the backstop:
 *   - validates the date string,
 *   - sets `court_date_verified = true` IFF the source is eTrack/NYSCEF,
 *   - never lets a document-extracted or tenant-entered date be verified.
 *
 * Returns a NEW Court object (pure — does not mutate the input). The caller is
 * responsible for persisting it and appending the audit event.
 */
export function setCourtDate(
  court: Court | undefined,
  input: SetCourtDateInput,
): SetCourtDateResult {
  const validation = validateCourtDateString(input.court_date);
  if (!validation.ok) {
    return { ok: false, reason: validation.reason };
  }

  const verified = isAuthoritativeSource(input.source);

  const next: Court = {
    ...(court ?? {}),
    court_date: validation.date,
    court_date_source: input.source,
    // HARD INVARIANT: only authoritative sources may verify a court date.
    court_date_verified: verified,
  };

  // Re-validate against the canonical schema so we never emit a Court that the
  // Case Object would reject (e.g. a bad pre-existing field on the spread).
  const parsed = CourtSchema.safeParse(next);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `Resulting court record is invalid: ${parsed.error.message}`,
    };
  }

  return { ok: true, court: { ...parsed.data, ...optionalTenantConfirm(input) } };
}

/**
 * `tenant_confirmed` is not a field on Court (the Case Object tracks tenant
 * confirmation per-deadline, and court-date confirmation is surfaced via the
 * source/verified pair plus the UI). We keep the parameter in the API for the
 * caller's convenience/auditing but do not invent a schema field for it here.
 * This helper is a no-op placeholder that keeps {@link setCourtDate} honest
 * about not writing a non-canonical field.
 */
function optionalTenantConfirm(_input: SetCourtDateInput): Partial<Court> {
  return {};
}

/**
 * Tenant confirms a court date they have read off their official court papers.
 *
 * This does NOT make the date authoritative (verified) — the tenant is not a
 * court system. It records the date as `tenant_entered` and unverified. Use
 * {@link sourceCourtDateFromCourtSystem} when an eTrack/NYSCEF feed provides
 * the date; only that path sets `court_date_verified = true`.
 */
export function confirmCourtDateFromTenant(
  court: Court | undefined,
  court_date: string,
): SetCourtDateResult {
  return setCourtDate(court, {
    court_date,
    source: "tenant_entered",
    tenant_confirmed: true,
  });
}

/**
 * Promote an LLM-extracted court date onto `court` as an UNVERIFIED working
 * value. The tenant must still confirm it; it is never authoritative.
 *
 * The extracted value rightly lives on the document (see lib/case.ts
 * ExtractedFieldsSchema.court_date). This helper makes the deliberate, narrow
 * move of surfacing it on `court` so the UI can show "we think your court date
 * is X — please confirm against your papers", with provenance recorded as
 * `document_extracted_unverified` and `court_date_verified = false`.
 */
export function setExtractedCourtDateUnverified(
  court: Court | undefined,
  court_date: string,
): SetCourtDateResult {
  return setCourtDate(court, {
    court_date,
    source: "document_extracted_unverified",
    tenant_confirmed: false,
  });
}

/**
 * Source a court date from the court system (eTrack / NYSCEF). This is the ONLY
 * path that yields `court_date_verified = true`.
 *
 * ============================================================================
 * PLACEHOLDER — FUTURE eTrack / NYSCEF SOURCING INTEGRATION
 * ============================================================================
 * Per LEGAL-RULES §8.5: court dates are sourced via **eTrack email ingest** and
 * the **NYSCEF public docket** — NEVER by scraping the live eCourts portal.
 * Those integrations are owned by a separate spec (the eTrack email-ingest
 * parse schema and the NYSCEF public-docket query/response contract, including
 * discrepancy surfacing). This function is the deterministic SINK that the
 * future integration will call once it has resolved an authoritative date:
 *
 *   - eTrack ingest parses a forwarded court email -> source "etrack".
 *   - NYSCEF docket query returns a calendared appearance -> source "nyscef".
 *
 * Until those integrations exist, this function still works correctly for the
 * date it is handed; there is simply no automated producer wired to it yet.
 * TODO(integration): wire eTrack email-ingest + NYSCEF docket clients to call
 * this with the parsed date + the matching source, and surface any discrepancy
 * against a previously-confirmed tenant/extracted date for human review.
 * ============================================================================
 */
export function sourceCourtDateFromCourtSystem(
  court: Court | undefined,
  court_date: string,
  source: (typeof AUTHORITATIVE_COURT_DATE_SOURCES)[number],
): SetCourtDateResult {
  return setCourtDate(court, { court_date, source });
}

/**
 * Is this court's date safe to RELY ON as authoritative? True only when the
 * date is present, well-formed, and verified from a court source. Downstream
 * countdown/filing surfaces should treat anything else as "estimate only —
 * confirm with the court".
 */
export function isCourtDateAuthoritative(court: Court | undefined): boolean {
  if (!court?.court_date || court.court_date_verified !== true) return false;
  if (!court.court_date_source || !isAuthoritativeSource(court.court_date_source)) {
    return false;
  }
  return validateCourtDateString(court.court_date).ok;
}
