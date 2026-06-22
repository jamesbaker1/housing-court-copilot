/**
 * NYC GeoSearch — resolve a confirmed premises address to a 10-digit BBL.
 *
 * GeoSearch (geosearch.planninglabs.nyc) is the city's keyless geocoder built on
 * Pelias + the PAD/PLUTO reference data. It is the CORRECT resolver per
 * TOOL-CONTRACTS §1 — do NOT use the legacy Geoclient API (deprecated, retired).
 *
 * We use the `/v2/search` endpoint with a free-text `text` query (line1 + city +
 * state + zip). GeoSearch returns GeoJSON `features[]`; the top feature carries
 * `properties.addendum.pad.bbl` (the 10-digit BBL we want) and a Pelias
 * `confidence` score we map to {exact|approximate|failed}.
 *
 * This module is server-side only (it calls an upstream HTTP API) and NEVER
 * throws to its caller: every failure path degrades to `{ bbl: null,
 * geo_confidence: "failed", note }`. The BBL itself is deterministic and is NOT a
 * filing assertion (no verify gate) — but downstream open-data lookups that USE
 * the BBL are all gated.
 */

import type { PostalAddress } from "@/lib/case";

/** geo_confidence enum, mirrors Property.geo_confidence in @/lib/case. */
export type GeoConfidence = "exact" | "approximate" | "failed";

export interface GeoSearchResult {
  /** 10-digit Borough-Block-Lot, or null when resolution failed/was ambiguous. */
  bbl: string | null;
  geo_confidence: GeoConfidence;
  /** How the BBL was resolved, for property.bbl_resolved_via. */
  bbl_resolved_via: "geosearch_pluto" | "geosearch_pad" | "manual" | null;
  /** GeoSearch-canonical label of the top match (display/debug only). */
  label: string | null;
  /** Endpoint actually called (for the OpenDataAssertion). */
  endpoint: string | null;
  /** Non-fatal explanation when bbl is null or confidence is degraded. */
  note: string | null;
}

const GEOSEARCH_BASE = "https://geosearch.planninglabs.nyc/v2/search";

/** A free-text query string GeoSearch's autocomplete/search expects. */
function addressToText(address: PostalAddress): string {
  return [
    address.line1,
    address.city,
    address.state,
    address.postal_code,
  ]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/** Map a Pelias `confidence` (0..1) to our coarse GeoConfidence. */
function mapConfidence(score: number | undefined): GeoConfidence {
  if (typeof score !== "number") return "approximate";
  if (score >= 0.9) return "exact";
  if (score >= 0.5) return "approximate";
  return "failed";
}

/** Validate a 10-digit BBL (borough 1-5 + 9 digits). */
function isValidBbl(bbl: unknown): bbl is string {
  return typeof bbl === "string" && /^[1-5]\d{9}$/.test(bbl);
}

interface PeliasFeature {
  properties?: {
    label?: string;
    confidence?: number;
    addendum?: { pad?: { bbl?: string; bin?: string } };
    // GeoSearch sometimes exposes borough/block/lot directly:
    pad_bbl?: string;
    borough?: string;
  };
}

/** Pull a BBL out of a Pelias feature, tolerating both shapes GeoSearch returns. */
function extractBbl(feature: PeliasFeature | undefined): string | null {
  const p = feature?.properties;
  if (!p) return null;
  const fromAddendum = p.addendum?.pad?.bbl;
  if (isValidBbl(fromAddendum)) return fromAddendum;
  if (isValidBbl(p.pad_bbl)) return p.pad_bbl;
  return null;
}

/**
 * Resolve a confirmed address to a BBL via NYC GeoSearch. Never throws.
 *
 * @param address  the tenant-confirmed premises address (PostalAddress)
 * @param opts.signal  optional AbortSignal for timeout/cancellation
 */
export async function resolveAddressToBbl(
  address: PostalAddress,
  opts: { signal?: AbortSignal } = {},
): Promise<GeoSearchResult> {
  const text = addressToText(address);
  if (!text || !address.line1) {
    return {
      bbl: null,
      geo_confidence: "failed",
      bbl_resolved_via: null,
      label: null,
      endpoint: null,
      note: "No street address to resolve.",
    };
  }

  const url = `${GEOSEARCH_BASE}?text=${encodeURIComponent(text)}&size=5`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: opts.signal,
      // GeoSearch is public; no auth. Keep the response fresh-ish.
      cache: "no-store",
    });

    if (!res.ok) {
      return {
        bbl: null,
        geo_confidence: "failed",
        bbl_resolved_via: null,
        label: null,
        endpoint: url,
        note: `GeoSearch returned HTTP ${res.status}.`,
      };
    }

    const json = (await res.json()) as { features?: PeliasFeature[] };
    const features = Array.isArray(json.features) ? json.features : [];
    if (features.length === 0) {
      return {
        bbl: null,
        geo_confidence: "failed",
        bbl_resolved_via: null,
        label: null,
        endpoint: url,
        note: "GeoSearch found no matching address.",
      };
    }

    const top = features[0];
    const bbl = extractBbl(top);
    if (!isValidBbl(bbl)) {
      return {
        bbl: null,
        geo_confidence: "failed",
        bbl_resolved_via: null,
        label: top?.properties?.label ?? null,
        endpoint: url,
        note: "GeoSearch matched an address but returned no usable BBL.",
      };
    }

    const confidence = mapConfidence(top?.properties?.confidence);
    return {
      bbl,
      geo_confidence: confidence,
      bbl_resolved_via: "geosearch_pad",
      label: top?.properties?.label ?? null,
      endpoint: url,
      note:
        confidence === "exact"
          ? null
          : "Address match was approximate; building records may be for a nearby parcel.",
    };
  } catch (err) {
    return {
      bbl: null,
      geo_confidence: "failed",
      bbl_resolved_via: null,
      label: null,
      endpoint: url,
      note:
        err instanceof Error
          ? `GeoSearch request failed: ${err.message}`
          : "GeoSearch request failed.",
    };
  }
}
