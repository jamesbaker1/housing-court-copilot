/**
 * /api/reminders dedup contract — repeat opt-in must not double the 7/3/1 set.
 *
 * A tenant whose court date is already authoritative can POST /api/reminders
 * twice (double-tap on a slow phone, retry after a flaky response, or simply
 * re-opting in). Consent is idempotent, but scheduleCourtDateReminders always
 * mints a FRESH 7/3/1 court_date set. Before merging that set onto the case, the
 * route drops PENDING (state=scheduled) court_date reminders so the tenant does
 * not end up with two copies of each — which the batch sender would text twice
 * (tenant-trust erosion + TCPA / A2P 10DLC carrier-compliance risk).
 *
 * The route guards this with a private keepNonPendingCourtDateReminders helper
 * (App Router modules may not export non-handler symbols). This test pins the
 * exact predicate the route uses; it mirrors court-source.rearmCourtDateReminders
 * ("Replace pending court_date reminders; keep sent ones + other types").
 */
import { describe, expect, it } from "vitest";

import type { Reminder } from "@/lib/case";

/**
 * Mirror of the route's private dedup predicate. Kept in lockstep with
 * app/api/reminders/route.ts keepNonPendingCourtDateReminders. If you change one,
 * change the other.
 */
function keepNonPendingCourtDateReminders(reminders: Reminder[]): Reminder[] {
  return reminders.filter(
    (r) => !(r.reminder_type === "court_date" && r.state === "scheduled"),
  );
}

function rem(
  reminder_id: string,
  reminder_type: Reminder["reminder_type"],
  state: Reminder["state"],
): Reminder {
  return {
    reminder_id,
    channel: "sms",
    consent_id: "cns_x",
    reminder_type,
    scheduled_for: "2026-07-08T13:00:00Z",
    state,
  };
}

describe("reminders dedup: keepNonPendingCourtDateReminders", () => {
  it("drops PENDING court_date reminders (the duplicate-prone set)", () => {
    const out = keepNonPendingCourtDateReminders([
      rem("rem_1", "court_date", "scheduled"),
      rem("rem_2", "court_date", "scheduled"),
      rem("rem_3", "court_date", "scheduled"),
    ]);
    expect(out).toHaveLength(0);
  });

  it("keeps already-SENT court_date reminders (never re-sends/clears history)", () => {
    const sent = rem("rem_sent", "court_date", "sent");
    const out = keepNonPendingCourtDateReminders([
      sent,
      rem("rem_pending", "court_date", "scheduled"),
    ]);
    expect(out).toEqual([sent]);
  });

  it("keeps failed/cancelled court_date reminders (only scheduled is pending)", () => {
    const failed = rem("rem_f", "court_date", "failed");
    const cancelled = rem("rem_c", "court_date", "cancelled");
    const out = keepNonPendingCourtDateReminders([
      failed,
      rem("rem_p", "court_date", "scheduled"),
      cancelled,
    ]);
    expect(out).toEqual([failed, cancelled]);
  });

  it("keeps non-court reminders regardless of state", () => {
    const answer = rem("rem_ans", "answer_deadline", "scheduled");
    const appt = rem("rem_appt", "appointment", "scheduled");
    const out = keepNonPendingCourtDateReminders([
      answer,
      rem("rem_court", "court_date", "scheduled"),
      appt,
    ]);
    expect(out).toEqual([answer, appt]);
  });

  it("simulated repeat opt-in: filter-then-merge yields exactly one 7/3/1 set", () => {
    // First opt-in produced these three pending court_date reminders.
    const firstSet: Reminder[] = [
      rem("rem_a7", "court_date", "scheduled"),
      rem("rem_a3", "court_date", "scheduled"),
      rem("rem_a1", "court_date", "scheduled"),
    ];
    // Second opt-in mints a fresh set (new ids) — the route appends after filter.
    const freshSet: Reminder[] = [
      rem("rem_b7", "court_date", "scheduled"),
      rem("rem_b3", "court_date", "scheduled"),
      rem("rem_b1", "court_date", "scheduled"),
    ];
    const merged = [
      ...keepNonPendingCourtDateReminders(firstSet),
      ...freshSet,
    ];
    expect(merged).toHaveLength(3);
    expect(merged.map((r) => r.reminder_id)).toEqual([
      "rem_b7",
      "rem_b3",
      "rem_b1",
    ]);
  });

  it("returns a new array (does not mutate input)", () => {
    const input: Reminder[] = [rem("rem_1", "court_date", "scheduled")];
    const out = keepNonPendingCourtDateReminders(input);
    expect(out).not.toBe(input);
    expect(input).toHaveLength(1);
  });
});
