/**
 * eTrack APPOINTMENT-REMINDER EMAIL adapter (Adapters-phase, primary sanctioned
 * live channel for ROADMAP Tier-2 #6).
 *
 * ============================================================================
 * WHAT THIS IS — and is NOT
 * ============================================================================
 * NY Courts "eTrack" lets a registrant track a case; when an appearance is
 * scheduled/upcoming, eTrack SENDS the registrant a reminder EMAIL. That email
 * is a SANCTIONED, push channel: the court system mails us, we parse what it
 * sent. We do NOT scrape the eTrack / eCourts / WebCivilLocal web portals
 * (CAPTCHA/Cloudflare-protected; UCS ToS prohibits bots — CFAA/contract risk).
 * There is NO HTTP fetch in this file. The ONLY input is an inbound email the
 * Cloudflare Email Worker hands us (see worker-entry.ts `email()`).
 *
 * This adapter does TWO things:
 *   1) parseEtrackEmail(...) — defensive, never-throwing extraction of the
 *      index number, next appearance date, and part from a reminder email.
 *   2) createEtrackEmailAdapter() — a CourtDateSourceAdapter (CourtDateSource
 *      shape) so the orchestrator can treat eTrack as one pluggable source. Its
 *      `trySource` only resolves when handed a `rawEmail`; it never polls.
 *
 * INVARIANT #2 is enforced by the ORCHESTRATOR, not here: this adapter only
 * reports `{ found, date, part, source:"etrack-email", confidence }`. The
 * connector routes that through lib/court-date.setCourtDate (the sole writer of
 * court_date_verified) and escalates discrepancies. This file never writes a
 * Case and never sets verified.
 *
 * ============================================================================
 * ASSUMED EMAIL FORMAT  —  *** UNVERIFIED — VALIDATE AGAINST A REAL EMAIL ***
 * ============================================================================
 * !!! FLAG FOR OPS/ENGINEERING: the patterns below are a BEST-EFFORT guess at
 * !!! the eTrack reminder layout. They have NOT been validated against a real
 * !!! eTrack appointment-reminder email. Before enabling this in production you
 * !!! MUST capture a genuine eTrack reminder (with PII redacted) and confirm /
 * !!! correct: the sender domain(s) (ETRACK_SENDER_DOMAINS), the index-number
 * !!! label + format, the date label + format, and the part label. Treat a hit
 * !!! as `confidence:"high"` ONLY once these are confirmed; until then the
 * !!! orchestrator's "act only on high" rule plus the verified-source gate keep
 * !!! a mis-parse from silently moving a real court date.
 *
 * The parser is written to tolerate a range of plausible layouts rather than
 * one rigid template. The illustrative example it is modeled on:
 *
 *   From: eTrack <donotreply@nycourts.gov>
 *   Subject: eTrack Appointment Reminder - Index No. 123456/2025
 *
 *   This is an automated reminder from the New York State Unified Court
 *   System eTrack service.
 *
 *   Index Number: 123456/2025
 *   Court: Civil Court of the City of New York, Kings County
 *   Next Appearance Date: 07/15/2026
 *   Part: H
 *   Purpose: Trial
 *
 *   Do not reply to this message.
 *
 * Recognized index-number forms (NY): "123456/2025", "L&T 070123/2025",
 * "LT-012345-25/KI", "CV-000123-26". Recognized date forms: MM/DD/YYYY,
 * "July 15, 2026", "Jul 15, 2026", and already-ISO YYYY-MM-DD. All dates are
 * normalized to a bare YYYY-MM-DD calendar date (America/New_York; no time) —
 * the canonical shape lib/court-date.validateCourtDateString enforces.
 */

import type {
  CourtDateSourceAdapter,
  CourtSourceInput,
  CourtSourceResult,
  ParsedEtrackEmail,
} from "@/lib/court-source";

// ---------------------------------------------------------------------------
// Sender guard
// ---------------------------------------------------------------------------

/**
 * Sender domain(s) the operator expects eTrack reminders from. eTrack mail
 * originates from the NY Courts domain; the exact envelope/from address is one
 * of the things to CONFIRM against a real email (it may be e.g.
 * `donotreply@nycourts.gov`, `etrack@nycourts.gov`, or a `@courts.state.ny.us`
 * sender). We allow the known NY Courts apex domains and match on suffix so a
 * subdomain (mail.nycourts.gov) still passes.
 *
 * Operators can additionally constrain this at the edge via Cloudflare Email
 * Routing rules (only route eTrack mail to the Worker) — this is defense in
 * depth, not the only gate.
 */
export const ETRACK_SENDER_DOMAINS: readonly string[] = [
  "nycourts.gov",
  "courts.state.ny.us",
  "nycourts.state.ny.us",
];

/**
 * Extract the bare domain from an address that may be a plain address
 * ("a@b.gov"), a display-name form ("eTrack <a@b.gov>"), or already a domain.
 * Lower-cased; returns "" when no `@` is present and the input is not a domain.
 */
function extractDomain(fromAddress: string): string {
  const trimmed = (fromAddress ?? "").trim().toLowerCase();
  if (!trimmed) return "";
  // Pull the address out of an RFC-5322 display-name form if present.
  const angle = trimmed.match(/<([^>]+)>/);
  const addr = (angle?.[1] ?? trimmed).trim();
  const at = addr.lastIndexOf("@");
  if (at === -1) {
    // No "@" — treat the whole token as a domain candidate (e.g. routing rule
    // passed us a bare domain). Strip any stray angle/space.
    return addr.replace(/[<>\s]/g, "");
  }
  return addr.slice(at + 1).replace(/[>\s]/g, "");
}

/**
 * True if `fromAddress` is from an allowed eTrack sender domain (exact apex or a
 * subdomain of one). Never throws; a malformed address simply returns false.
 */
export function isAllowedEtrackSender(fromAddress: string): boolean {
  const domain = extractDomain(fromAddress);
  if (!domain) return false;
  return ETRACK_SENDER_DOMAINS.some(
    (allowed) => domain === allowed || domain.endsWith(`.${allowed}`),
  );
}

// ---------------------------------------------------------------------------
// Parsing helpers (all pure, none throw)
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Zero-pad a 1-2 digit number to 2 chars. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Reject obviously-bogus calendar dates so a mis-parse can't yield "2026-13-40".
 * Mirrors (loosely) lib/court-date's real-calendar-date check; the orchestrator
 * re-validates via setCourtDate, so this is a cheap first filter only.
 */
function isPlausibleYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    return false;
  }
  if (y < 2000 || y > 2100) return false;
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return (
    probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
  );
}

/**
 * Normalize a date token in any recognized form to YYYY-MM-DD, or null if it is
 * not a recognizable / plausible date. Recognizes:
 *   - ISO            2026-07-15
 *   - US numeric     07/15/2026  (and 7/5/2026); also 07-15-2026
 *   - Long/abbrev    "July 15, 2026" / "Jul 15 2026"
 * 2-digit years are expanded to 20YY (court dates are present/future).
 */
function normalizeDate(token: string): string | null {
  const s = token.trim();
  if (!s) return null;

  // Already ISO (YYYY-MM-DD).
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    return isPlausibleYmd(y, mo, d) ? `${m[1]}-${pad2(mo)}-${pad2(d)}` : null;
  }

  // US numeric MM/DD/YYYY or MM-DD-YYYY (with 1-2 digit month/day, 2-4 yr).
  m = s.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b/);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return isPlausibleYmd(y, mo, d) ? `${y}-${pad2(mo)}-${pad2(d)}` : null;
  }

  // Long/abbreviated month name: "July 15, 2026" / "Jul 15 2026".
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})\b/);
  if (m) {
    const mo = MONTHS[(m[1] ?? "").toLowerCase()];
    const d = Number(m[2]);
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (mo && isPlausibleYmd(y, mo, d)) return `${y}-${pad2(mo)}-${pad2(d)}`;
  }

  return null;
}

/**
 * Pull a likely NY court index number out of a line of text. NY index numbers
 * vary by court/system; we accept the common shapes:
 *   - "123456/2025"            (Supreme/Civil classic)
 *   - "L&T 070123/2025"        (Housing L&T with prefix)
 *   - "LT-012345-25/KI"        (newer hyphenated case id with county suffix)
 *   - "CV-000123-26"
 * Returns the trimmed match, or null. Prefers the longest/most specific match.
 */
function extractIndexNumber(text: string): string | null {
  // 1) Hyphenated modern form: LT-012345-25 optionally /KI (county).
  let m = text.match(/\b([A-Z]{1,4}-\d{4,8}-\d{2,4}(?:\/[A-Z]{2})?)\b/);
  if (m?.[1]) return m[1];

  // 2) Classic slash form, optionally with an L&T / index prefix word.
  m = text.match(/\b(?:L&T\s+|Index\s*(?:No\.?|Number)?\s*:?\s*)?(\d{3,8}\/\d{4})\b/i);
  if (m?.[1]) return m[1];

  return null;
}

/**
 * Crudely strip the most common quoted-printable artifacts and collapse soft
 * line breaks so label/value extraction is more robust against transfer
 * encodings. We do NOT attempt full MIME parsing (no dep); we operate on the
 * decoded text body the Worker hands us plus a light cleanup. Never throws.
 */
function tidy(raw: string): string {
  return raw
    .replace(/=\r?\n/g, "") // QP soft line breaks
    .replace(/=3D/gi, "=") // QP-encoded '='
    .replace(/&nbsp;/gi, " ")
    .replace(/<[^>]+>/g, " ") // drop any HTML tags (keep text content)
    .replace(/\r\n/g, "\n");
}

/**
 * Find the value following a labeled field, e.g.
 *   "Next Appearance Date: 07/15/2026"  → "07/15/2026"
 * `labels` are tried in order; matching is case-insensitive and tolerates
 * varied spacing/punctuation after the label. Returns the raw value substring
 * (caller normalizes), or null.
 */
function valueForLabel(text: string, labels: string[]): string | null {
  for (const label of labels) {
    const re = new RegExp(
      `${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-]?\\s*(.+)`,
      "i",
    );
    const m = text.match(re);
    const captured = m?.[1];
    if (captured) {
      // Take up to end-of-line.
      const line = (captured.split("\n")[0] ?? "").trim();
      if (line) return line;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// parseEtrackEmail — the public, never-throwing parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw inbound eTrack reminder email into a court-date hit.
 *
 * NEVER throws. Returns `{ parsed:false, reason }` when the message does not
 * look like a recognizable eTrack reminder (or is missing the index/date we
 * need). On success returns `{ parsed:true, index_number, court_date (ISO),
 * part?, confidence }`. The orchestrator decides verification; we only report.
 *
 * Confidence policy (conservative until validated against real mail):
 *   - "high"   when BOTH the index number and the date were found via their
 *              expected LABELS (strong structural signal).
 *   - "medium" when found but at least one came from a looser fallback (e.g.
 *              subject line, or a bare date with no label).
 *   - "low"    is not emitted here; a result we are not confident enough to act
 *              on is reported as parsed:false (the handler drops it) so the
 *              orchestrator never even sees a sub-actionable eTrack hit.
 */
export function parseEtrackEmail(input: {
  from: string;
  raw: string;
  subject?: string | null;
}): ParsedEtrackEmail {
  try {
    const subject = (input.subject ?? "").trim();
    const body = tidy(input.raw ?? "");
    const haystack = `${subject}\n${body}`;

    // Sanity: does this even smell like eTrack? Cheap content guard so we don't
    // mis-parse unrelated court mail. (Sender domain is guarded upstream.)
    const looksLikeEtrack =
      /etrack/i.test(haystack) ||
      /unified court system/i.test(haystack) ||
      /appearance/i.test(haystack);
    if (!looksLikeEtrack) {
      return { parsed: false, reason: "no eTrack/appearance markers in message" };
    }

    // --- Index number -------------------------------------------------------
    // Prefer a labeled value in the body; fall back to the subject; then any
    // index-shaped token anywhere.
    let indexConfident = true;
    let indexNumber: string | null = null;

    const labeledIndexValue = valueForLabel(body, [
      "Index Number",
      "Index No",
      "Index #",
      "Case Number",
      "Docket Number",
    ]);
    if (labeledIndexValue) {
      indexNumber =
        extractIndexNumber(labeledIndexValue) ?? (labeledIndexValue.trim() || null);
    }
    if (!indexNumber) {
      indexNumber = extractIndexNumber(subject);
      if (indexNumber) indexConfident = false; // came from subject, not a body label
    }
    if (!indexNumber) {
      indexNumber = extractIndexNumber(body);
      if (indexNumber) indexConfident = false; // unlabeled token in body
    }
    if (!indexNumber) {
      return { parsed: false, reason: "could not locate an index number" };
    }

    // --- Court date ---------------------------------------------------------
    let dateConfident = true;
    let courtDate: string | null = null;

    const labeledDateValue = valueForLabel(body, [
      "Next Appearance Date",
      "Next Appearance",
      "Appearance Date",
      "Court Date",
      "Scheduled Date",
      "Date of Appearance",
      "Hearing Date",
    ]);
    if (labeledDateValue) {
      courtDate = normalizeDate(labeledDateValue);
    }
    if (!courtDate) {
      // Fallback: first plausible date anywhere in the body. Lower confidence.
      const anyDate = body.match(
        /\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4})\b/,
      );
      if (anyDate?.[1]) {
        courtDate = normalizeDate(anyDate[1]);
        if (courtDate) dateConfident = false;
      }
    }
    if (!courtDate) {
      return { parsed: false, reason: "could not locate a parseable court date" };
    }

    // --- Part / room (optional) --------------------------------------------
    let part: string | null = null;
    const labeledPart = valueForLabel(body, ["Part", "Courtroom", "Room"]);
    if (labeledPart) {
      // Keep it short — a part is typically a token like "H", "52", "TAP A".
      const cleaned = labeledPart.replace(/\s{2,}/g, " ").trim();
      part = cleaned.length > 0 && cleaned.length <= 32 ? cleaned : null;
    }

    const confidence: "high" | "medium" =
      indexConfident && dateConfident ? "high" : "medium";

    return {
      parsed: true,
      index_number: indexNumber.trim(),
      court_date: courtDate,
      part,
      confidence,
    };
  } catch (err) {
    // NEVER throw to the caller.
    console.error("[etrack-email] parseEtrackEmail failed:", err);
    return { parsed: false, reason: "parser error (degraded; see logs)" };
  }
}

// ---------------------------------------------------------------------------
// CourtDateSourceAdapter implementation
// ---------------------------------------------------------------------------

/**
 * Build the eTrack-email CourtDateSourceAdapter. Unlike a polling source, eTrack
 * is PUSH: the only way this adapter can resolve a date is from a `rawEmail`
 * present on the orchestrator input (the email-ingest path). When invoked
 * without one (e.g. the periodic poll that runs NYSCEF/vendor), it correctly
 * reports `{ found:false }` — it never reaches out to any portal.
 *
 * On the email path the orchestrator typically calls the adapter's parser
 * directly (via the worker handler + ingestSourcedCourtDate); this trySource is
 * provided so eTrack still slots into the generic adapter loop uniformly.
 */
export function createEtrackEmailAdapter(): CourtDateSourceAdapter {
  return {
    name: "etrack-email",
    async trySource(input: CourtSourceInput): Promise<CourtSourceResult> {
      const email = input.rawEmail;
      if (!email) {
        // No inbound email to parse — eTrack cannot be polled. Not an error.
        return {
          found: false,
          source: "etrack-email",
          note: "eTrack is a push (email) channel; no inbound email on this input",
        };
      }

      // Guard the sender even on this path (defense in depth).
      if (!isAllowedEtrackSender(email.from)) {
        return {
          found: false,
          source: "etrack-email",
          note: "sender not an allowed eTrack domain",
        };
      }

      const parsed = parseEtrackEmail({
        from: email.from,
        raw: email.raw,
        subject: email.subject ?? null,
      });
      if (!parsed.parsed) {
        return { found: false, source: "etrack-email", note: parsed.reason };
      }

      return {
        found: true,
        date: parsed.court_date,
        source: "etrack-email",
        part: parsed.part ?? null,
        index_number: parsed.index_number,
        confidence: parsed.confidence,
      };
    },
  };
}
