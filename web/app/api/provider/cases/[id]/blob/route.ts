/**
 * GET /api/provider/cases/[id]/blob?hash=… — stream an evidence blob to a
 * consented provider.
 *
 * The provider counterpart of GET /api/evidence/blob (which is tenant-owner
 * gated). Authorization here is the provider model:
 *   1. Cloudflare Access (middleware) — verified provider principal.
 *   2. A granted handoff_to_provider consent VISIBLE to this prv (§2.2).
 *   3. That consent must SHARE the "documents" category — a provider who was not
 *      granted documents cannot pull a file even with a valid handoff.
 *   4. The requested hash must belong to a Document ON THIS CASE — so a provider
 *      can't fish for arbitrary blobs in the case's R2 namespace.
 *
 * The object key is reconstructed server-side from (case_id, hash); the client
 * never supplies a raw key. Bytes stream through this route (never a public URL),
 * private/no-store, so an eviction document can't leak via a loggable URL.
 */
import { NextResponse } from "next/server";

import { getCase } from "@/lib/store";
import { getEvidenceBlob, evidenceKey } from "@/lib/evidence-storage";
import {
  readProviderPrincipal,
  visibleHandoffConsent,
} from "@/lib/auth/provider-principal";

export const runtime = "nodejs";

const HASH_RE = /^[a-f0-9]{64}$/;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function consentRequired(): NextResponse {
  return NextResponse.json(
    {
      error: "consent_required",
      message:
        "No granted handoff_to_provider consent (sharing documents) for this case.",
    },
    { status: 403 },
  );
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const { prv } = readProviderPrincipal(req);

  const url = new URL(req.url);
  const hash = (url.searchParams.get("hash") ?? "").toLowerCase();
  if (!HASH_RE.test(hash)) {
    return NextResponse.json(
      { error: "invalid_request", message: "A 64-hex hash is required." },
      { status: 400 },
    );
  }

  const found = await getCase(id);
  if (!found) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  // Consent must exist, be visible to this prv, AND share the documents category.
  const consent = visibleHandoffConsent(found, prv, nowIso());
  if (!consent || !consent.data_categories.includes("documents")) {
    return consentRequired();
  }

  // The hash must correspond to a Document on THIS case (no namespace fishing).
  const known = found.documents.some(
    (d) => d.storage_ref.content_hash_sha256 === hash,
  );
  if (!known) {
    return NextResponse.json({ error: "not_found", message: "No such file." }, { status: 404 });
  }

  const res = await getEvidenceBlob(evidenceKey(id, hash));
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
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
    },
  });
}
