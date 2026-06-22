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
import { screenTurn } from "@/lib/llm/advice-classifier";
import { limitPublicApi } from "@/lib/ratelimit";
import { verifyTurnstile, extractTurnstileToken } from "@/lib/turnstile";

export const runtime = "nodejs";

const RequestSchema = z.object({
  raw_statements: z.string().min(1, "raw_statements is required"),
  language: z.string().optional(),
  /** Tenant-set general-denial flag. NEVER decided by the LLM. */
  general_denial: z.boolean().nullable().optional(),
  /** Cloudflare Turnstile token (bot protection). */
  turnstileToken: z.string().optional(),
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
  // Rate limit (cost-DoS protection).
  const limit = await limitPublicApi(request, "answer");
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

  // Invariant #1: run the fail-closed advice classifier on the RAW free-text
  // BEFORE the authoring LLM call. A positive suppresses the draft entirely and
  // routes to a human. The authoring model's self-reported is_advice_request
  // stays as a SECONDARY backstop below.
  let screen;
  try {
    screen = await screenTurn({
      turnText: parsed.data.raw_statements,
      turnContext: "answer_free_text",
      language: parsed.data.language ?? "en",
    });
  } catch {
    screen = { decision: "route_to_human" as const, runs: [], any_positive: true };
  }
  if (screen.decision === "route_to_human") {
    return NextResponse.json({
      answer_draft: {
        general_denial: parsed.data.general_denial ?? null,
        factual_statements: [] as FactualStatement[],
        form_fields: [],
        status: "draft" as const,
      },
      advice_requests: [] as string[],
      route_to_human: true,
      stop_reason: "advice_screen_route_to_human",
      model: null,
      disclaimer: ANSWER_DRAFT_DISCLAIMER,
    });
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
