/**
 * POST /api/kb — retrieve the top vetted knowledge-base entries for a query.
 *
 * Powers a "sources" panel in the UI (so the tenant can see WHICH curated,
 * citable sources ground an answer) and is handy for debugging retrieval. This
 * endpoint serves GENERAL, public, non-advice information only and never gives
 * an individualized answer — it just returns curated entries + their citations.
 *
 * Body: { query: string, k?: number }. Returns { query, k, count, results,
 * review_status }, where each result is { id, topic, question,
 * plain_english_answer, source_name, source_url, tags, score }.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

import { CORPUS_REVIEW_STATUS } from "@/lib/kb/corpus";
import { retrieve } from "@/lib/kb/retrieve";

export const runtime = "nodejs";

const BodySchema = z.object({
  query: z.string().min(1, "query is required"),
  k: z.number().int().min(1).max(20).optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { query, k = 4 } = parsed.data;
  const hits = retrieve(query, k);

  const results = hits.map((h) => ({
    id: h.entry.id,
    topic: h.entry.topic,
    question: h.entry.question,
    plain_english_answer: h.entry.plain_english_answer,
    source_name: h.entry.source_name,
    source_url: h.entry.source_url,
    tags: h.entry.tags,
    score: h.score,
  }));

  return NextResponse.json({
    query,
    k,
    count: results.length,
    results,
    review_status: CORPUS_REVIEW_STATUS,
  });
}
