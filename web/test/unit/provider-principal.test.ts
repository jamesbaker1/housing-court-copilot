/**
 * Provider principal + authorization scoping (API-CONTRACTS §2.2).
 *
 * Guards the two v1-blocker fixes: per-provider consent scoping (a provider only
 * sees cases addressed to their prv, or unscoped) and the attorney-only advice
 * line (referred → represented needs intent AND the provider_attorney role in a
 * verified Access context; dev falls back to intent).
 */
import { describe, it, expect } from "vitest";

import {
  readProviderPrincipal,
  consentVisibleToPrv,
  hasVisibleHandoffConsent,
  visibleHandoffConsent,
  attorneyAdvanceAllowed,
  hasAttorneyRole,
  ATTORNEY_ROLE,
} from "@/lib/auth/provider-principal";
import { extractPrv, extractRoles } from "@/lib/auth/access";
import type { Case, Consent } from "@/lib/case";
import { makeCase } from "./fixtures";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://x/api/provider/cases/x", { headers });
}

function handoffConsent(opts: { recipientId?: string | null; granted?: boolean } = {}): Consent {
  return {
    consent_id: "cns_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    scope: "handoff_to_provider",
    recipient: { recipient_type: "legal_aid_provider", recipient_id: opts.recipientId ?? null },
    granted: opts.granted ?? true,
    granted_at: "2026-06-29T00:00:00Z",
    consent_text_version: "v1",
    data_categories: ["case_facts"],
    method: "pwa_checkbox",
  } as Consent;
}

describe("readProviderPrincipal — trusted headers only", () => {
  it("parses email/prv/roles and marks verified when the roles header is present", () => {
    const p = readProviderPrincipal(
      reqWith({ "x-access-email": "a@b.org", "x-access-prv": "prv_1", "x-access-roles": "provider_attorney,reviewer" }),
    );
    expect(p).toEqual({ email: "a@b.org", prv: "prv_1", roles: ["provider_attorney", "reviewer"], verified: true });
  });

  it("an empty roles header still marks verified (verified Access, no roles)", () => {
    const p = readProviderPrincipal(reqWith({ "x-access-roles": "" }));
    expect(p.verified).toBe(true);
    expect(p.roles).toEqual([]);
  });

  it("no roles header ⇒ unverified (dev/test/no-Access)", () => {
    const p = readProviderPrincipal(reqWith({}));
    expect(p.verified).toBe(false);
    expect(p.prv).toBeNull();
  });
});

describe("consentVisibleToPrv / hasVisibleHandoffConsent — per-provider scoping", () => {
  it("a consent addressed to a DIFFERENT prv is hidden", () => {
    expect(consentVisibleToPrv(handoffConsent({ recipientId: "prv_other" }), "prv_me")).toBe(false);
  });
  it("a matching prv is visible; an unscoped (null) consent is visible to anyone", () => {
    expect(consentVisibleToPrv(handoffConsent({ recipientId: "prv_me" }), "prv_me")).toBe(true);
    expect(consentVisibleToPrv(handoffConsent({ recipientId: null }), "prv_me")).toBe(true);
  });
  it("null prv (dev/single-tenant) ⇒ everything visible", () => {
    expect(consentVisibleToPrv(handoffConsent({ recipientId: "prv_other" }), null)).toBe(true);
  });
  it("hasVisibleHandoffConsent scopes a Case's consents to the caller's prv", () => {
    const c = makeCase({ consents: [handoffConsent({ recipientId: "prv_other" })] });
    expect(hasVisibleHandoffConsent(c, "prv_me")).toBe(false);
    expect(hasVisibleHandoffConsent(c, "prv_other")).toBe(true);
    expect(hasVisibleHandoffConsent(c, null)).toBe(true);
  });
  it("a revoked/expired consent is never visible regardless of prv", () => {
    const revoked = { ...handoffConsent({ recipientId: "prv_me" }), revoked_at: "2020-01-01T00:00:00Z" } as Consent;
    expect(hasVisibleHandoffConsent(makeCase({ consents: [revoked] }), "prv_me")).toBe(false);
  });
});

describe("visibleHandoffConsent — returns the consent for category gating", () => {
  it("returns the matching consent so callers can read data_categories", () => {
    const cn = handoffConsent({ recipientId: "prv_me" });
    const c = makeCase({ consents: [cn] });
    const got = visibleHandoffConsent(c, "prv_me");
    expect(got?.consent_id).toBe(cn.consent_id);
    // The documents-download gate reads this: case_facts is shared, documents is not.
    expect(got?.data_categories.includes("case_facts")).toBe(true);
    expect(got?.data_categories.includes("documents")).toBe(false);
  });
  it("returns null when the only consent is addressed to a different prv", () => {
    const c = makeCase({ consents: [handoffConsent({ recipientId: "prv_other" })] });
    expect(visibleHandoffConsent(c, "prv_me")).toBeNull();
  });
});

describe("attorneyAdvanceAllowed — intent AND permission", () => {
  const attorney = readProviderPrincipal(reqWith({ "x-access-roles": ATTORNEY_ROLE }));
  const nonAttorney = readProviderPrincipal(reqWith({ "x-access-roles": "reviewer" }));
  const dev = readProviderPrincipal(reqWith({}));

  it("requires intent (attorney_confirmed): no intent ⇒ never advances", () => {
    expect(attorneyAdvanceAllowed(attorney, false)).toBe(false);
  });
  it("verified attorney with intent ⇒ allowed; verified non-attorney ⇒ denied", () => {
    expect(attorneyAdvanceAllowed(attorney, true)).toBe(true);
    expect(attorneyAdvanceAllowed(nonAttorney, true)).toBe(false);
  });
  it("dev (unverified) falls back to intent alone", () => {
    expect(attorneyAdvanceAllowed(dev, true)).toBe(true);
    expect(attorneyAdvanceAllowed(dev, false)).toBe(false);
  });
  it("hasAttorneyRole reflects the role list", () => {
    expect(hasAttorneyRole(attorney)).toBe(true);
    expect(hasAttorneyRole(nonAttorney)).toBe(false);
  });
});

describe("extractPrv / extractRoles — claim parsing (default locations)", () => {
  it("reads top-level prv + roles array", () => {
    expect(extractPrv({ prv: "prv_x" } as never)).toBe("prv_x");
    expect(extractRoles({ roles: ["a", "b"] } as never)).toEqual(["a", "b"]);
  });
  it("reads nested custom.* and a comma/space role string", () => {
    expect(extractPrv({ custom: { prv: "prv_y" } } as never)).toBe("prv_y");
    expect(extractRoles({ custom: { roles: "x, y z" } } as never)).toEqual(["x", "y", "z"]);
  });
  it("absent claims ⇒ null / empty", () => {
    expect(extractPrv({} as never)).toBeNull();
    expect(extractRoles({} as never)).toEqual([]);
  });
});
