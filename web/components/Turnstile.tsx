/**
 * Turnstile — the Cloudflare Turnstile bot-protection widget for public entry
 * points (the upload/intake action and the OTP request).
 *
 * The backend (lib/turnstile.ts) verifies the token server-side and FAILS CLOSED
 * in production when the secret is unset. This client widget produces that token.
 *
 * Dev fallback: when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset (local `next dev`,
 * tests), we DO NOT load the Cloudflare script. We render a small dev placeholder
 * and emit a sentinel token immediately so the flow is not blocked locally — the
 * server side also allows-with-warning in dev when its secret is unset, so the
 * two halves agree. This sentinel is meaningless to Cloudflare and is rejected in
 * production (where a real site key is always present).
 *
 * Usage: render <Turnstile onToken={setToken} action="intake" />, hold the token
 * in state, and send it to the API (as the `turnstileToken` body field or the
 * `cf-turnstile-token` header). A token is single-use / expires; we expose
 * onToken(null) on expiry/error so the caller can disable the action until the
 * widget re-solves.
 */
"use client";

import { useEffect, useId, useRef } from "react";

/** The dev sentinel emitted when no site key is configured. */
export const DEV_TURNSTILE_TOKEN = "dev-no-turnstile";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      action?: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: "light" | "dark" | "auto";
    },
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

/** Load the Turnstile script once, shared across all widget instances. */
function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${SCRIPT_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("turnstile load failed")));
      if (window.turnstile) resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile load failed"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export interface TurnstileProps {
  /** Called with the solved token, or null when it expires / errors / resets. */
  onToken: (token: string | null) => void;
  /**
   * The token the PARENT currently holds. When it transitions to null — i.e. the
   * parent consumed/cleared it after a protected action — the widget RE-ISSUES a
   * fresh token. Without this, Turnstile tokens are single-use, so the SECOND
   * action on a surface (chat / stipulation / defenses / answer / intake) is
   * permanently blocked in production until the widget expires (minutes later),
   * dead-ending the flow. Optional: a caller that never re-uses a token can omit
   * it for one-shot behavior.
   */
  token?: string | null;
  /** Optional Turnstile action label (shown in CF analytics). */
  action?: string;
  className?: string;
}

export default function Turnstile({ onToken, token, action, className = "" }: TurnstileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  const reactId = useId();

  useEffect(() => {
    // Dev fallback (no site key): the re-arm effect below emits the sentinel
    // token (and re-emits it after each consume). In production we render the
    // real widget here exactly once.
    if (!SITE_KEY) return;

    let cancelled = false;
    void loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return;
        if (widgetIdRef.current != null) return; // already rendered
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: SITE_KEY,
          ...(action ? { action } : {}),
          callback: (token: string) => onTokenRef.current(token),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => onTokenRef.current(null),
          theme: "auto",
        });
      })
      .catch(() => {
        // Script failed to load — leave the token null so the caller blocks the
        // action and shows its own retry. (Production fails closed server-side.)
        if (!cancelled) onTokenRef.current(null);
      });

    return () => {
      cancelled = true;
      const id = widgetIdRef.current;
      if (id != null && window.turnstile) {
        try {
          window.turnstile.remove(id);
        } catch {
          /* ignore */
        }
      }
      widgetIdRef.current = null;
    };
  }, [action]);

  // Re-arm: issue a FRESH token whenever the parent has consumed/cleared the
  // current one (token === null / undefined). Closes the "second action is
  // permanently blocked" bug — Turnstile tokens are single-use, so after the
  // parent sends one it must get another. In dev we re-emit the sentinel; in
  // production we reset the live widget (a reset re-runs the challenge and fires
  // the callback again with a new token).
  useEffect(() => {
    if (token != null) return; // still holding a usable token — nothing to do
    if (!SITE_KEY) {
      onTokenRef.current(DEV_TURNSTILE_TOKEN);
      return;
    }
    const id = widgetIdRef.current;
    if (id != null && window.turnstile) {
      try {
        window.turnstile.reset(id);
      } catch {
        /* ignore — a failed reset leaves the token null and the caller blocks. */
      }
    }
  }, [token]);

  if (!SITE_KEY) {
    // Visible, honest dev placeholder — never shipped to prod (site key is set there).
    return (
      <p
        className={["text-xs text-trust-500", className].filter(Boolean).join(" ")}
        aria-hidden="true"
        data-testid="turnstile-dev-placeholder"
      >
        (Bot check disabled in this environment.)
      </p>
    );
  }

  return (
    <div
      ref={containerRef}
      id={`turnstile-${reactId}`}
      className={className}
      aria-label="Verifying you're human"
    />
  );
}
