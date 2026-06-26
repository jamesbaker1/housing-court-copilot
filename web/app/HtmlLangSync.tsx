"use client";

import { useEffect } from "react";
import {
  coerceLanguage,
  isRtl,
  isSupportedLanguage,
  type Language,
} from "@/lib/i18n";
import { LANGUAGE_STORAGE_KEY } from "@/lib/caseClient";

/**
 * Syncs the root `<html lang>`/`dir` attributes to the tenant-chosen language
 * (S5a — WCAG 3.1.1 "Language of Page" / 1.3.2). The server `RootLayout` emits a
 * static `lang="en"` / `dir="ltr"` (the correct default for an unknown/no-JS
 * tenant, and the value React renders so there is no hydration mismatch on the
 * `<html>` attributes). This tiny client component then corrects those two
 * presentation attributes on mount and whenever the chosen language changes, so
 * an Arabic (`ar`) tenant gets `lang="ar"` + `dir="rtl"` on the document root —
 * not just on the inner page containers, which already flip correctly.
 *
 * Source of truth is the same localStorage key the language selector writes
 * (`LANGUAGE_STORAGE_KEY`, lib/caseClient.ts); we never read/translate copy here,
 * we only mirror that choice onto the root element. `coerceLanguage(null)` maps
 * unknown/missing to the DEFAULT_LANGUAGE ("en"), preserving the en/ltr default.
 *
 * It renders nothing (`return null`). All DOM access is inside a `useEffect`, so
 * it is SSR-safe; `window.localStorage` is read defensively (it can throw in
 * locked-down/private-mode browsers), matching the try/catch pattern in
 * lib/caseClient.ts.
 *
 * Propagation of a *change* (the selector writes localStorage, then React
 * re-renders the inner containers — without a full reload) is covered without
 * touching the page components:
 *   - the native `storage` event (fires only in OTHER tabs) keeps tabs in sync;
 *   - a `MutationObserver` on the document subtree re-applies when the inner
 *     containers' own `lang`/`dir` attributes mutate (the same-tab selector
 *     change);
 *   - `visibilitychange`/`focus`/`pageshow` re-apply on route changes and on
 *     returning to the tab.
 *
 * Same-tab mutations prefer the mutated container's OWN `lang` over localStorage.
 * The manual selector writes localStorage synchronously before re-rendering, but
 * the resume path sets the language from the server Case WITHOUT touching
 * localStorage (a borrowed phone whose stored value is stale/empty). In that
 * case the container re-renders to the server language while localStorage still
 * holds the old one, so re-reading storage here would force the root back to the
 * wrong language/dir — silently breaking WCAG 3.1.1/1.3.2 for the resume the
 * tenant just performed. Trusting the element that actually mutated fixes both
 * paths (the selector's container also carries the new `lang`).
 */

/**
 * Choose the language to apply to the root `<html>` for a batch of subtree
 * attribute mutations. We prefer the newly-rendered `lang` on the mutated
 * (non-root) container — that reflects the chosen language for BOTH the manual
 * selector and the server-Case resume, whereas localStorage is correct only for
 * the selector. Falls back to `readStorage()` when no mutated element carries a
 * supported `lang` (e.g. only `dir` changed). Returns `null` if every record is
 * on the root element itself (our own writes) so the caller can skip.
 *
 * `target` is typed as `unknown` (not `Element`) so this stays a pure, DOM-free
 * function that still accepts a real `MutationRecord[]`: mutation targets can
 * also be non-element nodes, so we duck-type `getAttribute` at runtime rather
 * than rely on `instanceof Element`.
 */
export function pickLanguageFromMutations(
  records: readonly { target: unknown }[],
  root: unknown,
  readStorage: () => Language,
): Language | null {
  let sawNonRoot = false;
  for (const r of records) {
    const target = r.target;
    if (target === root) continue;
    sawNonRoot = true;
    const getAttribute =
      target != null && typeof (target as { getAttribute?: unknown }).getAttribute === "function"
        ? (target as { getAttribute: (name: string) => string | null }).getAttribute.bind(target)
        : null;
    if (getAttribute) {
      const lang = getAttribute("lang");
      if (isSupportedLanguage(lang)) return lang;
    }
  }
  return sawNonRoot ? readStorage() : null;
}

export default function HtmlLangSync() {
  useEffect(() => {
    function readLanguage(): Language {
      try {
        return coerceLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
      } catch {
        // Storage unavailable (private mode / locked down) -> en/ltr default.
        return coerceLanguage(null);
      }
    }

    function apply(lang: Language = readLanguage()) {
      const el = document.documentElement;
      const dir = isRtl(lang) ? "rtl" : "ltr";
      // Avoid redundant writes (and the MutationObserver loop they would cause).
      if (el.lang !== lang) el.lang = lang;
      if (el.dir !== dir) el.dir = dir;
    }

    const applyFromStorage = () => apply();

    apply();

    // Cross-tab: the native `storage` event fires in OTHER tabs only.
    window.addEventListener("storage", applyFromStorage);
    // Route changes / returning to the tab.
    window.addEventListener("visibilitychange", applyFromStorage);
    window.addEventListener("focus", applyFromStorage);
    window.addEventListener("pageshow", applyFromStorage);

    // Same-tab language change: the page containers set their own `lang`/`dir`
    // on re-render, so observing attribute mutations lets us re-apply to the root
    // without page edits. We prefer the mutated container's own `lang` (correct
    // for both the selector AND the server-Case resume) over localStorage, and
    // skip the root element itself to avoid reacting to our own writes.
    const observer = new MutationObserver((records) => {
      const lang = pickLanguageFromMutations(
        records,
        document.documentElement,
        readLanguage,
      );
      if (lang != null) apply(lang);
    });
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["lang", "dir"],
    });

    return () => {
      window.removeEventListener("storage", applyFromStorage);
      window.removeEventListener("visibilitychange", applyFromStorage);
      window.removeEventListener("focus", applyFromStorage);
      window.removeEventListener("pageshow", applyFromStorage);
      observer.disconnect();
    };
  }, []);

  return null;
}
