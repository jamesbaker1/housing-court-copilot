/**
 * POST /api/packet — assemble a DRAFT court packet from a Case (no LLM).
 *
 * Body: { case: <schema-valid Case>, type: "nonpayment_answer", turnstileToken? }
 * Returns: application/pdf (the draft Answer), stamped "DRAFT — review before filing".
 *
 * Boundary: this is a DETERMINISTIC transcription of tenant-confirmed facts. No
 * model call, no legal judgment, no defense selection (the PDF lists defenses
 * UNCHECKED for the tenant/lawyer to choose). The posted Case is schema-validated
 * before rendering so a malformed body can never produce a misleading document.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { CaseSchema } from "@/lib/case";
import { generateAnswerDraftPdf } from "@/lib/packet/answer";
import { limitPublicApi } from "@/lib/ratelimit";
import { verifyTurnstile, extractTurnstileToken } from "@/lib/turnstile";

export const runtime = "nodejs";

const RequestSchema = z.object({
  case: z.unknown(),
  type: z.literal("nonpayment_answer"),
  /** Cloudflare Turnstile token (bot protection). */
  turnstileToken: z.string().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  // Rate limit (cost / abuse protection).
  const limit = await limitPublicApi(request, "packet");
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Please slow down." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Bot protection. Fails closed in production; open in dev when unconfigured.
  const turnstile = await verifyTurnstile(
    extractTurnstileToken(request, body),
    request.headers.get("cf-connecting-ip"),
  );
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "challenge_failed", message: "Please complete the verification and try again." },
      { status: 403 },
    );
  }

  // The packet must only ever be built from a schema-valid Case (Invariant #4:
  // the safety-owned fields are validated, and a malformed Case is rejected
  // rather than rendered into an authoritative-looking court document).
  const caseResult = CaseSchema.safeParse(parsed.data.case);
  if (!caseResult.success) {
    return NextResponse.json(
      { error: "invalid_case", issues: caseResult.error.flatten() },
      { status: 400 },
    );
  }

  let pdf: Uint8Array;
  try {
    pdf = await generateAnswerDraftPdf(caseResult.data);
  } catch (err) {
    console.error("generateAnswerDraftPdf failed", err);
    return NextResponse.json({ error: "render_error" }, { status: 502 });
  }

  return new NextResponse(Buffer.from(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="draft-answer.pdf"',
      "Cache-Control": "no-store",
    },
  });
}
