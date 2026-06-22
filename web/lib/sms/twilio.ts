/**
 * Thin, env-gated SMS sender (Twilio REST) — server-only by construction.
 *
 * This is the single network egress point for SMS. It exists so the reminder
 * layer can attempt a real send without taking a new npm dependency: it calls
 * the Twilio Messages REST API directly with `fetch`. The Twilio Node SDK is
 * NOT used (no dep added).
 *
 * HARD RULES (compliance — see GUARDRAILS-SPEC §SMS, API-CONTRACTS §3.13,
 * LEGAL-RULES §4.5):
 *   - TCPA: a SEND requires a caller-passed `consent` flag that is true. This
 *     module NEVER sends without an affirmative prior consent. (The reminder
 *     layer is the source of truth for that consent; this is a defense-in-depth
 *     re-assertion at the egress boundary.)
 *   - STOP / opt-out: a process-level opt-out set is honored. Any number on it
 *     is suppressed, regardless of consent. Inbound STOP/UNSUBSCRIBE/QUIT/CANCEL
 *     keywords add the number; START/UNSTOP removes it. (A2P 10DLC carriers also
 *     enforce STOP independently; this is our own belt-and-suspenders ledger.)
 *   - DRY-RUN by default: if Twilio creds are absent from env, we DO NOT send.
 *     We log a structured line and return a `dry_run` result. We NEVER throw on
 *     a missing-creds / network / API error — the caller gets a typed result.
 *
 * A2P 10DLC: live SMS reminders are A2P traffic and require an approved A2P
 * 10DLC brand + campaign before any production send. Until that registration is
 * approved, keep this in dry-run (no creds) in any tenant-facing environment.
 *
 * Env (all required for a live send; absence => dry-run):
 *   TWILIO_ACCOUNT_SID   — "AC..." account SID
 *   TWILIO_AUTH_TOKEN    — auth token (kept in env, never logged)
 *   TWILIO_FROM          — E.164 sender number or messaging-service-backed from
 */

// E.164 (matches ContactSchema.phone_e164 in @/lib/case).
const E164_RE = /^\+[1-9]\d{1,14}$/;

/** Inbound keywords that opt a number OUT (carrier-standard, case-insensitive). */
const STOP_KEYWORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];
/** Inbound keywords that opt a number back IN. */
const START_KEYWORDS = ["start", "unstop", "yes"];

/**
 * Process-level opt-out ledger. In v1 this is in-memory (resets on restart) —
 * good enough to honor STOP within a running process and to make the gate
 * testable. TODO(integration): back this with the durable Consent revocation
 * store + a Twilio inbound (STOP) webhook so opt-outs survive restarts and are
 * authoritative across processes.
 */
const optOutSet = new Set<string>();

/** Record an opt-out (idempotent). Returns false if the number is malformed. */
export function recordOptOut(phoneE164: string): boolean {
  if (!E164_RE.test(phoneE164)) return false;
  optOutSet.add(phoneE164);
  return true;
}

/** Clear an opt-out (e.g. on START). Returns false if the number is malformed. */
export function clearOptOut(phoneE164: string): boolean {
  if (!E164_RE.test(phoneE164)) return false;
  optOutSet.delete(phoneE164);
  return true;
}

/** Is this number currently opted out? */
export function isOptedOut(phoneE164: string): boolean {
  return optOutSet.has(phoneE164);
}

/**
 * Classify an inbound message body as a STOP/START keyword and update the
 * opt-out ledger accordingly. Returns the action taken. The reminder/consent
 * layer should ALSO revoke the matching Consent on a "stop".
 */
export function handleInboundKeyword(
  phoneE164: string,
  body: string,
): { action: "stop" | "start" | "none" } {
  const word = body.trim().toLowerCase();
  if (STOP_KEYWORDS.includes(word)) {
    recordOptOut(phoneE164);
    return { action: "stop" };
  }
  if (START_KEYWORDS.includes(word)) {
    clearOptOut(phoneE164);
    return { action: "start" };
  }
  return { action: "none" };
}

/** Are all Twilio creds present? */
function twilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM,
  );
}

/** Arguments to {@link sendSms}. */
export interface SendSmsArgs {
  /** Destination, E.164. */
  to: string;
  /** Message body. Keep PII minimal; include opt-out language. */
  body: string;
  /**
   * TCPA gate: the caller asserts a valid prior consent exists for this send.
   * Must be `true` or the send is REFUSED (never sent). This is a hard
   * re-assertion at the egress boundary; the reminder layer owns the real check.
   */
  consent: boolean;
}

/** Typed outcome. Never thrown — always returned. */
export type SendSmsResult =
  | { status: "sent"; provider_message_id: string }
  | { status: "dry_run"; reason: string }
  | { status: "suppressed"; reason: string }
  | { status: "error"; reason: string };

/**
 * Send (or dry-run) one SMS. NEVER throws.
 *
 * Order of checks:
 *   1. consent flag must be true            -> "suppressed"
 *   2. `to` must be E.164                    -> "error"
 *   3. number must not be opted out (STOP)   -> "suppressed"
 *   4. creds absent                          -> "dry_run" (logged, not sent)
 *   5. POST to Twilio Messages API           -> "sent" | "error"
 */
export async function sendSms(args: SendSmsArgs): Promise<SendSmsResult> {
  const { to, body, consent } = args;

  if (consent !== true) {
    return {
      status: "suppressed",
      reason: "no prior consent asserted — SMS refused (TCPA)",
    };
  }
  if (!E164_RE.test(to)) {
    return { status: "error", reason: "destination is not a valid E.164 number" };
  }
  if (isOptedOut(to)) {
    return { status: "suppressed", reason: "recipient has opted out (STOP)" };
  }

  if (!twilioConfigured()) {
    // DRY-RUN: log, do not send. Never include the auth token. Body is logged
    // truncated to avoid dumping full PII into logs.
    console.info(
      "[sms.twilio] DRY-RUN (no Twilio creds) — would send",
      JSON.stringify({ to, body_preview: body.slice(0, 40) }),
    );
    return {
      status: "dry_run",
      reason: "Twilio not configured (TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM absent)",
    };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID as string;
  const authToken = process.env.TWILIO_AUTH_TOKEN as string;
  const from = process.env.TWILIO_FROM as string;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(
    accountSid,
  )}/Messages.json`;
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        status: "error",
        reason: `Twilio API ${res.status}: ${text.slice(0, 200)}`,
      };
    }

    const json = (await res.json().catch(() => ({}))) as { sid?: unknown };
    const sid = typeof json.sid === "string" ? json.sid : "";
    if (!sid) {
      return { status: "error", reason: "Twilio response missing message sid" };
    }
    return { status: "sent", provider_message_id: sid };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : "network error contacting Twilio",
    };
  }
}
