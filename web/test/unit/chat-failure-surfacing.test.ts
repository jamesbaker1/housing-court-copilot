/**
 * S11 (part 3) — the localized "assistant is busy, try again shortly" copy.
 *
 * When the copilot stream throws a transient Anthropic capacity error (HTTP 429
 * rate_limit_error / 529 overloaded_error), app/api/chat/route.ts surfaces the
 * tenant's-language `assistantBusy` string as a normal reply frame instead of
 * the generic failure — so a scared tenant doesn't read a temporary blip as
 * "this is broken." This guards the i18n half of that fix:
 *
 *   - the new key exists and is non-empty in BOTH fully-translated catalogs
 *     (en + es) — the two we ship complete (isFullyTranslated),
 *   - es is actually translated (not an accidental copy of en),
 *   - it reads as a TRANSIENT-capacity message, distinct from the generic
 *     chatError, so the two are not interchangeable, and
 *   - the other 6 priority languages alias en via the typed catalog (the
 *     documented fallback), so getStrings(lang).assistantBusy is always defined.
 */
import { describe, expect, it } from "vitest";

import {
  SUPPORTED_LANGUAGES,
  getStrings,
  isFullyTranslated,
} from "@/lib/i18n";

describe("i18n: assistantBusy (S11 overload copy)", () => {
  it("is present and non-empty in every fully-translated catalog", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      if (!isFullyTranslated(lang)) continue;
      const t = getStrings(lang);
      expect(typeof t.assistantBusy).toBe("string");
      expect(t.assistantBusy.trim().length).toBeGreaterThan(0);
    }
  });

  it("is actually translated in Spanish (not an en copy)", () => {
    expect(getStrings("es").assistantBusy).not.toBe(
      getStrings("en").assistantBusy,
    );
  });

  it("is distinct from the generic chatError in en and es", () => {
    for (const lang of ["en", "es"] as const) {
      const t = getStrings(lang);
      expect(t.assistantBusy).not.toBe(t.chatError);
    }
  });

  it("is defined for every supported language (the other 6 alias en)", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const t = getStrings(lang);
      expect(typeof t.assistantBusy).toBe("string");
      expect(t.assistantBusy.trim().length).toBeGreaterThan(0);
    }
    // The 6 non-fully-translated languages fall back to the en string verbatim.
    const enBusy = getStrings("en").assistantBusy;
    for (const lang of SUPPORTED_LANGUAGES) {
      if (isFullyTranslated(lang)) continue;
      expect(getStrings(lang).assistantBusy).toBe(enBusy);
    }
  });
});
