/**
 * GET /api/evidence/blob?case_id=…&hash=… — stream an evidence blob to its owner.
 *
 * Ownership-gated: the caller must prove ownership of `case_id`. The object key
 * is reconstructed SERVER-SIDE from (case_id, hash) — the client never supplies a
 * raw key — so a caller can only ever read blobs under a case they own (no
 * cross-case key traversal). We stream the bytes through this route rather than
 * minting a public R2 URL, so a loggable URL can't leak an eviction document.
 */
import { NextResponse } from "next/server";

import { getEvidenceBlob, evidenceKey } from "@/lib/evidence-storage";
import { limitPublicApi } from "@/lib/ratelimit";
import { authorizeCaseAccess, readAccessContext } from "@/lib/auth/session";

export const runtime = "nodejs";

const CASE_ID_RE = /^case_[0-9a-hjkmnp-tv-z]{26}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export async function GET(req: Request): Promise<Response> {
  const limit = await limitPublicApi(req, "evidence_blob");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  const url = new URL(req.url);
  const caseId = url.searchParams.get("case_id") ?? "";
  const hash = (url.searchParams.get("hash") ?? "").toLowerCase();
  if (!CASE_ID_RE.test(caseId) || !HASH_RE.test(hash)) {
    return NextResponse.json(
      { error: "invalid_request", message: "case_id and a 64-hex hash are required." },
      { status: 400 },
    );
  }

  // OWNERSHIP GATE first — uniform 403 that doesn't reveal whether the blob exists.
  const authz = await authorizeCaseAccess(caseId, readAccessContext(req));
  if (!authz.ok) {
    return NextResponse.json(
      { error: "forbidden", message: "You must prove ownership of this case to access it." },
      { status: 403 },
    );
  }

  // Reconstruct the key server-side — the client cannot point at another case.
  const res = await getEvidenceBlob(evidenceKey(caseId, hash));
  if (!res.ok) {
    if (res.reason === "unavailable") {
      return NextResponse.json(
        { error: "storage_unavailable", message: "Evidence file storage isn't configured here." },
        { status: 503 },
      );
    }
    if (res.reason === "not_found") {
      return NextResponse.json({ error: "not_found", message: "No such file." }, { status: 404 });
    }
    return NextResponse.json({ error: "storage_error", message: "Could not read the file." }, { status: 502 });
  }

  const contentType = res.object.httpMetadata?.contentType ?? "application/octet-stream";
  return new Response(res.object.body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(res.object.size),
      // Private, owner-only content — never cache in a shared cache.
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
    },
  });
}
