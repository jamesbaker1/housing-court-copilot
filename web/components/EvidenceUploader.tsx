/**
 * EvidenceUploader — the tenant affordance to upload supporting files (receipt
 * photos, repair pictures, document scans) and ATTACH them to their case.
 *
 * End-to-end pipeline (the three evidence endpoints, finally wired from a client):
 *   1. downscale + base64 the file (same low-bandwidth path as intake);
 *   2. POST /api/evidence/upload  → stores the blob in R2 (content-addressed,
 *      ownership-gated, Turnstile-protected) and returns a storage_ref;
 *   3. POST /api/evidence         → mints a Document around the storage_ref and a
 *      tenant_uploaded evidence item linked to it, returning the updated Case;
 *   4. PATCH /api/cases/[id]      → persists the new documents + evidence subtrees.
 *
 * Blobs are owner-only: a stored file is read back through GET /api/evidence/blob
 * (ownership-gated) — never a public URL — so "View" fetches the bytes WITH the
 * case auth headers and opens them via a transient object URL. A plain <a>/<img>
 * can't carry those headers, so a button + fetch is the correct shape.
 *
 * Degrades gracefully: when R2 isn't provisioned the upload returns 503 and we
 * tell the tenant their other progress is still saved (we never silently drop a
 * file the way the intake step used to).
 */
"use client";

import { useState } from "react";

import Turnstile from "@/components/Turnstile";
import type { Case, DocumentType, EvidenceType } from "@/lib/case";
import { downscaleImage } from "@/lib/image";
import { fetchWithTimeout, fetchLlm } from "@/lib/fetch";

/** Accepted original types (downscale re-encodes images to JPEG before sending). */
const SUPPORTED = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
]);

/** ~6.5M base64 chars ≈ 4.8MB binary — same backstop as the intake step. */
const MAX_B64 = 6_500_000;

/** Tenant-facing evidence categories + the Document type each maps to. */
const EVIDENCE_TYPES: { value: EvidenceType; label: string; doc: DocumentType }[] = [
  { value: "photo", label: "Photo (e.g. conditions / repairs)", doc: "repair_evidence" },
  { value: "rent_receipt", label: "Rent receipt", doc: "rent_receipt" },
  { value: "rent_payment_proof", label: "Proof of rent payment", doc: "rent_receipt" },
  { value: "repair_request", label: "Repair request", doc: "repair_evidence" },
  { value: "correspondence", label: "Letter / message", doc: "correspondence" },
  { value: "lease_term", label: "Lease / lease page", doc: "lease" },
  { value: "other", label: "Other document", doc: "other" },
];

interface EvidenceUploaderProps {
  caseId: string;
  caseObject: Case | null;
  /** Builds the case-scoped auth headers (Bearer token / owner session). */
  authHeaders: (json?: boolean) => Record<string, string>;
  /** Called with the freshly-persisted Case after a successful attach. */
  onCaseUpdate: (c: Case) => void;
}

interface AttachedRow {
  evidenceId: string;
  type: EvidenceType;
  hash: string | null;
  mime: string | null;
}

export default function EvidenceUploader({
  caseId,
  caseObject,
  authHeaders,
  onCaseUpdate,
}: EvidenceUploaderProps) {
  const [token, setToken] = useState<string | null>(null);
  const [evidenceType, setEvidenceType] = useState<EvidenceType>("photo");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewingHash, setViewingHash] = useState<string | null>(null);

  // Tenant_uploaded items + the stored blob (via their linked Document) so each
  // attached file gets a "View" affordance.
  const attached: AttachedRow[] = (caseObject?.evidence ?? [])
    .filter((e) => e.origin === "tenant_uploaded")
    .map((e) => {
      const doc = e.document_id
        ? (caseObject?.documents ?? []).find((d) => d.document_id === e.document_id)
        : undefined;
      return {
        evidenceId: e.evidence_id,
        type: e.evidence_type,
        hash: doc?.storage_ref.content_hash_sha256 ?? null,
        mime: doc?.storage_ref.mime_type ?? null,
      };
    });

  async function handleFile(file: File) {
    setError(null);
    setNotice(null);
    if (!SUPPORTED.has(file.type)) {
      setError("That file type isn't supported. Use a photo or a PDF.");
      return;
    }
    if (!token) {
      setError("Please wait for the verification check, then try again.");
      return;
    }
    if (!caseObject) {
      setError("Your case is still loading — try again in a moment.");
      return;
    }

    setBusy(true);
    try {
      const { data: base64Data, mediaType } = await downscaleImage(file);
      if (base64Data.length > MAX_B64) {
        setError("That file is too large even after resizing. Try a smaller photo.");
        return;
      }

      // 1) Store the blob in R2.
      const upRes = await fetchWithTimeout("/api/evidence/upload", {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({
          case_id: caseId,
          base64Data,
          mimeType: mediaType,
          turnstileToken: token,
        }),
      });
      const upData = await upRes.json().catch(() => ({}));
      if (upRes.status === 503) {
        setNotice(
          "File storage isn't set up on this deployment yet, so the file wasn't saved. Your other progress is still saved.",
        );
        return;
      }
      if (!upRes.ok || !upData?.storage_ref) {
        setError(upData?.message ?? "Could not upload the file. Please try again.");
        return;
      }

      // 2) Attach: mint a Document around the storage_ref + a tenant_uploaded item.
      const meta = EVIDENCE_TYPES.find((t) => t.value === evidenceType);
      const attachRes = await fetchLlm("/api/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          case: caseObject,
          origin: "tenant_uploaded",
          evidence_type: evidenceType,
          document_type: meta?.doc ?? "other",
          storage_ref: upData.storage_ref,
        }),
      });
      const attachData = await attachRes.json().catch(() => ({}));
      if (!attachRes.ok || !attachData?.case) {
        setError(attachData?.message ?? "Stored the file but could not attach it.");
        return;
      }
      const nextCase = attachData.case as Case;

      // 3) Persist the new documents + evidence subtrees onto the case.
      const patchRes = await fetchWithTimeout(`/api/cases/${caseId}`, {
        method: "PATCH",
        headers: authHeaders(true),
        body: JSON.stringify({
          documents: nextCase.documents,
          evidence: nextCase.evidence,
        }),
      });
      const patchData = await patchRes.json().catch(() => ({}));
      if (!patchRes.ok || !patchData?.case) {
        setError("Saved the file but could not record it on your case. Please retry.");
        return;
      }
      onCaseUpdate(patchData.case as Case);
      setNotice("File added to your case.");
    } catch {
      setError("Something went wrong uploading the file. Please try again.");
    } finally {
      // A Turnstile token is single-use; clear it so the widget re-arms.
      setToken(null);
      setBusy(false);
    }
  }

  async function viewFile(hash: string) {
    setViewingHash(hash);
    try {
      const res = await fetchWithTimeout(
        `/api/evidence/blob?case_id=${encodeURIComponent(caseId)}&hash=${hash}`,
        { headers: authHeaders(false) },
      );
      if (!res.ok) {
        setError("Could not open that file.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      // Revoke shortly after — the new tab has already taken the bytes.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      setError("Could not open that file.");
    } finally {
      setViewingHash(null);
    }
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-lg font-semibold text-gray-900">Add supporting evidence</h2>
      <p className="mt-1 text-sm text-gray-600">
        Photos or scans that support your case — rent receipts, repair photos,
        letters. Stored privately on your case; only you (and anyone you choose to
        share with) can open them.
      </p>

      {attached.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {attached.map((a) => (
            <li
              key={a.evidenceId}
              className="flex items-center justify-between gap-2 rounded border border-gray-100 p-2"
            >
              <span className="text-gray-800">{a.type.replace(/_/g, " ")}</span>
              {a.hash ? (
                <button
                  type="button"
                  disabled={viewingHash === a.hash}
                  onClick={() => void viewFile(a.hash!)}
                  className="text-xs font-medium text-trust-700 underline underline-offset-2 disabled:opacity-50"
                >
                  {viewingHash === a.hash ? "Opening…" : "View"}
                </button>
              ) : (
                <span className="text-xs text-gray-400">file not stored</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <label htmlFor="evidence-type" className="mt-4 block text-sm text-gray-700">
        What is this file?
      </label>
      <select
        id="evidence-type"
        value={evidenceType}
        onChange={(e) => setEvidenceType(e.target.value as EvidenceType)}
        disabled={busy}
        className="mt-1 w-full rounded border border-gray-300 p-2 text-sm"
      >
        {EVIDENCE_TYPES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>

      <div className="mt-3">
        <input
          id="evidence-file"
          type="file"
          accept="image/*,application/pdf"
          disabled={busy || !token}
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Reset the input so re-selecting the same file fires onChange again.
            e.target.value = "";
            if (f) void handleFile(f);
          }}
          className="block w-full text-sm text-gray-700 file:mr-3 file:rounded-md file:border-0 file:bg-trust-600 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-trust-700 disabled:opacity-50"
        />
      </div>

      <Turnstile onToken={setToken} token={token} action="evidence" className="mt-3" />

      {busy && <p className="mt-2 text-sm text-gray-600">Uploading…</p>}
      {notice && (
        <p className="mt-2 rounded bg-green-50 p-2 text-sm text-green-800">{notice}</p>
      )}
      {error && (
        <p className="mt-2 rounded bg-red-50 p-2 text-sm text-red-800">{error}</p>
      )}
      {!token && !busy && (
        <p className="mt-1 text-xs text-gray-400">Preparing the verification check…</p>
      )}
    </section>
  );
}
