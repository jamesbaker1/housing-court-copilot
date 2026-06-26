/**
 * Store round-trip — lib/store.ts (file backend) THROUGH PII encryption (M8).
 *
 * The D1 round-trip itself (the workerd path) is exercised by the workers
 * project; here we cover the SAME save->read->parse contract on the file
 * fallback, with CASE_PII_KEY set so the seal/open transform actually runs. The
 * load-bearing assertion: a Case written with PII (contact, parties,
 * claimed_arrears, sensitive) reads back BYTE-IDENTICAL after sealing+opening,
 * the at-rest bytes are NOT plaintext (the PII subtree is sealed), and the
 * non-PII structure stays queryable. createCase/getCase/patchCase/deleteCase
 * and listCases all go through the same seal/open hook.
 */
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A valid base64 32-byte AES-256 key (deterministic; test-only, not a secret).
const TEST_KEY_B64 = Buffer.alloc(32, 7).toString("base64");

let dataDir: string;
let store: typeof import("@/lib/store");
let caseLib: typeof import("@/lib/case");

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "hcc-store-"));
  process.env.HCC_DATA_DIR = dataDir;
  process.env.CASE_PII_KEY = TEST_KEY_B64;
  // No D1 binding in node => store uses the file backend (getDB() returns null).
  store = await import("@/lib/store");
  caseLib = await import("@/lib/case");
  // The first import transforms lib/store's whole graph; on a cold/loaded box
  // that can exceed the default 10s hook budget, so give it generous headroom.
}, 60_000);

afterAll(() => {
  delete process.env.HCC_DATA_DIR;
  delete process.env.CASE_PII_KEY;
});

function richCase(): import("@/lib/case").Case {
  const base = caseLib.CaseSchema.parse({
    case_id: "case_00000000000000000000000001",
    schema_version: "1.0.0",
    tenant_id: "ten_00000000000000000000000001",
    case_type: "nonpayment",
    case_type_confirmed: true,
    status: "intake",
    language: "es",
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    contact: {
      full_name: "Ada Tenant",
      phone_e164: "+15551234567",
      email: "ada@example.com",
      safe_to_text: true,
    },
    parties: {
      landlord: { name: "Landlord LLC", is_petitioner: true },
      tenant: { name: "Ada Tenant", is_respondent: true },
    },
    claimed_arrears: { amount_cents: 360000, currency: "USD" },
    court: {
      court_date: "2026-08-01",
      court_date_source: "etrack",
      court_date_verified: true,
    },
    audit: { created_by: { actor_type: "system" }, events: [] },
  });
  return base;
}

describe("store file-backend round-trip through encryption", () => {
  it("saveCase -> getCase is byte-identical (lossless through seal/open)", async () => {
    const c = richCase();
    await store.saveCase(c);
    const got = await store.getCase(c.case_id);
    expect(got).not.toBeNull();
    expect(got).toEqual(c); // PII subtree decrypts back to the exact same objects
  });

  it("PII is sealed at rest — plaintext PII is NOT present in the stored bytes", async () => {
    const c = richCase();
    await store.saveCase(c);
    const file = path.join(dataDir, `${c.case_id}.json`);
    const onDisk = readFileSync(file, "utf8");

    // The sealed PII fields must be encrypted envelopes, not plaintext.
    expect(onDisk).not.toContain("Ada Tenant");
    expect(onDisk).not.toContain("+15551234567");
    expect(onDisk).not.toContain("ada@example.com");
    expect(onDisk).not.toContain("Landlord LLC");
    expect(onDisk).not.toContain("360000");
    // The envelope marker IS present (fields were sealed).
    expect(onDisk).toContain('{\\"v\\":1,\\"alg\\":\\"A256GCM\\"');

    // Non-PII structure stays plaintext so derived columns/retention work.
    expect(onDisk).toContain("nonpayment");
    expect(onDisk).toContain("2026-08-01"); // court_date is not PII
  });

  it("getCase returns null for an unknown id", async () => {
    expect(await store.getCase("case_0000000000000000000000zzzz")).toBeNull();
  });

  it("getCase returns null for a malformed id (no traversal / no parse)", async () => {
    expect(await store.getCase("../../etc/passwd")).toBeNull();
  });

  it("createCase mints a schema-valid skeleton that reads back", async () => {
    const created = await store.createCase({ language: "ht" });
    expect(created.case_id).toMatch(/^case_/);
    const got = await store.getCase(created.case_id);
    expect(got).toEqual(created);
    expect(got!.language).toBe("ht");
  });

  it("patchCase merges, force-keeps identity, bumps updated_at, round-trips PII", async () => {
    const created = await store.createCase();
    const updated = await store.patchCase(created.case_id, {
      status: "prepared",
      contact: { full_name: "Renamed Tenant", phone_e164: "+15559998888" },
    } as Partial<import("@/lib/case").Case>);
    expect(updated).not.toBeNull();
    expect(updated!.case_id).toBe(created.case_id); // identity force-kept
    expect(updated!.tenant_id).toBe(created.tenant_id);
    expect(updated!.status).toBe("prepared");
    expect(updated!.contact?.full_name).toBe("Renamed Tenant");

    // Reads back losslessly from disk (through encryption).
    const got = await store.getCase(created.case_id);
    expect(got).toEqual(updated);
  });

  it("patchCase on a missing id returns null", async () => {
    expect(
      await store.patchCase("case_0000000000000000000000zzzz", { status: "resolved" }),
    ).toBeNull();
  });

  it("listCases derives summary columns from the (encrypted) docs", async () => {
    const created = await store.createCase();
    const list = await store.listCases();
    const found = list.find((s) => s.case_id === created.case_id);
    expect(found).toBeDefined();
    expect(found!.case_type).toBe("nonpayment");
    // court_date column is derived from non-PII structure even though PII is sealed.
    expect(found).toHaveProperty("court_date");
  });

  it("deleteCase removes the Case (and is idempotent on a second call)", async () => {
    const created = await store.createCase();
    expect(await store.deleteCase(created.case_id)).toBe(true);
    expect(await store.getCase(created.case_id)).toBeNull();
    expect(await store.deleteCase(created.case_id)).toBe(false);
  });
});

describe("patchCase court subtree deep-merge (S16)", () => {
  it("(a) preserve-on-omit: a partial tenant court patch keeps the verified date+source", async () => {
    // richCase() persists court_date 2026-08-01, source etrack, verified true.
    const c = richCase();
    await store.saveCase(c);

    // A benign, tenant-shaped court patch that OMITS source/verified (exactly the
    // shape the API route forwards after stripSafetyOwnedFields).
    const updated = await store.patchCase(c.case_id, {
      court: { court_date: "2026-09-01" },
    } as Partial<import("@/lib/case").Case>);

    expect(updated).not.toBeNull();
    expect(updated!.court?.court_date).toBe("2026-09-01"); // the supplied field flows through
    expect(updated!.court?.court_date_source).toBe("etrack"); // preserved on omit
    expect(updated!.court?.court_date_verified).toBe(true); // NOT downgraded

    // Round-trips identically from disk (through encryption).
    const got = await store.getCase(c.case_id);
    expect(got).toEqual(updated);
    expect(got!.court?.court_date_verified).toBe(true);
  });

  it("(b)(i) client cannot flip: stripped patch leaves an unverified case unverified", async () => {
    // A fresh case has no verified court source (court_date_verified defaults false).
    const created = await store.createCase();
    expect(created.court?.court_date_verified ?? false).toBe(false);

    // Drive through the REAL API boundary: stripSafetyOwnedFields removes the
    // forged source/verified keys, so preserve-on-omit can only carry forward the
    // case's existing (false/absent) value — the client gains nothing.
    const stripped = caseLib.stripSafetyOwnedFields({
      court: {
        court_date: "2026-09-01",
        court_date_verified: true,
        court_date_source: "etrack",
      },
    });
    const updated = await store.patchCase(
      created.case_id,
      stripped as Partial<import("@/lib/case").Case>,
    );

    expect(updated).not.toBeNull();
    expect(updated!.court?.court_date).toBe("2026-09-01");
    expect(updated!.court?.court_date_verified ?? false).toBe(false); // stayed unverified
    expect(updated!.court?.court_date_source ?? null).toBeNull(); // strip removed the source
  });

  it("(b)(ii) client cannot flip: schema refine rejects a forged verified=true with a non-authoritative source", async () => {
    const created = await store.createCase();

    // Even if a forged patch bypassed stripSafetyOwnedFields, CaseSchema.parse
    // (CourtSchema.superRefine) rejects verified=true paired with tenant_entered.
    await expect(
      store.patchCase(created.case_id, {
        court: {
          court_date: "2026-09-01",
          court_date_verified: true,
          court_date_source: "tenant_entered",
        },
      } as unknown as Partial<import("@/lib/case").Case>),
    ).rejects.toThrow();
  });
});

describe("store fail-closed posture (CASE_PII_ENCRYPTION_REQUIRED without key)", () => {
  it("refuses to read PII when required but the key is absent", async () => {
    // Write a case WITH the key, then re-read with the key removed but encryption
    // marked required: openFromStore must throw, which getCase swallows to null.
    const c = richCase();
    await store.saveCase(c);

    const savedKey = process.env.CASE_PII_KEY;
    delete process.env.CASE_PII_KEY;
    process.env.CASE_PII_ENCRYPTION_REQUIRED = "true";
    try {
      const got = await store.getCase(c.case_id);
      expect(got).toBeNull(); // sealed-without-key is treated like a corrupt doc
    } finally {
      process.env.CASE_PII_KEY = savedKey;
      delete process.env.CASE_PII_ENCRYPTION_REQUIRED;
    }
  });
});
