/**
 * Legal-aid handoff — build a structured intake packet from the Case Object.
 *
 * Pure TypeScript (no network, no provider integration). Produces:
 *   1. A typed `LegalAidHandoffPacket` object (mirrors CASE-OBJECT.md
 *      `LegalAidHandoffPacket` / `Packet`), with CSR/LIST tag PLACEHOLDERS.
 *   2. A plain-text one-page summary for human review.
 *
 * Boundaries honored:
 *   - `csr_tags` / `list_tags` are DET-assigned (here, placeholders — the
 *     canonical CSR/LIST code set is a Phase-0/1 content blocker, see
 *     API-CONTRACTS §3.14 / LLM-SCHEMAS §9). The LLM only *proposes* candidate
 *     tags upstream (Surface 8); this layer holds the authoritative slots.
 *   - `intake_summary_text` is LLM-generated upstream (information; attorney
 *     reviews). This builder ACCEPTS that text; it does not generate it. The
 *     plain-text rendering here is a deterministic factual fallback/summary.
 *   - Open-data verify gate: `blocked_by_unverified_open_data` is computed DET
 *     over BOTH included evidence open-data items AND `parties.landlord.open_data`
 *     (registration/standing). True if ANY is not `verified`. A blocked packet
 *     must not be delivered (API-CONTRACTS §3.14).
 *   - Consent: delivery REQUIRES a matching per-recipient `handoff_to_provider`
 *     consent. This module provides a consent-check STUB (the real gate lives in
 *     the API gateway). No data is ever furnished to a landlord (schema-barred).
 *
 * NOTE: no real LegalServer / PDF integration here — see the TODOs.
 */

import {
  type Case,
  type Consent,
  type EvidenceItem,
} from "@/lib/case";
import { newId } from "@/lib/ids";
import { isUnverifiedOpenData } from "@/lib/evidence";

// ---------------------------------------------------------------------------
// Packet types (mirror CASE-OBJECT.md LegalAidHandoffPacket / ProviderHandoff)
// ---------------------------------------------------------------------------

export type DocumentAssemblyStatus =
  | "not_started"
  | "assembling"
  | "ready"
  | "blocked"
  | "delivered"
  | "error";

export interface ProviderHandoff {
  provider_id: string | null;
  /** The specific consent authorizing THIS recipient. */
  consent_id: string;
  method: "legalserver_trigger_xml" | "pdf_packet_fallback";
  delivered_at: string | null;
  delivery_state: "pending" | "sent" | "acknowledged" | "failed";
  external_reference: string | null;
}

export interface LegalAidHandoffPacket {
  packet_id: string;
  kind: "legal_aid_handoff";
  status: DocumentAssemblyStatus;
  storage_ref: {
    uri: string;
    format: "pdf_a" | "pdf";
    content_hash_sha256: string | null;
  } | null;
  included_evidence_ids: string[];
  /** DET over evidence open-data AND parties.landlord.open_data. Must be false to deliver. */
  blocked_by_unverified_open_data: boolean;
  generated_by_model: "claude-opus-4-8" | "claude-sonnet-4-6" | null;
  generated_at: string | null;
  /** LSC CSR problem/closure codes. PLACEHOLDER — see Phase-0/1 content blocker. */
  csr_tags: string[];
  /** Legal Issue/Service Taxonomy codes. PLACEHOLDER. */
  list_tags: string[];
  /** LLM-generated one-page summary (information; attorney reviews). */
  intake_summary_text: string | null;
  delivery: ProviderHandoff | null;
}

// ---------------------------------------------------------------------------
// Consent check (STUB — authoritative gate is the API gateway, API-CONTRACTS §5)
// ---------------------------------------------------------------------------

export interface ConsentCheckResult {
  ok: boolean;
  /** The matching consent, when ok. */
  consent: Consent | null;
  /** Machine reason when not ok. */
  reason:
    | null
    | "no_matching_consent"
    | "not_granted"
    | "expired"
    | "revoked"
    | "wrong_recipient";
  /** Human-readable explanation for logs / UI. */
  message: string;
}

/**
 * STUB consent check for a handoff to a specific provider. Confirms there is a
 * `handoff_to_provider` consent, granted, not expired/revoked, for this
 * provider. This is a convenience pre-check ONLY — the real, authoritative
 * enforcement lives in the API gateway (API-CONTRACTS §5) and must be re-checked
 * at delivery time (consent can be revoked between generation and delivery).
 *
 * TODO: replace with the gateway-enforced consent middleware; also reconcile
 * `data_categories` against packet contents (eligibility must be covered; else
 * redact-and-proceed or 409 consent_category_missing — API-CONTRACTS §3.14).
 */
export function checkHandoffConsent(
  c: Case,
  opts: { providerId: string; now?: string },
): ConsentCheckResult {
  const now = opts.now ? Date.parse(opts.now) : Date.now();
  const candidates = (c.consents ?? []).filter(
    (cn) =>
      cn.scope === "handoff_to_provider" &&
      cn.recipient.recipient_type === "legal_aid_provider",
  );

  if (candidates.length === 0) {
    return {
      ok: false,
      consent: null,
      reason: "no_matching_consent",
      message: "No handoff_to_provider consent for a legal-aid provider exists.",
    };
  }

  const forProvider = candidates.filter(
    (cn) => cn.recipient.recipient_id === opts.providerId,
  );
  if (forProvider.length === 0) {
    return {
      ok: false,
      consent: null,
      reason: "wrong_recipient",
      message:
        "Consent exists but not for this provider — consent is per-recipient.",
    };
  }

  for (const cn of forProvider) {
    if (!cn.granted) continue;
    if (cn.revoked_at && Date.parse(cn.revoked_at) <= now) continue;
    if (cn.expires_at && Date.parse(cn.expires_at) <= now) continue;
    return {
      ok: true,
      consent: cn,
      reason: null,
      message: "Valid handoff consent found for this provider.",
    };
  }

  // Find the most specific failure reason among provider-matched consents.
  const anyGranted = forProvider.some((cn) => cn.granted);
  if (!anyGranted) {
    return {
      ok: false,
      consent: null,
      reason: "not_granted",
      message: "Handoff consent for this provider has not been granted.",
    };
  }
  const anyRevoked = forProvider.some(
    (cn) => cn.revoked_at && Date.parse(cn.revoked_at) <= now,
  );
  return {
    ok: false,
    consent: null,
    reason: anyRevoked ? "revoked" : "expired",
    message: anyRevoked
      ? "Handoff consent for this provider was revoked."
      : "Handoff consent for this provider has expired.",
  };
}

// ---------------------------------------------------------------------------
// Open-data block computation (DET, over the full open-data surface)
// ---------------------------------------------------------------------------

/**
 * Compute `blocked_by_unverified_open_data` over BOTH included evidence
 * open-data items AND `parties.landlord.open_data`. True if any is not
 * `verified`. Returns the offending paths for a clear 409 / UI message.
 */
export function computeOpenDataBlock(
  c: Case,
  includedEvidence: EvidenceItem[],
): { blocked: boolean; unverifiedPaths: string[] } {
  const paths: string[] = [];

  for (const item of includedEvidence) {
    if (isUnverifiedOpenData(item)) {
      paths.push(`/evidence/${item.evidence_id}/open_data/verify_before_file`);
    }
  }

  const landlordOD = c.parties?.landlord?.open_data;
  if (landlordOD && landlordOD.verify_before_file.state !== "verified") {
    paths.push("/parties/landlord/open_data/verify_before_file");
  }

  return { blocked: paths.length > 0, unverifiedPaths: paths };
}

// ---------------------------------------------------------------------------
// Packet builder
// ---------------------------------------------------------------------------

export interface BuildHandoffOptions {
  /**
   * Evidence ids to include in the packet. Defaults to ALL evidence on the case.
   * Open-data items that are not verified will set the block flag (and should be
   * excluded or verified before delivery).
   */
  includeEvidenceIds?: string[];
  /**
   * LLM-generated one-page summary text (Surface 8 upstream). Optional — when
   * absent, a deterministic factual summary is produced by
   * {@link renderPlainTextSummary}.
   */
  intakeSummaryText?: string | null;
  /** Model that generated the summary, for provenance. */
  generatedByModel?: "claude-opus-4-8" | "claude-sonnet-4-6" | null;
  /** CSR tag placeholders (DET; Phase-0/1 content blocker for the real set). */
  csrTags?: string[];
  /** LIST tag placeholders. */
  listTags?: string[];
  now?: string;
}

export interface BuildHandoffResult {
  packet: LegalAidHandoffPacket;
  /** Deterministic plain-text rendering of the packet for human review. */
  plainText: string;
  /** Offending open-data paths when blocked (empty otherwise). */
  unverifiedOpenDataPaths: string[];
}

/**
 * Build a `LegalAidHandoffPacket` object + a plain-text summary from a Case.
 * Generation does NOT require consent (per API-CONTRACTS §3.14 generation only
 * builds the object; delivery is the consent-gated step). Status is `ready`
 * unless open-data is unverified, in which case `blocked`.
 *
 * Tags are PLACEHOLDERS. The canonical CSR/LIST code set + the deterministic
 * rules that assign them are a Phase-0/1 content blocker (LEGAL-RULES.md /
 * API-CONTRACTS §13.10). See TODO below.
 */
export function buildHandoffPacket(
  c: Case,
  opts: BuildHandoffOptions = {},
): BuildHandoffResult {
  const now = opts.now ?? new Date().toISOString();

  const includedEvidence =
    opts.includeEvidenceIds != null
      ? c.evidence.filter((e) => opts.includeEvidenceIds!.includes(e.evidence_id))
      : c.evidence;

  const { blocked, unverifiedPaths } = computeOpenDataBlock(c, includedEvidence);

  const intakeSummaryText =
    opts.intakeSummaryText ?? renderPlainTextSummary(c, includedEvidence);

  // TODO(Phase-0/1): replace placeholder tags with DET-assigned CSR (LSC
  // problem/closure) + LIST codes from the canonical published code set, keyed
  // to the structured case (LEGAL-RULES.md). The LLM proposes candidates
  // (Surface 8); the attorney confirms; this layer holds the authoritative set.
  const csrTags = opts.csrTags ?? [];
  const listTags = opts.listTags ?? [];

  const packet: LegalAidHandoffPacket = {
    packet_id: newId("pkt"),
    kind: "legal_aid_handoff",
    status: blocked ? "blocked" : "ready",
    // TODO(integration): no PDF assembled in v1. docassemble + Suffolk
    // AssemblyLine on official NY fillable PDFs -> PDF/A would set storage_ref.
    storage_ref: null,
    included_evidence_ids: includedEvidence.map((e) => e.evidence_id),
    blocked_by_unverified_open_data: blocked,
    generated_by_model: opts.generatedByModel ?? null,
    generated_at: now,
    csr_tags: csrTags,
    list_tags: listTags,
    intake_summary_text: intakeSummaryText,
    // Delivery is armed by the separate consent-gated delivery step (§3.15).
    delivery: null,
  };

  return {
    packet,
    plainText: renderPlainTextSummary(c, includedEvidence),
    unverifiedOpenDataPaths: unverifiedPaths,
  };
}

// ---------------------------------------------------------------------------
// Plain-text summary (deterministic, factual, no legal conclusions)
// ---------------------------------------------------------------------------

function fmtMoneyCents(cents: number | null | undefined): string {
  if (cents == null) return "unknown";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Render a neutral, factual one-page plain-text intake summary for a supervising
 * attorney. Uses only confirmed/structured facts. No legal conclusions, no
 * defense recommendations, no outcome predictions (mirrors the Surface 8
 * boundary). Immigration status is intentionally NEVER included here.
 */
export function renderPlainTextSummary(
  c: Case,
  includedEvidence: EvidenceItem[] = c.evidence,
): string {
  const lines: string[] = [];
  const L = (s = "") => lines.push(s);

  L("NYC NONPAYMENT INTAKE SUMMARY (for attorney review)");
  L("Information only — not legal advice. Facts below are tenant-provided/structured.");
  L("");

  L(`Case ID: ${c.case_id}`);
  L(`Case type: ${c.case_type}${c.case_type_confirmed ? " (confirmed)" : " (unconfirmed)"}`);
  L(`Status: ${c.status}`);
  L(`Language: ${c.language}`);
  L("");

  // Court
  const court = c.court;
  L("COURT");
  if (court) {
    L(`  Borough/County: ${court.borough ?? "unknown"} / ${court.county ?? "unknown"}`);
    L(`  Index number: ${court.index_number ?? "unknown"}`);
    L(
      `  Court date: ${court.court_date ?? "unknown"}` +
        ` (source: ${court.court_date_source ?? "none"}; ` +
        `verified: ${court.court_date_verified ? "yes" : "NO — confirm against official papers"})`,
    );
  } else {
    L("  (none recorded)");
  }
  L("");

  // Parties
  L("PARTIES");
  L(`  Tenant/respondent: ${c.parties?.tenant?.name ?? "unknown"}`);
  L(`  Landlord/petitioner: ${c.parties?.landlord?.name ?? "unknown"}`);
  if (c.parties?.landlord?.attorney_name) {
    L(`  Landlord attorney: ${c.parties.landlord.attorney_name}`);
  }
  const landlordOD = c.parties?.landlord?.open_data;
  if (landlordOD) {
    L(
      `  Landlord open-data (registration/standing): verify_before_file=` +
        `${landlordOD.verify_before_file.state} — ${landlordOD.data_accuracy_disclaimer}`,
    );
  }
  L("");

  // Property + money
  L("PROPERTY & ARREARS");
  const addr = c.property?.address;
  if (addr) {
    const parts = [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code]
      .filter(Boolean)
      .join(", ");
    L(`  Address: ${parts || "unknown"}`);
  }
  if (c.property?.apartment_unit) L(`  Unit: ${c.property.apartment_unit}`);
  L(`  Claimed arrears: ${fmtMoneyCents(c.claimed_arrears?.amount_cents)}`);
  L("");

  // Deadlines (DET, with confirmation state)
  L("DEADLINES (system-computed; tenant must confirm against official papers)");
  if (c.deadlines.length === 0) {
    L("  (none computed)");
  } else {
    for (const d of c.deadlines) {
      L(
        `  - ${d.deadline_type}: due ${d.due_date}` +
          ` [confirmed: ${d.tenant_confirmed ? "yes" : "NO"}]` +
          (d.risk.is_missed ? " [MISSED]" : d.risk.is_imminent ? " [IMMINENT]" : ""),
      );
    }
  }
  L("");

  // Confirmed factual statements (transcription only)
  L("TENANT'S FACTUAL STATEMENTS (faithful transcription; tenant-confirmed only)");
  const confirmed = (c.answer_draft?.factual_statements ?? []).filter(
    (s) => s.tenant_confirmed,
  );
  if (confirmed.length === 0) {
    L("  (none confirmed yet)");
  } else {
    for (const s of confirmed) L(`  - ${s.text}`);
  }
  L("");

  // Evidence inventory
  L("EVIDENCE INVENTORY");
  if (includedEvidence.length === 0) {
    L("  (none)");
  } else {
    for (const e of includedEvidence) {
      const od = e.open_data
        ? ` [open-data: verify_before_file=${e.open_data.verify_before_file.state}]`
        : "";
      const cand =
        e.supports_defense_codes.length > 0
          ? ` (candidate issues for review: ${e.supports_defense_codes.join(", ")})`
          : "";
      L(`  - [${e.evidence_type}/${e.origin}] ${e.summary ?? "(no summary)"}${od}${cand}`);
    }
  }
  L("");

  // Candidate defenses (information, not advice)
  L("POSSIBLE ISSUES TO REVIEW (information for the attorney — NOT assertions)");
  if (c.defenses_checklist.length === 0) {
    L("  (none surfaced)");
  } else {
    for (const d of c.defenses_checklist) {
      L(`  - ${d.defense_code} [signal: ${d.relevance_signal ?? "n/a"}]`);
    }
  }
  L("");

  // Eligibility (DET)
  L("ELIGIBILITY (system-estimated; confirm with the program/provider)");
  const elig = c.eligibility;
  if (!elig) {
    L("  (not evaluated)");
  } else {
    if (elig.rtc) L(`  RTC (Right to Counsel): ${elig.rtc.determination}`);
    if (elig.legal_aid) L(`  Legal aid: ${elig.legal_aid.determination}`);
    if (elig.rental_assistance)
      L(`  Rental assistance: ${elig.rental_assistance.determination}`);
  }
  L("");

  L("CSR/LIST tags: assigned deterministically + confirmed by attorney (placeholders in v1).");
  L("Generated by Housing Court Copilot — a guide, not a lawyer. Attorney review required.");

  return lines.join("\n");
}
