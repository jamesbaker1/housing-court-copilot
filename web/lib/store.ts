/**
 * Server-only, DUAL-MODE Case store (v1 persistence foundation).
 *
 * Same public interface as before — createCase / getCase / patchCase / saveCase
 * / listCases and the CaseSummary shape are preserved verbatim so no caller
 * breaks. There are two backends, selected at runtime:
 *
 *   1) Cloudflare D1 (production on Workers via @opennextjs/cloudflare). When a
 *      D1 binding is reachable (getCloudflareContext().env.DB), Cases live in a
 *      single `cases` table: column `doc` holds the full Case JSON (source of
 *      truth) and the other columns (status, case_type, court_date, updated_at,
 *      has_provider_consent, advice_routed) are DERIVED projections re-computed
 *      on every write so listCases() can query/sort without parsing every blob.
 *
 *   2) File-based fallback (plain node / local tooling / tests). When no D1
 *      binding is present, we fall back to the original one-JSON-file-per-Case
 *      behavior (atomic temp-file + rename) so local dev and tests keep working
 *      with no Cloudflare account.
 *
 * Either way: every read and write validates against CaseSchema, so a Case in
 * this store is always schema-valid (or treated as absent/corrupt). Identity
 * fields (case_id, schema_version, tenant_id, created_at) are force-kept on
 * patch so a client can never rewrite a Case's identity, and `updated_at` is
 * bumped on write.
 *
 * SAFETY: the D1 swap does NOT relax any backstop. `doc` is authoritative;
 * court_date_verified, advice_routed, and open-data verify gates all continue
 * to live inside `doc` and are enforced by CaseSchema + the application. The
 * derived columns are advisory indices only.
 *
 * NOTE: this remains a best-effort store for v1 — no cross-process locking;
 * last-writer-wins on concurrent patches (true of both backends).
 */

// Server-only by construction: imports node:fs/promises + node:crypto (used
// ONLY on the file-fallback path) and @opennextjs/cloudflare, so this module
// can never be bundled into a client component.
import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  CaseSchema,
  type Case,
  type CaseType,
} from "@/lib/case";
import { newId } from "@/lib/ids";
import { hasGrantedHandoffConsent } from "@/components/provider/TriageList";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Same char class as the case_id regex in @/lib/case (Crockford base32). */
const CASE_ID_RE = /^case_[0-9a-hjkmnp-tv-z]{26}$/;

/** Top-level identity fields a patch may never change. */
const PROTECTED_KEYS = [
  "case_id",
  "schema_version",
  "tenant_id",
  "created_at",
] as const;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Minimal shape of the D1 binding we use (avoids a hard dep on @cloudflare/workers-types). */
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

/**
 * Resolve the D1 binding if we're running on Cloudflare, else null. Detection is
 * graceful: outside a Workers/OpenNext context getCloudflareContext throws (or
 * there is no env.DB), and we fall through to the file backend.
 */
async function getDB(): Promise<D1Database | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const ctx = await mod.getCloudflareContext({ async: true });
    const db = (ctx?.env as { DB?: unknown } | undefined)?.DB;
    return db ? (db as D1Database) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Derivation: project a Case's indexed columns from its `doc`
// ---------------------------------------------------------------------------

interface DerivedColumns {
  status: string;
  case_type: string;
  court_date: string | null;
  updated_at: string;
  has_provider_consent: number; // 0 | 1
  advice_routed: number; // 0 | 1
}

/** Re-derive the indexed columns from the authoritative Case `doc`. */
function deriveColumns(c: Case): DerivedColumns {
  return {
    status: c.status,
    case_type: c.case_type,
    court_date: c.court?.court_date ?? null,
    updated_at: c.updated_at,
    has_provider_consent: hasGrantedHandoffConsent(c) ? 1 : 0,
    advice_routed: c.review?.advice_routed ? 1 : 0,
  };
}

// ===========================================================================
// File backend (fallback — plain node / local tooling / tests)
// ===========================================================================

function dataDir(): string {
  return process.env.HCC_DATA_DIR || path.join(process.cwd(), ".data", "cases");
}

let ensured = false;
async function ensureDir(): Promise<string> {
  const dir = dataDir();
  if (!ensured) {
    await mkdir(dir, { recursive: true });
    ensured = true;
  }
  return dir;
}

/** Resolve the on-disk path for a validated case id (no traversal possible). */
function caseFilePath(dir: string, caseId: string): string {
  return path.join(dir, `${caseId}.json`);
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const tmp = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, filePath);
}

async function fileSave(valid: Case): Promise<Case> {
  const dir = await ensureDir();
  await writeAtomic(
    caseFilePath(dir, valid.case_id),
    JSON.stringify(valid, null, 2),
  );
  return valid;
}

async function fileGet(caseId: string): Promise<Case | null> {
  const dir = await ensureDir();
  let raw: string;
  try {
    raw = await readFile(caseFilePath(dir, caseId), "utf8");
  } catch {
    return null; // missing
  }
  try {
    return CaseSchema.parse(JSON.parse(raw));
  } catch {
    return null; // corrupt / schema-invalid
  }
}

async function fileList(): Promise<CaseSummary[]> {
  const dir = await ensureDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: CaseSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const caseId = name.slice(0, -".json".length);
    if (!CASE_ID_RE.test(caseId)) continue;
    const c = await fileGet(caseId);
    if (c) out.push(toSummary(c));
  }
  out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return out;
}

// ===========================================================================
// D1 backend (production on Cloudflare Workers)
// ===========================================================================

async function d1Save(db: D1Database, valid: Case): Promise<Case> {
  const col = deriveColumns(valid);
  await db
    .prepare(
      `INSERT INTO cases
         (case_id, doc, status, case_type, court_date, updated_at, has_provider_consent, advice_routed)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(case_id) DO UPDATE SET
         doc = excluded.doc,
         status = excluded.status,
         case_type = excluded.case_type,
         court_date = excluded.court_date,
         updated_at = excluded.updated_at,
         has_provider_consent = excluded.has_provider_consent,
         advice_routed = excluded.advice_routed`,
    )
    .bind(
      valid.case_id,
      JSON.stringify(valid),
      col.status,
      col.case_type,
      col.court_date,
      col.updated_at,
      col.has_provider_consent,
      col.advice_routed,
    )
    .run();
  return valid;
}

async function d1Get(db: D1Database, caseId: string): Promise<Case | null> {
  const row = await db
    .prepare(`SELECT doc FROM cases WHERE case_id = ?1`)
    .bind(caseId)
    .first<{ doc: string }>();
  if (!row) return null;
  try {
    return CaseSchema.parse(JSON.parse(row.doc));
  } catch {
    return null; // corrupt / schema-invalid
  }
}

interface SummaryRow {
  case_id: string;
  status: string;
  case_type: string;
  court_date: string | null;
  updated_at: string;
  advice_routed: number;
  doc: string;
}

async function d1List(db: D1Database): Promise<CaseSummary[]> {
  // Query the indexed columns; only `doc` is parsed for review_state (which is
  // not projected to its own column). Newest-updated first.
  const { results } = await db
    .prepare(
      `SELECT case_id, status, case_type, court_date, updated_at, advice_routed, doc
         FROM cases
        ORDER BY updated_at DESC`,
    )
    .all<SummaryRow>();

  const out: CaseSummary[] = [];
  for (const r of results) {
    if (!CASE_ID_RE.test(r.case_id)) continue;
    let reviewState: string | null = null;
    try {
      const parsed = JSON.parse(r.doc) as { review?: { review_state?: string } };
      reviewState = parsed.review?.review_state ?? null;
    } catch {
      // tolerate a corrupt blob in the index path; doc is still authoritative on read
    }
    out.push({
      case_id: r.case_id,
      status: r.status as Case["status"],
      case_type: r.case_type as CaseType,
      updated_at: r.updated_at,
      court_date: r.court_date,
      advice_routed: r.advice_routed === 1,
      review_state: reviewState,
    });
  }
  return out;
}

// ===========================================================================
// Public interface (preserved verbatim) — dispatch to whichever backend is live
// ===========================================================================

/** Validate, then atomically persist a Case. Returns the parsed Case. */
export async function saveCase(c: Case): Promise<Case> {
  const valid = CaseSchema.parse(c);
  const db = await getDB();
  return db ? d1Save(db, valid) : fileSave(valid);
}

export async function createCase(init?: {
  language?: string;
  case_type?: CaseType;
}): Promise<Case> {
  const ts = nowIso();
  const skeleton: Case = CaseSchema.parse({
    case_id: newId("case"),
    schema_version: "1.0.0",
    tenant_id: newId("ten"),
    case_type: init?.case_type ?? "nonpayment",
    status: "intake",
    language: init?.language ?? "en",
    created_at: ts,
    updated_at: ts,
    audit: {
      created_by: { actor_type: "system" },
      events: [],
    },
  });
  return saveCase(skeleton);
}

/** Read + parse a Case by id. Returns null on missing/corrupt/invalid-id. */
export async function getCase(caseId: string): Promise<Case | null> {
  if (!CASE_ID_RE.test(caseId)) return null;
  const db = await getDB();
  return db ? d1Get(db, caseId) : fileGet(caseId);
}

/**
 * Load, shallow-merge top-level keys (patch replaces whole sub-objects/arrays),
 * force-keep identity fields, bump updated_at, validate, and persist atomically.
 * Returns the updated Case, or null if the Case does not exist.
 */
export async function patchCase(
  caseId: string,
  patch: Partial<Case>,
): Promise<Case | null> {
  const current = await getCase(caseId);
  if (!current) return null;

  const merged: Record<string, unknown> = { ...current, ...patch };
  for (const key of PROTECTED_KEYS) {
    merged[key] = current[key];
  }
  merged.updated_at = nowIso();

  const valid = CaseSchema.parse(merged);
  return saveCase(valid);
}

// ---------------------------------------------------------------------------
// List (lightweight summary for the provider console)
// ---------------------------------------------------------------------------

export interface CaseSummary {
  case_id: string;
  status: Case["status"];
  case_type: CaseType;
  updated_at: string;
  court_date: string | null;
  advice_routed: boolean;
  review_state: string | null;
}

function toSummary(c: Case): CaseSummary {
  return {
    case_id: c.case_id,
    status: c.status,
    case_type: c.case_type,
    updated_at: c.updated_at,
    court_date: c.court?.court_date ?? null,
    advice_routed: c.review?.advice_routed ?? false,
    review_state: c.review?.review_state ?? null,
  };
}

/** List Case summaries, newest-updated first. Tolerates corrupt rows/files. */
export async function listCases(): Promise<CaseSummary[]> {
  const db = await getDB();
  return db ? d1List(db) : fileList();
}
