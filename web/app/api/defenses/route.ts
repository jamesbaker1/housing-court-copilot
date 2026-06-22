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
});

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
