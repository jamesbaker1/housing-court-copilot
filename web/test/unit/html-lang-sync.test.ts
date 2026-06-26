/**
 * HtmlLangSync.pickLanguageFromMutations — WCAG 3.1.1/1.3.2 regression tests.
 *
 * Same-tab language changes flow through a MutationObserver on the document
 * subtree. The bug this guards: the resume path sets the language from the
 * server Case (incl. RTL `ar`) WITHOUT writing localStorage, so re-reading
 * storage on the mutation would force the root `<html>` back to a stale language/
 * dir — leaving Arabic/RTL page content under an English/LTR root. The fix
 * prefers the mutated container's OWN `lang` over localStorage; storage is only
 * the fallback (and only for changes that don't carry a supported `lang`).
 */
import { describe, it, expect } from "vitest";

import { pickLanguageFromMutations } from "@/app/HtmlLangSync";
import type { Language } from "@/lib/i18n";

/** A non-element mutation target (e.g. a text node) lacks `getAttribute`. */
const ROOT = { tag: "html" } as const;

function rec(target: unknown) {
  return { target };
}

/** A fake container element carrying a `lang` attribute. */
function el(lang: string | null) {
  return {
    getAttribute: (name: string) => (name === "lang" ? lang : null),
  };
}

describe("pickLanguageFromMutations", () => {
  const storage = (v: Language) => () => v;

  it("prefers the mutated container's own lang over stale localStorage (RTL resume)", () => {
    // Server-Case resume to Arabic; localStorage still holds the old 'en'.
    const lang = pickLanguageFromMutations([rec(el("ar"))], ROOT, storage("en"));
    expect(lang).toBe("ar");
  });

  it("prefers the container lang for the manual selector path too", () => {
    const lang = pickLanguageFromMutations([rec(el("es"))], ROOT, storage("es"));
    expect(lang).toBe("es");
  });

  it("falls back to localStorage when no mutated element carries a supported lang", () => {
    // e.g. only `dir` changed, so the element exposes no usable `lang`.
    const lang = pickLanguageFromMutations([rec(el(null))], ROOT, storage("ru"));
    expect(lang).toBe("ru");
  });

  it("ignores an unsupported lang value and falls back to localStorage", () => {
    const lang = pickLanguageFromMutations([rec(el("xx"))], ROOT, storage("ko"));
    expect(lang).toBe("ko");
  });

  it("returns null when every record targets the root itself (our own writes)", () => {
    let read = 0;
    const lang = pickLanguageFromMutations(
      [rec(ROOT)],
      ROOT,
      () => {
        read += 1;
        return "en";
      },
    );
    expect(lang).toBeNull();
    // The storage fallback must not run for a root-only batch.
    expect(read).toBe(0);
  });

  it("skips root records but still reads the first non-root supported lang", () => {
    const lang = pickLanguageFromMutations(
      [rec(ROOT), rec(el("bn"))],
      ROOT,
      storage("en"),
    );
    expect(lang).toBe("bn");
  });

  it("returns the FIRST supported container lang when several mutate at once", () => {
    const lang = pickLanguageFromMutations(
      [rec(el("ht")), rec(el("zh-Hant"))],
      ROOT,
      storage("en"),
    );
    expect(lang).toBe("ht");
  });

  it("tolerates a non-element (text-node-like) target and falls back to storage", () => {
    // Text nodes have no getAttribute; must not throw, must fall back.
    const lang = pickLanguageFromMutations([rec({})], ROOT, storage("es"));
    expect(lang).toBe("es");
  });
});
