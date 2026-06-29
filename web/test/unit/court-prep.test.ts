/**
 * Court-day prep checklist — deterministic, state-gated, UPL-safe.
 *
 * Guards: items adapt to case state; the list never advises on the MERITS (no
 * "raise this defense" / "you should argue"); the no-court-date case leads with
 * "confirm your court date first".
 */
import { describe, it, expect } from "vitest";

import {
  buildCourtPrepChecklist,
  groupPrepItems,
  PREP_CATEGORY_LABEL,
} from "@/lib/court-prep";
import { makeCase } from "./fixtures";

describe("buildCourtPrepChecklist — state gating", () => {
  it("always includes the universal bring/timing/expect/protect items", () => {
    const { items } = buildCourtPrepChecklist(makeCase());
    const cats = new Set(items.map((i) => i.category));
    expect(cats).toEqual(new Set(["bring", "timing", "expect", "protect"]));
    expect(items.find((i) => i.id === "dont_sign_blindly")).toBeDefined();
  });

  it("leads with 'confirm your court date first' when there is no confirmed date", () => {
    const { hasCourtDate, items } = buildCourtPrepChecklist(makeCase());
    expect(hasCourtDate).toBe(false);
    expect(items[0]!.id).toBe("confirm_court_date_first");
  });

  it("shows the index number when present, else a 'find it' prompt", () => {
    const withIdx = buildCourtPrepChecklist(
      makeCase({ court: { index_number: "LT-1/26", court_date_verified: false } }),
    );
    expect(withIdx.items.find((i) => i.id === "bring_index_number")?.text).toContain("LT-1/26");

    const without = buildCourtPrepChecklist(makeCase());
    expect(without.items.find((i) => i.id === "find_index_number")).toBeDefined();
  });

  it("adapts the evidence item to whether evidence is saved", () => {
    const none = buildCourtPrepChecklist(makeCase());
    expect(none.items.find((i) => i.id === "gather_evidence")).toBeDefined();

    const withEvidence = makeCase({
      evidence: [
        {
          evidence_id: "ev_aaaaaaaaaaaaaaaaaaaaaaaaaa",
          evidence_type: "rent_receipt",
          origin: "tenant_uploaded",
          tags: [],
          supports_defense_codes: [],
        },
      ],
    });
    expect(buildCourtPrepChecklist(withEvidence).items.find((i) => i.id === "bring_evidence")?.text).toContain("1 item");
  });

  it("adds the free-interpreter item when the case language is not English", () => {
    const es = buildCourtPrepChecklist(makeCase({ language: "es" }));
    expect(es.items.find((i) => i.id === "request_interpreter")).toBeDefined();
    const en = buildCourtPrepChecklist(makeCase({ language: "en" }));
    expect(en.items.find((i) => i.id === "request_interpreter")).toBeUndefined();
  });

  it("adds the payment-proof item when arrears are claimed", () => {
    const c = makeCase({ claimed_arrears: { amount_cents: 250000, currency: "USD" } });
    expect(buildCourtPrepChecklist(c).items.find((i) => i.id === "bring_payment_proof")).toBeDefined();
  });

  it("NEVER advises on the merits (no 'you should argue / raise this defense')", () => {
    const c = makeCase({ language: "es", claimed_arrears: { amount_cents: 1, currency: "USD" } });
    const blob = buildCourtPrepChecklist(c).items.map((i) => i.text.toLowerCase()).join(" ");
    expect(blob).not.toContain("you should argue");
    expect(blob).not.toContain("raise the defense");
    expect(blob).not.toContain("you will win");
    expect(blob).not.toContain("you have a strong case");
  });
});

describe("groupPrepItems", () => {
  it("buckets items by category and every category has a label", () => {
    const groups = groupPrepItems(buildCourtPrepChecklist(makeCase()).items);
    expect(groups.bring.length).toBeGreaterThan(0);
    expect(groups.protect.length).toBeGreaterThan(0);
    for (const k of Object.keys(groups)) {
      expect(PREP_CATEGORY_LABEL[k as keyof typeof PREP_CATEGORY_LABEL].length).toBeGreaterThan(0);
    }
  });
});
