/**
 * HPD open data via the Socrata SODA JSON API (data.cityofnewyork.us).
 *
 * Three lookups, all keyed by BBL (resolved first via GeoSearch — see
 * geosearch.ts), per TOOL-CONTRACTS §2-§4:
 *   - Violations   (wvxf-dwi5)            → open violations w/ class + dates
 *   - Complaints   (ygpa-z7cr)            → tenant complaint trail (notice signal)
 *   - Registration (tesw-yqqr → feu5-w2e2) → registered owner + registration signal
 *
 * Socrata is keyless for low volume; an optional `X-App-Token` lifts the rate
 * limit. We read it from process.env.SOCRATA_APP_TOKEN (never hardcoded).
 *
 * NONE of these functions throw: every network/HTTP/parse failure returns a
 * partial result with `ok:false` + a `note`, so the orchestrator can degrade
 * gracefully. These are pure reads (no Case mutation here); index.ts maps the
 * results onto the Case.
 *
 * IMPORTANT mappings from the spec:
 *  - The legacy complaint datasets (uwyv-629c / a2nx-4u46) were SUNSET — we use
 *    ygpa-z7cr only.
 *  - registration_on_file is true ONLY when a registration exists AND is current.
 *    A missing OR expired/lapsed registration maps to false (§4 — the registration
 *    defense signal cares about the absence of a *current/valid* registration).
 */

const SOCRATA_BASE = "https://data.cityofnewyork.us/resource";

/** Dataset ids are config in the spec; pinned here to the current (non-sunset) ids. */
export const HPD_DATASETS = {
  violations: "wvxf-dwi5",
  complaints: "ygpa-z7cr",
  registration: "tesw-yqqr",
  contacts: "feu5-w2e2",
} as const;

function appTokenHeaders(): Record<string, string> {
  const token = process.env.SOCRATA_APP_TOKEN;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token && token.trim()) headers["X-App-Token"] = token.trim();
  return headers;
}

/** Run a SODA query; returns the parsed rows or throws (callers catch). */
async function sodaQuery(
  dataset: string,
  query: string,
  signal?: AbortSignal,
): Promise<{ rows: Record<string, unknown>[]; endpoint: string }> {
  const endpoint = `${SOCRATA_BASE}/${dataset}.json?${query}`;
  const res = await fetch(endpoint, {
    method: "GET",
    headers: appTokenHeaders(),
    signal,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Socrata ${dataset} HTTP ${res.status}`);
  }
  const json = (await res.json()) as unknown;
  const rows = Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
  return { rows, endpoint };
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Normalize a Socrata date-ish field to YYYY-MM-DD (or null). */
function toDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Violations (wvxf-dwi5)
// ---------------------------------------------------------------------------

export interface HpdViolation {
  violation_id: string | null;
  /** Hazard class A | B | C (C = immediately hazardous). */
  hazard_class: string | null;
  /** Open | Closed (raw CurrentStatus, normalized to "open"/"closed"/raw). */
  status: string | null;
  /** Plain-text condition / NOV description. */
  description: string | null;
  /** Date the violation was issued / reported (YYYY-MM-DD). */
  reported_date: string | null;
  /** Apartment, if present. */
  apartment: string | null;
}

export interface HpdViolationsResult {
  ok: boolean;
  violations: HpdViolation[];
  counts: { open: number; class_c_open: number; total: number };
  endpoint: string | null;
  note: string | null;
}

function normalizeStatus(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("close")) return "closed";
  if (lower.includes("open")) return "open";
  return raw;
}

export async function lookupHpdViolations(
  bbl: string,
  opts: { signal?: AbortSignal; openOnly?: boolean } = {},
): Promise<HpdViolationsResult> {
  // wvxf-dwi5 keys on `bbl` (10-digit). Order newest-first, cap the window.
  const where = `bbl='${bbl}'`;
  const query = `$where=${encodeURIComponent(where)}&$order=novissueddate DESC&$limit=200`;
  try {
    const { rows, endpoint } = await sodaQuery(
      HPD_DATASETS.violations,
      query,
      opts.signal,
    );
    const violations: HpdViolation[] = rows.map((r) => ({
      violation_id: str(r.violationid) ?? str(r.violation_id),
      hazard_class: (str(r.class) ?? str(r.violationclass))?.toUpperCase() ?? null,
      status: normalizeStatus(str(r.currentstatus) ?? str(r.violationstatus)),
      description: str(r.novdescription) ?? str(r.nov_description),
      reported_date: toDate(r.novissueddate) ?? toDate(r.inspectiondate),
      apartment: str(r.apartment),
    }));

    const open = violations.filter((v) => v.status === "open");
    const result: HpdViolationsResult = {
      ok: true,
      violations: opts.openOnly ? open : violations,
      counts: {
        open: open.length,
        class_c_open: open.filter((v) => v.hazard_class === "C").length,
        total: violations.length,
      },
      endpoint,
      note: null,
    };
    return result;
  } catch (err) {
    return {
      ok: false,
      violations: [],
      counts: { open: 0, class_c_open: 0, total: 0 },
      endpoint: `${SOCRATA_BASE}/${HPD_DATASETS.violations}.json`,
      note:
        err instanceof Error
          ? `HPD violations lookup failed: ${err.message}`
          : "HPD violations lookup failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Complaints (ygpa-z7cr)
// ---------------------------------------------------------------------------

export interface HpdComplaint {
  complaint_id: string | null;
  /** Condition / problem category. */
  condition: string | null;
  status: string | null;
  /** Date received (YYYY-MM-DD). */
  received_date: string | null;
  apartment: string | null;
}

export interface HpdComplaintsResult {
  ok: boolean;
  complaints: HpdComplaint[];
  /** Descriptive (non-authoritative) notice timeline of complaint dates. */
  notice_timeline: { date: string; condition: string | null; status: string | null }[];
  counts: { total: number; open: number };
  endpoint: string | null;
  note: string | null;
}

export async function lookupHpdComplaints(
  bbl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<HpdComplaintsResult> {
  const where = `bbl='${bbl}'`;
  const query = `$where=${encodeURIComponent(where)}&$order=receiveddate DESC&$limit=200`;
  try {
    const { rows, endpoint } = await sodaQuery(
      HPD_DATASETS.complaints,
      query,
      opts.signal,
    );
    const complaints: HpdComplaint[] = rows.map((r) => ({
      complaint_id: str(r.complaintid) ?? str(r.complaint_id),
      condition:
        str(r.majorcategory) ??
        str(r.minorcategory) ??
        str(r.type) ??
        str(r.complaintcategory),
      status: normalizeStatus(str(r.status) ?? str(r.complaintstatus)),
      received_date: toDate(r.receiveddate) ?? toDate(r.statusdate),
      apartment: str(r.apartment),
    }));

    const notice_timeline = complaints
      .filter((c) => c.received_date)
      .map((c) => ({
        date: c.received_date!,
        condition: c.condition,
        status: c.status,
      }));

    return {
      ok: true,
      complaints,
      notice_timeline,
      counts: {
        total: complaints.length,
        open: complaints.filter((c) => c.status === "open").length,
      },
      endpoint,
      note: null,
    };
  } catch (err) {
    return {
      ok: false,
      complaints: [],
      notice_timeline: [],
      counts: { total: 0, open: 0 },
      endpoint: `${SOCRATA_BASE}/${HPD_DATASETS.complaints}.json`,
      note:
        err instanceof Error
          ? `HPD complaints lookup failed: ${err.message}`
          : "HPD complaints lookup failed.",
    };
  }
}

// ---------------------------------------------------------------------------
// Registration + contacts (tesw-yqqr → feu5-w2e2)
// ---------------------------------------------------------------------------

export interface HpdContact {
  role: string | null;
  name: string | null;
  business_address: string | null;
}

export interface HpdRegistrationResult {
  ok: boolean;
  registration_id: string | null;
  /**
   * Per §4 mapping: TRUE only when a registration exists AND is current.
   * Missing OR expired/lapsed → FALSE (the legally relevant signal is the
   * absence of a *current/valid* registration).
   */
  registration_on_file: boolean;
  /** Raw signal retained for the human reviewer: whether the record is current. */
  registration_current: boolean;
  registered_owner_name: string | null;
  contacts: HpdContact[];
  endpoint: string | null;
  /** "missing" | "expired" | "current" — human-readable distinction. */
  registration_state: "missing" | "expired" | "current";
  note: string | null;
}

/** Pick the best owner-ish contact name for parties.landlord.registered_owner_name. */
function pickOwnerName(contacts: HpdContact[]): string | null {
  const priority = [
    "CorporateOwner",
    "IndividualOwner",
    "HeadOfficer",
    "Owner",
    "Agent",
  ];
  for (const role of priority) {
    const hit = contacts.find(
      (c) => (c.role ?? "").toLowerCase() === role.toLowerCase() && c.name,
    );
    if (hit) return hit.name;
  }
  return contacts.find((c) => c.name)?.name ?? null;
}

function composeAddress(r: Record<string, unknown>): string | null {
  const parts = [
    str(r.businesshousenumber),
    str(r.businessstreetname),
    str(r.businessapartment),
    str(r.businesscity),
    str(r.businessstate),
    str(r.businesszip),
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

/** Is the registration record current (not past its registration end date)? */
function isRegistrationCurrent(row: Record<string, unknown>): boolean {
  const end =
    toDate(row.registrationenddate) ??
    toDate(row.lastregistrationdate) ??
    null;
  if (!end) {
    // No end date present: treat the existence of a record as current (best-effort).
    return true;
  }
  const today = new Date().toISOString().slice(0, 10);
  return end >= today;
}

export async function lookupHpdRegistration(
  bbl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<HpdRegistrationResult> {
  const regEndpoint = `${SOCRATA_BASE}/${HPD_DATASETS.registration}.json`;
  let registrationId: string | null = null;
  let current = false;
  let endpoint = regEndpoint;

  // Step 1: BBL -> registration record (tesw-yqqr).
  try {
    const where = `bbl='${bbl}'`;
    const query = `$where=${encodeURIComponent(where)}&$order=lastregistrationdate DESC&$limit=5`;
    const { rows, endpoint: ep } = await sodaQuery(
      HPD_DATASETS.registration,
      query,
      opts.signal,
    );
    endpoint = ep;
    if (rows.length === 0) {
      return {
        ok: true,
        registration_id: null,
        registration_on_file: false,
        registration_current: false,
        registered_owner_name: null,
        contacts: [],
        endpoint,
        registration_state: "missing",
        note: "No HPD registration record found for this building.",
      };
    }
    const top = rows[0]!;
    registrationId = str(top.registrationid) ?? str(top.registration_id);
    current = isRegistrationCurrent(top);
  } catch (err) {
    return {
      ok: false,
      registration_id: null,
      registration_on_file: false,
      registration_current: false,
      registered_owner_name: null,
      contacts: [],
      endpoint: regEndpoint,
      registration_state: "missing",
      note:
        err instanceof Error
          ? `HPD registration lookup failed: ${err.message}`
          : "HPD registration lookup failed.",
    };
  }

  // Step 2: registrationid -> contacts (feu5-w2e2). Best-effort.
  let contacts: HpdContact[] = [];
  let contactsNote: string | null = null;
  if (registrationId) {
    try {
      const where = `registrationid='${registrationId}'`;
      const query = `$where=${encodeURIComponent(where)}&$limit=50`;
      const { rows } = await sodaQuery(HPD_DATASETS.contacts, query, opts.signal);
      contacts = rows.map((r) => ({
        role: str(r.type) ?? str(r.contactdescription),
        name:
          [str(r.firstname), str(r.lastname)].filter(Boolean).join(" ") ||
          str(r.corporationname) ||
          null,
        business_address: composeAddress(r),
      }));
      if (contacts.length === 0) contactsNote = "Registration found but no contacts listed.";
    } catch {
      contactsNote = "Registration found but contacts lookup failed.";
    }
  }

  // §4 mapping: on_file true ONLY when a record exists AND is current.
  const onFile = registrationId != null && current;
  const registration_state: HpdRegistrationResult["registration_state"] = !registrationId
    ? "missing"
    : current
      ? "current"
      : "expired";

  return {
    ok: true,
    registration_id: registrationId,
    registration_on_file: onFile,
    registration_current: current,
    registered_owner_name: pickOwnerName(contacts),
    contacts,
    endpoint,
    registration_state,
    note: contactsNote,
  };
}
