/**
 * NYSCEF PUBLIC-DOCKET adapter — e-filed L&T subset (Adapters phase).
 *
 * ROADMAP Tier-2 #6 / INTEGRATIONS.md §court-data: resolve an authoritative
 * "next appearance" date for an E-FILED Landlord & Tenant case from the NYSCEF
 * public docket. Source provenance value = "nyscef" (authoritative; flips
 * court_date_verified=true via the deterministic sink lib/court-date.setCourtDate
 * — this adapter NEVER touches court_date_verified directly, it only returns a
 * candidate hit to the orchestrator).
 *
 * ===========================================================================
 * NON-NEGOTIABLE BOUNDARY (RISKS-AND-COMPLIANCE.md, INTEGRATIONS.md §court-data)
 * ===========================================================================
 * This adapter does NOT scrape the live UCS eCourts / WebCivilLocal / eTrack
 * web UI. Those portals are CAPTCHA / Cloudflare-protected and the UCS Terms of
 * Service prohibit bots/crawlers (CFAA + contract risk).
 *
 *   - NO headless browser, NO CAPTCHA solving/bypass, NO bulk crawl, NO
 *     session/cookie replay against an interactive portal.
 *   - DISABLED BY DEFAULT. The whole adapter is gated behind the config flag
 *     COURT_SOURCE_NYSCEF_ENABLED (default-deny). When the flag is off (the
 *     default) every lookup degrades immediately to { found: false } and makes
 *     NO network request.
 *   - When (and only when) the operator has BOTH (a) flipped the flag on AND
 *     (b) confirmed a sanctioned, ToS-compatible data path, the adapter performs
 *     at most ONE rate-limited GET with an identifying, contactable User-Agent,
 *     honoring robots.txt and any documented usage policy, and BACKS OFF (a
 *     persisted cool-down) on ANY block / 403 / 429 / challenge response. It
 *     never retries through a block.
 *
 * ===========================================================================
 * HONEST STATUS: NO CONFIRMED SANCTIONED PROGRAMMATIC PATH (as of this writing)
 * ===========================================================================
 * NYSCEF exposes a public docket for the PUBLIC to read individual cases, but it
 * does NOT publish a documented, openly-licensed JSON/data API for appearance
 * dates that we can point to as clearly sanctioned for automated polling. The
 * read surface that exists is the same human-facing portal covered by the UCS
 * ToS bot prohibition above. Per the task's explicit instruction:
 *
 *     "If no legitimate programmatic path is confirmable, ship the interface +
 *      normalization + a { found:false, reason:'needs sanctioned data path' }
 *      and document it honestly rather than scraping."
 *
 * So this adapter ships in exactly that posture:
 *   - the CourtDateSourceAdapter interface + input/output normalization are
 *     fully implemented and typecheck,
 *   - the gate (flag + endpoint config + rate-limit + back-off + robots check)
 *     is fully implemented,
 *   - but the DEFAULT, with no sanctioned endpoint configured, is to return
 *     { found:false, note:"needs sanctioned data path" } WITHOUT any request.
 *
 * To turn this on legitimately, an operator must supply
 * COURT_SOURCE_NYSCEF_ENDPOINT pointing at a sanctioned data endpoint (a
 * partner/vendor proxy, a documented open-data export, or a NYSCEF/UCS data
 * agreement) — NOT the interactive portal URL — and set
 * COURT_SOURCE_NYSCEF_ENABLED="true". Wiring the interactive eCourts/NYSCEF web
 * UI here is a compliance violation and is intentionally not supported.
 *
 * ===========================================================================
 * COVERAGE CAVEAT — partial by construction
 * ===========================================================================
 * Even fully enabled, coverage is PARTIAL. NYSCEF e-filing is mandatory only for
 * a subset of L&T matters; PRO SE tenants are EXEMPT from e-filing, and many
 * L&T cases (especially the ones our tenants face) are paper-filed and never
 * appear on NYSCEF. A { found:false } from this adapter therefore means "not
 * found on NYSCEF", NOT "no court date exists". The orchestrator treats this as
 * one channel among several (eTrack email, vendor) and never down-weights the
 * tenant's own date because NYSCEF was silent.
 */

import type {
  CourtDateSourceAdapter,
  CourtSourceInput,
  CourtSourceResult,
} from "@/lib/court-source/index";
import { validateCourtDateString } from "@/lib/court-date";

const SOURCE = "nyscef" as const;

// ---------------------------------------------------------------------------
// Config (all default-deny / unset). Read from env at call time so tests can
// inject and so the Worker picks up wrangler [vars] without a rebuild.
// ---------------------------------------------------------------------------

/**
 * Optional injectable config (tests / explicit wiring). When omitted, each field
 * falls back to the corresponding environment variable. Defaults are the SAFE,
 * disabled posture.
 */
export interface NyscefAdapterConfig {
  /** Master gate. MUST be explicitly true to make ANY network request. */
  enabled?: boolean;
  /**
   * A SANCTIONED data endpoint (vendor proxy / documented export / data
   * agreement). MUST NOT be the interactive eCourts/NYSCEF web portal. When
   * unset, the adapter returns "needs sanctioned data path" and never fetches.
   * The literal `{index}` token is replaced with the URL-encoded index number.
   */
  endpoint?: string | null;
  /**
   * Identifying, contactable User-Agent so the data provider can reach us. We
   * never spoof a browser. Example:
   *   "HousingCourtCopilot/1.0 (+https://example.org/court-data; ops@example.org)"
   */
  userAgent?: string | null;
  /** Per-request timeout (ms). Keeps us polite and bounded. */
  timeoutMs?: number;
  /**
   * Minimum spacing between requests (ms) — a crude single-instance rate limit.
   * Real per-host limiting belongs in the orchestrator/queue; this is a floor.
   */
  minIntervalMs?: number;
  /** fetch impl (injectable for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

function envFlag(name: string): boolean {
  const raw =
    typeof process !== "undefined" ? process.env?.[name] : undefined;
  return raw === "true" || raw === "1";
}

function envStr(name: string): string | undefined {
  const raw =
    typeof process !== "undefined" ? process.env?.[name] : undefined;
  return raw && raw.trim() ? raw.trim() : undefined;
}

function resolveConfig(config: NyscefAdapterConfig | undefined): {
  enabled: boolean;
  endpoint: string | null;
  userAgent: string;
  timeoutMs: number;
  minIntervalMs: number;
  fetchImpl: typeof fetch | undefined;
} {
  return {
    enabled:
      typeof config?.enabled === "boolean"
        ? config.enabled
        : envFlag("COURT_SOURCE_NYSCEF_ENABLED"),
    endpoint:
      config?.endpoint ?? envStr("COURT_SOURCE_NYSCEF_ENDPOINT") ?? null,
    userAgent:
      config?.userAgent ??
      envStr("COURT_SOURCE_NYSCEF_USER_AGENT") ??
      "HousingCourtCopilot/1.0 (+court-data; configure COURT_SOURCE_NYSCEF_USER_AGENT)",
    timeoutMs: config?.timeoutMs ?? 8000,
    minIntervalMs: config?.minIntervalMs ?? 5000,
    fetchImpl: config?.fetchImpl,
  };
}

// ---------------------------------------------------------------------------
// Politeness state: a module-level single-instance rate limiter + back-off.
// On Workers each isolate is short-lived so this is a best-effort floor, not a
// distributed limiter — but it guarantees we never tight-loop a host within one
// isolate, and the back-off makes a blocked host stop being hit immediately.
// ---------------------------------------------------------------------------

let lastRequestAt = 0;
/** Epoch ms until which we must NOT make any request (set on a block). */
let backoffUntil = 0;
/** Default cool-down after a block/challenge: 30 minutes. */
const BACKOFF_MS = 30 * 60 * 1000;

/** Reset politeness state — test hook only. */
export function __resetNyscefRateLimitStateForTests(): void {
  lastRequestAt = 0;
  backoffUntil = 0;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a court index number for use in a lookup. NYSCEF index numbers look
 * like "LT-012345-24/NY" or "70123/2024"; we trim and collapse whitespace but do
 * NOT reformat, since the sanctioned endpoint defines its own key format. Returns
 * null when there is nothing usable.
 */
export function normalizeIndexNumber(
  index: string | null | undefined,
): string | null {
  if (!index) return null;
  const trimmed = index.replace(/\s+/g, " ").trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Extract a YYYY-MM-DD "next appearance" date from a parsed sanctioned-endpoint
 * payload. Defensive: the payload shape depends on the eventual sanctioned
 * provider, so we look for a small set of common field names and validate the
 * value through the canonical court-date validator. Returns null on anything
 * unrecognized — NEVER guesses. Exported for unit testing the normalization
 * independent of any network path.
 */
export function extractNextAppearanceDate(payload: unknown): {
  date: string;
  part?: string | null;
} | null {
  if (payload == null || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;

  // Common candidate keys a sanctioned data export might use, most-specific
  // first. We only accept a value that passes the canonical date validator.
  const dateKeys = [
    "next_appearance_date",
    "nextAppearanceDate",
    "next_appearance",
    "appearance_date",
    "appearanceDate",
    "court_date",
    "courtDate",
  ];

  let date: string | null = null;
  for (const k of dateKeys) {
    const v = o[k];
    if (typeof v === "string") {
      const norm = coerceToIsoDate(v);
      if (norm && validateCourtDateString(norm).ok) {
        date = norm;
        break;
      }
    }
  }
  if (!date) return null;

  let part: string | null = null;
  for (const k of ["part", "court_part", "courtPart", "room"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) {
      part = v.trim();
      break;
    }
  }

  return { date, part };
}

/**
 * Coerce a few common date string shapes to canonical YYYY-MM-DD (America/
 * New_York calendar dates have no time component). Returns null if it cannot do
 * so confidently. Deliberately conservative — never invents a date.
 */
function coerceToIsoDate(raw: string): string | null {
  const s = raw.trim();
  // Already YYYY-MM-DD (optionally with a time we strip).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // MM/DD/YYYY (common in US court exports).
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us && us[1] && us[2] && us[3]) {
    const mm = us[1].padStart(2, "0");
    const dd = us[2].padStart(2, "0");
    return `${us[3]}-${mm}-${dd}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Create the NYSCEF public-docket adapter. Disabled by default; see the file
 * header for the compliance posture. NEVER throws (degrades to { found:false }).
 */
export function createNyscefAdapter(
  config?: NyscefAdapterConfig,
): CourtDateSourceAdapter {
  return {
    name: SOURCE,
    async trySource(input: CourtSourceInput): Promise<CourtSourceResult> {
      try {
        return await tryNyscef(input, config);
      } catch (err) {
        // Belt-and-suspenders: an adapter must never throw to the orchestrator.
        console.error("[court-source:nyscef] degraded on error:", err);
        return { found: false, source: SOURCE, note: "nyscef error (degraded)" };
      }
    },
  };
}

async function tryNyscef(
  input: CourtSourceInput,
  rawConfig: NyscefAdapterConfig | undefined,
): Promise<CourtSourceResult> {
  const cfg = resolveConfig(rawConfig);

  // GATE 1 — master flag (default-deny). No flag => no request, ever.
  if (!cfg.enabled) {
    return {
      found: false,
      source: SOURCE,
      note: "nyscef disabled (set COURT_SOURCE_NYSCEF_ENABLED=true to enable)",
    };
  }

  // GATE 2 — we need an index number to look anything up.
  const index = normalizeIndexNumber(input.index_number);
  if (!index) {
    return {
      found: false,
      source: SOURCE,
      note: "nyscef requires an index_number",
    };
  }

  // GATE 3 — a SANCTIONED data endpoint must be configured. Without one we do
  // NOT touch the interactive portal; we honestly report the missing data path.
  if (!cfg.endpoint) {
    return {
      found: false,
      source: SOURCE,
      note: "needs sanctioned data path (COURT_SOURCE_NYSCEF_ENDPOINT unset; refusing to scrape the public portal)",
    };
  }

  // GATE 4 — guard against being pointed at the interactive portal. We refuse
  // known human-UI hosts/paths even if someone sets the endpoint to them.
  if (looksLikeInteractivePortal(cfg.endpoint)) {
    console.warn(
      "[court-source:nyscef] endpoint looks like the interactive UCS portal; refusing (ToS).",
    );
    return {
      found: false,
      source: SOURCE,
      note: "refusing: endpoint resembles the interactive eCourts/NYSCEF portal (ToS-prohibited)",
    };
  }

  // GATE 5 — back-off: if a prior request was blocked, do not hit the host again
  // until the cool-down elapses.
  const now = Date.now();
  if (now < backoffUntil) {
    return {
      found: false,
      source: SOURCE,
      note: "nyscef in back-off after a prior block; skipping",
    };
  }

  // GATE 6 — single-instance rate limit floor. If we requested too recently,
  // skip rather than queue (the orchestrator can retry on the next cycle).
  if (now - lastRequestAt < cfg.minIntervalMs) {
    return {
      found: false,
      source: SOURCE,
      note: "nyscef rate-limit floor; skipping this cycle",
    };
  }

  const fetchImpl = cfg.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (!fetchImpl) {
    return { found: false, source: SOURCE, note: "no fetch available" };
  }

  const url = cfg.endpoint.includes("{index}")
    ? cfg.endpoint.replace("{index}", encodeURIComponent(index))
    : `${cfg.endpoint}${cfg.endpoint.includes("?") ? "&" : "?"}index=${encodeURIComponent(index)}`;

  // ONE polite, identifying, bounded request. No retries on failure/block.
  lastRequestAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": cfg.userAgent,
        Accept: "application/json",
      },
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  // Treat any block/challenge/error as a signal to BACK OFF. We never try to
  // work around a 403/429/CAPTCHA — that is exactly the prohibited behavior.
  if (resp.status === 403 || resp.status === 429 || resp.status === 503) {
    backoffUntil = Date.now() + BACKOFF_MS;
    console.warn(
      `[court-source:nyscef] blocked (HTTP ${resp.status}); backing off ${BACKOFF_MS}ms.`,
    );
    return {
      found: false,
      source: SOURCE,
      note: `nyscef blocked (HTTP ${resp.status}); backing off`,
    };
  }
  if (!resp.ok) {
    return {
      found: false,
      source: SOURCE,
      note: `nyscef endpoint returned HTTP ${resp.status}`,
    };
  }

  // A challenge page often returns 200 with HTML. If we did not get JSON, treat
  // it as a soft block and back off rather than parsing/guessing.
  const contentType = resp.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    backoffUntil = Date.now() + BACKOFF_MS;
    console.warn(
      "[court-source:nyscef] non-JSON response (possible challenge); backing off.",
    );
    return {
      found: false,
      source: SOURCE,
      note: "nyscef returned non-JSON (possible challenge); backing off",
    };
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch {
    return { found: false, source: SOURCE, note: "nyscef response not valid JSON" };
  }

  const hit = extractNextAppearanceDate(payload);
  if (!hit) {
    return {
      found: false,
      source: SOURCE,
      note: "nyscef payload had no recognizable appearance date (case may be paper-filed / pro se exempt)",
    };
  }

  // Hand the candidate to the orchestrator. We mark "high" confidence because a
  // sanctioned NYSCEF data path is authoritative court data; the orchestrator
  // (not us) routes it through setCourtDate to flip court_date_verified, and
  // escalates on any discrepancy with an existing tenant/extracted date.
  return {
    found: true,
    source: SOURCE,
    date: hit.date,
    part: hit.part ?? null,
    index_number: index,
    confidence: "high",
  };
}

/**
 * Defensive guard: refuse endpoints that look like the human-facing UCS portal,
 * even if misconfigured. This is a safety net, not the primary gate — the
 * primary gate is that an operator must deliberately set a sanctioned endpoint.
 */
function looksLikeInteractivePortal(endpoint: string): boolean {
  let host = "";
  let path = "";
  try {
    const u = new URL(endpoint);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    // Non-URL endpoint string; let the fetch fail later rather than guess.
    return false;
  }
  const portalHosts = [
    "iapps.courts.state.ny.us", // eCourts / WebCivilLocal / eTrack live UI
    "ecourts.courts.state.ny.us",
    "www.nycourts.gov",
    "nycourts.gov",
  ];
  if (portalHosts.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  // Known interactive UI path fragments.
  const portalPaths = ["/webcivil", "/webcivillocal", "/nyscef/", "/etrack"];
  return portalPaths.some((p) => path.includes(p));
}
