/**
 * OTP resume — OWNERSHIP gating against a live Miniflare D1.
 *
 * Regression test for the account-takeover IDOR: requestOtp must NOT pin a case
 * to a phone (and verifyOtp must NOT create a case_owners link) unless the caller
 * PROVES ownership — a valid capability token / owner session for that case, OR
 * the phone is already a linked owner. case_id alone (a non-secret locator) is
 * not enough. Without this, anyone who learns a victim's case_id could bind it
 * to their own phone and seize read/write/delete.
 */
import { env } from "cloudflare:test";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env }),
}));

import { requestOtp, verifyOtp } from "@/lib/auth/otp";
import { issueCaseToken, readAccessContext } from "@/lib/auth/session";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

const DB = env.DB;
const CASE_A = "case_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const VICTIM_PHONE = "+15550000001";
const ATTACKER_PHONE = "+15550000002";

function bearer(token: string): Request {
  return new Request("https://x/api/auth/otp/request", {
    headers: { authorization: `Bearer ${token}` },
  });
}
function noAuth(): Request {
  return new Request("https://x/api/auth/otp/request");
}
function pinnedCaseId(phone: string): Promise<string | null> {
  return DB.prepare(`SELECT case_id FROM otp_codes WHERE phone_e164 = ?1`)
    .bind(phone)
    .first<{ case_id: string }>()
    .then((r) => r?.case_id ?? null);
}
async function linkExists(caseId: string, phone: string): Promise<boolean> {
  const r = await DB.prepare(
    `SELECT 1 AS ok FROM case_owners WHERE case_id = ?1 AND phone_e164 = ?2`,
  )
    .bind(caseId, phone)
    .first<{ ok: number }>();
  return !!r;
}

beforeEach(async () => {
  for (const t of ["case_tokens", "owner_sessions", "case_owners", "otp_codes", "tenant_phones"]) {
    await DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("requestOtp ownership gating", () => {
  it("pins the case when the caller holds a valid capability token", async () => {
    const token = await issueCaseToken(CASE_A);
    await requestOtp({
      phone_e164: ATTACKER_PHONE, // any phone — ownership comes from the token
      case_id: CASE_A,
      ctx: readAccessContext(bearer(token!)),
    });
    expect(await pinnedCaseId(ATTACKER_PHONE)).toBe(CASE_A);
  });

  it("does NOT pin the case for a caller with no ownership proof (IDOR fix)", async () => {
    await requestOtp({
      phone_e164: ATTACKER_PHONE,
      case_id: CASE_A,
      ctx: readAccessContext(noAuth()),
    });
    // A code row may exist (we still send a code), but it pins NO case.
    expect(await pinnedCaseId(ATTACKER_PHONE)).toBe("");
  });

  it("allows an already-linked phone to re-pin without a token (cross-device resume)", async () => {
    await DB.prepare(
      `INSERT INTO case_owners (case_id, phone_e164, linked_at) VALUES (?1, ?2, ?3)`,
    )
      .bind(CASE_A, VICTIM_PHONE, "2026-01-01T00:00:00Z")
      .run();
    await requestOtp({
      phone_e164: VICTIM_PHONE,
      case_id: CASE_A,
      ctx: readAccessContext(noAuth()),
    });
    expect(await pinnedCaseId(VICTIM_PHONE)).toBe(CASE_A);
  });
});

describe("verifyOtp linking", () => {
  // Insert an OTP row directly (we control the code) to exercise verify in isolation.
  async function seedCode(phone: string, code: string, caseId: string) {
    const codeHash = createHash("sha256").update(`${phone}:${code}`).digest("hex");
    await DB.prepare(
      `INSERT INTO otp_codes (phone_e164, code_hash, case_id, expires_at, attempts)
       VALUES (?1, ?2, ?3, ?4, 0)`,
    )
      .bind(phone, codeHash, caseId, "2999-01-01T00:00:00Z")
      .run();
  }

  it("links the case when a real case_id was pinned", async () => {
    await seedCode(VICTIM_PHONE, "123456", CASE_A);
    const res = await verifyOtp({ phone_e164: VICTIM_PHONE, code: "123456" });
    expect(res.ok).toBe(true);
    expect(await linkExists(CASE_A, VICTIM_PHONE)).toBe(true);
    if (res.ok) expect(res.case_ids).toContain(CASE_A);
  });

  it("links NOTHING when the pinned case_id is the empty (unauthorized) sentinel", async () => {
    await seedCode(ATTACKER_PHONE, "654321", "");
    const res = await verifyOtp({ phone_e164: ATTACKER_PHONE, code: "654321" });
    expect(res.ok).toBe(true); // phone verified…
    if (res.ok) expect(res.case_ids).toEqual([]); // …but it owns no cases
    expect(await linkExists(CASE_A, ATTACKER_PHONE)).toBe(false);
  });
});
