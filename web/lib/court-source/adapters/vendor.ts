/**
 * COURT-DATA VENDOR adapter (Adapters phase) — the legitimate path to BROAD
 * court-date coverage via a paid/partner court-data API (e.g. an OCA-data
 * aggregator that licenses the NYS UCS bulk/feed data).
 *
 * ============================================================================
 * WHY A VENDOR, NOT A SCRAPER (RISKS-AND-COMPLIANCE.md, INTEGRATIONS.md §court-data)
 * ============================================================================
 * We DO NOT scrape the live UCS eCourts / WebCivilLocal / eTrack web portals.
 * They are CAPTCHA/Cloudflare-protected and the UCS ToS prohibits bots/crawlers
 * (CFAA/contract risk). A configured court-data VENDOR is a legitimate channel:
 * the operator provisions an API key and accepts the vendor's terms. This
 * adapter is the client for that vendor's HTTP API. It is DISABLED (returns
 * `{ found: false }`) unless the operator has set the vendor URL + key.
 *
 * ============================================================================
 * AUTHORITATIVE? — AN OPS/ATTORNEY DECISION, NOT A CODE FACT
 * ============================================================================
 * Whether a given vendor's feed is trustworthy enough to flip
 * `court_date_verified = true` is an operator/attorney call, gated at runtime by
 * `lib/court-date.isVendorTreatedAsAuthoritative` (default-deny via
 * COURT_DATA_VENDOR_AUTHORITATIVE). This adapter NEVER decides verification — it
 * only reports `source: "court_data_vendor"` + a `confidence`. The orchestrator
 * (`@/lib/court-source`) routes the hit through `setCourtDate`, which alone may
 * verify, and only when the ops gate is on. So even a `confidence:"high"` vendor
 * hit stays `found_unverified` unless the operator opted in.
 *
 * ============================================================================
 * GENERIC OVER THE VENDOR
 * ============================================================================
 * There is no single canonical court-data vendor schema, so this adapter does
 * NOT hardcode one proprietary response shape. It performs the HTTP call and
 * defers the JSON->normalized mapping to {@link mapVendorResponse}, a small
 * clearly-marked function with a TODO to fit the chosen vendor. Swap that one
 * function (and the request shape in {@link buildVendorRequest}) when you
 * contract a specific vendor; the rest of the adapter (env gating, error
 * degradation, confidence handling) is vendor-agnostic.
 *
 * NEVER throws — any error (no key, network, non-2xx, bad JSON, unmappable body)
 * degrades to `{ found: false }`.
 */

import type {
  CourtDateSourceAdapter,
  CourtSourceInput,
  CourtSourceResult,
} from "@/lib/court-source";
import { validateCourtDateString } from "@/lib/court-date";

const SOURCE = "court_data_vendor" as const;

/** Network timeout for the vendor call (ms). Kept short — this is best-effort. */
const VENDOR_TIMEOUT_MS = 8_000;

/**
 * Operator-provided vendor configuration, read from env. DISABLED unless BOTH a
 * base URL and an API key are present.
 *
 * Env (set the key as a Worker SECRET, not a plaintext var):
 *   COURT_DATA_VENDOR_URL  — base URL of the vendor API (e.g. https://api.vendor.example).
 *   COURT_DATA_VENDOR_KEY  — API key/token (preferred name).
 *   COURT_DATA_VENDOR_API_KEY — accepted alias (matches wrangler.toml's secret note).
 */
export interface VendorConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Read vendor config from env. Returns null (=> adapter disabled) when the URL
 * or key is missing. Accepts both COURT_DATA_VENDOR_KEY and the
 * COURT_DATA_VENDOR_API_KEY alias documented in wrangler.toml.
 */
export function readVendorConfig(
  env?: Record<string, string | undefined>,
): VendorConfig | null {
  const e = env ?? (typeof process !== "undefined" ? process.env : undefined);
  if (!e) return null;
  const baseUrl = (e.COURT_DATA_VENDOR_URL ?? "").trim();
  const apiKey = (e.COURT_DATA_VENDOR_KEY ?? e.COURT_DATA_VENDOR_API_KEY ?? "").trim();
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, apiKey };
}

/**
 * Build the outbound request for a "next appearance by index #/county" lookup.
 *
 * TODO(vendor): fit your vendor's actual lookup contract here — the path, query
 * params, and auth header scheme are vendor-specific. The defaults below are a
 * reasonable generic shape (REST GET with a Bearer token); adjust as needed.
 */
export function buildVendorRequest(
  cfg: VendorConfig,
  input: CourtSourceInput,
): { url: string; init: RequestInit } {
  const url = new URL("/v1/cases/next-appearance", cfg.baseUrl);
  if (input.index_number) url.searchParams.set("index_number", input.index_number.trim());
  // Many OCA aggregators key on county; borough is a useful disambiguator for NYC.
  if (input.county) url.searchParams.set("county", input.county);
  if (input.borough) url.searchParams.set("borough", input.borough);

  return {
    url: url.toString(),
    init: {
      method: "GET",
      headers: {
        // TODO(vendor): some vendors use `X-Api-Key` or a query param instead.
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: "application/json",
      },
    },
  };
}

/**
 * Map a vendor JSON response to a normalized {@link CourtSourceResult}.
 *
 * TODO(vendor): THIS is the one place to adapt to your chosen vendor's response
 * schema. The generic shape assumed below is:
 *   {
 *     "found": true,
 *     "next_appearance_date": "2026-07-15" | "2026-07-15T09:30:00-04:00",
 *     "part": "Part H" | null,
 *     "index_number": "LT-012345-26/NY" | null,
 *     "confidence": "high" | "medium" | "low"   // optional; defaults to "medium"
 *   }
 * Real vendors differ wildly (nested `data`, `events[]`, ISO datetimes, MM/DD/YYYY,
 * status codes). Normalize to a bare YYYY-MM-DD calendar date (no time) and a
 * conservative confidence. Anything unmappable => `{ found: false }`.
 *
 * NEVER throws.
 */
export function mapVendorResponse(
  body: unknown,
  fallbackIndex?: string | null,
): CourtSourceResult {
  if (body == null || typeof body !== "object") {
    return { found: false, source: SOURCE, note: "vendor: non-object body" };
  }
  const b = body as Record<string, unknown>;

  // Explicit not-found from the vendor.
  if (b.found === false) {
    return { found: false, source: SOURCE, note: "vendor: no appearance found" };
  }

  // TODO(vendor): adjust the field name(s) below to the vendor's schema.
  const rawDate =
    typeof b.next_appearance_date === "string"
      ? b.next_appearance_date
      : typeof b.court_date === "string"
        ? b.court_date
        : null;
  if (!rawDate) {
    return { found: false, source: SOURCE, note: "vendor: no date field" };
  }

  // Reduce any ISO datetime to a bare calendar date (the canonical court-date
  // shape). We deliberately drop the time/zone: setCourtDate enforces YYYY-MM-DD.
  const calendarDate = rawDate.slice(0, 10);
  const valid = validateCourtDateString(calendarDate);
  if (!valid.ok) {
    return {
      found: false,
      source: SOURCE,
      note: `vendor: unparseable date (${valid.reason})`,
    };
  }

  const part =
    typeof b.part === "string" && b.part.trim() !== "" ? b.part.trim() : null;
  const index_number =
    typeof b.index_number === "string" && b.index_number.trim() !== ""
      ? b.index_number.trim()
      : (fallbackIndex?.trim() || null);

  // Confidence: trust an explicit vendor confidence if it is one of our levels,
  // else default to "medium". We do NOT default to "high": the orchestrator only
  // ACTS on "high", and absent an explicit strong signal we should not flip a
  // date that can cause a default judgment. The ops authoritative-gate is a
  // SECOND, independent guard; confidence is the adapter's own caution.
  const confidence: "high" | "medium" | "low" =
    b.confidence === "high" || b.confidence === "medium" || b.confidence === "low"
      ? b.confidence
      : "medium";

  return { found: true, date: valid.date, source: SOURCE, part, index_number, confidence };
}

/**
 * Create the court-data vendor adapter.
 *
 * `env` is injectable for tests; defaults to `process.env` (OpenNext exposes
 * Worker vars/secrets there). When no vendor URL+key is configured the adapter
 * is DISABLED and every lookup degrades to `{ found: false }`.
 */
export function createVendorAdapter(
  env?: Record<string, string | undefined>,
): CourtDateSourceAdapter {
  return {
    name: SOURCE,
    async trySource(input: CourtSourceInput): Promise<CourtSourceResult> {
      const cfg = readVendorConfig(env);
      if (!cfg) {
        return {
          found: false,
          source: SOURCE,
          note: "court-data vendor not configured (set COURT_DATA_VENDOR_URL + COURT_DATA_VENDOR_KEY)",
        };
      }

      // Need at least an index number to look up a specific case. (A vendor that
      // supports name/address search would extend buildVendorRequest; for the
      // primary join key we require index_number.)
      if (!input.index_number || !input.index_number.trim()) {
        return { found: false, source: SOURCE, note: "vendor: no index_number to look up" };
      }

      const controller =
        typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => controller.abort(), VENDOR_TIMEOUT_MS)
        : null;

      try {
        const { url, init } = buildVendorRequest(cfg, input);
        const res = await fetch(url, {
          ...init,
          signal: controller?.signal,
        });

        if (!res.ok) {
          return {
            found: false,
            source: SOURCE,
            note: `vendor: HTTP ${res.status}`,
          };
        }

        let body: unknown;
        try {
          body = await res.json();
        } catch {
          return { found: false, source: SOURCE, note: "vendor: invalid JSON" };
        }

        return mapVendorResponse(body, input.index_number);
      } catch (err) {
        // Network error, abort/timeout, etc. — degrade, never throw.
        console.error("[court-source] vendor adapter degraded:", err);
        return { found: false, source: SOURCE, note: "vendor: request failed (degraded)" };
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
