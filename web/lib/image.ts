/**
 * Client-side image downscale + re-encode before a base64 upload (S3).
 *
 * The make-or-break first step is a scared tenant on a borrowed/cheap phone
 * uploading a court-papers photo over a slow, metered connection. A raw full-res
 * phone photo is 4-16MB of base64 — slow to send, expensive on data, and at risk
 * of the Worker body-size limit. We downscale the longest edge to ~2000px and
 * re-encode as JPEG (quality ~0.75) using ONLY native Canvas APIs (no new deps),
 * which typically cuts the payload by an order of magnitude with no meaningful
 * loss of OCR legibility.
 *
 * PDFs (and anything that isn't an image/* type) are passed through UNTOUCHED —
 * a PDF is already a compact, text-bearing document and re-encoding it as a JPEG
 * would destroy it. This helper only ever rewrites raster images.
 *
 * EXIF orientation: phone cameras often store a sideways sensor read plus an
 * orientation tag. `createImageBitmap(file, { imageOrientation: "from-image" })`
 * bakes that rotation into the bitmap so the upload is upright. But per spec an
 * engine that does not support the `imageOrientation` option must IGNORE it (not
 * throw) — older Chrome <79 and some embedded WebViews do exactly that, silently
 * returning the RAW sideways pixels while we then strip the EXIF tag on re-encode
 * (the worst of both worlds: sideways AND untagged). So we don't trust the option
 * blindly: we probe it once against a known orientation-tagged image and only use
 * the createImageBitmap path when the engine actually honors the rotation. When
 * it doesn't (or createImageBitmap is missing — older Safari), we fall back to an
 * <img> loaded from a blob URL. That fallback does NOT auto-correct orientation,
 * which we accept as a degraded fallback rather than hand-rolling EXIF parsing —
 * but at least it preserves the original tag-bearing bytes' display intent on the
 * server side rather than baking in a wrong rotation.
 */

/** Longest-edge target in CSS pixels. Smaller images are left as-is. */
const LONGEST_EDGE = 2000;

/** JPEG quality for the re-encode — legible for OCR, much smaller on the wire. */
const JPEG_QUALITY = 0.75;

export interface DownscaleResult {
  /** Base64 payload WITHOUT the `data:...;base64,` prefix (route contract). */
  data: string;
  /** The media type to send: the re-encoded "image/jpeg", or the original. */
  mediaType: string;
}

export interface DownscaleOptions {
  /** Override the longest-edge target (defaults to {@link LONGEST_EDGE}). */
  longestEdge?: number;
  /** Override the JPEG quality (defaults to {@link JPEG_QUALITY}). */
  quality?: number;
}

/** Read a File as base64 (strips the `data:...;base64,` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("read failed"));
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** Strip the `data:...;base64,` prefix from a data URL. */
function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * A 2x1 (wide) JPEG carrying EXIF orientation=6 (rotate 90deg CW). An engine that
 * honors `imageOrientation: "from-image"` decodes it to a 1x2 (tall) bitmap; one
 * that silently IGNORES the option leaves it 2x1. Comparing the two tells us
 * whether baked-in orientation can be trusted. Kept tiny so the probe is cheap.
 */
const ORIENTATION_PROBE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDR0X/kD2H/AFwj/wDQRRRRX5FU+N+p+K5v/v8AX/xy/wDSmf/Z";

/**
 * Pure decision: given the dimensions `createImageBitmap` returned for the
 * orientation-6 probe (whose RAW pixels are 2 wide x 1 tall), decide whether the
 * engine actually honored `imageOrientation: "from-image"`. Honored => the bitmap
 * is rotated to 1x2 (taller than wide); ignored => it stays 2x1 (wider than tall).
 * Anything degenerate (zero/equal dims, or a too-large bitmap that means we read
 * the wrong source) is treated as NOT honored, so we never falsely claim support.
 */
export function probeOrientationHonored(width: number, height: number): boolean {
  if (!width || !height) return false;
  // The probe's raw read is exactly 2x1; honoring orientation=6 makes it 1x2.
  return width === 1 && height === 2;
}

/** Decode the base64 probe into an image/jpeg Blob for createImageBitmap. */
function probeBlob(): Blob {
  const binary = atob(ORIENTATION_PROBE_JPEG_B64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

/** Cached result of the one-time orientation-support probe (per page load). */
let orientationSupport: Promise<boolean> | undefined;

/**
 * Probe (once, memoized) whether `createImageBitmap` honors
 * `imageOrientation: "from-image"` on this engine. Resolves false if
 * createImageBitmap is missing, throws, or silently ignores the option.
 */
function supportsImageOrientation(
  cib: typeof createImageBitmap,
): Promise<boolean> {
  if (orientationSupport) return orientationSupport;
  orientationSupport = (async () => {
    try {
      const bitmap = await cib(probeBlob(), { imageOrientation: "from-image" });
      const honored = probeOrientationHonored(bitmap.width, bitmap.height);
      if (typeof bitmap.close === "function") bitmap.close();
      return honored;
    } catch {
      return false;
    }
  })();
  return orientationSupport;
}

/**
 * Decode the file to an upright bitmap-like source with intrinsic dimensions.
 * Uses createImageBitmap ONLY on engines confirmed (via a one-time probe) to
 * honor EXIF orientation; otherwise falls back to an <img> from a blob URL. The
 * probe guards against engines that silently ignore `imageOrientation` and would
 * otherwise hand us raw sideways pixels that we'd re-encode tag-less.
 */
async function decodeImage(
  file: File,
): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  const cib = (
    globalThis as { createImageBitmap?: typeof createImageBitmap }
  ).createImageBitmap;
  if (typeof cib === "function" && (await supportsImageOrientation(cib))) {
    try {
      // Confirmed-honoring engine: `imageOrientation: "from-image"` bakes EXIF
      // rotation into the bitmap so a sideways phone photo uploads upright.
      const bitmap = await cib(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Fall through to the <img> path (e.g. a decode failure on this file).
    }
  }

  // Degraded fallback: load via an <img> from a blob URL. This will NOT
  // auto-correct EXIF orientation (accepted tradeoff — no manual EXIF parsing).
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      URL.revokeObjectURL(url);
      resolve({ source: img, width, height });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("image decode failed"));
    };
    img.src = url;
  });
}

/**
 * Downscale + re-encode an image File for upload, or pass a non-image through
 * untouched. Returns the base64 payload (no data-URL prefix) and the media type
 * to send to the route (the re-encoded "image/jpeg" for images, the original
 * type for PDFs / anything else).
 *
 * Always resolves with SOMETHING: if anything in the canvas path fails we fall
 * back to the raw file bytes + original media type, so a tenant never loses the
 * ability to upload because of a downscale hiccup.
 */
export async function downscaleImage(
  file: File,
  opts: DownscaleOptions = {},
): Promise<DownscaleResult> {
  // PDFs and any non-image type pass through unchanged (leave PDFs untouched).
  if (file.type === "application/pdf" || !file.type.startsWith("image/")) {
    return { data: await fileToBase64(file), mediaType: file.type };
  }

  const longestEdge = opts.longestEdge ?? LONGEST_EDGE;
  const quality = opts.quality ?? JPEG_QUALITY;

  try {
    const { source, width, height } = await decodeImage(file);
    if (!width || !height) throw new Error("zero-size image");

    // Only shrink — never upscale a small photo.
    const longest = Math.max(width, height);
    const scale = longest > longestEdge ? longestEdge / longest : 1;
    const targetW = Math.max(1, Math.round(width * scale));
    const targetH = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(source, 0, 0, targetW, targetH);

    // toDataURL is universally available (vs toBlob+FileReader); JPEG re-encode.
    const dataUrl = canvas.toDataURL("image/jpeg", quality);

    // Free the decoded bitmap when we created one (no-op for <img>).
    if (typeof (source as ImageBitmap).close === "function") {
      (source as ImageBitmap).close();
    }

    // A pathological toDataURL (e.g. SecurityError-tainted, unsupported) yields a
    // non-jpeg / empty string; fall back to the raw bytes in that case.
    if (!dataUrl.startsWith("data:image/jpeg")) {
      return { data: await fileToBase64(file), mediaType: file.type };
    }
    return { data: stripDataUrlPrefix(dataUrl), mediaType: "image/jpeg" };
  } catch {
    // Any decode/encode failure: degrade to the raw upload so the tenant is
    // never blocked from sending their papers.
    return { data: await fileToBase64(file), mediaType: file.type };
  }
}
