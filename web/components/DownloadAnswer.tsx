/**
 * DownloadAnswer — generate + download the DRAFT nonpayment Answer PDF.
 *
 * Posts the current Case to /api/packet (a deterministic, no-LLM transform) and
 * triggers a browser download of the returned PDF. The draft is plainly marked
 * "not the official court form — review before filing"; this button only restates
 * what the server already stamps on the document.
 */
"use client";

import { useState } from "react";

import { fetchWithTimeout } from "@/lib/fetch";
import {
  type Strings,
  DEFAULT_LANGUAGE,
  getStrings,
  errorMessage,
} from "@/lib/i18n";
import type { Case } from "@/lib/case";

export interface DownloadAnswerProps {
  /** The current Case the draft is built from. */
  caseObject: Case;
  /** Localized UI strings; falls back to English standalone. */
  strings?: Strings;
  className?: string;
}

export default function DownloadAnswer({
  caseObject,
  strings,
  className = "",
}: DownloadAnswerProps) {
  const t = strings ?? getStrings(DEFAULT_LANGUAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetchWithTimeout("/api/packet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case: caseObject, type: "nonpayment_answer" }),
      });
      if (!res.ok) {
        setError(t.packetError);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "draft-answer.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(errorMessage(t, err, t.packetError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={className}>
      <button
        type="button"
        onClick={handleDownload}
        disabled={busy}
        className="rounded bg-trust-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        <span aria-hidden="true">📄 </span>
        {busy ? "…" : t.packetDownload}
      </button>
      <p className="mt-2 text-xs text-trust-700">{t.packetDraftNote}</p>
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
