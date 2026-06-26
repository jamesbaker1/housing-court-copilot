/**
 * scheduleReminders must NOT create already-past ('immediately due') reminders.
 *
 * scheduleReminders computes scheduled_for = anchorDate - offset days at the
 * configured local send time for every configured offset. When a verified court
 * date lands (or a tenant opts in) FEWER days before the appearance than an
 * offset implies — common, since eTrack/NYSCEF verification frequently arrives
 * late and the court-source rearm path fires exactly when a verified date lands
 * — that offset's send instant is in the PAST. A past-dated reminder is treated
 * as due (scheduled_for <= now) and would fire immediately on the next batch
 * run, bunching stale offsets into one confusing burst for a date that is
 * already imminent.
 *
 * The fix skips any offset whose computed instant is already past (recording a
 * reason). This pins that behavior with the live 7/3/1 court-date config.
 */
import { describe, expect, it } from "vitest";

import {
  COURT_DATE_REMINDER_CONFIG,
  scheduleReminders,
  type ReminderAnchor,
} from "@/lib/reminders";
import type { Case } from "@/lib/case";

import { makeCase, testId } from "./fixtures";

/** A case that passes both send gates (safe_to_text + valid sms consent). */
function sendableCase(nowIso: string): Case {
  return makeCase({
    contact: { safe_to_text: true, phone_e164: "+15555550123" },
    consents: [
      {
        consent_id: testId("cns"),
        scope: "sms_reminders",
        recipient: { recipient_type: "reminder_service" },
        granted: true,
        granted_at: nowIso,
        consent_text_version: "v1",
        data_categories: ["contact"],
        method: "pwa_checkbox",
      },
    ],
  });
}

function courtAnchor(date: string): ReminderAnchor {
  return { kind: "court_date", date, reminder_type: "court_date" };
}

describe("scheduleReminders: skips already-past offsets", () => {
  it("with 7+ days lead, all three 7/3/1 reminders are future-dated", () => {
    const now = "2026-06-24T00:00:00Z"; // well before the appearance
    const res = scheduleReminders(
      sendableCase(now),
      courtAnchor("2026-07-08"), // 14 days out
      now,
      COURT_DATE_REMINDER_CONFIG,
    );
    expect(res.reminders).toHaveLength(3);
    for (const r of res.reminders) {
      expect(Date.parse(r.scheduled_for)).toBeGreaterThan(Date.parse(now));
    }
  });

  it("opting in 3 days out drops the past 7-day offset, keeps future ones", () => {
    // Appearance 2026-07-08; "now" is ~3 days before at noon NY (after 09:00),
    // so the 7-day (07-01) and 3-day (07-05 09:00) offsets are past; only the
    // 1-day (07-07 09:00) reminder is still in the future.
    const now = "2026-07-05T16:00:00Z"; // 12:00 EDT on 07-05
    const res = scheduleReminders(
      sendableCase(now),
      courtAnchor("2026-07-08"),
      now,
      COURT_DATE_REMINDER_CONFIG,
    );
    expect(res.reminders).toHaveLength(1);
    expect(Date.parse(res.reminders[0]!.scheduled_for)).toBeGreaterThan(
      Date.parse(now),
    );
    // Past offsets are recorded as skip reasons (not silently dropped).
    const skips = res.reasons.filter((r) => r.startsWith("skipped"));
    expect(skips).toHaveLength(2);
  });

  it("never emits a scheduled_for at or before now (no immediate burst)", () => {
    // Verified date lands 1 day before the appearance: every 7/3/1 offset's
    // send instant is in the past, so nothing should be scheduled.
    const now = "2026-07-07T16:00:00Z"; // 12:00 EDT, day before 07-08
    const res = scheduleReminders(
      sendableCase(now),
      courtAnchor("2026-07-08"),
      now,
      COURT_DATE_REMINDER_CONFIG,
    );
    expect(res.reminders).toHaveLength(0);
    for (const r of res.reminders) {
      expect(Date.parse(r.scheduled_for)).toBeGreaterThan(Date.parse(now));
    }
  });
});
