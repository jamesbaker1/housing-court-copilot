/**
 * Disclaimer — the reusable contextual "verify this / not legal advice" UX.
 *
 * Product direction: disclaimers are a TRUST FEATURE, not a footer. Wherever LLM
 * output is shown, wrap it in a clear, contextual disclaimer with a friendly
 * "talk to a person" link. This component takes a {@link DisclaimerContext} and
 * renders the right contextual copy from `@/lib/disclaimers`.
 *
 * Two visual treatments:
 *  - `chip` — a compact inline badge (the `label`), good for headers next to a
 *    block of LLM output. Expandable to reveal the full `body`.
 *  - `panel` — a full inline panel showing `label` + `body`, with the
 *    "talk to a person" call-to-action.
 *
 * The Deadline context uses the red `hcc-deadline` treatment (the code-backed
 * court-date backstop); everything else uses the amber `hcc-verify` treatment.
 */
"use client";

import { useState, useId } from "react";
import {
  DisclaimerContext,
  getDisclaimer,
  TALK_TO_A_PERSON_CTA,
  type DisclaimerContextValue,
} from "@/lib/disclaimers";

export interface DisclaimerProps {
  context: DisclaimerContext | DisclaimerContextValue;
  /** Visual treatment. Defaults to `panel`. */
  variant?: "chip" | "panel";
  /**
   * Show the "Talk to a person / free help" call-to-action. Defaults to true
   * for `panel`. Always available regardless of variant.
   */
  showTalkToAPerson?: boolean;
  className?: string;
}

/** Small, friendly "talk to a person" link with the free-help hotline. */
export function TalkToAPersonLink({ className = "" }: { className?: string }) {
  return (
    <a
      href={`tel:${TALK_TO_A_PERSON_CTA.hotlinePhone}`}
      className={[
        "inline-flex items-center gap-1 font-medium text-trust-700 underline underline-offset-2",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span aria-hidden="true">💬</span>
      {TALK_TO_A_PERSON_CTA.action}
    </a>
  );
}

export default function Disclaimer({
  context,
  variant = "panel",
  showTalkToAPerson,
  className = "",
}: DisclaimerProps) {
  const { label, body } = getDisclaimer(context);
  const isDeadline = String(context) === DisclaimerContext.Deadline;
  const baseClass = isDeadline ? "hcc-deadline" : "hcc-verify";
  const wantsCta = showTalkToAPerson ?? variant === "panel";

  const [open, setOpen] = useState(false);
  const bodyId = useId();

  if (variant === "chip") {
    return (
      <div className={["text-sm", className].filter(Boolean).join(" ")}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
          className={[
            baseClass,
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-left font-medium",
            "focus:outline-none focus:ring-2 focus:ring-trust-400",
          ].join(" ")}
        >
          <span aria-hidden="true">{isDeadline ? "📅" : "ⓘ"}</span>
          <span>{label}</span>
          <span aria-hidden="true" className="text-xs opacity-70">
            {open ? "▲" : "▼"}
          </span>
        </button>
        {open && (
          <div
            id={bodyId}
            className={[baseClass, "mt-2 rounded-lg"].join(" ")}
          >
            <p>{body}</p>
            {wantsCta && (
              <p className="mt-2">
                <TalkToAPersonLink />
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={[baseClass, "rounded-lg", className].filter(Boolean).join(" ")}
      role="note"
      aria-label={label}
    >
      <p className="flex items-start gap-1.5 font-semibold">
        <span aria-hidden="true">{isDeadline ? "📅" : "ⓘ"}</span>
        <span>{label}</span>
      </p>
      <p className="mt-1">{body}</p>
      {wantsCta && (
        <p className="mt-2">
          <TalkToAPersonLink />
        </p>
      )}
    </div>
  );
}
