/**
 * POST /api/answer — answer-draft transcription.
 *
 * Body: { raw_statements, language?, general_denial? }
 * Returns faithfully-transcribed answer-field statements (transcription_only),
 * plus any advice-seeking utterances surfaced SEPARATELY for human routing, plus
 * the tenant-set general_denial flag echoed back.
 *
 * Boundary (GUARDRAILS §2.2 / §0.3):
 *   - `general_denial` is the TENANT's choice — accepted as a passthrough, never
 *     decided by the LLM. Defaults null when the tenant has not chosen.
 *   - `form_fields[]` is NOT produced here (deterministic placement, later step).
 *   - Advice-seeking utterances are flagged and NOT written as factual statements
 *     (they feed the advice-routing path; route returns route_to_human=true).
 *   - Output is always labeled "DRAFT — have a lawyer review before filing".
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  draftAnswer,
  partitionStatements,
  toFactualStatement,
  ANSWER_DRAFT_DISCLAIMER,
  type DraftAnswerInput,
} from "@/lib/llm/answer-draft";
import { type FactualStatement } from "@/lib/case";

export const runtime = "nodejs";

const RequestSchema = z.object({
  raw_statements: z.string().min(1, "raw_statements is required"),
  language: z.string().optional(),
  /** Tenant-set general-denial flag. NEVER decided by the LLM. */
  general_denial: z.boolean().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Minimal stmt_ ULID generator. Crockford base32, 26 chars, matching the
// StatementIdSchema pattern in @/lib/case. Time-ordered prefix + random tail;
// no external dep, good enough for draft statement ids (DET layer may re-mint).
// ---------------------------------------------------------------------------
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"; // excludes i, l, o, u

function ulid(): string {
  let ts = Date.now();
  const timeChars: string[] = [];
  for (let i = 0; i < 10; i++) {
    timeChars.unshift(CROCKFORD[ts % 32] as string);
    ts = Math.floor(ts / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[Math.floor(Math.random() * 32)] as string;
  }
  return timeChars.join("") + rand;
}

export async function POST(request: Request): Promise<NextResponse> {
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

  const input: DraftAnswerInput = {
    raw_statements: parsed.data.raw_statements,
    language: parsed.data.language,
  };

  let result;
  try {
    result = await draftAnswer(input);
  } catch (err) {
    console.error("draftAnswer failed", err);
    return NextResponse.json({ error: "llm_error" }, { status: 502 });
  }

  // Fail safe: refusal / unparseable → no statements, route to a human.
  if (result.statements === null) {
    return NextResponse.json({
      answer_draft: {
        general_denial: parsed.data.general_denial ?? null,
        factual_statements: [] as FactualStatement[],
        form_fields: [],
        status: "draft" as const,
      },
      advice_requests: [] as string[],
      route_to_human: true,
      stop_reason: result.stopReason,
      model: result.model,
      disclaimer: ANSWER_DRAFT_DISCLAIMER,
    });
  }

  const { factual, adviceRequests } = partitionStatements(result.statements);

  const factual_statements: FactualStatement[] = factual.map((s) =>
    toFactualStatement(s, `stmt_${ulid()}`),
  );

  return NextResponse.json({
    answer_draft: {
      // Tenant-set only — echoed back, never inferred by the LLM.
      general_denial: parsed.data.general_denial ?? null,
      factual_statements,
      // Deterministic placement happens in a later step — empty here.
      form_fields: [],
      status: "draft" as const,
    },
    // Advice-seeking utterances surfaced for human routing (neutral paraphrase only).
    advice_requests: adviceRequests.map((s) => s.text),
    route_to_human: adviceRequests.length > 0,
    model: result.model,
    stop_reason: result.stopReason,
    // "DRAFT — have a lawyer review before filing."
    disclaimer: ANSWER_DRAFT_DISCLAIMER,
  });
}
