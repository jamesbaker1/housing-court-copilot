/**
 * POST /api/evidence/upload — store an evidence blob in R2 (ownership-gated).
 *
 * Body: { case_id, base64Data, mimeType, retention_class? }.
 * Returns: { storage_ref } — the content-addressed r2:// uri + sha256 + size, to
 * attach to an evidence/document item on the Case (via /api/evidence).
 *
 * The blob is content-addressed and case-namespaced; bytes live in R2 inside the
 * SHIELD boundary, never in D1 and never behind a public URL. When R2 is not
 * bound (dev / not yet provisioned), returns 503 so the client keeps the existing
 * no-blob flow rather than silently dropping the file.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { MimeTypeSchema } from "@/lib/case";
import { getCase } from "@/lib/store";
import { putEvidenceBlob } from "@/lib/evidence-storage";
import { limitPublicApi } from "@/lib/ratelimit";
import { verifyTurnstile, extractTurnstileToken } from "@/lib/turnstile";
import { authorizeCaseAccess, readAccessContext } from "@/lib/auth/session";

export const runtime = "nodejs";

/** ~12 MB base64 ceiling (≈9 MB binary) — a downscaled phone photo / scan. */
const MAX_BASE64_LEN = 12_000_000;

const BodySchema = z.object({
  case_id: z.string().regex(/^case_[0-9a-hjkmnp-tv-z]{26}$/),
  base64Data: z.string().min(1).max(MAX_BASE64_LEN),
  mimeType: MimeTypeSchema,
  retention_class: z.enum(["standard", "minimized", "sensitive"]).optional(),
});

function normalizeBase64(input: string): string {
  const match = input.match(/^data:[^;]+;base64,(.*)$/s);
  return match ? (match[1] ?? input) : input;
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function POST(req: Request): Promise<NextResponse> {
  const limit = await limitPublicApi(req, "evidence_upload");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : undefined;
  } catch {
    return NextResponse.json({ error: "invalid_json", message: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { case_id, mimeType, retention_class } = parsed.data;

  const turnstile = await verifyTurnstile(extractTurnstileToken(req, raw), req.headers.get("cf-connecting-ip"));
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "challenge_failed", message: "Please complete the verification and try again." },
      { status: 403 },
    );
  }

  // OWNERSHIP GATE: storing a blob against a case is a write to that case.
  const authz = await authorizeCaseAccess(case_id, readAccessContext(req));
  if (!authz.ok) {
    return NextResponse.json(
      { error: "forbidden", message: "You must prove ownership of this case to access it." },
      { status: 403 },
    );
  }

  const existing = await getCase(case_id);
  if (!existing) {
    return NextResponse.json({ error: "not_found", message: "No case with that id." }, { status: 404 });
  }

  // Decode base64 → bytes.
  let bytes: Uint8Array;
  try {
    const b64 = normalizeBase64(parsed.data.base64Data);
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return NextResponse.json({ error: "invalid_base64", message: "Could not decode the upload." }, { status: 400 });
  }
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "empty_upload", message: "The upload was empty." }, { status: 400 });
  }

  const res = await putEvidenceBlob({
    caseId: case_id,
    bytes,
    mimeType,
    retentionClass: retention_class ?? existing.audit?.data_retention_class ?? "standard",
    now: nowIso(),
  });

  if (!res.ok) {
    if (res.reason === "unavailable") {
      return NextResponse.json(
        {
          error: "storage_unavailable",
          message: "Evidence file storage isn't configured on this deployment yet.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "storage_error", message: "Could not store the file." }, { status: 502 });
  }

  return NextResponse.json(
    {
      case_id,
      storage_ref: {
        uri: res.uri,
        content_hash_sha256: res.content_hash_sha256,
        mime_type: mimeType,
        byte_size: res.byte_size,
      },
      purge_after: res.purge_after,
    },
    { status: 201 },
  );
}
