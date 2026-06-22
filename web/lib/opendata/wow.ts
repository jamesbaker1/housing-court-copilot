/**
 * JustFix "Who Owns What" (WoW) ownership/portfolio lookup, keyed by BBL.
 *
 * WoW aggregates HPD registration + ACRIS into a landlord-portfolio view: given a
 * building (BBL) it returns the registered owner/portfolio, an approximate count
 * of buildings in the same portfolio, and "landlord indicator" history. We use it
 * ONLY as a corroborating, NON-AUTHORITATIVE signal — index.ts wraps every WoW
 * finding in an OpenDataAssertion whose `verify_before_file` gate starts
 * `unverified`, and nothing is ever auto-filed (TOOL-CONTRACTS §5).
 *
 * The public API is keyless. We hit the aggregate endpoint; shell-company /
 * portfolio inferences are leads to verify, never legal conclusions.
 *
 * Like the HPD lookups (hpd.ts), NOTHING here throws: every network / HTTP /
 * parse failure returns a partial result with `ok:false` + a human `note`, so the
 * orchestrator degrades gracefully. Pure read — no Case mutation here.
 */

// JustFix WoW public API. The aggregate endpoint summarizes a BBL's portfolio.
const WOW_BASE = "https://wowapi.justfix.org/api";

/** Which upstream call produced the result (for the reviewer + debugging). */
export type WowSource = "none" | "aggregate";

export interface WowPortfolio {
  /** Approximate number of buildings in the same ownership portfolio. */
  building_count: number | null;
  /** Approximate number of residential units across the portfolio, if known. */
  unit_count: number | null;
}

export interface WowResult {
  ok: boolean;
  /** Stable WoW/portfolio identifier when available (else null). */
  wow_landlord_id: string | null;
  /** Registered owner / portfolio name WoW associates with this BBL. */
  registered_owner_name: string | null;
  /** Portfolio-size signal (leads to verify, not conclusions). */
  portfolio: WowPortfolio | null;
  /** WoW "landlord indicator" history, passed through descriptively if present. */
  indicator_history: unknown[] | null;
  /** Best-effort dataset freshness marker (YYYY-MM-DD), if the API reports one. */
  dataset_last_updated: string | null;
  /** Which call produced the data. */
  source_used: WowSource;
  endpoint: string | null;
  note: string | null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  return null;
}

/** Normalize a date-ish field to YYYY-MM-DD (or null). */
function toDate(v: unknown): string | null {
  const s = typeof v === "string" ? v : null;
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}

/**
 * Look up a building's ownership/portfolio in WoW by 10-digit BBL.
 *
 * The aggregate endpoint accepts the BBL directly. The response shape has varied
 * across WoW versions, so we read defensively: we accept either a bare object or
 * a `{ result: [...] }` / `{ result: {...} }` envelope and pull the first row.
 */
export async function lookupWhoOwnsWhat(
  bbl: string,
  opts: { signal?: AbortSignal } = {},
): Promise<WowResult> {
  const endpoint = `${WOW_BASE}/address/aggregate?bbl=${encodeURIComponent(bbl)}`;
  try {
    const res = await fetch(endpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: opts.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`WoW aggregate HTTP ${res.status}`);
    }
    const json = (await res.json()) as unknown;

    // Unwrap the common envelopes: { result: [...] } | { result: {...} } | {...}.
    let row: Record<string, unknown> | null = null;
    if (json && typeof json === "object") {
      const obj = json as Record<string, unknown>;
      const result = obj.result;
      if (Array.isArray(result)) {
        row = (result[0] as Record<string, unknown>) ?? null;
      } else if (result && typeof result === "object") {
        row = result as Record<string, unknown>;
      } else {
        row = obj;
      }
    }

    if (!row) {
      return {
        ok: true,
        wow_landlord_id: null,
        registered_owner_name: null,
        portfolio: null,
        indicator_history: null,
        dataset_last_updated: null,
        source_used: "aggregate",
        endpoint,
        note: "No ownership/portfolio record found for this building.",
      };
    }

    const building_count =
      num(row.bldgs) ?? num(row.buildings) ?? num(row.building_count);
    const unit_count =
      num(row.units) ?? num(row.unitsres) ?? num(row.unit_count);
    const owner =
      str(row.ownernames) ??
      str(row.registered_owner_name) ??
      str(row.landlord_name) ??
      str(row.name);
    const landlordId =
      str(row.landlord_id) ?? str(row.portfolio_id) ?? str(row.id);
    const indicator = Array.isArray(row.indicatorHistory)
      ? (row.indicatorHistory as unknown[])
      : Array.isArray(row.indicator_history)
        ? (row.indicator_history as unknown[])
        : null;

    return {
      ok: true,
      wow_landlord_id: landlordId,
      registered_owner_name: owner,
      portfolio:
        building_count != null || unit_count != null
          ? { building_count, unit_count }
          : null,
      indicator_history: indicator,
      dataset_last_updated:
        toDate(row.lastupdated) ?? toDate(row.dataset_last_updated),
      source_used: "aggregate",
      endpoint,
      note: null,
    };
  } catch (err) {
    return {
      ok: false,
      wow_landlord_id: null,
      registered_owner_name: null,
      portfolio: null,
      indicator_history: null,
      dataset_last_updated: null,
      source_used: "none",
      endpoint,
      note:
        err instanceof Error
          ? `WoW lookup failed: ${err.message}`
          : "WoW lookup failed.",
    };
  }
}
