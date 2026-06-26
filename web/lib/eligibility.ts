/**
 * BACKSTOP — Eligibility engine (LEGAL-RULES §8). Config-driven, deterministic.
 *
 * Determines RTC (Right to Counsel), legal-aid, and rental-assistance eligibility
 * and writes the three canonical slots `case.eligibility.{rtc,legal_aid,
 * rental_assistance}` — every result carries `determined_by = "deterministic"`
 * (the hard const in lib/case.ts). The LLM NEVER determines eligibility
 * (Invariant #4); it may only EXPLAIN a determination this engine produced.
 *
 * ===========================================================================
 * !!! ATTORNEY / POLICY MUST VALIDATE — NOT PRODUCTION VALUES !!!
 * ===========================================================================
 * Per LEGAL-RULES §1.1 + §8: every legally-operative threshold (FPL multiplier,
 * FPL table, RTC ZIP/borough coverage, CityFHEPS litigation toggle) is a NAMED
 * config key, ALL UNPOPULATED here (null / [] / false / disabled). Until a rule's
 * `attorney_validated_config = true` (and its inputs are populated) the engine
 * FAILS SAFE to `insufficient_data` — never a fabricated "you qualify".
 *
 * Hard config facts encoded by the spec (not eligibility math):
 *   - ERAP is CLOSED → always `program_unavailable` (§8.3).
 *   - CityFHEPS is litigation-gated → `program_unavailable` while disabled (§8.2).
 *
 * Canonical slotting (§8): ERAP / CityFHEPS / One-Shot / OFA / SNAP ALL write
 * `eligibility.rental_assistance` (one EligibilityResult, `program` names which);
 * every evaluated program is also recorded in `rental_assistance_programs[]`.
 * There is NO `eligibility.erap` / `eligibility.cityfheps` key.
 *
 * Pure functions. No I/O, no LLM, no mutation. `evaluated_at` is passed in so the
 * module stays deterministic and side-effect-free (no Date.now()).
 */
import type {
  Case,
  Borough,
  Eligibility,
  EligibilityResult,
  EligibilityDetermination,
} from "@/lib/case";

// ===========================================================================
// CONFIG TYPES (the named values an attorney/policy owner populates)
// ===========================================================================

/** RTC geography gating mode. Null = unconfigured (rule cannot determine geo). */
export type RtcGeographyMode = "citywide" | "zip_list" | "borough_list";

/** §8.1 RTC — income + geography. */
export interface RtcEligibilityConfig {
  rule_id: "rtc_eligibility";
  rule_version: string;
  /** MUST be true to emit anything but insufficient_data. Default false. */
  attorney_validated_config: boolean;
  monitored: true;
  /** Coverage changes over time; surfaced on the monitored-config dashboard. */
  review_by: string | null;
  income: {
    /** ATTORNEY POPULATES (RTC ≤ N% FPL per scope). null = unpopulated. */
    fpl_multiplier_pct: number | null;
    /** Versioned FPL table id. null = unpopulated. */
    fpl_table_version: string | null;
    /** Annual FPL by household size, in CENTS. Empty = unpopulated. */
    fpl_table_annual_cents: Record<string, number>;
  };
  geography: {
    /** "citywide" | "zip_list" | "borough_list". null = unconfigured. */
    mode: RtcGeographyMode | null;
    covered_zips: string[];
    covered_boroughs: Borough[];
  };
}

/** §8.2/§8.4 legal-aid / a generic income-band program. */
export interface LegalAidEligibilityConfig {
  rule_id: "legal_aid_eligibility";
  rule_version: string;
  attorney_validated_config: boolean;
  income: {
    /** Income ceiling (cents/yr) by household size. Empty = unpopulated. */
    income_ceiling_annual_cents: Record<string, number>;
  };
}

/** §8.2 CityFHEPS — litigation-gated toggle (writes rental_assistance). */
export interface CityFhepsConfig {
  rule_id: "cityfheps_eligibility";
  attorney_validated_config: boolean;
  monitored: true;
  /** "enabled" | "disabled" — disabled by active litigation. */
  config_toggle_state: "enabled" | "disabled";
  rules_version: string | null;
}

/** The full eligibility-engine config bundle. */
export interface EligibilityEngineConfig {
  config_version: string;
  rtc: RtcEligibilityConfig;
  legal_aid: LegalAidEligibilityConfig;
  cityfheps: CityFhepsConfig;
}

// ===========================================================================
// DEFAULT CONFIG — ALL UNPOPULATED. "ATTORNEY/POLICY MUST VALIDATE."
// Mirrors the YAML scaffolds in LEGAL-RULES §8 with every operative value
// left null/[]/false/disabled so an unconfigured engine FAILS SAFE.
// ===========================================================================

export const UNVALIDATED_ELIGIBILITY_CONFIG: EligibilityEngineConfig = {
  config_version: "0.0.0-UNVALIDATED",
  rtc: {
    rule_id: "rtc_eligibility",
    rule_version: "0.0.0-UNVALIDATED",
    attorney_validated_config: false, // <-- ATTORNEY/POLICY sets true
    monitored: true,
    review_by: null,
    income: {
      fpl_multiplier_pct: null, // <-- POPULATE (≤200% FPL per scope; do not assume)
      fpl_table_version: null,
      fpl_table_annual_cents: {}, // <-- POPULATE per household size
    },
    geography: {
      mode: null, // <-- "citywide" | "zip_list" | "borough_list"
      covered_zips: [],
      covered_boroughs: [],
    },
  },
  legal_aid: {
    rule_id: "legal_aid_eligibility",
    rule_version: "0.0.0-UNVALIDATED",
    attorney_validated_config: false,
    income: {
      income_ceiling_annual_cents: {}, // <-- POPULATE per household size
    },
  },
  cityfheps: {
    rule_id: "cityfheps_eligibility",
    attorney_validated_config: false,
    monitored: true,
    config_toggle_state: "disabled", // active litigation; flip only on policy sign-off
    rules_version: null,
  },
};

// ===========================================================================
// Result helpers
// ===========================================================================

function result(
  determination: EligibilityDetermination,
  opts: {
    program?: EligibilityResult["program"];
    rule_ids?: string[];
    reasons?: string[];
    data_source?: EligibilityResult["data_source"];
    config_toggle_state?: EligibilityResult["config_toggle_state"];
  } = {},
): EligibilityResult {
  return {
    program: opts.program ?? null,
    determination,
    determined_by: "deterministic",
    rule_ids: opts.rule_ids ?? [],
    reasons: opts.reasons ?? [],
    data_source: opts.data_source ?? null,
    config_toggle_state: opts.config_toggle_state ?? null,
  };
}

// ===========================================================================
// §8.1 RTC — income + geography
// ===========================================================================

/** Resolve RTC geography coverage. Returns null when geography is unconfigured. */
function rtcGeographyCovered(
  c: Case,
  geo: RtcEligibilityConfig["geography"],
): boolean | null {
  switch (geo.mode) {
    case "citywide":
      return true;
    case "zip_list": {
      const zip = c.property?.address?.postal_code ?? null;
      if (!zip) return null; // cannot evaluate without the input
      return geo.covered_zips.includes(zip);
    }
    case "borough_list": {
      const borough = c.court?.borough ?? null; // borough is read from court.borough
      if (!borough) return null;
      return geo.covered_boroughs.includes(borough);
    }
    default:
      return null; // mode unconfigured
  }
}

export function evaluateRtc(c: Case, cfg: RtcEligibilityConfig): EligibilityResult {
  const ruleIds = [cfg.rule_id];
  const base = { program: "rtc" as const, rule_ids: ruleIds, data_source: "internal_rules" as const };

  if (!cfg.attorney_validated_config) {
    return result("insufficient_data", { ...base, reasons: ["rtc_config_unvalidated"] });
  }

  const income = c.sensitive?.household_income_cents ?? null;
  const size = c.sensitive?.household_size ?? null;
  if (income == null || size == null) {
    // Opt-in income/size not provided — never assume.
    return result("insufficient_data", { ...base, reasons: ["income_or_household_size_not_provided"] });
  }

  const geoCovered = rtcGeographyCovered(c, cfg.geography);
  if (geoCovered === null) {
    return result("insufficient_data", { ...base, reasons: ["rtc_geography_input_or_config_missing"] });
  }

  const fplBase = cfg.income.fpl_table_annual_cents[String(size)];
  if (cfg.income.fpl_multiplier_pct == null || fplBase == null) {
    return result("insufficient_data", { ...base, reasons: ["rtc_fpl_table_unpopulated"] });
  }

  const threshold = Math.round((fplBase * cfg.income.fpl_multiplier_pct) / 100);
  const incomeWithin = income <= threshold;

  if (!geoCovered) {
    return result("ineligible", { ...base, reasons: ["outside_rtc_coverage_area"] });
  }
  if (!incomeWithin) {
    return result("ineligible", { ...base, reasons: ["income_above_rtc_threshold"] });
  }
  return result("eligible", {
    ...base,
    reasons: ["income_within_rtc_threshold", "within_rtc_coverage_area"],
  });
}

// ===========================================================================
// Legal aid — income band
// ===========================================================================

export function evaluateLegalAid(
  c: Case,
  cfg: LegalAidEligibilityConfig,
): EligibilityResult {
  const ruleIds = [cfg.rule_id];
  const base = { program: "legal_aid" as const, rule_ids: ruleIds, data_source: "internal_rules" as const };

  if (!cfg.attorney_validated_config) {
    return result("insufficient_data", { ...base, reasons: ["legal_aid_config_unvalidated"] });
  }
  const income = c.sensitive?.household_income_cents ?? null;
  const size = c.sensitive?.household_size ?? null;
  if (income == null || size == null) {
    return result("insufficient_data", { ...base, reasons: ["income_or_household_size_not_provided"] });
  }
  const ceiling = cfg.income.income_ceiling_annual_cents[String(size)];
  if (ceiling == null) {
    return result("insufficient_data", { ...base, reasons: ["legal_aid_income_table_unpopulated"] });
  }
  return income <= ceiling
    ? result("eligible", { ...base, reasons: ["income_within_legal_aid_ceiling"] })
    : result("ineligible", { ...base, reasons: ["income_above_legal_aid_ceiling"] });
}

// ===========================================================================
// Rental assistance — CityFHEPS (litigation-gated) + ERAP (closed)
// ===========================================================================

/** §8.3 ERAP is CLOSED. Hard config: always program_unavailable. */
export function evaluateErap(): EligibilityResult {
  return result("program_unavailable", {
    program: "erap",
    rule_ids: ["erap_eligibility"],
    reasons: ["erap_program_closed"],
  });
}

/** §8.2 CityFHEPS — program_unavailable while litigation-disabled. */
export function evaluateCityFheps(c: Case, cfg: CityFhepsConfig): EligibilityResult {
  const base = { program: "cityfheps" as const, rule_ids: [cfg.rule_id] };
  if (cfg.config_toggle_state === "disabled") {
    return result("program_unavailable", {
      ...base,
      reasons: ["cityfheps_disabled_active_litigation"],
      config_toggle_state: "disabled",
    });
  }
  // Enabled: the income/eligibility rules are attorney-owned config we do not
  // assume — without them we cannot determine, so fail safe.
  if (!cfg.attorney_validated_config) {
    return result("insufficient_data", {
      ...base,
      reasons: ["cityfheps_rules_unvalidated"],
      config_toggle_state: "enabled",
    });
  }
  // (Populated CityFHEPS rules would evaluate here.) Until then: insufficient.
  return result("insufficient_data", {
    ...base,
    reasons: ["cityfheps_inputs_insufficient"],
    config_toggle_state: "enabled",
    data_source: "internal_rules",
  });
}

/**
 * Pick the single most relevant rental-assistance result for the canonical slot:
 * prefer an actionable determination (eligible > likely_eligible), else the first
 * evaluated. All evaluated programs are kept in rental_assistance_programs[].
 */
function selectPrimaryRentalAssistance(all: EligibilityResult[]): EligibilityResult {
  const rank: Record<EligibilityDetermination, number> = {
    eligible: 0,
    likely_eligible: 1,
    insufficient_data: 2,
    ineligible: 3,
    program_unavailable: 4,
  };
  return [...all].sort((a, b) => rank[a.determination] - rank[b.determination])[0]!;
}

// ===========================================================================
// Orchestrator
// ===========================================================================

export interface EvaluateEligibilityOptions {
  config?: EligibilityEngineConfig;
  /** ISO timestamp stamped onto eligibility.evaluated_at (no Date.now in lib). */
  now: string;
}

/**
 * Evaluate all eligibility programs for a Case and return the `Eligibility`
 * object to PATCH onto it. Pure: callers persist the result server-side so the
 * `determined_by = "deterministic"` invariant is never client-writable.
 */
export function evaluateEligibility(
  c: Case,
  opts: EvaluateEligibilityOptions,
): Eligibility {
  const config = opts.config ?? UNVALIDATED_ELIGIBILITY_CONFIG;

  const rtc = evaluateRtc(c, config.rtc);
  const legal_aid = evaluateLegalAid(c, config.legal_aid);

  const rentalPrograms = [evaluateCityFheps(c, config.cityfheps), evaluateErap()];
  const rental_assistance = selectPrimaryRentalAssistance(rentalPrograms);

  return {
    rtc,
    legal_aid,
    rental_assistance,
    rental_assistance_programs: rentalPrograms,
    config_version: config.config_version,
    evaluated_at: opts.now,
  };
}
