/**
 * POST /api/building — Landlord & Building Intelligence.
 *
 * Body: { case_id } and/or { address }.
 *   - With case_id: load the Case from @/lib/store, run the open-data
 *     orchestrator off the confirmed property.address, PATCH the resulting
 *     evidence[] + parties.landlord + property(bbl) onto the Case, and return
 *     the findings.
 *   - With address only (no case_id): run the orchestrator and return findings
 *     WITHOUT persisting (preview mode).
 *
 * Everything open-data lands on the Case wrapped in an OpenDataAssertion with a
 * verify_before_file gate that starts "unverified" — nothing is auto-filed. The
 * orchestrator never throws, so a degraded upstream returns partial findings +
 * notes (HTTP 200), never a 500.
 *
 * Node runtime (uses the file store + node fetch), generous maxDuration for the
 * fan-out of upstream calls.
 */

import { NextResponse } from "next/server";

import type { Case, PostalAddress } from "@/lib/case";
import { PostalAddressSchema } from "@/lib/case";
import { getCase, patchCase } from "@/lib/store";
import { lookupBuildingIntel, applyBuildingIntelToCase } from "@/lib/opendata";
import { limitPublicApi } from "@/lib/ratelimit";
import { verifyTurnstile, extractTurnstileToken } from "@/lib/turnstile";
import { authorizeCaseAccess, readAccessContext } from "@/lib/auth/session";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Hard ceiling so a slow upstream can't hang the request. */
const UPSTREAM_TIMEOUT_MS = 25_000;

function hasUsableAddress(a: PostalAddress | null | undefined): a is PostalAddress {
  return !!a && typeof a.line1 === "string" && a.line1.trim().length > 0;
}

export async function POST(req: Request): Promise<NextResponse> {
  // Rate limit (cost-DoS protection on the open-data fan-out).
  const limit = await limitPublicApi(req, "building");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  // Bot protection. Fails closed in production; open in dev when unconfigured.
  const turnstile = await verifyTurnstile(
    extractTurnstileToken(req, body),
    req.headers.get("cf-connecting-ip"),
  );
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "challenge_failed", message: "Please complete the verification and try again." },
      { status: 403 },
    );
  }

  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "invalid_request", message: "Body must be an object." },
      { status: 400 },
    );
  }

  const { case_id, address } = body as {
    case_id?: unknown;
    address?: unknown;
  };

  // Resolve the address to query: explicit address wins, else the Case's.
  let queryAddress: PostalAddress | null = null;
  let loadedCase: Case | null = null;

  if (typeof case_id === "string" && case_id.length > 0) {
    // OWNERSHIP GATE (M11): persisting open-data findings onto a Case is a write
    // to that case — it requires proof of ownership, not just a loggable case_id.
    // (Address-only PREVIEW below needs no case and stays open.) Uniform 403 so
    // we never reveal whether the case exists.
    const authz = await authorizeCaseAccess(case_id, readAccessContext(req));
    if (!authz.ok) {
      return NextResponse.json(
        { error: "forbidden", message: "You must prove ownership of this case to access it." },
        { status: 403 },
      );
    }
    loadedCase = await getCase(case_id);
    if (!loadedCase) {
      return NextResponse.json(
        { error: "not_found", message: "No case with that id." },
        { status: 404 },
      );
    }
    queryAddress = loadedCase.property?.address ?? null;
  }

  if (address != null) {
    const parsed = PostalAddressSchema.safeParse(address);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    queryAddress = parsed.data;
  }

  if (!hasUsableAddress(queryAddress)) {
    return NextResponse.json(
      {
        error: "no_address",
        message:
          "No confirmed building address to look up. Confirm the premises address first.",
      },
      { status: 400 },
    );
  }

  // Run the orchestrator with a timeout (it never throws on its own).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let output;
  try {
    output = await lookupBuildingIntel(queryAddress, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  // No case_id → preview only (do not persist).
  if (!loadedCase) {
    return NextResponse.json({
      findings: output.findings,
      verify_reminder: output.findings.verify_reminder,
      persisted: false,
    });
  }

  // Persist: apply evidence + landlord + property onto the Case, then PATCH.
  const nextCase = applyBuildingIntelToCase(loadedCase, output);
  let updated: Case | null;
  try {
    updated = await patchCase(loadedCase.case_id, {
      evidence: nextCase.evidence,
      parties: nextCase.parties,
      property: nextCase.property,
    });
  } catch (err) {
    // Persisting failed (e.g. schema) — still return findings so the UI can show them.
    return NextResponse.json({
      findings: output.findings,
      verify_reminder: output.findings.verify_reminder,
      persisted: false,
      persist_error:
        err instanceof Error ? err.message : "Failed to persist findings to the case.",
    });
  }

  if (!updated) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    findings: output.findings,
    verify_reminder: output.findings.verify_reminder,
    persisted: true,
    case: updated,
  });
}
