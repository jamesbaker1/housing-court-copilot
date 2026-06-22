/**
 * TriageList — renders the provider triage queue.
 *
 * This is the provider-facing capacity-multiplier surface: a legal-aid worker
 * scans pre-screened intakes, soonest court date / highest urgency first, and
 * opens one to triage (accept / refer / decline).
 *
 * It is a presentational component (no client-only hooks), so the same module
 * can export the pure projection helpers (`toTriageRow`, `hasGrantedHandoffConsent`)
 * that the server route + page use to build the rows. The triage_score is the
 * LLM (Sonnet) routing AID — information, NOT a legal conclusion; it never
 * auto-accepts/declines (API-CONTRACTS §4.1).
 *
 * What is shown is INTAKE, not advice: every row is a starting point for a human
 * to review, not a determination about the tenant's case.
 */

import Link from "next/link";

import type { Case } from "@/lib/case";

// ---------------------------------------------------------------------------
// Triage row projection (pure, server-safe — imported by the API route + page)
// ---------------------------------------------------------------------------

export interface TriageCompleteness {
  /** Count of confirmed intake fields present (court date, parties, arrears…). */
  confirmed_fields: number;
  /** Max meaningful fields we look for (for a simple N/M progress display). */
  total_fields: number;
  /** True when a handoff packet has been generated and is ready (not blocked). */
  packet_ready: boolean;
  /** True when any open-data assertion still blocks filing (verify gate). */
  open_data_blocked: boolean;
}

export interface TriageRow {
  case_id: string;
  case_type: Case["case_type"];
  status: Case["status"];
  updated_at: string;
  /** Authoritative court date (YYYY-MM-DD) when present. */
  court_date: string | null;
  /** True only when court_date_verified (etrack/nyscef) — never tenant/model. */
  court_date_verified: boolean;
  /** Days until court date relative to `asOf`; null when no court date. */
  days_until_court: number | null;
  urgency: "overdue" | "imminent" | "soon" | "scheduled" | "unknown";
  advice_routed: boolean;
  review_state: string | null;
  /** LLM routing aid (0..1-ish). Information, not a legal conclusion. */
  triage_score: number | null;
  default_risk: boolean;
  completeness: TriageCompleteness;
}

const PACKET_READY_STATUSES = new Set(["prepared", "referred", "represented"]);

/**
 * Whether a Case carries a granted, live `handoff_to_provider` consent for a
 * legal-aid provider. This is the (consent-only, v1) gate for the provider
 * queue. NOTE: this does NOT scope to a specific `prv` — real authz must add
 * that (see route SECURITY TODO).
 */
export function hasGrantedHandoffConsent(c: Case, asOf: string = new Date().toISOString()): boolean {
  const now = Date.parse(asOf);
  return (c.consents ?? []).some((cn) => {
    if (cn.scope !== "handoff_to_provider") return false;
    if (cn.recipient.recipient_type !== "legal_aid_provider") return false;
    if (!cn.granted) return false;
    if (cn.revoked_at && Date.parse(cn.revoked_at) <= now) return false;
    if (cn.expires_at && Date.parse(cn.expires_at) <= now) return false;
    return true;
  });
}

function daysBetween(fromIso: string, dateYmd: string): number {
  const start = Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${dateYmd}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

function urgencyFor(days: number | null): TriageRow["urgency"] {
  if (days == null) return "unknown";
  if (days < 0) return "overdue";
  if (days <= 3) return "imminent";
  if (days <= 10) return "soon";
  return "scheduled";
}

function countConfirmedFields(c: Case): number {
  let n = 0;
  if (c.court?.court_date) n += 1;
  if (c.court?.index_number) n += 1;
  if (c.parties?.landlord?.name) n += 1;
  if (c.parties?.tenant?.name) n += 1;
  if (c.property?.address) n += 1;
  if (c.claimed_arrears) n += 1;
  if (c.case_type_confirmed) n += 1;
  return n;
}

/** Build the lightweight triage projection from a full Case. */
export function toTriageRow(c: Case, asOf: string = new Date().toISOString()): TriageRow {
  const courtDate = c.court?.court_date ?? null;
  const days = courtDate ? daysBetween(asOf, courtDate) : null;

  const openDataBlocked =
    c.evidence.some(
      (e) => e.origin === "open_data" && e.open_data?.verify_before_file.state !== "verified",
    ) ||
    (c.parties?.landlord?.open_data != null &&
      c.parties.landlord.open_data.verify_before_file.state !== "verified");

  return {
    case_id: c.case_id,
    case_type: c.case_type,
    status: c.status,
    updated_at: c.updated_at,
    court_date: courtDate,
    court_date_verified: c.court?.court_date_verified ?? false,
    days_until_court: days,
    urgency: urgencyFor(days),
    advice_routed: c.review?.advice_routed ?? false,
    review_state: c.review?.review_state ?? null,
    triage_score: c.review?.triage_score?.score ?? null,
    default_risk: c.deadlines.some((d) => d.risk.default_risk || d.risk.is_missed),
    completeness: {
      confirmed_fields: countConfirmedFields(c),
      total_fields: 7,
      packet_ready: PACKET_READY_STATUSES.has(c.status),
      open_data_blocked: openDataBlocked,
    },
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const URGENCY_STYLE: Record<TriageRow["urgency"], { label: string; cls: string }> = {
  overdue: { label: "Court date passed", cls: "bg-red-100 text-red-800 border-red-200" },
  imminent: { label: "≤ 3 days", cls: "bg-red-50 text-red-700 border-red-200" },
  soon: { label: "≤ 10 days", cls: "bg-amber-50 text-amber-800 border-amber-200" },
  scheduled: { label: "Scheduled", cls: "bg-gray-50 text-gray-700 border-gray-200" },
  unknown: { label: "No court date", cls: "bg-gray-50 text-gray-500 border-gray-200" },
};

function Badge({ children, cls }: { children: React.ReactNode; cls: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}

export interface TriageListProps {
  rows: TriageRow[];
}

export default function TriageList({ rows }: TriageListProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600">
        No consented intakes in the queue. Cases appear here only after a tenant
        grants a handoff-to-provider consent.
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const urg = URGENCY_STYLE[row.urgency];
        return (
          <li key={row.case_id}>
            <Link
              href={`/provider/${row.case_id}`}
              className="block rounded-lg border border-gray-200 bg-white p-4 no-underline hover:border-trust-300 hover:bg-trust-50 focus:outline-none focus:ring-2 focus:ring-trust-400"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge cls="border-trust-200 bg-trust-50 text-trust-800">
                    {row.case_type.replace(/_/g, " ")}
                  </Badge>
                  <Badge cls={urg.cls}>{urg.label}</Badge>
                  {row.default_risk && (
                    <Badge cls="bg-red-100 text-red-800 border-red-200">default risk</Badge>
                  )}
                  {row.advice_routed && (
                    <Badge cls="bg-purple-50 text-purple-800 border-purple-200">advice-routed</Badge>
                  )}
                </div>
                {row.triage_score != null && (
                  <span className="text-xs text-gray-500" title="LLM routing aid — information, not a legal conclusion">
                    triage score {row.triage_score.toFixed(2)}
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-gray-700">
                <span>
                  <span className="text-gray-500">Court date:</span>{" "}
                  {row.court_date ?? "—"}
                  {row.court_date && !row.court_date_verified && (
                    <span className="ml-1 text-xs text-amber-700">(unverified)</span>
                  )}
                  {row.days_until_court != null && (
                    <span className="ml-1 text-xs text-gray-500">
                      ({row.days_until_court >= 0
                        ? `in ${row.days_until_court}d`
                        : `${Math.abs(row.days_until_court)}d ago`})
                    </span>
                  )}
                </span>
                <span>
                  <span className="text-gray-500">Status:</span> {row.status}
                </span>
                {row.review_state && (
                  <span>
                    <span className="text-gray-500">Review:</span> {row.review_state}
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                <span>
                  Intake fields: {row.completeness.confirmed_fields}/{row.completeness.total_fields}
                </span>
                <span>Packet: {row.completeness.packet_ready ? "ready" : "not ready"}</span>
                {row.completeness.open_data_blocked && (
                  <span className="text-amber-700">open-data not verified</span>
                )}
                <span className="font-mono text-[11px] text-gray-400">{row.case_id}</span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
