/**
 * Open-data orchestrator: address → BBL → HPD + WoW → Case-field mapping.
 *
 * This is the "an out-of-box LLM can't do this" layer: it joins live NYC open
 * data (GeoSearch + HPD Socrata + JustFix WoW) into the canonical Case Object as
 * gated, non-authoritative evidence and landlord signals.
 *
 * SAFETY (TOOL-CONTRACTS §0.2 / §2-§5):
 *  - Every open-data-derived value is written wrapped in an OpenDataAssertion
 *    whose verify_before_file gate starts "unverified". Nothing is auto-filed.
 *  - parties.landlord.registration_on_file follows the §4 mapping (missing OR
 *    expired → false).
 *  - This module NEVER throws to its caller: any network/HTTP/parse failure
 *    degrades to a partial result + a human-readable note (failures[]).
 *  - It does NOT set any legal conclusion, attorney_disposition, or
 *    review.advice_routed.
 *
 * Pure data layer: it builds the evidence[] items and the parties.landlord patch
 * but does NOT persist — the route (app/api/building) applies the patch.
 */

import type {
  Case,
  EvidenceItem,
  LandlordParty,
  OpenDataAssertion,
  PostalAddress,
  Property,
} from "@/lib/case";
import { buildOpenDataAssertion, buildEvidenceItem } from "@/lib/evidence";

import { resolveAddressToBbl, type GeoConfidence } from "./geosearch";
import {
  lookupHpdViolations,
  lookupHpdComplaints,
  lookupHpdRegistration,
  type HpdViolationsResult,
  type HpdComplaintsResult,
  type HpdRegistrationResult,
} from "./hpd";
import { lookupWhoOwnsWhat, type WowResult } from "./wow";

const VERIFY_REMINDER =
  "These building records come from public NYC datasets and can be out of date " +
  "or wrong. Verify each one yourself before you rely on it in court — you are " +
  "the person filing.";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function disclaimerWithGeo(base: string, geo: GeoConfidence): string {
  if (geo === "exact") return base;
  return (
    base +
    " NOTE: the address match was approximate, so these records may be for a " +
    "nearby parcel — double-check the building before relying on them."
  );
}

// ---------------------------------------------------------------------------
// Result shape returned to the route (and surfaced to the UI)
// ---------------------------------------------------------------------------

export interface BuildingIntelFindings {
  bbl: string | null;
  geo_confidence: GeoConfidence;
  violations: HpdViolationsResult;
  complaints: HpdComplaintsResult;
  registration: HpdRegistrationResult;
  wow: WowResult;
  /** Non-fatal notes from any degraded lookup. */
  failures: string[];
  /** Always shown: the verify-before-file reminder. */
  verify_reminder: string;
}

export interface OrchestratorOutput {
  findings: BuildingIntelFindings;
  /** New evidence[] items to append (each carries an unverified open_data gate). */
  evidence: EvidenceItem[];
  /** parties.landlord patch (registered owner, wow id, registration signal, open_data). */
  landlordPatch: LandlordParty | null;
  /** property patch (bbl, geo_confidence) — deterministic, no gate. */
  propertyPatch: Partial<Property> | null;
}

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------

/**
 * Run the full address → BBL → open-data join. Never throws.
 *
 * @param address  the tenant-confirmed premises address
 * @param opts.signal optional AbortSignal (route sets a timeout)
 */
export async function lookupBuildingIntel(
  address: PostalAddress,
  opts: { signal?: AbortSignal } = {},
): Promise<OrchestratorOutput> {
  const failures: string[] = [];
  const retrievedAt = nowIso();

  // 1) Resolve BBL.
  const geo = await resolveAddressToBbl(address, opts);
  if (!geo.bbl) {
    if (geo.note) failures.push(geo.note);
    return {
      findings: {
        bbl: null,
        geo_confidence: geo.geo_confidence,
        violations: emptyViolations(geo.note),
        complaints: emptyComplaints(geo.note),
        registration: emptyRegistration(geo.note),
        wow: emptyWow(geo.note),
        failures,
        verify_reminder: VERIFY_REMINDER,
      },
      evidence: [],
      landlordPatch: null,
      propertyPatch: {
        bbl: null,
        geo_confidence: geo.geo_confidence,
      },
    };
  }

  const bbl = geo.bbl;

  // 2) Fetch all sources in parallel (each is independently fail-safe).
  const [violations, complaints, registration, wow] = await Promise.all([
    lookupHpdViolations(bbl, { signal: opts.signal, openOnly: false }),
    lookupHpdComplaints(bbl, { signal: opts.signal }),
    lookupHpdRegistration(bbl, { signal: opts.signal }),
    lookupWhoOwnsWhat(bbl, { signal: opts.signal }),
  ]);

  for (const r of [violations, complaints, registration, wow]) {
    if (!r.ok && r.note) failures.push(r.note);
    else if (r.note) failures.push(r.note);
  }

  // 3) Build evidence[] items (one per dataset that returned usable data).
  const evidence: EvidenceItem[] = [];

  // Violations → one evidence item per OPEN violation (the repair-defense signal).
  if (violations.ok) {
    const openViolations = violations.violations.filter((v) => v.status === "open");
    for (const v of openViolations) {
      const assertion = buildOpenDataAssertion({
        dataset: "hpd_violations_wvxf-dwi5",
        datasetVersion: retrievedAt,
        retrievedAt,
        endpoint: violations.endpoint,
        disclaimer: disclaimerWithGeo(
          "HPD open data lags real-world status and can include closed-but-not-" +
            "updated records. Verify this violation before relying on it in court.",
          geo.geo_confidence,
        ),
      });
      evidence.push(
        buildEvidenceItem({
          evidence_type: "hpd_violation",
          origin: "open_data",
          summary: violationSummary(v),
          supports_defense_codes: ["warranty_of_habitability", "repairs_needed"],
          open_data: assertion,
        }),
      );
    }
  }

  // Complaints → one evidence item per complaint (notice signal).
  if (complaints.ok) {
    for (const c of complaints.complaints) {
      const assertion = buildOpenDataAssertion({
        dataset: "hpd_complaints_ygpa-z7cr",
        datasetVersion: retrievedAt,
        retrievedAt,
        endpoint: complaints.endpoint,
        disclaimer: disclaimerWithGeo(
          "HPD complaint data is tenant-reported and may be incomplete or out of " +
            "date. Verify this complaint before relying on it in court.",
          geo.geo_confidence,
        ),
      });
      evidence.push(
        buildEvidenceItem({
          evidence_type: "hpd_complaint",
          origin: "open_data",
          summary: complaintSummary(c),
          supports_defense_codes: ["warranty_of_habitability", "repairs_needed"],
          open_data: assertion,
        }),
      );
    }
  }

  // 4) Registration → parties.landlord + a registration_record evidence item.
  let landlordPatch: LandlordParty | null = null;
  let registrationAssertion: OpenDataAssertion | null = null;

  if (registration.ok) {
    registrationAssertion = buildOpenDataAssertion({
      dataset: "hpd_registration_tesw-yqqr",
      datasetVersion: retrievedAt,
      retrievedAt,
      endpoint: registration.endpoint,
      disclaimer: disclaimerWithGeo(
        registrationStateDisclaimer(registration.registration_state),
        geo.geo_confidence,
      ),
    });
    evidence.push(
      buildEvidenceItem({
        evidence_type: "registration_record",
        origin: "open_data",
        summary: registrationSummary(registration),
        supports_defense_codes: registration.registration_on_file
          ? []
          : ["not_registered_multiple_dwelling"],
        open_data: registrationAssertion,
      }),
    );
  }

  // 5) WoW → ownership_record evidence + corroborate landlord owner/portfolio id.
  let wowOwnerName: string | null = null;
  if (wow.ok) {
    const wowAssertion = buildOpenDataAssertion({
      dataset: "justfix_wow",
      datasetVersion: wow.dataset_last_updated ?? retrievedAt,
      retrievedAt,
      endpoint: wow.endpoint,
      disclaimer: disclaimerWithGeo(
        "Ownership/portfolio data comes from a third-party aggregator (JustFix). " +
          "Treat shell-company and standing inferences as leads to verify, not " +
          "legal conclusions.",
        geo.geo_confidence,
      ),
    });
    evidence.push(
      buildEvidenceItem({
        evidence_type: "ownership_record",
        origin: "open_data",
        summary: wowSummary(wow),
        open_data: wowAssertion,
      }),
    );
    wowOwnerName = wow.registered_owner_name;
  }

  // Compose the landlord patch. We attach the registration OpenDataAssertion to
  // parties.landlord.open_data (the §4/§9 home that assemble_packet scans).
  if (registration.ok || wow.ok) {
    landlordPatch = {
      registered_owner_name:
        registration.registered_owner_name ?? wowOwnerName ?? null,
      wow_landlord_id: wow.ok ? wow.wow_landlord_id : null,
      registration_on_file: registration.ok ? registration.registration_on_file : null,
      open_data: registrationAssertion,
    };
  }

  return {
    findings: {
      bbl,
      geo_confidence: geo.geo_confidence,
      violations,
      complaints,
      registration,
      wow,
      failures,
      verify_reminder: VERIFY_REMINDER,
    },
    evidence,
    landlordPatch,
    propertyPatch: {
      bbl,
      bbl_resolved_via: geo.bbl_resolved_via ?? undefined,
      geo_confidence: geo.geo_confidence,
    },
  };
}

// ---------------------------------------------------------------------------
// Summaries (plain-English, descriptive — not legal conclusions)
// ---------------------------------------------------------------------------

function violationSummary(v: {
  hazard_class: string | null;
  description: string | null;
  reported_date: string | null;
  apartment: string | null;
}): string {
  const cls = v.hazard_class ? `Class ${v.hazard_class}` : "Open";
  const where = v.apartment ? ` (Apt ${v.apartment})` : "";
  const when = v.reported_date ? ` — reported ${v.reported_date}` : "";
  const what = v.description ? `: ${v.description}` : "";
  return `${cls} HPD violation${where}${when}${what}`.trim();
}

function complaintSummary(c: {
  condition: string | null;
  status: string | null;
  received_date: string | null;
}): string {
  const cond = c.condition ?? "Condition";
  const when = c.received_date ? ` — received ${c.received_date}` : "";
  const status = c.status ? ` (${c.status})` : "";
  return `HPD complaint: ${cond}${when}${status}`;
}

function registrationSummary(r: HpdRegistrationResult): string {
  if (r.registration_state === "missing") {
    return "No HPD registration on file for this building.";
  }
  if (r.registration_state === "expired") {
    return "HPD registration appears expired/lapsed.";
  }
  const owner = r.registered_owner_name ? ` Owner of record: ${r.registered_owner_name}.` : "";
  return `HPD registration on file.${owner}`;
}

function registrationStateDisclaimer(
  state: HpdRegistrationResult["registration_state"],
): string {
  const base =
    "HPD registration data may be outdated. This is information to verify with " +
    "HPD, not a legal conclusion. Confirm before raising it in court.";
  if (state === "missing") return "No registration found. " + base;
  if (state === "expired") return "Registration found but appears expired/lapsed. " + base;
  return base;
}

function wowSummary(w: WowResult): string {
  const owner = w.registered_owner_name ? `Owner/portfolio: ${w.registered_owner_name}.` : "";
  const count =
    w.portfolio?.building_count != null
      ? ` Portfolio of ~${w.portfolio.building_count} building(s).`
      : "";
  return `${owner}${count}`.trim() || "Ownership record found.";
}

// ---------------------------------------------------------------------------
// Empty results for the no-BBL early return
// ---------------------------------------------------------------------------

function emptyViolations(note: string | null): HpdViolationsResult {
  return {
    ok: false,
    violations: [],
    counts: { open: 0, class_c_open: 0, total: 0 },
    endpoint: null,
    note: note ?? "Skipped (no BBL).",
  };
}
function emptyComplaints(note: string | null): HpdComplaintsResult {
  return {
    ok: false,
    complaints: [],
    notice_timeline: [],
    counts: { total: 0, open: 0 },
    endpoint: null,
    note: note ?? "Skipped (no BBL).",
  };
}
function emptyRegistration(note: string | null): HpdRegistrationResult {
  return {
    ok: false,
    registration_id: null,
    registration_on_file: false,
    registration_current: false,
    registered_owner_name: null,
    contacts: [],
    endpoint: null,
    registration_state: "missing",
    note: note ?? "Skipped (no BBL).",
  };
}
function emptyWow(note: string | null): WowResult {
  return {
    ok: false,
    wow_landlord_id: null,
    registered_owner_name: null,
    portfolio: null,
    indicator_history: null,
    dataset_last_updated: null,
    source_used: "none",
    endpoint: null,
    note: note ?? "Skipped (no BBL).",
  };
}

/**
 * Apply an orchestrator output onto a Case (immutable). The route uses this to
 * produce the patch it hands to the store. Appends evidence and merges the
 * landlord/property patches; touches nothing else.
 */
export function applyBuildingIntelToCase(c: Case, out: OrchestratorOutput): Case {
  const next: Case = { ...c };

  if (out.evidence.length) {
    next.evidence = [...c.evidence, ...out.evidence];
  }

  if (out.landlordPatch) {
    next.parties = {
      ...c.parties,
      landlord: {
        ...c.parties?.landlord,
        ...out.landlordPatch,
      },
    };
  }

  if (out.propertyPatch) {
    next.property = {
      ...c.property,
      ...out.propertyPatch,
    };
  }

  return next;
}
