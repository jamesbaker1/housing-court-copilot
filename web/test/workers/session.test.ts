/**
 * Boundary auth against a LIVE Miniflare D1 (@cloudflare/vitest-pool-workers).
 *
 * This is the only project that can exercise lib/auth/session.ts against a real
 * `env.DB`: the module reads D1 through getCloudflareContext().env.DB, which we
 * point at the pool's `env`. node:crypto (the only node builtin session.ts
 * needs) is provided by workerd's nodejs_compat, so this file runs in the pool.
 *
 * It deliberately does NOT import lib/store or the route (those statically pull
 * in node:fs/promises, which the sandboxed workerd runtime cannot resolve — see
 * test/workers/route.test.ts and the report). The auth contract is fully
 * exercisable at the session layer:
 *   - capability-token round-trip; only the SHA-256 hash is persisted.
 *   - IDOR: a token minted for case A must NOT authorize case B.
 *   - no-existence-oracle (authz half): authorize() returns the SAME { ok:false }
 *     for an unknown token, a wrong-case token, and an empty context — it never
 *     reveals whether a case exists.
 *   - revocation: revokeCaseTokens kills every token for a case.
 *   - owner-session: a session whose phone owns the case (case_owners) is
 *     authorized; a non-owning phone is not; an expired/revoked session is not.
 *   - constant-time hash compare tolerates malformed hex without throwing.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Point the OpenNext Cloudflare context shim at the POOL's bindings so the
// session library's getDB() resolves the live Miniflare D1.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({ env }),
}));

import {
  authorizeCaseAccess,
  issueCaseToken,
  issueOwnerSession,
  readAccessContext,
  revokeCaseTokens,
  revokeCaseOwnerBindings,
  _hashTokenForTest,
} from "@/lib/auth/session";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

const DB = env.DB;

// Two distinct, regex-valid synthetic case ids (^case_[0-9a-hjkmnp-tv-z]{26}$).
const CASE_A = "case_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CASE_B = "case_bbbbbbbbbbbbbbbbbbbbbbbbbb";

function bearer(token: string): Request {
  return new Request("https://x/api/cases/x", {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(async () => {
  for (const t of ["case_tokens", "owner_sessions", "case_owners"]) {
    await DB.prepare(`DELETE FROM ${t}`).run();
  }
});

describe("capability token round-trip + hashing", () => {
  it("issues a token, authorizes the bound case, persists ONLY the hash", async () => {
    const token = await issueCaseToken(CASE_A);
    expect(token).toBeTypeOf("string");
    expect(token!.length).toBeGreaterThan(20);

    expect(
      await authorizeCaseAccess(CASE_A, readAccessContext(bearer(token!))),
    ).toEqual({ ok: true, via: "case_token" });

    const row = await DB.prepare(
      "SELECT token_hash, case_id, revoked FROM case_tokens WHERE case_id = ?1",
    )
      .bind(CASE_A)
      .first<{ token_hash: string; case_id: string; revoked: number }>();
    expect(row).not.toBeNull();
    expect(row!.token_hash).toBe(_hashTokenForTest(token!));
    expect(row!.token_hash).not.toBe(token!); // the plaintext is never stored
    expect(row!.revoked).toBe(0);
  });

  it("authorizes via the x-case-token header too", async () => {
    const token = await issueCaseToken(CASE_A);
    const req = new Request("https://x", { headers: { "x-case-token": token! } });
    expect(
      await authorizeCaseAccess(CASE_A, readAccessContext(req)),
    ).toEqual({ ok: true, via: "case_token" });
  });

  it("rejects an invalid case_id shape before touching D1", async () => {
    expect(await issueCaseToken("not-a-case-id")).toBeNull();
    expect(
      await authorizeCaseAccess("not-a-case-id", readAccessContext(bearer("x"))),
    ).toEqual({ ok: false });
  });
});

describe("no-existence-oracle (authz half) — uniform { ok:false }", () => {
  it("unknown token, wrong-case token, and empty ctx all deny identically", async () => {
    const token = await issueCaseToken(CASE_A);

    const unknown = await authorizeCaseAccess(
      CASE_A,
      readAccessContext(bearer("totally-bogus-token")),
    );
    const wrongCase = await authorizeCaseAccess(
      CASE_B,
      readAccessContext(bearer(token!)),
    );
    const empty = await authorizeCaseAccess(
      CASE_A,
      readAccessContext(new Request("https://x")),
    );

    expect(unknown).toEqual({ ok: false });
    expect(wrongCase).toEqual({ ok: false });
    expect(empty).toEqual({ ok: false });
  });

  it("a malformed bearer (non-hex token) fails closed, no throw", async () => {
    // hashesEqual must tolerate a non-hex digest path without crashing.
    const r = await authorizeCaseAccess(
      CASE_A,
      readAccessContext(bearer("zzz nothex %%%")),
    );
    expect(r).toEqual({ ok: false });
  });
});

describe("IDOR — a token is bound to exactly one case", () => {
  it("token minted for A authorizes A but not B", async () => {
    const tokenA = await issueCaseToken(CASE_A);
    expect(
      await authorizeCaseAccess(CASE_A, readAccessContext(bearer(tokenA!))),
    ).toEqual({ ok: true, via: "case_token" });
    expect(
      await authorizeCaseAccess(CASE_B, readAccessContext(bearer(tokenA!))),
    ).toEqual({ ok: false });
  });
});

describe("revocation", () => {
  it("revokeCaseTokens kills the token (and is idempotent on a bad id)", async () => {
    const token = await issueCaseToken(CASE_A);
    await revokeCaseTokens(CASE_A);

    const row = await DB.prepare(
      "SELECT revoked FROM case_tokens WHERE case_id = ?1",
    )
      .bind(CASE_A)
      .first<{ revoked: number }>();
    expect(row!.revoked).toBe(1);
    expect(
      await authorizeCaseAccess(CASE_A, readAccessContext(bearer(token!))),
    ).toEqual({ ok: false });

    await expect(revokeCaseTokens("not-a-case-id")).resolves.toBeUndefined();
  });
});

describe("owner-session path (case_owners)", () => {
  const PHONE = "+15551234567";

  function ownerReq(token: string): Request {
    return new Request("https://x", { headers: { "x-owner-session": token } });
  }

  it("a session whose phone owns the case authorizes; a non-owner does not", async () => {
    const issued = await issueOwnerSession(PHONE);
    expect(issued).not.toBeNull();

    // No ownership link yet -> denied.
    expect(
      (await authorizeCaseAccess(CASE_A, readAccessContext(ownerReq(issued!.token))))
        .ok,
    ).toBe(false);

    await DB.prepare(
      "INSERT INTO case_owners (case_id, phone_e164, linked_at) VALUES (?1, ?2, ?3)",
    )
      .bind(CASE_A, PHONE, new Date().toISOString())
      .run();

    expect(
      await authorizeCaseAccess(CASE_A, readAccessContext(ownerReq(issued!.token))),
    ).toEqual({ ok: true, via: "owner_session" });

    // The same session does NOT authorize a different case the phone doesn't own.
    expect(
      (await authorizeCaseAccess(CASE_B, readAccessContext(ownerReq(issued!.token))))
        .ok,
    ).toBe(false);
  });

  it("a revoked session does not authorize even when the phone owns the case", async () => {
    const issued = await issueOwnerSession(PHONE);
    await DB.prepare(
      "INSERT INTO case_owners (case_id, phone_e164, linked_at) VALUES (?1, ?2, ?3)",
    )
      .bind(CASE_A, PHONE, new Date().toISOString())
      .run();
    await DB.prepare(
      "UPDATE owner_sessions SET revoked = 1 WHERE token_hash = ?1",
    )
      .bind(_hashTokenForTest(issued!.token))
      .run();

    expect(
      (await authorizeCaseAccess(CASE_A, readAccessContext(ownerReq(issued!.token))))
        .ok,
    ).toBe(false);
  });

  it("an expired session does not authorize", async () => {
    const issued = await issueOwnerSession(PHONE);
    await DB.prepare(
      "INSERT INTO case_owners (case_id, phone_e164, linked_at) VALUES (?1, ?2, ?3)",
    )
      .bind(CASE_A, PHONE, new Date().toISOString())
      .run();
    await DB.prepare(
      "UPDATE owner_sessions SET expires_at = ?1 WHERE token_hash = ?2",
    )
      .bind("2000-01-01T00:00:00Z", _hashTokenForTest(issued!.token))
      .run();

    expect(
      (await authorizeCaseAccess(CASE_A, readAccessContext(ownerReq(issued!.token))))
        .ok,
    ).toBe(false);
  });
});

describe("revokeCaseOwnerBindings — delete cascade (REVIEW fix #1)", () => {
  const PHONE = "+15551234567";

  function ownerReq(token: string): Request {
    return new Request("https://x", { headers: { "x-owner-session": token } });
  }

  it("a previously-authorized owner session no longer authorizes after delete", async () => {
    const issued = await issueOwnerSession(PHONE);
    await DB.prepare(
      "INSERT INTO case_owners (case_id, phone_e164, linked_at) VALUES (?1, ?2, ?3)",
    )
      .bind(CASE_A, PHONE, new Date().toISOString())
      .run();

    // Sanity: the session authorizes the case before delete.
    expect(
      await authorizeCaseAccess(CASE_A, readAccessContext(ownerReq(issued!.token))),
    ).toEqual({ ok: true, via: "owner_session" });

    await revokeCaseOwnerBindings(CASE_A);

    // The per-case link is gone...
    const link = await DB.prepare(
      "SELECT 1 AS ok FROM case_owners WHERE case_id = ?1 AND phone_e164 = ?2",
    )
      .bind(CASE_A, PHONE)
      .first<{ ok: number }>();
    expect(link).toBeNull();

    // ...and the owner session (whose only authorization was this case) is revoked.
    const sess = await DB.prepare(
      "SELECT revoked FROM owner_sessions WHERE token_hash = ?1",
    )
      .bind(_hashTokenForTest(issued!.token))
      .first<{ revoked: number }>();
    expect(sess!.revoked).toBe(1);

    // The previously-authorized session can no longer resurrect access.
    expect(
      (await authorizeCaseAccess(CASE_A, readAccessContext(ownerReq(issued!.token))))
        .ok,
    ).toBe(false);
  });

  it("a re-created/re-used case_id is NOT silently re-authorized by a stale link", async () => {
    const issued = await issueOwnerSession(PHONE);
    await DB.prepare(
      "INSERT INTO case_owners (case_id, phone_e164, linked_at) VALUES (?1, ?2, ?3)",
    )
      .bind(CASE_A, PHONE, new Date().toISOString())
      .run();

    await revokeCaseOwnerBindings(CASE_A);

    // Even if the case_id is reused later, there is no leftover owner link, so
    // the stale session does not re-authorize the new case under that id.
    expect(
      (await authorizeCaseAccess(CASE_A, readAccessContext(ownerReq(issued!.token))))
        .ok,
    ).toBe(false);
  });

  it("keeps the session of a phone that still owns ANOTHER case", async () => {
    const issued = await issueOwnerSession(PHONE);
    const now = new Date().toISOString();
    await DB.prepare(
      "INSERT INTO case_owners (case_id, phone_e164, linked_at) VALUES (?1, ?2, ?3)",
    )
      .bind(CASE_A, PHONE, now)
      .run();
    await DB.prepare(
      "INSERT INTO case_owners (case_id, phone_e164, linked_at) VALUES (?1, ?2, ?3)",
    )
      .bind(CASE_B, PHONE, now)
      .run();

    await revokeCaseOwnerBindings(CASE_A);

    // The deleted case's link is gone; CASE_B's link survives.
    expect(
      await DB.prepare(
        "SELECT 1 AS ok FROM case_owners WHERE case_id = ?1 AND phone_e164 = ?2",
      )
        .bind(CASE_A, PHONE)
        .first<{ ok: number }>(),
    ).toBeNull();

    // The session is NOT revoked (the phone still owns CASE_B) and still
    // authorizes that other case.
    const sess = await DB.prepare(
      "SELECT revoked FROM owner_sessions WHERE token_hash = ?1",
    )
      .bind(_hashTokenForTest(issued!.token))
      .first<{ revoked: number }>();
    expect(sess!.revoked).toBe(0);
    expect(
      await authorizeCaseAccess(CASE_B, readAccessContext(ownerReq(issued!.token))),
    ).toEqual({ ok: true, via: "owner_session" });
  });

  it("is idempotent / safe on a bad id and when there are no links", async () => {
    await expect(revokeCaseOwnerBindings("not-a-case-id")).resolves.toBeUndefined();
    await expect(revokeCaseOwnerBindings(CASE_A)).resolves.toBeUndefined();
  });
});
