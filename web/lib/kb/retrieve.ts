/**
 * Dependency-free retrieval over the curated KB corpus (no embeddings, no
 * network). A small TF-IDF-ish keyword scorer: it tokenizes the query and each
 * entry's searchable text, weights rarer terms higher (inverse document
 * frequency), and boosts matches that land on an entry's `tags`. Good enough to
 * surface the right vetted entries for a tenant's GENERAL question, fully
 * deterministic and offline.
 *
 * Used by lib/llm/copilot.ts to ground the copilot's answers and to power
 * /api/kb (a sources / debugging panel).
 */

import { KB_CORPUS, type KbEntry } from "@/lib/kb/corpus";

/** A scored retrieval hit. */
export interface KbHit {
  entry: KbEntry;
  /** Relevance score (higher = better). 0 means no term overlap. */
  score: number;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/** Very small English stopword set — drop high-frequency words that add noise. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does",
  "for", "from", "have", "how", "i", "if", "in", "is", "it", "its", "me", "my",
  "no", "not", "of", "on", "or", "so", "that", "the", "their", "them", "there",
  "they", "this", "to", "up", "was", "we", "what", "when", "where", "which",
  "who", "why", "will", "with", "you", "your",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords + very short tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ---------------------------------------------------------------------------
// Index (built once at module load — the corpus is static)
// ---------------------------------------------------------------------------

interface IndexedDoc {
  entry: KbEntry;
  /** Term -> count over the entry's full searchable text. */
  termFreq: Map<string, number>;
  /** Set of terms appearing in the entry's tags (for a match boost). */
  tagTerms: Set<string>;
  /** Total token count, for length normalization. */
  length: number;
}

/** The searchable text for an entry: question + answer + topic + tags. */
function searchableText(e: KbEntry): string {
  return [e.question, e.plain_english_answer, e.topic, ...e.tags].join(" ");
}

function buildIndex(): { docs: IndexedDoc[]; idf: Map<string, number> } {
  const docs: IndexedDoc[] = KB_CORPUS.map((entry) => {
    const tokens = tokenize(searchableText(entry));
    const termFreq = new Map<string, number>();
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);

    const tagTerms = new Set<string>();
    for (const tag of entry.tags) for (const t of tokenize(tag)) tagTerms.add(t);

    return { entry, termFreq, tagTerms, length: tokens.length || 1 };
  });

  // IDF: log(N / (1 + df)). Rarer terms across the corpus weigh more.
  const N = docs.length;
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const term of d.termFreq.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((N + 1) / (1 + count)) + 1);
  }

  return { docs, idf };
}

const { docs: INDEX, idf: IDF } = buildIndex();

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Extra multiplier when a query term also appears in the entry's tags. */
const TAG_BOOST = 1.75;

function scoreDoc(doc: IndexedDoc, queryTerms: string[]): number {
  let score = 0;
  for (const term of queryTerms) {
    const tf = doc.termFreq.get(term);
    if (!tf) continue;
    const idf = IDF.get(term) ?? 1;
    // Length-normalized tf-idf; small boost when the hit is on a tag.
    const tfNorm = tf / doc.length;
    const boost = doc.tagTerms.has(term) ? TAG_BOOST : 1;
    score += tfNorm * idf * boost;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the top-`k` corpus entries for `query`, best first. Entries with no
 * term overlap (score 0) are excluded, so the result may be shorter than `k`
 * (and empty when nothing in the curated corpus is relevant — the copilot then
 * says it is not sure and routes to a person).
 */
export function retrieve(query: string, k = 4): KbHit[] {
  const queryTerms = tokenize(query ?? "");
  if (queryTerms.length === 0) return [];

  const hits: KbHit[] = [];
  for (const doc of INDEX) {
    const score = scoreDoc(doc, queryTerms);
    if (score > 0) hits.push({ entry: doc.entry, score });
  }

  hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  return hits.slice(0, Math.max(0, k));
}
