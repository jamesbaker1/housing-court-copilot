/**
 * ResumeByPhone — OPTIONAL opt-in to save a case to a phone so a tenant can come
 * back to it on another device.
 *
 * This is deliberately low-friction and NEVER a login wall: it is collapsed
 * behind an opt-in toggle, the copilot works fully without it, and the privacy
 * note makes clear what linking a number does (and does not) do.
 *
 * Flow (matches the routes):
 *   1) Tenant opts in, enters a phone -> POST /api/auth/otp/request {phone_e164, case_id}
 *   2) Tenant enters the 6-digit code -> POST /api/auth/otp/verify {phone_e164, code}
 *      -> on success we receive the linked case_id(s).
 *
 * The Integrate phase wires this into the page (passing the live caseId and an
 * onLinked callback). Both endpoints return GENERIC messages; this UI never
 * claims more than the server tells it.
 */
"use client";

import { useState } from "react";

import Turnstile from "@/components/Turnstile";
import { readStoredCaseToken } from "@/lib/caseClient";
import { fetchWithTimeout } from "@/lib/fetch";
import {
  type Strings,
  DEFAULT_LANGUAGE,
  getStrings,
  errorMessage,
} from "@/lib/i18n";

export interface ResumeByPhoneProps {
  /** The case currently being worked on; linked to the phone on success. */
  caseId: string;
  /** Called with the phone's owned case_ids after a successful verification. */
  onLinked?: (caseIds: string[]) => void;
  /**
   * Called with the OTP-verified owner session token (+ expiry) on success. The
   * page can present it as `x-owner-session` to the owner-gated cases route from
   * a device that doesn't hold the per-case capability token.
   */
  onSession?: (session: { token: string; expires_at?: string }) => void;
  /**
   * Localized UI strings (M7). The copilot page passes its `t` so network-error
   * messages are in the tenant's language. Falls back to English standalone.
   */
  strings?: Strings;
  className?: string;
}

type Step = "idle" | "code";

export default function ResumeByPhone({
  caseId,
  onLinked,
  onSession,
  strings,
  className = "",
}: ResumeByPhoneProps) {
  const t = strings ?? getStrings(DEFAULT_LANGUAGE);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("idle");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // Bot protection for the public OTP-request action (sends an SMS).
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  function normalizePhone(raw: string): string {
    // Best-effort E.164: strip spaces/dashes/parens; default a bare 10-digit US
    // number to +1. The server is the authoritative validator.
    const trimmed = raw.replace(/[\s\-().]/g, "");
    if (/^\+[1-9]\d{1,14}$/.test(trimmed)) return trimmed;
    if (/^\d{10}$/.test(trimmed)) return `+1${trimmed}`;
    if (/^1\d{10}$/.test(trimmed)) return `+${trimmed}`;
    return trimmed;
  }

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const phone_e164 = normalizePhone(phone);
    if (!/^\+[1-9]\d{1,14}$/.test(phone_e164)) {
      setError("Enter a valid mobile number (e.g. +1 555 123 4567).");
      return;
    }
    setBusy(true);
    try {
      // Prove ownership of THIS case so the server will link it to the phone:
      // send the per-case capability token (held on the device that created the
      // case). Without an ownership proof the server sends a code but links no
      // case — preventing anyone who merely knows the case_id from binding it.
      const caseToken = readStoredCaseToken();
      const res = await fetchWithTimeout("/api/auth/otp/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(caseToken ? { Authorization: `Bearer ${caseToken}` } : {}),
        },
        body: JSON.stringify({
          phone_e164,
          case_id: caseId,
          ...(turnstileToken ? { turnstileToken } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError("Couldn't send a code right now. Please try again.");
        return;
      }
      setPhone(phone_e164);
      setStep("code");
      setNotice(
        data.message ??
          "If that number can receive texts, we sent a 6-digit code.",
      );
    } catch (err) {
      setError(errorMessage(t, err, t.networkError));
    } finally {
      // The Turnstile token is single-use; force a re-solve before another send.
      setTurnstileToken(null);
      setBusy(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setError("Enter the 6-digit code from the text.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetchWithTimeout("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone_e164: phone, code: code.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        case_ids?: string[];
        owner_session?: string;
        session_expires_at?: string;
      };
      if (!res.ok) {
        setError("That code didn't work. Request a new one and try again.");
        return;
      }
      setDone(true);
      setNotice("Saved. You can resume this case from your phone anytime.");
      onLinked?.(Array.isArray(data.case_ids) ? data.case_ids : [caseId]);
      if (data.owner_session) {
        onSession?.({
          token: data.owner_session,
          ...(data.session_expires_at ? { expires_at: data.session_expires_at } : {}),
        });
      }
    } catch (err) {
      setError(errorMessage(t, err, t.networkError));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep("idle");
    setCode("");
    setError(null);
    setNotice(null);
  }

  const baseClass = [
    "rounded-lg border border-trust-200 bg-white p-4 text-sm text-trust-900",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // Collapsed opt-in entry point.
  if (!open) {
    return (
      <div className={baseClass}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-medium text-trust-900 underline underline-offset-2"
        >
          Save my case to my phone so I can come back to it
        </button>
        <p className="mt-1 text-xs text-trust-700">
          Optional. You can keep using this tool without giving a phone number.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className={baseClass} role="status">
        <p className="font-medium">Saved to your phone.</p>
        <p className="mt-1 text-xs text-trust-700">
          {notice ?? "You can resume this case from your phone anytime."}
        </p>
      </div>
    );
  }

  return (
    <div className={baseClass}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">Save my case to my phone</p>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            reset();
          }}
          className="text-xs text-trust-700 underline underline-offset-2"
        >
          Not now
        </button>
      </div>

      {step === "idle" && (
        <form onSubmit={handleRequest} className="mt-3 space-y-2">
          <label className="block text-xs font-medium text-trust-700">
            Mobile number
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(ev) => setPhone(ev.target.value)}
              placeholder="+1 555 123 4567"
              className="mt-1 w-full rounded border border-trust-300 px-2 py-1.5 text-sm"
              disabled={busy}
            />
          </label>
          {/* Bot protection before we send any SMS. Dev shows a no-op placeholder
              and emits a sentinel token so local dev still works. */}
          <Turnstile token={turnstileToken} onToken={setTurnstileToken} action="otp_request" />
          <button
            type="submit"
            disabled={busy || turnstileToken == null}
            className="rounded bg-trust-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send me a code"}
          </button>
        </form>
      )}

      {step === "code" && (
        <form onSubmit={handleVerify} className="mt-3 space-y-2">
          <label className="block text-xs font-medium text-trust-700">
            Enter the 6-digit code
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(ev) => setCode(ev.target.value.replace(/\D/g, ""))}
              placeholder="123456"
              className="mt-1 w-full rounded border border-trust-300 px-2 py-1.5 text-sm tracking-widest"
              disabled={busy}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-trust-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {busy ? "Checking…" : "Verify"}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={busy}
              className="text-xs text-trust-700 underline underline-offset-2"
            >
              Use a different number
            </button>
          </div>
        </form>
      )}

      {notice && (
        <p className="mt-2 text-xs text-trust-700" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}

      <p className="mt-3 border-t border-trust-100 pt-2 text-xs text-trust-600">
        Privacy: we only use your number to text you a code and to let you
        reopen this case later. We don&apos;t share it, and this isn&apos;t a
        login — you can keep using the tool without it. Reply STOP to any text to
        opt out.
      </p>
    </div>
  );
}
