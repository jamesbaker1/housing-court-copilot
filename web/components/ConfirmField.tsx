/**
 * ConfirmField — the human verify gate for an LLM-extracted value.
 *
 * Backstop #1 lives here for the court date: nothing the model read is trusted
 * until the tenant confirms (or corrects) it against their official court
 * papers. A wrong court date can cause a default judgment, so the court-date
 * field gets the red, can't-miss treatment and a stronger prompt.
 *
 * This renders the `ConfirmableValue` flow: show what we read ("We read
 * June 30 — is this right?"), then either CONFIRM as-is or CORRECT with a typed
 * value. The corrected value is authoritative over the read value.
 *
 * It is presentation only — the parent owns persistence (the /api/intake
 * confirm calls). It surfaces `confidence` per the API read-shape requirement
 * and never claims a date is authoritative on the model's say-so.
 */
"use client";

import { useState, useId } from "react";
import type { ConfidenceLevel } from "@/lib/case";

export interface ConfirmFieldProps {
  /** Friendly field label, e.g. "Your next court date". */
  label: string;
  /** Human-readable rendering of what the model read, e.g. "June 30, 2026". */
  readValue: string;
  /** The model's confidence in the read value. Always surfaced. */
  confidence?: ConfidenceLevel;
  /**
   * When true, this field is treated as safety-critical (the court date). It
   * gets the red deadline treatment, a stronger prompt, and a default-risk note.
   */
  critical?: boolean;
  /** Whether the tenant has already confirmed this field. */
  confirmed?: boolean;
  /**
   * Input type for the correction field. `date` shows a date picker; `text` a
   * plain box; `money` a dollars box. Defaults to `text`.
   */
  inputType?: "date" | "text" | "money";
  /**
   * Help text shown under the prompt, e.g. where to find the value on the
   * papers ("Look for the date next to 'Return Date' on your court notice.").
   */
  hint?: string;
  /** Called when the tenant confirms the read value as-is. */
  onConfirm: () => void;
  /**
   * Called when the tenant corrects the value. `correctedValue` is the raw
   * string the tenant typed (ISO date for `date`, dollars for `money`).
   */
  onCorrect: (correctedValue: string) => void;
  className?: string;
}

const CONFIDENCE_COPY: Record<ConfidenceLevel, { text: string; tone: string }> =
  {
    high: { text: "We're fairly sure we read this right", tone: "text-trust-700" },
    medium: {
      text: "We think we read this right — please double-check",
      tone: "text-verify-800",
    },
    low: {
      text: "We're not sure we read this right — please check carefully",
      tone: "text-verify-900 font-medium",
    },
    unreadable: {
      text: "We couldn't read this clearly — please enter it yourself",
      tone: "text-deadline-700 font-medium",
    },
  };

export default function ConfirmField({
  label,
  readValue,
  confidence,
  critical = false,
  confirmed = false,
  inputType = "text",
  hint,
  onConfirm,
  onCorrect,
  className = "",
}: ConfirmFieldProps) {
  const [mode, setMode] = useState<"prompt" | "correcting">("prompt");
  const [draft, setDraft] = useState("");
  const fieldId = useId();

  const shellClass = critical ? "hcc-deadline" : "hcc-verify";
  const conf = confidence ? CONFIDENCE_COPY[confidence] : null;
  const unreadable = confidence === "unreadable";

  function submitCorrection() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onCorrect(trimmed);
  }

  return (
    <div
      className={[shellClass, "rounded-lg", className].filter(Boolean).join(" ")}
      aria-label={`Confirm ${label}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
            {critical && <span aria-hidden="true">📅 </span>}
            {label}
          </p>
          {!unreadable && (
            <p className="mt-0.5 text-lg font-semibold leading-tight">
              {readValue}
            </p>
          )}
        </div>
        {confirmed && (
          <span
            className="shrink-0 rounded-full bg-trust-600 px-2 py-0.5 text-xs font-medium text-white"
            aria-label="Confirmed"
          >
            ✓ Confirmed
          </span>
        )}
      </div>

      {conf && (
        <p className={["mt-1 text-xs", conf.tone].join(" ")}>{conf.text}</p>
      )}

      {critical && (
        <p className="mt-2 text-xs text-deadline-700">
          Missing your court date can lead to losing your case automatically (a
          &ldquo;default&rdquo;). We never trust this date until you confirm it
          against your official court papers.
        </p>
      )}

      {hint && <p className="mt-1 text-xs opacity-80">{hint}</p>}

      {mode === "prompt" && !confirmed && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!unreadable && (
            <button
              type="button"
              onClick={onConfirm}
              className="rounded-md bg-trust-600 px-4 py-2 text-sm font-semibold text-white hover:bg-trust-700 focus:outline-none focus:ring-2 focus:ring-trust-400"
            >
              Yes, that&apos;s right
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setMode("correcting");
              setDraft("");
            }}
            className="rounded-md border border-trust-400 bg-white px-4 py-2 text-sm font-semibold text-trust-800 hover:bg-trust-50 focus:outline-none focus:ring-2 focus:ring-trust-400"
          >
            {unreadable ? "Enter it" : "No, fix it"}
          </button>
        </div>
      )}

      {mode === "prompt" && confirmed && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setMode("correcting")}
            className="text-sm font-medium text-trust-700 underline underline-offset-2"
          >
            Change this
          </button>
        </div>
      )}

      {mode === "correcting" && (
        <div className="mt-3 space-y-2">
          <label htmlFor={fieldId} className="block text-sm font-medium">
            {inputType === "money"
              ? "Enter the correct amount (in dollars)"
              : inputType === "date"
                ? "Enter the correct date"
                : "Enter the correct value"}
          </label>
          <div className="flex items-center gap-2">
            {inputType === "money" && (
              <span aria-hidden="true" className="text-lg font-semibold">
                $
              </span>
            )}
            <input
              id={fieldId}
              type={inputType === "date" ? "date" : inputType === "money" ? "number" : "text"}
              inputMode={inputType === "money" ? "decimal" : undefined}
              step={inputType === "money" ? "0.01" : undefined}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full rounded-md border border-trust-300 bg-white px-3 py-2 text-base focus:border-trust-500 focus:outline-none focus:ring-2 focus:ring-trust-400"
              autoFocus
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={submitCorrection}
              disabled={!draft.trim()}
              className="rounded-md bg-trust-600 px-4 py-2 text-sm font-semibold text-white hover:bg-trust-700 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-trust-400"
            >
              Save this value
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("prompt");
                setDraft("");
              }}
              className="rounded-md border border-trust-300 bg-white px-4 py-2 text-sm font-medium text-trust-700 hover:bg-trust-50 focus:outline-none focus:ring-2 focus:ring-trust-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
