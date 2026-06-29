/**
 * POST /api/eligibility — run the deterministic eligibility engine on a Case and
 * persist the result (LEGAL-RULES §8).
 *
 * Body: { case_id }.
 *
 * Server-authoritative (Invariant #4): the `determined_by = "deterministic"`
 * eligibility slots are written ONLY here, by deterministic code, onto a
 * schema-valid Case — never by the LLM or a tenant PATCH (the case PATCH boundary
 * strips eligibility.*). Ownership-gated + rate-limited like every case write.
 *
 * The engine FAILS SAFE: with the default UNVALIDATED config it returns
 * insufficient_data / program_unavailable, never a fabricated "you qualify".
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import type { Case, Consent, SensitiveData } from "@/lib/case";
import { getCase, patchCase } from "@/lib/store";
import { evaluateEligibility } from "@/lib/eligibility";
import { limitPublicApi } from "@/lib/ratelimit";
import { authorizeCaseAccess, readAccessContext } from "@/lib/auth/session";
import { newId } from "@/lib/ids";

export const runtime = "nodejs";

/** Versioned text the tenant agreed to when opting in to store income/size. */
const STORE_SENSITIVE_CONSENT_TEXT_VERSION = "store-sensitive-v1";

const BodySchema = z.object({
  case_id: z.string().regex(/^case_[0-9a-hjkmnp-tv-z]{26}$/),
  /** Annual household income in CENTS (opt-in, stored only with consent). */
  household_income_cents: z.number().int().min(0).optional(),
  household_size: z.number().int().min(1).optional(),
  /** Affirmative opt-in to STORE the household income/size for screening. */
  consent_to_store: z.boolean().optional(),
});

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function POST(req: Request): Promise<NextResponse> {
  // Rate limit (cost protection).
  const limit = await limitPublicApi(req, "eligibility");
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
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { case_id, household_income_cents, household_size, consent_to_store } = parsed.data;

  // OWNERSHIP GATE: writing eligibility is a write to the case.
  const authz = await authorizeCaseAccess(case_id, readAccessContext(req));
  if (!authz.ok) {
    return NextResponse.json(
      { error: "forbidden", message: "You must prove ownership of this case to access it." },
      { status: 403 },
    );
  }

  const existing = await getCase(case_id);
  if (!existing) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  // If the tenant supplied household income/size, persist them — but ONLY with an
  // affirmative store_sensitive_data consent (default-deny). The sensitive write
  // and the consent record are made together here, server-side, so income is
  // never stored without the recorded opt-in.
  const at = nowIso();
  const providingSensitive =
    household_income_cents !== undefined || household_size !== undefined;
  let candidate: Case = existing;
  const patch: Partial<Case> = {};

  if (providingSensitive) {
    if (consent_to_store !== true) {
      return NextResponse.json(
        {
          error: "consent_required",
          message:
            "Storing household income/size requires consent_to_store: true.",
        },
        { status: 403 },
      );
    }
    const sensitive: SensitiveData = {
      ...(existing.sensitive ?? {}),
      ...(household_income_cents !== undefined ? { household_income_cents } : {}),
      ...(household_size !== undefined ? { household_size } : {}),
    };
    const consent: Consent = {
      consent_id: newId("cns"),
      scope: "store_sensitive_data",
      // First-party storage by this service — not a third-party share.
      recipient: { recipient_type: "service" },
      granted: true,
      granted_at: at,
      consent_text_version: STORE_SENSITIVE_CONSENT_TEXT_VERSION,
      data_categories: ["eligibility"],
      method: "pwa_checkbox",
    };
    candidate = { ...existing, sensitive };
    patch.sensitive = sensitive;
    patch.consents = [...existing.consents, consent];
  }

  // Deterministic evaluation (no LLM) on the candidate (post-sensitive-write).
  // `evaluated_at` is stamped by the server.
  patch.eligibility = evaluateEligibility(candidate, { now: at });

  let updated;
  try {
    updated = await patchCase(case_id, patch);
  } catch (err) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: err instanceof Error ? err.message : "Eligibility patch did not validate.",
      },
      { status: 400 },
    );
  }
  if (!updated) {
    return NextResponse.json(
      { error: "not_found", message: "No case with that id." },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { case_id, eligibility: updated.eligibility, case: updated },
    { status: 200 },
  );
}
