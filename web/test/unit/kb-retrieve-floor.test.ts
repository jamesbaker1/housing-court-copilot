/**
 * retrieve() relevance floor — guards the fix that stops a single tangential
 * keyword from grounding an authoritative-looking citation.
 *
 * The copilot surfaces retrieved hits as "VETTED SOURCES (the ONLY source you
 * may use ...)" and tells the model to cite them by name. Before the floor, any
 * hit with score > 0 was returned, so a question that merely shared one
 * tag/term with an entry could ground a confident, named citation that did not
 * actually support the claim. These tests pin the floor's behavior:
 *   - lone, barely-matching hits are dropped (empty result -> copilot says it is
 *     not sure, per buildKbGrounding's "no vetted entry matched" branch);
 *   - genuinely-relevant queries still retrieve their on-topic entries;
 *   - trailing weak matches far behind a strong top hit are trimmed.
 */
import { describe, it, expect } from "vitest";

import { retrieve } from "@/lib/kb/retrieve";

describe("retrieve() relevance floor", () => {
  it("returns no hits for an off-topic question (no near-noise citation)", () => {
    // "joke" only brushes one entry via a tangential term; it must not surface.
    expect(retrieve("Can you tell me a joke?")).toEqual([]);
  });

  it("returns no hits for gibberish with no term overlap", () => {
    expect(retrieve("asdf qwerty zxcv")).toEqual([]);
  });

  it("returns no hits for an empty / whitespace query", () => {
    expect(retrieve("")).toEqual([]);
    expect(retrieve("   ")).toEqual([]);
  });

  it("still retrieves the on-topic entry for a genuine question", () => {
    const hits = retrieve("What is a stipulation?");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.entry.id).toBe("what-is-a-stipulation");
  });

  it("retrieves multiple genuinely-relevant entries for a real query", () => {
    const hits = retrieve("How do I find free legal help?");
    const ids = hits.map((h) => h.entry.id);
    expect(ids).toContain("find-free-help");
    expect(ids.length).toBeGreaterThan(1);
  });

  it("every returned hit clears both the absolute and relative-to-top floor", () => {
    const MIN_SCORE = 0.1;
    const REL_SCORE = 0.18;
    for (const q of [
      "What is a stipulation?",
      "I have mold in my apartment",
      "How do I find free legal help?",
      "What should I bring to court?",
      "court",
    ]) {
      const hits = retrieve(q, 10);
      const top = hits[0]?.score ?? 0;
      const floor = Math.max(MIN_SCORE, top * REL_SCORE);
      for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(floor);
    }
  });

  it("trims trailing weak matches that sit far behind a strong top hit", () => {
    // A strong top hit raises the relative floor, dropping ~noise tail entries.
    const hits = retrieve("How do I find free legal help?", 10);
    const top = hits[0]?.score ?? 0;
    const min = Math.min(...hits.map((h) => h.score));
    // Nothing returned is a tiny fraction of the top (the tail is trimmed).
    expect(min).toBeGreaterThanOrEqual(top * 0.18);
  });

  it("respects k as an upper bound on cleared hits", () => {
    expect(retrieve("court", 2).length).toBeLessThanOrEqual(2);
    expect(retrieve("court", 0)).toEqual([]);
  });
});
