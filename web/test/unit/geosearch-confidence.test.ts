/**
 * GeoSearch confidence gating — a low-confidence ("failed") geocode must NOT
 * surface a BBL, so the downstream HPD/WoW open-data fan-out (gated on `!bbl`)
 * is skipped rather than presenting a DIFFERENT building's records as evidence.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAddressToBbl } from "@/lib/opendata/geosearch";
import type { PostalAddress } from "@/lib/case";

const ADDRESS: PostalAddress = {
  line1: "123 Main St",
  line2: null,
  city: "Bronx",
  state: "NY",
  postal_code: "10458",
};

function mockGeoSearch(confidence: number, bbl = "2012340001") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          features: [
            { properties: { label: "123 Main St", confidence, addendum: { pad: { bbl } } } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveAddressToBbl confidence gating", () => {
  it("returns NO bbl when the geocoder confidence is below threshold (failed)", async () => {
    mockGeoSearch(0.3);
    const r = await resolveAddressToBbl(ADDRESS);
    expect(r.bbl).toBeNull();
    expect(r.geo_confidence).toBe("failed");
    expect(r.note).toMatch(/too low/i);
  });

  it("returns the bbl for a high-confidence (exact) match", async () => {
    mockGeoSearch(0.95);
    const r = await resolveAddressToBbl(ADDRESS);
    expect(r.bbl).toBe("2012340001");
    expect(r.geo_confidence).toBe("exact");
  });

  it("returns the bbl (approximate) for a mid-confidence match", async () => {
    mockGeoSearch(0.6);
    const r = await resolveAddressToBbl(ADDRESS);
    expect(r.bbl).toBe("2012340001");
    expect(r.geo_confidence).toBe("approximate");
  });
});
