/**
 * EligibilityScreener — the tenant affordance to check what FREE HELP they may
 * qualify for (Right to Counsel, legal aid, rental assistance).
 *
 * Collects household income + size (opt-in, sensitive) behind an explicit
 * store_sensitive_data consent, then calls POST /api/eligibility — the server
 * records the consent, stores the figures, runs the DETERMINISTIC engine
 * (never an LLM), and returns the populated Case. Results render through
 * lib/eligibility-display, which is §8.7-safe: `likely_eligible` is NEVER shown
 * to the tenant as a conclusion — at most "you may qualify, a lawyer will
 * confirm." Nothing here is legal advice.
 *
 * Default-deny: with no consent box checked, nothing sensitive is sent or stored.
 */
"use client";

import { useState } from "react";

import type { Case } from "@/lib/case";
import { fetchWithTimeout } from "@/lib/fetch";
import {
  tenantEligibilityRows,
  eligibilitySummary,
  type EligibilityTone,
} from "@/lib/eligibility-display";

const TONE_CLASS: Record<EligibilityTone, string> = {
  positive: "border-green-200 bg-green-50 text-green-900",
  neutral: "border-trust-200 bg-trust-50 text-trust-900",
  unavailable: "border-gray-200 bg-gray-50 text-gray-600",
};

interface EligibilityScreenerProps {
  caseId: string;
  caseObject: Case | null;
  authHeaders: (json?: boolean) => Record<string, string>;
  onCaseUpdate: (c: Case) => void;
}

export default function EligibilityScreener({
  caseId,
  caseObject,
  authHeaders,
  onCaseUpdate,
}: EligibilityScreenerProps) {
  const evaluated = caseObject?.eligibility;
  const rows = tenantEligibilityRows(evaluated);

  const [income, setIncome] = useState("");
  const [size, setSize] = useState("");
  const [consent, setConsent] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showForm = !evaluated || editing;

  async function submit() {
    setError(null);
    const dollars = Number(income.replace(/[^0-9.]/g, ""));
    const householdSize = parseInt(size, 10);
    if (!consent) {
      setError("Please check the box to store this so we can check eligibility.");
      return;
    }
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError("Enter your household income as a number (yearly, before taxes).");
      return;
    }
    if (!Number.isInteger(householdSize) || householdSize < 1) {
      setError("Enter how many people are in your household (1 or more).");
      return;
    }

    setBusy(true);
    try {
      const res = await fetchWithTimeout("/api/eligibility", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          case_id: caseId,
          household_income_cents: Math.round(dollars * 100),
          household_size: householdSize,
          consent_to_store: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.case) {
        setError(data?.message ?? "Could not check eligibility. Please try again.");
        return;
      }
      onCaseUpdate(data.case as Case);
      setEditing(false);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-gray-900">
        See what free help you may qualify for
      </h2>
      <p className="mt-1 text-sm text-gray-600">{eligibilitySummary(evaluated)}</p>

      {!showForm && (
        <>
          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <li
                key={row.label}
                className={`rounded border p-2 text-sm ${TONE_CLASS[row.tone]}`}
              >
                <span className="font-medium">{row.label}:</span> {row.status}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">
            This is information, not legal advice or a guarantee. A lawyer confirms
            what you qualify for — it&apos;s free to ask.
          </p>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="mt-2 text-sm font-medium text-trust-700 underline underline-offset-2"
          >
            Update my income / household size
          </button>
        </>
      )}

      {showForm && (
        <div className="mt-3 space-y-3">
          <div>
            <label htmlFor="elig-income" className="block text-sm text-gray-700">
              Yearly household income (before taxes)
            </label>
            <div className="mt-1 flex items-center gap-1">
              <span className="text-gray-500">$</span>
              <input
                id="elig-income"
                inputMode="decimal"
                value={income}
                onChange={(e) => setIncome(e.target.value)}
                disabled={busy}
                placeholder="e.g. 32000"
                className="w-full rounded border border-gray-300 p-2 text-sm"
              />
            </div>
          </div>
          <div>
            <label htmlFor="elig-size" className="block text-sm text-gray-700">
              People in your household
            </label>
            <input
              id="elig-size"
              inputMode="numeric"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              disabled={busy}
              placeholder="e.g. 3"
              className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
            />
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              disabled={busy}
              className="mt-0.5"
            />
            <span>
              I agree to store my household income and size so the copilot can
              check what free help I may qualify for. It is never shared with my
              landlord.
            </span>
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !consent}
              onClick={() => void submit()}
              className="rounded-md bg-trust-600 px-4 py-2 text-sm font-medium text-white hover:bg-trust-700 disabled:opacity-50"
            >
              {busy ? "Checking…" : "Check what I qualify for"}
            </button>
            {evaluated && (
              <button
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
                className="text-sm text-gray-600 underline underline-offset-2"
              >
                Cancel
              </button>
            )}
          </div>
          {error && (
            <p className="rounded bg-red-50 p-2 text-sm text-red-800">{error}</p>
          )}
        </div>
      )}
    </section>
  );
}
