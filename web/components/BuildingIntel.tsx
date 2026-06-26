/**
 * BuildingIntel — renders Landlord & Building Intelligence findings.
 *
 * This surfaces the open-data join (HPD violations/complaints + JustFix Who Owns
 * What + HPD registration) as:
 *   - a violations timeline,
 *   - a landlord / portfolio panel,
 *   - a registration signal,
 * each wrapped in a "verify before you rely on this in court" Disclaimer (the
 * open-data trust feature — none of this is authoritative or auto-filed).
 *
 * Tenant can tap "I checked this" on any open-data evidence item to flip its
 * verify_before_file gate to "verified". That PATCHes the whole evidence[] array
 * back onto the Case via /api/cases/[id] (the verify gate lives on each
 * EvidenceItem.open_data). This is the human-in-the-loop step the 22 NYCRR 130
 * filer-risk rule requires before any open-data item can enter a packet.
 *
 * Presentational client component. It is given the findings (from
 * POST /api/building) and the Case's current evidence[] (to read/flip gates).
 */
"use client";

import { useMemo, useState } from "react";

import Disclaimer from "@/components/Disclaimer";
import { DisclaimerContext } from "@/lib/disclaimers";
import type { EvidenceItem } from "@/lib/case";
import { fetchWithTimeout } from "@/lib/fetch";

// Mirror of lib/opendata findings — kept structural to avoid importing a
// server-only module (lib/opendata pulls node fetch + the store transitively
// is not imported, but the orchestrator is server-side). Structural typing here
// keeps the client bundle clean.
export interface BuildingIntelFindings {
  bbl: string | null;
  geo_confidence: "exact" | "approximate" | "failed";
  violations: {
    ok: boolean;
    violations: {
      violation_id: string | null;
      hazard_class: string | null;
      status: string | null;
      description: string | null;
      reported_date: string | null;
      apartment: string | null;
    }[];
    counts: { open: number; class_c_open: number; total: number };
    note: string | null;
  };
  complaints: {
    ok: boolean;
    notice_timeline: { date: string; condition: string | null; status: string | null }[];
    counts: { total: number; open: number };
    note: string | null;
  };
  registration: {
    ok: boolean;
    registration_on_file: boolean;
    registration_state: "missing" | "expired" | "current";
    registered_owner_name: string | null;
    note: string | null;
  };
  wow: {
    ok: boolean;
    wow_landlord_id: string | null;
    registered_owner_name: string | null;
    portfolio: {
      building_count: number | null;
      owner_names: string[];
      business_addresses: string[];
      related_bbls: string[];
    } | null;
    indicator_history: {
      hpd_violations_total: number | null;
      evictions_executed: number | null;
    } | null;
    note: string | null;
  };
  failures: string[];
  verify_reminder: string;
}

export interface BuildingIntelProps {
  caseId: string | null;
  /** Per-case capability token (Bearer) required by the owner-gated cases route. */
  caseToken?: string | null;
  findings: BuildingIntelFindings | null;
  /** Current Case evidence[] — used to read/flip the open-data verify gates. */
  evidence?: EvidenceItem[];
  /** Called after a successful verify PATCH with the updated evidence[]. */
  onEvidenceUpdate?: (evidence: EvidenceItem[]) => void;
  className?: string;
}

function StatusPill({ children, tone }: { children: React.ReactNode; tone: "danger" | "warn" | "ok" | "muted" }) {
  const cls =
    tone === "danger"
      ? "bg-red-100 text-red-700"
      : tone === "warn"
        ? "bg-amber-100 text-amber-800"
        : tone === "ok"
          ? "bg-green-100 text-green-700"
          : "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {children}
    </span>
  );
}

/** A verify control bound to a single open-data evidence item by id. */
function VerifyControl({
  caseId,
  caseToken,
  item,
  allEvidence,
  onEvidenceUpdate,
}: {
  caseId: string | null;
  caseToken?: string | null;
  item: EvidenceItem | undefined;
  allEvidence: EvidenceItem[];
  onEvidenceUpdate?: (evidence: EvidenceItem[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!item || item.origin !== "open_data" || !item.open_data) return null;
  const state = item.open_data.verify_before_file.state;
  const verified = state === "verified";

  async function markVerified() {
    if (!caseId || !item) return;
    setBusy(true);
    setError(null);
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const updatedEvidence: EvidenceItem[] = allEvidence.map((e) => {
      if (e.evidence_id !== item.evidence_id || e.origin !== "open_data" || !e.open_data) {
        return e;
      }
      return {
        ...e,
        open_data: {
          ...e.open_data,
          verify_before_file: {
            ...e.open_data.verify_before_file,
            state: "verified",
            verified_at: nowIso,
            verified_by: { actor_type: "tenant" },
          },
        },
      };
    });
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (caseToken) headers["Authorization"] = `Bearer ${caseToken}`;
      // Route through fetchWithTimeout (the M6 wrapper) so a slow/dropped
      // connection on the tenant's borrowed phone can't hang this PATCH forever.
      // On timeout it throws FetchTimeoutError; the catch below surfaces the
      // message inline and the finally re-enables the button (no dead-end).
      const res = await fetchWithTimeout(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ evidence: updatedEvidence }),
      });
      if (!res.ok) throw new Error(`Save failed (HTTP ${res.status})`);
      onEvidenceUpdate?.(updatedEvidence);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your verification.");
    } finally {
      setBusy(false);
    }
  }

  if (verified) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700">
        <span aria-hidden="true">✓</span> You marked this checked
      </span>
    );
  }

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={markVerified}
        disabled={busy || !caseId}
        className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
      >
        {busy ? "Saving…" : "I checked this against my records"}
      </button>
      {error && <p className="mt-1 text-red-600">{error}</p>}
    </div>
  );
}

export default function BuildingIntel({
  caseId,
  caseToken,
  findings,
  evidence = [],
  onEvidenceUpdate,
  className,
}: BuildingIntelProps) {
  // Index open-data evidence items by dataset so each panel can find its gate.
  const byDataset = useMemo(() => {
    const map: Record<string, EvidenceItem[]> = {};
    for (const e of evidence) {
      const ds = e.open_data?.dataset;
      if (!ds) continue;
      (map[ds] ??= []).push(e);
    }
    return map;
  }, [evidence]);

  if (!findings) {
    return (
      <section className={className} aria-label="Building intelligence">
        <p className="text-sm text-gray-500">
          Look up your building to see public HPD and ownership records.
        </p>
      </section>
    );
  }

  const violationItems = byDataset["hpd_violations_wvxf-dwi5"] ?? [];
  const registrationItems = byDataset["hpd_registration_tesw-yqqr"] ?? [];
  const ownershipItems = byDataset["justfix_wow"] ?? [];

  return (
    <section className={className} aria-label="Building intelligence">
      <header className="mb-3">
        <h2 className="text-lg font-semibold text-gray-900">Your building's record</h2>
        <p className="mt-1 text-sm text-gray-600">
          Public NYC data about your building and landlord. {findings.bbl ? `BBL ${findings.bbl}.` : ""}
          {findings.geo_confidence !== "exact" && findings.bbl && (
            <span className="ml-1 text-amber-700">
              (Address match was {findings.geo_confidence} — confirm this is your building.)
            </span>
          )}
        </p>
      </header>

      <Disclaimer context={DisclaimerContext.Defense} variant="panel" className="mb-4" />

      {findings.bbl == null && (
        <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          We couldn&apos;t match your address to a NYC building record
          {findings.failures[0] ? `: ${findings.failures[0]}` : "."} You can still
          look up your building&apos;s violations directly on the HPD website.
        </p>
      )}

      {/* Registration signal */}
      {findings.registration.ok && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-gray-900">HPD registration</h3>
            {findings.registration.registration_state === "missing" ? (
              <StatusPill tone="warn">No registration found</StatusPill>
            ) : findings.registration.registration_state === "expired" ? (
              <StatusPill tone="warn">Appears expired</StatusPill>
            ) : (
              <StatusPill tone="ok">On file</StatusPill>
            )}
          </div>
          {findings.registration.registered_owner_name && (
            <p className="mt-1 text-sm text-gray-700">
              Owner of record: <span className="font-medium">{findings.registration.registered_owner_name}</span>
            </p>
          )}
          {!findings.registration.registration_on_file && (
            <p className="mt-2 text-sm text-gray-600">
              A missing or expired registration is something some tenants raise — it is
              information to verify with HPD, not a conclusion that it applies to you.
            </p>
          )}
          <div className="mt-3">
            <VerifyControl
              caseId={caseId}
              caseToken={caseToken}
              item={registrationItems[0]}
              allEvidence={evidence}
              onEvidenceUpdate={onEvidenceUpdate}
            />
          </div>
        </div>
      )}

      {/* Landlord / portfolio */}
      {findings.wow.ok && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-base font-semibold text-gray-900">Landlord &amp; portfolio</h3>
          {findings.wow.registered_owner_name && (
            <p className="mt-1 text-sm text-gray-700">
              Owner / portfolio: <span className="font-medium">{findings.wow.registered_owner_name}</span>
            </p>
          )}
          {findings.wow.portfolio?.building_count != null && (
            <p className="mt-1 text-sm text-gray-600">
              Associated with about {findings.wow.portfolio.building_count} building(s).
            </p>
          )}
          {findings.wow.portfolio?.owner_names && findings.wow.portfolio.owner_names.length > 0 && (
            <p className="mt-1 text-xs text-gray-500">
              Names on record: {findings.wow.portfolio.owner_names.slice(0, 5).join("; ")}
            </p>
          )}
          {findings.wow.indicator_history && (
            <p className="mt-2 text-xs text-gray-500">
              {findings.wow.indicator_history.hpd_violations_total != null &&
                `~${findings.wow.indicator_history.hpd_violations_total} HPD violations on record across the portfolio. `}
              {findings.wow.indicator_history.evictions_executed != null &&
                `~${findings.wow.indicator_history.evictions_executed} evictions executed.`}
            </p>
          )}
          <div className="mt-3">
            <VerifyControl
              caseId={caseId}
              caseToken={caseToken}
              item={ownershipItems[0]}
              allEvidence={evidence}
              onEvidenceUpdate={onEvidenceUpdate}
            />
          </div>
        </div>
      )}

      {/* Violations timeline */}
      {findings.violations.ok && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-gray-900">Open HPD violations</h3>
            <div className="flex gap-1.5">
              {findings.violations.counts.class_c_open > 0 && (
                <StatusPill tone="danger">
                  {findings.violations.counts.class_c_open} Class C
                </StatusPill>
              )}
              <StatusPill tone="muted">
                {findings.violations.counts.open} open / {findings.violations.counts.total} total
              </StatusPill>
            </div>
          </div>

          {findings.violations.counts.open === 0 ? (
            <p className="mt-2 text-sm text-gray-600">
              No open violations on record. (That can also mean records are not up to date.)
            </p>
          ) : (
            <ol className="mt-3 space-y-3">
              {findings.violations.violations
                .filter((v) => v.status === "open")
                .slice(0, 25)
                .map((v, i) => {
                  // Each open violation maps to one evidence item, in order.
                  const item = violationItems[i];
                  return (
                    <li
                      key={v.violation_id ?? i}
                      className="border-l-2 border-amber-300 pl-3"
                    >
                      <div className="flex items-center gap-2">
                        {v.hazard_class && (
                          <StatusPill tone={v.hazard_class === "C" ? "danger" : "warn"}>
                            Class {v.hazard_class}
                          </StatusPill>
                        )}
                        {v.reported_date && (
                          <span className="text-xs text-gray-500">{v.reported_date}</span>
                        )}
                        {v.apartment && (
                          <span className="text-xs text-gray-500">Apt {v.apartment}</span>
                        )}
                      </div>
                      {v.description && (
                        <p className="mt-1 text-sm text-gray-700">{v.description}</p>
                      )}
                      <div className="mt-2">
                        <VerifyControl
                          caseId={caseId}
              caseToken={caseToken}
                          item={item}
                          allEvidence={evidence}
                          onEvidenceUpdate={onEvidenceUpdate}
                        />
                      </div>
                    </li>
                  );
                })}
            </ol>
          )}
        </div>
      )}

      {/* Complaint / notice timeline */}
      {findings.complaints.ok && findings.complaints.notice_timeline.length > 0 && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-base font-semibold text-gray-900">Complaint history</h3>
          <p className="mt-1 text-xs text-gray-500">
            Tenant-reported conditions. Dates here are descriptive, not court-authoritative.
          </p>
          <ul className="mt-3 space-y-1.5">
            {findings.complaints.notice_timeline.slice(0, 15).map((c, i) => (
              <li key={i} className="text-sm text-gray-700">
                <span className="text-gray-500">{c.date}</span> — {c.condition ?? "Condition"}
                {c.status ? ` (${c.status})` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Degraded-source notes */}
      {findings.failures.length > 0 && (
        <p className="mb-2 text-xs text-gray-400">
          Some sources were unavailable: {findings.failures.join(" · ")}
        </p>
      )}

      <p className="mt-2 text-xs text-gray-500">{findings.verify_reminder}</p>
    </section>
  );
}
