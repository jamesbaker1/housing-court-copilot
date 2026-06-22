/**
 * POST /api/reminders — opt a tenant into SMS court-date reminders.
 *
 * Body: { case_id, phone_e164, consent: true }.
 *
 * Flow (consent-gated, DET-scheduled — API-CONTRACTS §3.13, LEGAL-RULES §4.5):
 *   1. Load the Case (404 if absent).
 *   2. Require affirmative consent:true and a valid E.164 phone.
 *   3. Record an sms_reminders Consent (scope=sms_reminders, recipient
 *      reminder_service) + set contact.phone_e164 + contact.safe_to_text=true,
 *      PATCHed into the Case.
 *   4. Schedule court-date reminders (7/3/1 days before) DETERMINISTICALLY off
 *      the case's VERIFIED court date. If the court date is not yet
 *      authoritative (eTrack/NYSCEF-verified), no reminders are scheduled and a
 *      reason is returned — we never anchor reminders off an unverified date.
 *   5. PATCH the scheduled reminders onto the Case and return the schedule,
 *      plus a dry_run note when Twilio creds are absent (no SMS configured).
 *
 * NOTE: this records consent + schedules; it does not SEND. Sending is done by
 * the batch sender (lib/reminders.sendDueReminders -> lib/sms/twilio), which is
 * dry-run unless Twilio creds are present in env.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import type { Case, Consent } from "@/lib/case";
import { newId } from "@/lib/ids";
import { getCase, patchCase } from "@/lib/store";
import { isCourtDateAuthoritative } from "@/lib/court-date";
import {
  findValidSmsConsent,
  scheduleCourtDateReminders,
} from "@/lib/reminders";

export const runtime = "nodejs";

const BodySchema = z.object({
  case_id: z.string(),
  phone_e164: z.string().regex(/^\+[1-9]\d{1,14}$/, "phone must be E.164 (e.g. +12125550123)"),
  consent: z.literal(true),
});

/** Stable version tag for the consent text the tenant agreed to. */
const SMS_CONSENT_TEXT_VERSION = "sms_reminders-v1";

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function twilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM,
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { case_id, phone_e164 } = parsed.data;

  const existing = await getCase(case_id);
  if (!existing) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  const ts = nowIso();

  // 1) Record consent + contact (idempotent-ish: reuse a still-valid consent).
  let consent = findValidSmsConsent(existing, ts);
  const consents: Consent[] = [...existing.consents];
  if (!consent) {
    consent = {
      consent_id: newId("cns"),
      scope: "sms_reminders",
      recipient: { recipient_type: "reminder_service" },
      granted: true,
      granted_at: ts,
      consent_text_version: SMS_CONSENT_TEXT_VERSION,
      data_categories: ["contact"],
      method: "pwa_checkbox",
    };
    consents.push(consent);
  }

  const withConsent = await patchCase(case_id, {
    consents,
    contact: {
      ...(existing.contact ?? {}),
      phone_e164,
      // Affirmative opt-in via this endpoint also marks safe_to_text.
      safe_to_text: true,
      preferred_contact_method:
        existing.contact?.preferred_contact_method ?? "sms",
    },
  });
  if (!withConsent) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  // 2) Schedule court-date reminders DET off the VERIFIED date.
  const schedule = scheduleCourtDateReminders(withConsent, ts, undefined, () =>
    newId("rem"),
  );

  let finalCase: Case = withConsent;
  if (schedule.reminders.length > 0) {
    const merged = [...withConsent.reminders, ...schedule.reminders];
    const patched = await patchCase(case_id, { reminders: merged });
    if (patched) finalCase = patched;
  }

  const dry_run = !twilioConfigured();
  return NextResponse.json(
    {
      case_id,
      consent_id: consent.consent_id,
      court_date_verified: isCourtDateAuthoritative(finalCase.court),
      scheduled: schedule.reminders,
      scheduled_count: schedule.reminders.length,
      reasons: schedule.reasons,
      dry_run,
      dry_run_note: dry_run
        ? "Twilio is not configured (no TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM); reminders are scheduled but no SMS will be sent until creds are present."
        : null,
    },
    { status: 200 },
  );
}
