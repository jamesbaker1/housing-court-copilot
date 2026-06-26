/**
 * EXIF-orientation probe regression test for lib/image.
 *
 * Scared tenants photograph court papers on a phone; the OS displays them upright
 * via the EXIF orientation tag. We must only trust createImageBitmap's baked-in
 * rotation on engines that actually honor `imageOrientation: "from-image"`. Some
 * engines (older Chrome <79, embedded WebViews) silently IGNORE the option and
 * hand back raw sideways pixels, which we'd then re-encode tag-less — uploading a
 * 90/180deg-rotated photo to vision intake and degrading extraction of the very
 * court date the tenant has ~10 days to act on.
 *
 * `probeOrientationHonored` is the pure decision behind that gate: given the
 * dimensions createImageBitmap returned for a 2x1 (wide) orientation-6 probe, it
 * reports whether the engine rotated it to 1x2 (honored) or left it 2x1 (ignored).
 */
import { describe, it, expect } from "vitest";

import { probeOrientationHonored } from "@/lib/image";

describe("image orientation probe decision", () => {
  it("reports HONORED when the wide probe came back rotated to tall (1x2)", () => {
    expect(probeOrientationHonored(1, 2)).toBe(true);
  });

  it("reports NOT honored when the option was ignored and dims stay raw (2x1)", () => {
    expect(probeOrientationHonored(2, 1)).toBe(false);
  });

  it("treats degenerate / zero dimensions as NOT honored (never false-positive)", () => {
    expect(probeOrientationHonored(0, 0)).toBe(false);
    expect(probeOrientationHonored(0, 2)).toBe(false);
    expect(probeOrientationHonored(1, 0)).toBe(false);
  });

  it("treats a square or unexpectedly-large read as NOT honored", () => {
    // Equal dims can't distinguish rotation; an unexpected size means we read the
    // wrong source. Either way, do not claim baked-in orientation support.
    expect(probeOrientationHonored(2, 2)).toBe(false);
    expect(probeOrientationHonored(2000, 1500)).toBe(false);
  });
});
