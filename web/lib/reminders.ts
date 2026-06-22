/**
 * Reminder scheduling — DETERMINISTIC (LEGAL-RULES §4.5).
 *
 * Schedules reminder objects off the CONFIRMED AUTHORITATIVE date (a verified
 * court date, or an attorney-validated answer deadline) — never off an
 * LLM-extracted/unverified date. Reminders are computed by code; the LLM is not
 * involved.
 *
 * Two hard send gates (§4.5):
 *   1. A `consents[]` record with scope="sms_reminders", granted=true, not
 *      expired/revoked.
 *   2. `contact.safe_to_text === true` (DV/safety consideration).
 * A reminder may be CREATED (state="scheduled") without consent, but it MUST be
 * suppressed at send time if either gate fails.
 *
 * NO REAL SMS IS SENT from this module. `sendReminder` is a stub with a clear
 * TODO for the Twilio A2P 10DLC integration + the runtime consent re-check.
 *
 * Date math is on the bare America/New_York calendar; `scheduled_for` is then
 * serialized as an RFC-3339 UTC `Z` instant at the configured local send time.
 */
import type { Case, Consent, Deadline, Reminder } from "@/lib/case";
import type { DateUnit } from "@/lib/deadlines";
import { isCourtDateAuthoritative } from "@/lib/court-date";
import { sendSms } from "@/lib/sms/twilio";
import { PERSISTENT_BANNER_SHORT } from "@/lib/disclaimers";

// ===========================================================================
// CONFIG — reminder offsets (§4.2 `nonpayment_default_risk.reminder_offsets`).
// "ATTORNEY/OPS MUST POPULATE — not production values."
// ===========================================================================

/** Reminder offset schedule. Lives inside the default-risk rule's config. */
export interface ReminderOffsetConfig {
  /**
   * Days-before-due offsets. The product direction calls for a 7/3/1-day
   * cadence; that is the INTENT, but the operative values are ops/attorney-
   * owned and version-stamped, so this defaults to [] (unpopulated) here.
   */
  offsets: number[];
  /** ATTORNEY/OPS POPULATES. null = unpopulated. */
  unit: DateUnit | null;
  /** "HH:MM" America/New_York send time. null = unpopulated. */
  send_local_time: string | null;
  /** Version stamp of the emitting rule (for audit reproducibility). */
  rule_version: string;
}

/**
 * The product-intended cadence is 7/3/1 days. We expose it as a named constant
 * so the intent is documented, but it is NOT the default config — ops/attorney
 * must explicitly populate {@link ReminderOffsetConfig} to activate sending.
 */
export const INTENDED_REMINDER_OFFSETS_DAYS = [7, 3, 1] as const;

/** UNVALIDATED default — empty offsets so nothing schedules until populated. */
export const UNVALIDATED_REMINDER_CONFIG: ReminderOffsetConfig = {
  offsets: [], // <-- ATTORNEY/OPS POPULATES (intended: 7/3/1 — see above)
  unit: null, // <-- ATTORNEY/OPS POPULATES ("calendar_days" | "court_days")
  send_local_time: null, // <-- ATTORNEY/OPS POPULATES ("HH:MM" America/New_York)
  rule_version: "0.0.0-UNVALIDATED",
};

// ===========================================================================
// AUTHORITATIVE DATE SOURCE — what a reminder is allowed to fire off.
// ===========================================================================

/**
 * The authoritative anchor a reminder schedule hangs off. Either a verified
 * court date or an attorney-validated answer deadline. Reminders MUST NOT be
 * scheduled off unverified/provisional dates (backstop #1).
 */
export type ReminderAnchor =
  | {
      kind: "court_date";
      /** The verified court date (YYYY-MM-DD). */
      date: string;
      /** Reminder.reminder_type to stamp. */
      reminder_type: "court_date";
      related_deadline_id?: null;
    }
  | {
      kind: "answer_deadline";
      date: string;
      reminder_type: "answer_deadline";
      /** The Deadline FK. */
      related_deadline_id: string;
    };

// ===========================================================================
// PURE CALENDAR HELPERS (mirrors deadlines.ts; kept local to avoid coupling).
// ===========================================================================

function parseCalendarDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function addCalendarDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Parse "HH:MM" into [hours, minutes], or null if malformed. */
function parseLocalTime(hhmm: string): [number, number] | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/**
 * America/New_York UTC offset in minutes for a given calendar date.
 *
 * v1 pragmatic implementation: use Intl to resolve the zone offset for the
 * date's noon (avoids DST-transition edge cases at midnight). This keeps the
 * module dependency-free. TODO: if a tz library is later added project-wide,
 * swap to it for full IANA fidelity.
 */
function nyOffsetMinutes(localDate: Date): number {
  // Resolve what wall-clock time America/New_York shows for this UTC instant,
  // then derive the offset. We sample at the date's UTC-noon to stay clear of
  // the DST switch window.
  const sample = new Date(
    Date.UTC(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth(),
      localDate.getUTCDate(),
      12,
      0,
      0,
    ),
  );
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(sample);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  // offset = (wall-clock interpreted as UTC) - actual UTC instant.
  return Math.round((asUtc - sample.getTime()) / 60_000);
}

/**
 * Convert an America/New_York wall-clock (date + HH:MM) to an RFC-3339 UTC `Z`
 * instant string.
 */
function nyWallClockToUtcZ(date: Date, hours: number, minutes: number): string {
  const offsetMin = nyOffsetMinutes(date);
  const utcMillis = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hours,
    minutes,
    0,
  ) - offsetMin * 60_000;
  return new Date(utcMillis).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ===========================================================================
// SCHEDULING (DETERMINISTIC)
// ===========================================================================

/** Result of building a reminder schedule. */
export interface ReminderScheduleResult {
  reminders: Reminder[];
  reasons: string[];
}

/** A SYS id generator the caller supplies (rem_<ULID>). */
export type ReminderIdFactory = () => string;

/**
 * Find a currently-valid sms_reminders consent on the Case (§4.5 gate 1).
 * Returns the consent or null. A consent is valid when granted, not revoked,
 * and not expired as of `nowIso`.
 */
export function findValidSmsConsent(
  caseObj: Case,
  nowIso: string,
): Consent | null {
  const now = Date.parse(nowIso);
  for (const c of caseObj.consents) {
    if (c.scope !== "sms_reminders") continue;
    if (c.granted !== true) continue;
    if (c.revoked_at != null) continue;
    if (c.expires_at != null && Date.parse(c.expires_at) <= now) continue;
    return c;
  }
  return null;
}

/**
 * Both hard send gates (§4.5): valid sms_reminders consent AND safe_to_text.
 * Returns the matching consent_id when both hold, else a reason it failed.
 */
export function checkSendGates(
  caseObj: Case,
  nowIso: string,
):
  | { ok: true; consent_id: string }
  | { ok: false; reason: string } {
  if (caseObj.contact?.safe_to_text !== true) {
    return {
      ok: false,
      reason: "contact.safe_to_text is not true — SMS suppressed (DV/safety)",
    };
  }
  const consent = findValidSmsConsent(caseObj, nowIso);
  if (!consent) {
    return { ok: false, reason: "no valid sms_reminders consent" };
  }
  return { ok: true, consent_id: consent.consent_id };
}

/**
 * Build the reminder schedule for an authoritative anchor (§4.5).
 * DETERMINISTIC. Returns reminders in state "scheduled".
 *
 * Behavior:
 *  - If `offsets`/`unit`/`send_local_time` are unpopulated -> no reminders
 *    (returns empty with a reason). We never fabricate a send time.
 *  - Each reminder requires a `consent_id` (the schema makes it required). If
 *    there is no valid consent, NO reminders are created (the safest of the two
 *    spec options) and a reason is recorded. The send-time gate in
 *    {@link sendReminder} is a second, independent backstop.
 *  - court_days offsets are not computed here without a calendar; if unit is
 *    "court_days" we record a reason and skip (TODO: thread a calendar in).
 *
 * @param nowIso current instant (RFC-3339 Z) for consent validity.
 */
export function scheduleReminders(
  caseObj: Case,
  anchor: ReminderAnchor,
  nowIso: string,
  cfg: ReminderOffsetConfig = UNVALIDATED_REMINDER_CONFIG,
  newReminderId: ReminderIdFactory = defaultReminderId,
): ReminderScheduleResult {
  const reasons: string[] = [];

  if (cfg.offsets.length === 0 || cfg.unit == null || cfg.send_local_time == null) {
    return {
      reminders: [],
      reasons: ["reminder offset config is unpopulated (ATTORNEY/OPS MUST VALIDATE)"],
    };
  }
  if (cfg.unit === "court_days") {
    return {
      reminders: [],
      reasons: ["court_days reminder offsets require a court-holiday calendar; skipped (TODO)"],
    };
  }

  const anchorDate = parseCalendarDate(anchor.date);
  if (anchorDate == null) {
    return { reminders: [], reasons: ["anchor date is not a real calendar date"] };
  }

  const time = parseLocalTime(cfg.send_local_time);
  if (time == null) {
    return { reminders: [], reasons: ["send_local_time is malformed (expected HH:MM)"] };
  }

  // Gate 1+2: a reminder requires a consent_id (schema-required). No valid
  // consent => create nothing.
  const gates = checkSendGates(caseObj, nowIso);
  if (!gates.ok) {
    return { reminders: [], reasons: [gates.reason] };
  }

  const [hh, mm] = time;
  const reminders: Reminder[] = [];
  for (const offset of cfg.offsets) {
    const sendDay = addCalendarDays(anchorDate, -offset);
    const scheduled_for = nyWallClockToUtcZ(sendDay, hh, mm);
    reminders.push({
      reminder_id: newReminderId(),
      channel: "sms",
      consent_id: gates.consent_id,
      reminder_type: anchor.reminder_type,
      related_deadline_id:
        anchor.kind === "answer_deadline" ? anchor.related_deadline_id : null,
      scheduled_for,
      state: "scheduled",
      sent_at: null,
    });
  }

  reasons.push(
    `scheduled ${reminders.length} reminder(s) via ${cfg.rule_version} for ${anchor.kind}`,
  );
  return { reminders, reasons };
}

/**
 * Convenience: schedule reminders off an attorney-validated, tenant-confirmed
 * answer deadline. Refuses to schedule off a provisional/unconfirmed deadline
 * (backstop #1 — we never remind off a date a lawyer hasn't validated).
 */
export function scheduleAnswerDeadlineReminders(
  caseObj: Case,
  deadline: Deadline,
  nowIso: string,
  cfg: ReminderOffsetConfig = UNVALIDATED_REMINDER_CONFIG,
  newReminderId: ReminderIdFactory = defaultReminderId,
): ReminderScheduleResult {
  if (deadline.attorney_validated !== true) {
    return {
      reminders: [],
      reasons: ["deadline is not attorney-validated; not scheduling reminders"],
    };
  }
  return scheduleReminders(
    caseObj,
    {
      kind: "answer_deadline",
      date: deadline.due_date,
      reminder_type: "answer_deadline",
      related_deadline_id: deadline.deadline_id,
    },
    nowIso,
    cfg,
    newReminderId,
  );
}

// ===========================================================================
// COURT-DATE REMINDERS (the appearance-driver) — 7/3/1 days before.
// ===========================================================================

/**
 * The ACTIVE court-date reminder cadence for this feature: 7, 3, and 1 calendar
 * days before the appearance, at 09:00 America/New_York. This is the concrete,
 * version-stamped config the SMS-reminders feature ships with (the generic
 * deadline engine still defers to attorney/ops-owned config via
 * {@link UNVALIDATED_REMINDER_CONFIG}; this constant is scoped to court-date
 * reminders, which a tenant explicitly opts into).
 */
export const COURT_DATE_REMINDER_CONFIG: ReminderOffsetConfig = {
  offsets: [...INTENDED_REMINDER_OFFSETS_DAYS], // [7, 3, 1]
  unit: "calendar_days",
  send_local_time: "09:00",
  rule_version: "court_date_reminders-v1",
};

/**
 * Schedule court-date reminders off the case's CONFIRMED, VERIFIED court date.
 *
 * Backstop #1: we ONLY anchor off an AUTHORITATIVE court date
 * ({@link isCourtDateAuthoritative} — verified via eTrack/NYSCEF). A
 * tenant-entered or document-extracted (unverified) date is REFUSED here so we
 * never text a tenant a wrong appearance date. (A wrong-date send is a
 * substantive liability vector — API-CONTRACTS §3.13.)
 *
 * Consent + safe_to_text gates are enforced by {@link scheduleReminders}.
 */
export function scheduleCourtDateReminders(
  caseObj: Case,
  nowIso: string,
  cfg: ReminderOffsetConfig = COURT_DATE_REMINDER_CONFIG,
  newReminderId: ReminderIdFactory = defaultReminderId,
): ReminderScheduleResult {
  if (!isCourtDateAuthoritative(caseObj.court)) {
    return {
      reminders: [],
      reasons: [
        "court date is not authoritative (must be verified via eTrack/NYSCEF); " +
          "not scheduling court-date reminders off an unverified/tenant-entered date",
      ],
    };
  }
  // isCourtDateAuthoritative guarantees a present, valid court_date string.
  const courtDate = caseObj.court!.court_date as string;
  return scheduleReminders(
    caseObj,
    { kind: "court_date", date: courtDate, reminder_type: "court_date" },
    nowIso,
    cfg,
    newReminderId,
  );
}

// ===========================================================================
// SEND — STUB ONLY for the single-reminder helper below; the batch
// sendDueReminders() routes through the env-gated Twilio sender (dry-run when
// creds are absent).
// ===========================================================================

/** Outcome of a (stubbed) send attempt. */
export type SendReminderResult =
  | { sent: false; suppressed: true; reason: string }
  | { sent: false; suppressed: false; reason: string }
  | { sent: true; provider_message_id: string };

/**
 * Send a reminder. STUB — DOES NOT SEND.
 *
 * Re-checks the hard gates at send time (consent may have been revoked, or
 * safe_to_text flipped, since scheduling). If a gate fails the reminder is
 * SUPPRESSED, not sent.
 *
 * ============================================================================
 * TODO(integration): Twilio A2P 10DLC SMS
 * ============================================================================
 * - Use the Twilio Node SDK with credentials from env (TWILIO_ACCOUNT_SID,
 *   TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID — reserved in .env.example).
 *   NEVER hardcode credentials.
 * - SMS reminders are A2P traffic and REQUIRE A2P 10DLC brand + campaign
 *   registration before any live send (carrier compliance). Do not send until
 *   the campaign is approved.
 * - Runtime consent re-check (done below): the scheduled `consent_id` must STILL
 *   be granted, unrevoked, unexpired, AND `contact.safe_to_text === true`.
 *   Honor STOP/opt-out: a HELP/STOP inbound must revoke the consent.
 * - Include the required opt-out language ("Reply STOP to unsubscribe") and the
 *   "guide, not a lawyer" framing where appropriate. Keep PII minimal — never
 *   put case specifics that exceed the consent's data_categories in the body.
 * - On send, flip reminder.state -> "sent" and set sent_at; on failure ->
 *   "failed". Record an audit event. This stub returns without contacting any
 *   network.
 * ============================================================================
 */
export async function sendReminder(
  caseObj: Case,
  reminder: Reminder,
  nowIso: string,
): Promise<SendReminderResult> {
  // Second backstop: re-check gates at send time.
  const gates = checkSendGates(caseObj, nowIso);
  if (!gates.ok) {
    return { sent: false, suppressed: true, reason: gates.reason };
  }
  if (gates.consent_id !== reminder.consent_id) {
    return {
      sent: false,
      suppressed: true,
      reason: "consent on file no longer matches the reminder's consent_id",
    };
  }
  if (reminder.state !== "scheduled") {
    return {
      sent: false,
      suppressed: false,
      reason: `reminder is in state "${reminder.state}", not "scheduled"`,
    };
  }

  // STUB: no real SMS. Real Twilio A2P send wired in per the TODO above.
  return {
    sent: false,
    suppressed: false,
    reason: "sendReminder is a stub — Twilio A2P integration not yet wired (no SMS sent)",
  };
}

// ===========================================================================
// BATCH SEND — sendDueReminders(): dispatch due reminders via Twilio.
// ===========================================================================

/** A short, opt-out-bearing SMS body for a court-date reminder. */
function courtDateReminderBody(caseObj: Case): string {
  const date = caseObj.court?.court_date ?? "your scheduled date";
  // Keep PII minimal; no case specifics beyond the date. Include framing +
  // opt-out language (carrier + TCPA requirement).
  return (
    `Reminder: your NYC housing court date is ${date}. ` +
    `Bring your papers and any evidence. ${PERSISTENT_BANNER_SHORT} ` +
    `Reply STOP to unsubscribe.`
  );
}

/** Outcome for one reminder in a {@link sendDueReminders} batch. */
export interface SendDueReminderOutcome {
  reminder_id: string;
  /** New state to persist for this reminder. */
  state: Reminder["state"];
  sent_at: string | null;
  result:
    | { kind: "sent"; provider_message_id: string }
    | { kind: "dry_run"; reason: string }
    | { kind: "skipped"; reason: string }
    | { kind: "suppressed"; reason: string }
    | { kind: "failed"; reason: string };
}

/** Aggregate result of a batch send. */
export interface SendDueRemindersResult {
  /** The reminders array with states/sent_at updated (ready to PATCH back). */
  reminders: Reminder[];
  outcomes: SendDueReminderOutcome[];
  /** True if at least one send was a dry-run (no Twilio creds). */
  dry_run: boolean;
}

/**
 * Send all reminders that are due as of `nowIso`. A reminder is due when it is
 * in state "scheduled" and `scheduled_for <= now`.
 *
 * For each due reminder we RE-CHECK the hard gates (consent + safe_to_text) and
 * then dispatch through the env-gated {@link sendSms}. With no Twilio creds the
 * send is a dry-run (logged, not sent) and the reminder STAYS "scheduled" so a
 * later run with creds can deliver it. On a real send it flips to "sent"; on a
 * provider error it flips to "failed"; on a failed gate it is "cancelled"
 * (suppressed — e.g. consent revoked since scheduling).
 *
 * Pure w.r.t. the Case: returns a NEW reminders array; the caller persists it.
 * Requires `contact.phone_e164` to actually send.
 */
export async function sendDueReminders(
  caseObj: Case,
  nowIso: string,
): Promise<SendDueRemindersResult> {
  const now = Date.parse(nowIso);
  const phone = caseObj.contact?.phone_e164 ?? null;

  const reminders: Reminder[] = [];
  const outcomes: SendDueReminderOutcome[] = [];
  let anyDryRun = false;

  for (const r of caseObj.reminders) {
    // Not due / not sendable-by-this-path: carry through untouched.
    if (
      r.state !== "scheduled" ||
      r.channel !== "sms" ||
      Date.parse(r.scheduled_for) > now
    ) {
      reminders.push(r);
      continue;
    }

    // Re-check hard gates at send time (consent may have been revoked, etc.).
    const gates = checkSendGates(caseObj, nowIso);
    if (!gates.ok || gates.consent_id !== r.consent_id) {
      const reason = gates.ok
        ? "consent on file no longer matches this reminder's consent_id"
        : gates.reason;
      reminders.push({ ...r, state: "cancelled" });
      outcomes.push({
        reminder_id: r.reminder_id,
        state: "cancelled",
        sent_at: null,
        result: { kind: "suppressed", reason },
      });
      continue;
    }

    if (!phone) {
      // No number to send to — leave scheduled, record a skip.
      reminders.push(r);
      outcomes.push({
        reminder_id: r.reminder_id,
        state: "scheduled",
        sent_at: null,
        result: { kind: "skipped", reason: "no contact.phone_e164 on file" },
      });
      continue;
    }

    const body = courtDateReminderBody(caseObj);
    const sent = await sendSms({ to: phone, body, consent: true });

    if (sent.status === "sent") {
      reminders.push({ ...r, state: "sent", sent_at: nowIso });
      outcomes.push({
        reminder_id: r.reminder_id,
        state: "sent",
        sent_at: nowIso,
        result: { kind: "sent", provider_message_id: sent.provider_message_id },
      });
    } else if (sent.status === "dry_run") {
      anyDryRun = true;
      reminders.push(r); // stay scheduled — no creds, nothing was sent
      outcomes.push({
        reminder_id: r.reminder_id,
        state: "scheduled",
        sent_at: null,
        result: { kind: "dry_run", reason: sent.reason },
      });
    } else if (sent.status === "suppressed") {
      reminders.push({ ...r, state: "cancelled" });
      outcomes.push({
        reminder_id: r.reminder_id,
        state: "cancelled",
        sent_at: null,
        result: { kind: "suppressed", reason: sent.reason },
      });
    } else {
      reminders.push({ ...r, state: "failed" });
      outcomes.push({
        reminder_id: r.reminder_id,
        state: "failed",
        sent_at: null,
        result: { kind: "failed", reason: sent.reason },
      });
    }
  }

  return { reminders, outcomes, dry_run: anyDryRun };
}

// ===========================================================================
// Internal id helper (caller normally injects a real ULID factory).
// ===========================================================================

/**
 * Fallback rem_<26-char> id generator. The real system injects a shared ULID
 * factory; this exists so the pure functions are runnable in isolation/tests.
 */
function defaultReminderId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32 (lowercased)
  let s = "";
  for (let i = 0; i < 26; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `rem_${s}`;
}
