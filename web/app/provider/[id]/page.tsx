/**
 * /provider/[id] — provider intake DETAIL + triage actions.
 *
 * Shows the consented, redacted intake summary (the deterministic factual
 * one-pager from @/lib/handoff), the evidence list with open-data verify state,
 * the possible-issues checklist (information, NOT advice), and Accept / Refer /
 * Decline actions that drive the case state machine via the provider API.
 *
 * This is a client component so the triage actions can POST and reflect the
 * result inline. It fetches the consent-gated Case from GET /api/provider/cases/[id]
 * (403 when no granted handoff consent). It deliberately renders only neutral,
 * factual content — surfaced issues are framed as "to review," never as legal
 * conclusions or assertions that the tenant "has a case."
 *
 * SECURITY TODO (v1 BLOCKER): no provider authn/authz. Add a provider principal,
 * per-provider consent scoping, and data_categories redaction before real data.
 */
"use client";

import { use, useEffect, useState, useCallback } from "react";
import Link from "next/link";

import type { Case, ConsentDataCategory, Outcome, OutcomeDisposition } from "@/lib/case";
import { DISPOSITION_LABEL, type OutcomeSignals } from "@/lib/outcomes";

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; status: number; message: string }
  | {
      phase: "ready";
      case: Case;
      summary: string;
      dataCategories: ConsentDataCategory[];
      redactedCategories: ConsentDataCategory[];
      etag: string | null;
    };

type Action = "accept" | "refer" | "decline";

const ACTION_LABEL: Record<Action, string> = {
  accept: "Accept",
  refer: "Refer onward",
  decline: "Decline",
};

export default function ProviderCaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionResult, setActionResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await fetch(`/api/provider/cases/${id}`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({
          phase: "error",
          status: res.status,
          message: data?.message ?? "Could not load this intake.",
        });
        return;
      }
      setState({
        phase: "ready",
        case: data.case as Case,
        summary: typeof data.summary === "string" ? data.summary : "",
        dataCategories: Array.isArray(data.data_categories) ? data.data_categories : [],
        redactedCategories: Array.isArray(data.redacted_categories) ? data.redacted_categories : [],
        etag: res.headers.get("etag"),
      });
    } catch {
      setState({ phase: "error", status: 0, message: "Network error loading the intake." });
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = useCallback(
    async (action: Action, opts: { asAttorney?: boolean } = {}) => {
      setBusy(true);
      setActionResult(null);
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        // Optimistic concurrency: send If-Match so a stale triage write is
        // rejected (412) rather than clobbering a concurrent update.
        const etag = state.phase === "ready" ? state.etag : null;
        if (etag) headers["if-match"] = etag;

        const res = await fetch(`/api/provider/cases/${id}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            action,
            note: note.trim() || undefined,
            ...(opts.asAttorney ? { attorney_confirmed: true } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 412) {
          setActionResult(
            "This intake changed since you opened it. Reloading the latest before you act…",
          );
          await load();
          return;
        }
        if (!res.ok) {
          setActionResult(`Action failed: ${data?.message ?? res.statusText}`);
          return;
        }
        const refusedNote =
          data.refused === "represented_requires_attorney"
            ? " (Status held — moving to represented requires an attorney; use “Accept as attorney”.)"
            : "";
        setActionResult(
          `${ACTION_LABEL[action]} recorded. Status: ${data.status}; review: ${data.review_state}.${refusedNote}`,
        );
        setState((prev) => ({
          phase: "ready",
          case: data.case as Case,
          summary: prev.phase === "ready" ? prev.summary : "",
          dataCategories: prev.phase === "ready" ? prev.dataCategories : [],
          redactedCategories: prev.phase === "ready" ? prev.redactedCategories : [],
          etag: res.headers.get("etag"),
        }));
      } catch {
        setActionResult("Network error applying the action.");
      } finally {
        setBusy(false);
      }
    },
    [id, note, state, load],
  );

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <Link href="/provider" className="text-sm text-trust-700 underline underline-offset-2">
          ← Back to triage queue
        </Link>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-trust-300 bg-trust-100 px-2 py-0.5 text-xs font-semibold text-trust-800">
            Provider console
          </span>
          <span className="font-mono text-xs text-gray-400">{id}</span>
        </div>
        <h1 className="text-2xl font-semibold text-gray-900">Intake detail</h1>
      </header>

      <div
        role="note"
        className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
      >
        <p className="font-semibold">Pre-screened intake, not legal advice.</p>
        <p className="mt-1">
          Facts below are tenant-provided/structured. Possible issues are
          information for a human to review — not legal conclusions.
        </p>
      </div>

      {state.phase === "loading" && (
        <p className="text-sm text-gray-600">Loading intake…</p>
      )}

      {state.phase === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-semibold">
            {state.status === 403
              ? "No consent on file"
              : state.status === 404
                ? "Intake not found"
                : "Could not load intake"}
          </p>
          <p className="mt-1">{state.message}</p>
        </div>
      )}

      {state.phase === "ready" && (
        <ReadyDetail
          id={id}
          c={state.case}
          summary={state.summary}
          dataCategories={state.dataCategories}
          redactedCategories={state.redactedCategories}
          note={note}
          setNote={setNote}
          busy={busy}
          actionResult={actionResult}
          runAction={runAction}
        />
      )}
    </div>
  );
}

function ReadyDetail({
  id,
  c,
  summary,
  dataCategories,
  redactedCategories,
  note,
  setNote,
  busy,
  actionResult,
  runAction,
}: {
  id: string;
  c: Case;
  summary: string;
  dataCategories: ConsentDataCategory[];
  redactedCategories: ConsentDataCategory[];
  note: string;
  setNote: (v: string) => void;
  busy: boolean;
  actionResult: string | null;
  runAction: (a: Action, opts?: { asAttorney?: boolean }) => void;
}) {
  const confirmedFields = [
    c.court?.court_date && "court date",
    c.court?.index_number && "index number",
    c.parties?.landlord?.name && "landlord",
    c.parties?.tenant?.name && "tenant",
    c.property?.address && "address",
    c.claimed_arrears && "arrears",
    c.case_type_confirmed && "case type confirmed",
  ].filter(Boolean) as string[];

  const packetReady = ["prepared", "referred", "represented"].includes(c.status);

  // Owner-only blob view: fetch WITH the Access cookie (same-origin) and open via
  // a transient object URL — never a public URL. Gated server-side on a consent
  // that shares the "documents" category.
  const [viewingHash, setViewingHash] = useState<string | null>(null);
  async function viewFile(hash: string) {
    setViewingHash(hash);
    try {
      const res = await fetch(`/api/provider/cases/${id}/blob?hash=${hash}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      /* non-fatal */
    } finally {
      setViewingHash(null);
    }
  }
  // The attorney advance (referred → represented) is the only gated transition.
  const canTakeAsAttorney = c.status === "referred";

  return (
    <div className="space-y-6">
      {/* Consent-scope disclosure — what this consent permits you to see. */}
      <section className="rounded-lg border border-trust-200 bg-white p-3 text-sm">
        <h2 className="text-sm font-semibold text-gray-900">Data shared under this consent</h2>
        <p className="mt-1 text-gray-700">
          Shared:{" "}
          <span className="font-medium">
            {dataCategories.length > 0 ? dataCategories.join(", ") : "none"}
          </span>
        </p>
        {redactedCategories.length > 0 && (
          <p className="mt-1 text-amber-800">
            Withheld (not consented):{" "}
            <span className="font-medium">{redactedCategories.join(", ")}</span>. Ask
            the tenant to extend consent if you need these to assist.
          </p>
        )}
      </section>

      {/* Snapshot */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900">Snapshot</h2>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-gray-500">Case type</dt>
          <dd>{c.case_type.replace(/_/g, " ")}</dd>
          <dt className="text-gray-500">Status</dt>
          <dd>{c.status}</dd>
          <dt className="text-gray-500">Review state</dt>
          <dd>{c.review?.review_state ?? "unassigned"}</dd>
          <dt className="text-gray-500">Advice routed</dt>
          <dd>{c.review?.advice_routed ? "yes — needs a human" : "no"}</dd>
          <dt className="text-gray-500">Court date</dt>
          <dd>
            {c.court?.court_date ?? "—"}
            {c.court?.court_date && !c.court.court_date_verified && (
              <span className="ml-1 text-xs text-amber-700">(unverified)</span>
            )}
          </dd>
          <dt className="text-gray-500">Triage score</dt>
          <dd>
            {c.review?.triage_score?.score != null
              ? `${c.review.triage_score.score.toFixed(2)} (routing aid, not a conclusion)`
              : "—"}
          </dd>
          <dt className="text-gray-500">Intake completeness</dt>
          <dd>{confirmedFields.length}/7 fields{confirmedFields.length > 0 ? ` (${confirmedFields.join(", ")})` : ""}</dd>
          <dt className="text-gray-500">Handoff packet</dt>
          <dd>{packetReady ? "ready" : "not ready"}</dd>
        </dl>
      </section>

      {/* Redacted intake summary (deterministic factual one-pager) */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900">Intake summary</h2>
        <p className="mt-1 text-xs text-gray-500">
          Deterministic factual summary (no legal conclusions; immigration status
          never included).
        </p>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-gray-50 p-3 text-xs text-gray-800">
          {summary}
        </pre>
      </section>

      {/* Evidence with verify state */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900">Evidence</h2>
        {c.evidence.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">No evidence on file.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {c.evidence.map((e) => {
              const verifyState = e.open_data?.verify_before_file.state ?? null;
              const blocked = e.origin === "open_data" && verifyState !== "verified";
              const doc = e.document_id
                ? c.documents.find((d) => d.document_id === e.document_id)
                : undefined;
              const hash = doc?.storage_ref.content_hash_sha256 ?? null;
              return (
                <li key={e.evidence_id} className="rounded border border-gray-100 p-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-700">
                      {e.evidence_type.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs text-gray-500">{e.origin.replace(/_/g, " ")}</span>
                    {verifyState && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs ${
                          blocked
                            ? "bg-amber-100 text-amber-800"
                            : "bg-green-100 text-green-800"
                        }`}
                      >
                        verify: {verifyState}
                      </span>
                    )}
                    {hash && (
                      <button
                        type="button"
                        disabled={viewingHash === hash}
                        onClick={() => void viewFile(hash)}
                        className="text-xs font-medium text-trust-700 underline underline-offset-2 disabled:opacity-50"
                      >
                        {viewingHash === hash ? "Opening…" : "View file"}
                      </button>
                    )}
                  </div>
                  {e.summary && <p className="mt-1 text-gray-700">{e.summary}</p>}
                  {e.supports_defense_codes.length > 0 && (
                    <p className="mt-1 text-xs text-gray-500">
                      candidate issues for review: {e.supports_defense_codes.join(", ")}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Defenses checklist (information, not advice) */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-lg font-semibold text-gray-900">Possible issues to review</h2>
        <p className="mt-1 text-xs text-gray-500">
          Information for the reviewing attorney — NOT assertions or advice.
        </p>
        {c.defenses_checklist.length === 0 ? (
          <p className="mt-1 text-sm text-gray-500">None surfaced.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {c.defenses_checklist.map((d) => (
              <li key={d.defense_code} className="flex items-center justify-between gap-2">
                <span>{d.defense_code.replace(/_/g, " ")}</span>
                <span className="text-xs text-gray-500">
                  signal: {d.relevance_signal ?? "n/a"}
                  {d.attorney_disposition ? ` · disposition: ${d.attorney_disposition}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Triage actions */}
      <section className="rounded-lg border border-trust-200 bg-trust-50 p-4">
        <h2 className="text-lg font-semibold text-gray-900">Triage</h2>
        <label htmlFor="triage-note" className="mt-2 block text-sm text-gray-700">
          Note (optional)
        </label>
        <textarea
          id="triage-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
          placeholder="Reason / handoff note (recorded on the case)"
        />
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => runAction("accept")}
            className="rounded-md bg-trust-600 px-4 py-2 text-sm font-medium text-white hover:bg-trust-700 disabled:opacity-50"
          >
            {ACTION_LABEL.accept}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runAction("refer")}
            className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {ACTION_LABEL.refer}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => runAction("decline")}
            className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
          >
            {ACTION_LABEL.decline}
          </button>
          {canTakeAsAttorney && (
            <button
              type="button"
              disabled={busy}
              onClick={() => runAction("accept", { asAttorney: true })}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              Accept as attorney (represent)
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Accept moves an untransitioned case to <strong>referred</strong> and
          sets review to <strong>in_review</strong>. Advancing a referred case to{" "}
          <strong>represented</strong> is the attorney advice-line step — use{" "}
          <strong>Accept as attorney</strong>. Refer escalates for supervising
          review (a real onward re-route needs a fresh consent). Decline records a
          review without deleting data. Triage scores never auto-decide.
        </p>
        {actionResult && (
          <p className="mt-2 rounded bg-white p-2 text-sm text-gray-800">{actionResult}</p>
        )}
      </section>

      {/* Outcome (impact tracking) */}
      <OutcomeSection id={id} caseStatus={c.status} />
    </div>
  );
}

/**
 * Record the terminal disposition for impact/funder reporting. Fetches the
 * deterministic SUGGESTIONS (the provider confirms — the engine never auto-sets a
 * disposition) and the current outcome, then POSTs a provider-recorded outcome.
 * Disposition is NOT a legal conclusion; it records what happened to the case.
 */
function OutcomeSection({ id, caseStatus }: { id: string; caseStatus: Case["status"] }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [signals, setSignals] = useState<OutcomeSignals | null>(null);
  const [disposition, setDisposition] = useState<OutcomeDisposition | "">("");
  const [note, setNote] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/provider/cases/${id}/outcome`, { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      const o = (data.outcome as Outcome | null) ?? null;
      const s = (data.signals as OutcomeSignals | null) ?? null;
      setOutcome(o);
      setSignals(s);
      setConsent(o?.consented_to_report === true);
      // Default the selector to the existing disposition, else the top suggestion.
      setDisposition(o?.disposition ?? s?.suggested?.[0] ?? "");
    } catch {
      /* non-fatal: outcome recording is optional */
    }
  }, [id]);

  // Re-load whenever the case status changes (a triage action can change the
  // suggested disposition, e.g. once a case becomes represented).
  useEffect(() => {
    void load();
  }, [load, caseStatus]);

  const record = useCallback(async () => {
    if (!disposition) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/provider/cases/${id}/outcome`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          disposition,
          note: note.trim() || undefined,
          consented_to_report: consent,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult(`Could not record outcome: ${data?.message ?? res.statusText}`);
        return;
      }
      const o = (data.outcome as Outcome | null) ?? null;
      setOutcome(o);
      setNote("");
      setResult(
        `Outcome recorded: ${o ? DISPOSITION_LABEL[o.disposition] : disposition}.` +
          (data.anonymized ? " An anonymized impact row was emitted (tenant consented)." : ""),
      );
    } catch {
      setResult("Network error recording the outcome.");
    } finally {
      setBusy(false);
    }
  }, [id, disposition, note, consent]);

  const suggested = signals?.suggested ?? [];

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-gray-900">Outcome (impact tracking)</h2>
      <p className="mt-1 text-xs text-gray-500">
        Records what happened to the case for impact/funder reporting — NOT a legal
        conclusion or advice. Suggestions are derived from case state; you confirm.
      </p>

      {outcome && (
        <p className="mt-2 rounded bg-gray-50 p-2 text-sm text-gray-800">
          Recorded: <strong>{DISPOSITION_LABEL[outcome.disposition]}</strong>
          <span className="text-gray-500"> · {outcome.recorded_at}</span>
          {outcome.consented_to_report ? (
            <span className="ml-1 text-xs text-green-700">(reported, anonymized)</span>
          ) : (
            <span className="ml-1 text-xs text-gray-500">(not reported)</span>
          )}
          {outcome.note ? <span className="block text-xs text-gray-600">note: {outcome.note}</span> : null}
        </p>
      )}

      <label htmlFor="outcome-disposition" className="mt-3 block text-sm text-gray-700">
        Disposition
      </label>
      <select
        id="outcome-disposition"
        value={disposition}
        onChange={(e) => setDisposition(e.target.value as OutcomeDisposition)}
        className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
      >
        <option value="" disabled>
          Select a disposition…
        </option>
        {(Object.entries(DISPOSITION_LABEL) as [OutcomeDisposition, string][]).map(
          ([code, label]) => (
            <option key={code} value={code}>
              {label}
              {suggested.includes(code) ? " (suggested)" : ""}
            </option>
          ),
        )}
      </select>
      {suggested.length > 0 && (
        <p className="mt-1 text-xs text-gray-500">
          Suggested from case state:{" "}
          {suggested.map((s) => DISPOSITION_LABEL[s]).join(", ")}.
        </p>
      )}

      <label htmlFor="outcome-note" className="mt-3 block text-sm text-gray-700">
        Note (optional)
      </label>
      <textarea
        id="outcome-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
        placeholder="Internal note (never furnished to a landlord)"
      />

      <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Tenant consented to include this outcome (anonymized, no PII) in impact /
          funder reporting. Leave unchecked to keep it on the case only.
        </span>
      </label>

      <div className="mt-3">
        <button
          type="button"
          disabled={busy || !disposition}
          onClick={() => void record()}
          className="rounded-md bg-trust-600 px-4 py-2 text-sm font-medium text-white hover:bg-trust-700 disabled:opacity-50"
        >
          {outcome ? "Update outcome" : "Record outcome"}
        </button>
      </div>
      {result && (
        <p className="mt-2 rounded bg-gray-50 p-2 text-sm text-gray-800">{result}</p>
      )}
    </section>
  );
}
