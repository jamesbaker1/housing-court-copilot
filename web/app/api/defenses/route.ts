/**
 * POST /api/defenses — defense-spotting.
 *
 * Body: { narrative?, confirmed_facts?, candidate_defense_codes?, evidence?, language? }
 * Returns a defenses_checklist[] of POSSIBILITIES (information, not advice).
 *
 * The LLM authors only the explanation / relevance signal / candidate code; the
 * route deterministically stamps `surfaced_as="information_not_advice"`,
 * `attorney_reviewed=false`, and leaves `attorney_disposition` unset
 * (GUARDRAILS §0.3 / §2.3 / §14). On a refusal/unparseable result we fail safe:
 * return an empty checklist + a route-to-human flag rather than fabricate.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  spotDefenses,
  toChecklistItem,
  type DefenseSpotInput,
} from "@/lib/llm/defenses";
import { DefenseCodeSchema, type DefenseChecklistItem } from "@/lib/case";
import { DisclaimerContext, getDisclaimer } from "@/lib/disclaimers";
import { screenTurn } from "@/lib/llm/advice-classifier";
import { limitPublicApi, checkLlmGlobalLimit } from "@/lib/ratelimit";
import { verifyTurnstile, extractTurnstileToken } from "@/lib/turnstile";

export const runtime = "nodejs";

const EvidenceContextSchema = z.object({
  evidence_id: z.string(),
  evidence_type: z.string().optional(),
  summary: z.string().nullable().optional(),
  open_data_verified: z.boolean().optional(),
});

const RequestSchema = z.object({
  narrative: z.string().nullable().optional(),
  confirmed_facts: z.record(z.unknown()).optional(),
  candidate_defense_codes: z.array(DefenseCodeSchema).optional(),
  evidence: z.array(EvidenceContextSchema).optional(),
  language: z.string().optional(),
  /** Cloudflare Turnstile token (bot protection). */
  turnstileToken: z.string().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  // Rate limit (cost-DoS protection).
  const limit = await limitPublicApi(request, "defenses");
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

  // LLM global spend ceiling (M12): the last gate before any Anthropic call
  // (incl. the advice classifier) so a cost-DoS cannot run up unbounded spend.
  if (!(await checkLlmGlobalLimit())) {
    return NextResponse.json(
      { error: "at_capacity", message: "Service is temporarily at capacity. Please try again later." },
      { status: 503 },
    );
  }

  const disclaimerEarly = getDisclaimer(DisclaimerContext.Defense);

  // Invariant #1: run the fail-closed advice classifier on the RAW narrative
  // BEFORE the authoring LLM call. A positive suppresses the checklist entirely
  // and routes to a human. The model's own refusal/route stays a SECONDARY
  // backstop below.
  const narrative = parsed.data.narrative;
  if (narrative && narrative.trim().length > 0) {
    let screen;
    try {
      screen = await screenTurn({
        turnText: narrative,
        turnContext: "evidence_narrative",
        language: parsed.data.language ?? "en",
      });
    } catch {
      screen = { decision: "route_to_human" as const, runs: [], any_positive: true };
    }
    if (screen.decision === "route_to_human") {
      return NextResponse.json({
        defenses_checklist: [] as DefenseChecklistItem[],
        route_to_human: true,
        stop_reason: "advice_screen_route_to_human",
        model: null,
        disclaimer: disclaimerEarly,
      });
    }
  }

  const input: DefenseSpotInput = parsed.data;

  let result;
  try {
    result = await spotDefenses(input);
  } catch (err) {
    console.error("spotDefenses failed", err);
    return NextResponse.json({ error: "llm_error" }, { status: 502 });
  }

  const disclaimer = getDisclaimer(DisclaimerContext.Defense);

  // Fail safe: refusal / unparseable → no checklist, route to a human.
  if (result.items === null) {
    return NextResponse.json({
      defenses_checklist: [] as DefenseChecklistItem[],
      route_to_human: true,
      stop_reason: result.stopReason,
      model: result.model,
      disclaimer,
    });
  }

  const defenses_checklist: DefenseChecklistItem[] =
    result.items.map(toChecklistItem);

  return NextResponse.json({
    defenses_checklist,
    route_to_human: false,
    model: result.model,
    stop_reason: result.stopReason,
    // A trust feature, not a footer — surfaced with every defense list.
    disclaimer,
  });
}
