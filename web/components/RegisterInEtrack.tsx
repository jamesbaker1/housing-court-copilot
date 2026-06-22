/**
 * RegisterInEtrack — a tenant-facing affordance that explains how to register a
 * case in NY Courts eTrack so the official court system EMAILS appearance
 * reminders, which (when routed to the operator's ingest address) lets the app
 * CONFIRM the court date from an authoritative source (eTrack) instead of the
 * tenant's own typing.
 *
 * WHY THIS LIVES NEXT TO THE COURT-DATE CONFIRM STEP: a tenant-entered date is
 * never authoritative (court_date_verified stays false). The single legitimate,
 * tenant-driven way to get a VERIFIED date is the sanctioned eTrack email
 * channel. This component points the tenant at the official eTrack self-service
 * site and (optionally) at the operator's ingest address to forward reminders
 * to. It is purely informational — it does NOT scrape eTrack, store credentials,
 * or submit anything on the tenant's behalf.
 *
 * The ingest address is operator-configured and surfaced via the build-time
 * public env var NEXT_PUBLIC_ETRACK_INGEST_ADDRESS. When unset, the component
 * shows the registration guidance without a forwarding address (the most common
 * pre-launch state), so nothing breaks if the operator hasn't wired Email
 * Routing yet.
 */
"use client";

import { useState } from "react";

/** Official NY Courts eTrack self-service URL (public, human-facing). */
const ETRACK_URL = "https://iapps.courts.state.ny.us/webetrack/";

export interface RegisterInEtrackProps {
  /**
   * Already-verified from the court system (eTrack/NYSCEF)? When true we show a
   * confirmation chip instead of the registration prompt — there is nothing more
   * for the tenant to do.
   */
  verified?: boolean;
  className?: string;
}

export default function RegisterInEtrack({
  verified = false,
  className,
}: RegisterInEtrackProps) {
  const [open, setOpen] = useState(false);

  // Operator-configured inbound ingest address (Cloudflare Email Routing ->
  // Worker). Public, non-secret. Absent => show guidance without a target.
  const ingestAddress =
    typeof process !== "undefined"
      ? process.env.NEXT_PUBLIC_ETRACK_INGEST_ADDRESS
      : undefined;

  if (verified) {
    return (
      <p
        className={[
          "rounded-md bg-trust-50 px-3 py-2 text-xs text-trust-700",
          className ?? "",
        ].join(" ")}
      >
        <span aria-hidden="true">✅ </span>
        Your court date is confirmed from the official court system (eTrack /
        NYSCEF). You don&apos;t need to do anything else to verify it.
      </p>
    );
  }

  return (
    <section
      className={[
        "rounded-lg border border-trust-200 bg-trust-50 px-4 py-3 text-sm",
        className ?? "",
      ].join(" ")}
    >
      <h3 className="text-sm font-semibold text-trust-900">
        <span aria-hidden="true">🏛️ </span>
        Get your court date confirmed by the court system
      </h3>
      <p className="mt-1 text-trust-800">
        The date you enter here is what <em>you</em> read off your papers — we
        treat it as unconfirmed until the court system itself confirms it. New
        York&apos;s free <strong>eTrack</strong> service can email you reminders
        when your case is scheduled. That official email is something we can use
        to confirm your date automatically.
      </p>

      <button
        type="button"
        className="mt-2 text-xs font-medium text-trust-700 underline underline-offset-2"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? "Hide steps" : "How to set this up"}
      </button>

      {open && (
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-trust-800">
          <li>
            Go to the official{" "}
            <a
              href={ETRACK_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-trust-700 underline underline-offset-2"
            >
              NY Courts eTrack site
            </a>{" "}
            and create a free account.
          </li>
          <li>
            Add your case using your <strong>index number</strong> (it&apos;s on
            your court papers). eTrack will then email you when your case is
            calendared or adjourned.
          </li>
          {ingestAddress ? (
            <li>
              In eTrack, set your notification email to{" "}
              <code className="rounded bg-white px-1 py-0.5 text-xs text-trust-900">
                {ingestAddress}
              </code>{" "}
              (or auto-forward eTrack&apos;s reminder emails there). We&apos;ll
              read the official date from that email and mark it confirmed for
              you.
            </li>
          ) : (
            <li>
              Keep eTrack&apos;s reminder emails — they show the official date.
              When that date matches what you entered, you can trust it; if it
              differs, always follow the court&apos;s official notice.
            </li>
          )}
        </ol>
      )}

      <p className="mt-2 text-xs text-trust-600">
        We never log into eTrack for you or store your court login — eTrack emails
        you, and (if set up) those emails come to us. Always trust your official
        court notice over anything shown here.
      </p>
    </section>
  );
}
