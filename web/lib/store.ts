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
import { mkdir, readFile, writeFile, rename, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import {
  CaseSchema,
  type Case,
  type CaseType,
} from "@/lib/case";
import { newId } from "@/lib/ids";
import { hasGrantedHandoffConsent } from "@/components/provider/TriageList";
import { sealCasePii, openCasePii } from "@/lib/crypto-field";

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

/**
 * Narrow to a non-null, non-array plain object. Local copy of the (private,
 * un-exported) helper in @/lib/case — duplicated here deliberately to keep this
 * change surgical and avoid widening case.ts's public surface.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
// PII-at-rest encryption (lib/crypto-field) — seal before persist, open on read
// ---------------------------------------------------------------------------

/**
 * Read PII-encryption env. CASE_PII_KEY is a Wrangler SECRET surfaced on the
 * Workers binding env (getCloudflareContext().env); on plain Node / file mode it
 * lives in process.env. CASE_PII_ENCRYPTION_REQUIRED is a non-secret posture flag
 * (same convention as COURT_DATA_VENDOR_AUTHORITATIVE) that turns the no-op
 * passthrough into a fail-closed: when it is set but the key is absent/invalid,
 * the store refuses to read/write rather than persist tenant PII as plaintext.
 */
async function getPiiEnv(): Promise<{ key: string | undefined; required: boolean }> {
  let key: string | undefined;
  let required: string | undefined;
  try {
    const mod = await import("@opennextjs/cloudflare");
    const ctx = await mod.getCloudflareContext({ async: true });
    const env = ctx?.env as
      | { CASE_PII_KEY?: string; CASE_PII_ENCRYPTION_REQUIRED?: string }
      | undefined;
    key = env?.CASE_PII_KEY;
    required = env?.CASE_PII_ENCRYPTION_REQUIRED;
  } catch {
    // not on Workers — fall through to process.env
  }
  if (typeof process !== "undefined") {
    key = key ?? process.env?.CASE_PII_KEY;
    required = required ?? process.env?.CASE_PII_ENCRYPTION_REQUIRED;
  }
  return { key: key || undefined, required: required === "true" || required === "1" };
}

/**
 * Seal the PII subtree before it is written to the store. Fails CLOSED when
 * encryption is REQUIRED but no key is present, so we never silently persist
 * plaintext PII in a deployment that asked for encryption. When not required and
 * no key is set, sealCasePii is a no-op (local dev / file mode keep working).
 */
async function sealForStore(valid: Case): Promise<Record<string, unknown>> {
  const { key, required } = await getPiiEnv();
  if (required && !key) {
    throw new Error(
      "CASE_PII_KEY is required (CASE_PII_ENCRYPTION_REQUIRED is set) but absent; refusing to persist Case PII as plaintext",
    );
  }
  return sealCasePii(valid as unknown as Record<string, unknown>, key);
}

/**
 * Open any sealed PII fields on a doc read from the store, BEFORE CaseSchema.parse.
 * Fails CLOSED when encryption is REQUIRED but no key is present. openCasePii also
 * throws if a sealed envelope is present but the key is missing/wrong (tampering /
 * lost key); callers treat a throw like a corrupt doc (null).
 */
async function openFromStore(raw: unknown): Promise<Record<string, unknown>> {
  const { key, required } = await getPiiEnv();
  if (required && !key) {
    throw new Error(
      "CASE_PII_KEY is required (CASE_PII_ENCRYPTION_REQUIRED is set) but absent; cannot read Case PII",
    );
  }
  return openCasePii(raw as Record<string, unknown>, key);
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
  const sealed = await sealForStore(valid);
  await writeAtomic(
    caseFilePath(dir, valid.case_id),
    JSON.stringify(sealed, null, 2),
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
    return CaseSchema.parse(await openFromStore(JSON.parse(raw)));
  } catch {
    return null; // corrupt / schema-invalid / sealed-without-key
  }
}

async function fileDelete(caseId: string): Promise<boolean> {
  const dir = await ensureDir();
  try {
    await unlink(caseFilePath(dir, caseId));
    return true;
  } catch {
    return false; // missing
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
  // Seal the PII subtree before it lands in `doc`. The derived columns above are
  // re-computed from the plaintext Case (status/court_date/etc. are NOT in the
  // sealed subtree), so the index stays correct.
  const sealed = await sealForStore(valid);
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
      JSON.stringify(sealed),
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
    return CaseSchema.parse(await openFromStore(JSON.parse(row.doc)));
  } catch {
    return null; // corrupt / schema-invalid / sealed-without-key
  }
}

async function d1Delete(db: D1Database, caseId: string): Promise<boolean> {
  const row = await db
    .prepare(`DELETE FROM cases WHERE case_id = ?1 RETURNING case_id`)
    .bind(caseId)
    .first<{ case_id: string }>();
  return row != null;
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
 *
 * EXCEPTION (invariant #2): the `court` subtree is deep-merged preserve-on-omit so
 * a partial court patch that omits court_date_source/court_date_verified cannot
 * silently downgrade a verified court date. See the inline SAFETY note below — this
 * only ever carries the EXISTING persisted value forward; it never grants
 * verified=true (the schema refine remains the backstop for a forged value).
 */
export async function patchCase(
  caseId: string,
  patch: Partial<Case>,
): Promise<Case | null> {
  const current = await getCase(caseId);
  if (!current) return null;

  const merged: Record<string, unknown> = { ...current, ...patch };

  // SAFETY (invariant #2), fail-safe deep-merge of the court subtree. The shallow
  // top-level spread above REPLACES current.court wholesale when the patch carries
  // a court object. A benign tenant patch reaches the store as
  // `court: { court_date: "..." }` with NO court_date_source/court_date_verified
  // (the API route strips them via stripSafetyOwnedFields), and that replacement
  // would silently downgrade a previously-verified eTrack/NYSCEF date back to the
  // schema default (verified=false) — disarming reminders once a verified path is
  // live. So we PRESERVE-ON-OMIT: when the incoming court patch OMITS a
  // safety-owned key, carry forward the value already persisted by the
  // deterministic writer (lib/court-date.setCourtDate).
  //
  // This NEVER newly grants verified=true: we use a presence test (`'key' in`),
  // not truthiness, so an explicitly-supplied key flows through to CaseSchema.parse
  // below — and CourtSchema.superRefine still rejects a client-forged
  // verified=true paired with a non-authoritative source. The authoritative
  // writers always emit the FULL court subtree (both keys present), so the `in`
  // checks fall through to their values: no behavior change for that path.
  if (patch.court !== undefined && isPlainObject(patch.court) && current.court) {
    const incoming = patch.court as Record<string, unknown>;
    const preserved: Record<string, unknown> = { ...incoming };
    if (!("court_date_source" in incoming)) {
      preserved.court_date_source = current.court.court_date_source;
    }
    if (!("court_date_verified" in incoming)) {
      preserved.court_date_verified = current.court.court_date_verified;
    }
    merged.court = preserved;
  }

  for (const key of PROTECTED_KEYS) {
    merged[key] = current[key];
  }
  merged.updated_at = nowIso();

  const valid = CaseSchema.parse(merged);
  return saveCase(valid);
}

/**
 * Permanently delete a Case by id. Returns true if a Case was removed, false if
 * none existed. Used by the owner-initiated tenant delete path and Ops retention
 * (cron purge). Invalid ids return false without touching the store.
 */
export async function deleteCase(caseId: string): Promise<boolean> {
  if (!CASE_ID_RE.test(caseId)) return false;
  const db = await getDB();
  return db ? d1Delete(db, caseId) : fileDelete(caseId);
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

// ---------------------------------------------------------------------------
// List (consent-filtered) — provider triage inbox
// ---------------------------------------------------------------------------
//
// ADDITIVE helper for the provider console (S12 perf). listCases() above reads
// the WHOLE table and the caller then getCase()s every row only to drop the
// non-consented majority — an O(2N) full read of tenant PII blobs. This helper
// instead filters to the CONSENTED subset at the SQL/index level so the caller
// only getCase()s rows that can actually appear in the queue.
//
// IMPORTANT: this still returns the lightweight CaseSummary set (no triage
// fields) — the provider route/page must still getCase() each id to build a
// TriageRow (toTriageRow needs the full Case). The win is purely that we no
// longer touch the non-consented rows' `doc` blobs. Sort matches the queue's
// own ordering (soonest court date first; null court dates sink last; then
// newest-updated), mirroring compareTriageRows so the pre-sorted set is stable.

/** Map a D1 SummaryRow (reused from d1List) to a CaseSummary, tolerating a corrupt blob. */
function summaryRowToCaseSummary(r: SummaryRow): CaseSummary {
  let reviewState: string | null = null;
  try {
    const parsed = JSON.parse(r.doc) as { review?: { review_state?: string } };
    reviewState = parsed.review?.review_state ?? null;
  } catch {
    // tolerate a corrupt blob in the index path; doc is still authoritative on read
  }
  return {
    case_id: r.case_id,
    status: r.status as Case["status"],
    case_type: r.case_type as CaseType,
    updated_at: r.updated_at,
    court_date: r.court_date,
    advice_routed: r.advice_routed === 1,
    review_state: reviewState,
  };
}

async function d1ListConsented(db: D1Database): Promise<CaseSummary[]> {
  // WHERE has_provider_consent = 1 lets the planner use idx_cases_consent_court_date
  // (has_provider_consent, court_date). `court_date IS NULL` sinks null court dates
  // last so the ordering matches compareTriageRows; only `doc` is parsed (for
  // review_state, which has no projected column).
  const { results } = await db
    .prepare(
      `SELECT case_id, status, case_type, court_date, updated_at, advice_routed, doc
         FROM cases
        WHERE has_provider_consent = 1
        ORDER BY court_date IS NULL, court_date ASC`,
    )
    .all<SummaryRow>();

  const out: CaseSummary[] = [];
  for (const r of results) {
    if (!CASE_ID_RE.test(r.case_id)) continue;
    out.push(summaryRowToCaseSummary(r));
  }
  return out;
}

async function fileListConsented(): Promise<CaseSummary[]> {
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
    // Consent filter at the read level — the file backend has no index, so this
    // mirrors the D1 WHERE by skipping non-consented Cases (fail-closed: an
    // unreadable/corrupt Case is dropped by fileGet returning null).
    if (c && hasGrantedHandoffConsent(c)) out.push(toSummary(c));
  }
  // Match the D1 ordering: soonest court date first, null court dates last,
  // then newest-updated (mirrors compareTriageRows).
  out.sort((a, b) => {
    if (a.court_date && b.court_date) {
      return a.court_date < b.court_date ? -1 : a.court_date > b.court_date ? 1 : 0;
    }
    if (a.court_date) return -1;
    if (b.court_date) return 1;
    return a.updated_at < b.updated_at ? 1 : -1;
  });
  return out;
}

/**
 * List Case summaries for ONLY the cases with a granted, live
 * handoff_to_provider consent — the provider triage inbox subset. Same dual-mode
 * dispatch as listCases(), but the consent filter runs at the SQL/index level
 * (D1) or at the read level (file backend) so callers avoid reading the
 * non-consented majority's PII. Sorted soonest-court-date-first (null last).
 */
export async function listConsentedCases(): Promise<CaseSummary[]> {
  const db = await getDB();
  return db ? d1ListConsented(db) : fileListConsented();
}
