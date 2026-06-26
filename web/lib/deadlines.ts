/**
 * BACKSTOP #1 (deadline half) — config-driven, deterministic deadline engine.
 *
 * Implements LEGAL-RULES §3 (Rule A — answer window) and §4 (Rule B —
 * default-risk detection + the "satisfied" predicate). The LLM NEVER computes
 * a deadline; every Deadline this module emits carries `computed_by =
 * "deterministic"` (the hard const in lib/case.ts). The LLM may only attach a
 * plain-English `explanation`.
 *
 * ===========================================================================
 * !!! ATTORNEY MUST VALIDATE — NOT PRODUCTION VALUES !!!
 * ===========================================================================
 * Per LEGAL-RULES §1.1 ("No magic numbers in code"): every legally-operative
 * number, window, and unit is a NAMED config key, and they are ALL UNPOPULATED
 * here (null / 0 / [] / `attorney_validated_config = false`). A NY-licensed
 * supervising attorney MUST populate and sign off on these before production.
 *
 * Until `attorney_validated_config = true` for a rule, this engine refuses to
 * emit an authoritative clock. When config is unpopulated it returns status
 * "insufficient_data" / "uncertain" and a PROVISIONAL deadline (flagged
 * `attorney_validated = false`, `uncertain_anchor = true`) — NEVER a fake
 * number the UI can treat as a real deadline. (§3.4, §1.3, AT-LR-6.)
 * ===========================================================================
 *
 * Pure functions. No I/O, no LLM, no mutation. All date math is on the bare
 * America/New_York calendar (YYYY-MM-DD, no time component), per §1.1.
 */
import type {
  Case,
  Deadline,
  DeadlineType,
  RiskFlags,
  TimelineEvent,
} from "@/lib/case";

// ===========================================================================
// CONFIG TYPES (the named thresholds an attorney populates)
// ===========================================================================

/** How a count is measured. */
export type DateUnit = "calendar_days" | "court_days";

/** Whether the anchor day itself counts toward the window. */
export type CountingBasis = "from_anchor_exclusive" | "from_anchor_inclusive";

/** What to do when a computed due date lands on a weekend/holiday. */
export type WeekendHolidayRule = "roll_forward_to_next_court_day" | "none";

/** A named, attorney-populated window (count + unit). Null = unpopulated. */
export interface WindowConfig {
  /** ATTORNEY POPULATES integer. null = unpopulated (rule inert). */
  count: number | null;
  /** ATTORNEY POPULATES. null = unpopulated. */
  unit: DateUnit | null;
}

/** Rule A — answer/response window. §3.2 `nonpayment_answer_window`. */
export interface AnswerWindowConfig {
  rule_id: "nonpayment_answer_window";
  rule_version: string;
  /** MUST be true to emit an authoritative clock. Default false. */
  attorney_validated_config: boolean;
  /**
   * Anchor priority — first available & usable wins. Each entry names the
   * Case Object date field that starts the clock. ATTORNEY confirms ordering.
   */
  anchor_priority: AnchorConfig[];
  /** The window itself — NAMED, attorney-populated, DO NOT assume a number. */
  answer_window: {
    count: number | null; // ATTORNEY POPULATES
    unit: DateUnit | null; // ATTORNEY POPULATES
    counting_basis: CountingBasis | null; // ATTORNEY POPULATES
    weekend_holiday_rule: WeekendHolidayRule | null; // ATTORNEY POPULATES
  };
  /** Below this anchor confidence, the clock is provisional. */
  min_anchor_confidence: "high" | "medium" | "low";
  /** Court-holiday calendar id for court_days counting (§1.2.1). */
  court_calendar_id: string;
}

/** Which event starts the clock. */
export interface AnchorConfig {
  /** The TimelineEvent kind / logical anchor event name. */
  event: "petition_served" | "petition_filed";
  /** Documentation of the Case Object field this maps to. */
  case_field: string;
}

/** Rule B — default-risk detection. §4.2 `nonpayment_default_risk`. */
export interface DefaultRiskConfig {
  rule_id: "nonpayment_default_risk";
  rule_version: string;
  attorney_validated_config: boolean;
  /** N before due_date at which a deadline is "imminent". Null = unpopulated. */
  imminent_window: WindowConfig;
  /** Grace after due_date before treating as missed. Null = unpopulated. */
  missed_grace: WindowConfig;
  /** Which deadline types carry default risk. ATTORNEY confirms set. */
  default_risk_deadline_types: DeadlineType[];
  /** Only risky if not yet satisfied/answered. */
  default_risk_requires_unsatisfied: boolean;
  /** Satisfaction predicate config (§4.3.1). */
  satisfaction_signals: SatisfactionSignalsConfig;
}

/** §4.3.1 — what clears default risk. */
export interface SatisfactionSignalsConfig {
  /** Court-sourced timeline kinds that clear risk. ATTORNEY confirms. */
  court_sourced_kinds: string[];
  /** timeline kind=other structured tag for tenant-attested filing. */
  tenant_attested_tag: string;
  /** Tenant attestation down-grades (clears is_missed) but not fully. */
  tenant_attested_clears_missed: boolean;
}

/** The court-holiday calendar (§1.2.1). Empty/unvalidated by default. */
export interface CourtHolidayCalendar {
  calendar_id: string;
  calendar_version: string;
  /** Earliest date the list is authoritative for. Null = unpopulated. */
  coverage_from: string | null;
  /** Latest date covered; court_days math past this is refused. Null = unpopulated. */
  coverage_until: string | null;
  /** Observed court-closed dates: { date: YYYY-MM-DD }. Empty by default. */
  observed: { date: string; label?: string }[];
}

/** The full deadline-engine config bundle. */
export interface DeadlineEngineConfig {
  answer_window: AnswerWindowConfig;
  default_risk: DefaultRiskConfig;
  court_holidays: CourtHolidayCalendar;
}

// ===========================================================================
// DEFAULT CONFIG — ALL UNPOPULATED. "ATTORNEY MUST VALIDATE — not production
// values." Every legally-operative value is null / 0 / [] / false here.
// ===========================================================================

/**
 * The canonical UNVALIDATED config. Mirrors the YAML scaffolds in LEGAL-RULES
 * §3.2 / §4.2 / §1.2.1, with every operative value left null/0/[]/false.
 *
 * DO NOT hardcode real numbers here. These are populated from a versioned,
 * attorney-signed ruleset at runtime. This object exists so the engine has a
 * well-typed shape to read, and so an unconfigured engine FAILS SAFE (emits
 * "insufficient_data"/"uncertain", never a fabricated deadline).
 */
export const UNVALIDATED_DEADLINE_CONFIG: DeadlineEngineConfig = {
  answer_window: {
    rule_id: "nonpayment_answer_window",
    rule_version: "0.0.0-UNVALIDATED",
    attorney_validated_config: false, // <-- ATTORNEY sets true
    anchor_priority: [
      {
        event: "petition_served",
        case_field: "documents[].extracted_fields.service_date",
      },
      {
        event: "petition_filed",
        case_field: "documents[].extracted_fields.petition_filed_date",
      },
    ],
    answer_window: {
      count: null, // <-- ATTORNEY POPULATES — NOT a production value
      unit: null, // <-- ATTORNEY POPULATES
      counting_basis: null, // <-- ATTORNEY POPULATES
      weekend_holiday_rule: null, // <-- ATTORNEY POPULATES
    },
    min_anchor_confidence: "medium",
    court_calendar_id: "nyc_housing_court_holidays",
  },
  default_risk: {
    rule_id: "nonpayment_default_risk",
    rule_version: "0.0.0-UNVALIDATED",
    attorney_validated_config: false, // <-- ATTORNEY sets true
    imminent_window: { count: null, unit: null }, // <-- ATTORNEY POPULATES
    missed_grace: { count: 0, unit: null }, // <-- ATTORNEY POPULATES (0 = no grace placeholder)
    default_risk_deadline_types: ["answer_due", "first_appearance"],
    default_risk_requires_unsatisfied: true,
    satisfaction_signals: {
      court_sourced_kinds: [], // <-- ATTORNEY confirms (e.g. court_appearance, adjournment)
      tenant_attested_tag: "answer_filed_attested",
      tenant_attested_clears_missed: true,
    },
  },
  court_holidays: {
    calendar_id: "nyc_housing_court_holidays",
    calendar_version: "0.0.0-UNVALIDATED",
    coverage_from: null, // <-- OPS/ATTORNEY POPULATES
    coverage_until: null, // <-- OPS/ATTORNEY POPULATES
    observed: [], // <-- OPS/ATTORNEY POPULATES
  },
};

// ===========================================================================
// PURE CALENDAR DATE MATH (America/New_York bare calendar — no time component)
// ===========================================================================

/** Parse YYYY-MM-DD into a UTC-midnight Date used purely as a calendar cursor. */
function parseCalendarDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null; // not a real calendar date
  }
  return d;
}

/** Serialize a calendar-cursor Date back to YYYY-MM-DD. */
function formatCalendarDate(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Add N calendar days. */
function addCalendarDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Whole-day difference b - a (calendar days). */
function diffCalendarDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Is this calendar day a weekend (Sat/Sun)? */
function isWeekend(d: Date): boolean {
  const dow = d.getUTCDay();
  return dow === 0 || dow === 6;
}

/** Is this calendar day in the observed court-holiday list? */
function isHoliday(d: Date, cal: CourtHolidayCalendar): boolean {
  const iso = formatCalendarDate(d);
  return cal.observed.some((h) => h.date === iso);
}

/** A court day = not a weekend and not an observed holiday. */
function isCourtDay(d: Date, cal: CourtHolidayCalendar): boolean {
  return !isWeekend(d) && !isHoliday(d, cal);
}

/** Roll a date forward to the next court day (or return as-is if already one). */
function rollForwardToCourtDay(d: Date, cal: CourtHolidayCalendar): Date {
  let cur = d;
  // Bounded loop — a sane calendar never has an unbounded holiday run.
  for (let i = 0; i < 366; i++) {
    if (isCourtDay(cur, cal)) return cur;
    cur = addCalendarDays(cur, 1);
  }
  return cur;
}

// ===========================================================================
// RULE A — ANSWER WINDOW COMPUTATION
// ===========================================================================

/** Status of a deadline computation. */
export type DeadlineComputationStatus =
  | "authoritative" // attorney-validated config + trusted anchor produced a real clock
  | "provisional" // computed, but flagged uncertain (unvalidated config or shaky anchor)
  | "insufficient_data"; // could not compute at all (no anchor / unpopulated window)

/** A resolved anchor: which event and what confirmed date. */
export interface ResolvedAnchor {
  event: string;
  date: string;
  /** Confidence of the underlying extracted value, if any. */
  confidence: "high" | "medium" | "low" | "unreadable" | null;
  /** Whether the underlying value was tenant-confirmed. */
  tenant_confirmed: boolean;
  /** Whether the date is court-verified (vs LLM-extracted). */
  authoritative_source: boolean;
}

/** Output of {@link computeAnswerDeadline}. */
export interface AnswerDeadlineResult {
  status: DeadlineComputationStatus;
  /** The Deadline object (always `computed_by = "deterministic"`), or null. */
  deadline: Deadline | null;
  /** The matching authoritative-only timeline event (kind="answer_due"), or null. */
  timeline_event: Omit<TimelineEvent, "event_id"> | null;
  /** Human-/dev-readable reasons (structured, not advice). */
  reasons: string[];
}

const ORDER: Record<"high" | "medium" | "low", number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Is `have` >= `min` on the confidence scale? */
function meetsConfidence(
  have: "high" | "medium" | "low" | "unreadable" | null,
  min: "high" | "medium" | "low",
): boolean {
  if (have == null || have === "unreadable") return false;
  return ORDER[have] >= ORDER[min];
}

/**
 * Resolve the clock anchor from the Case by walking `anchor_priority` and
 * picking the first event whose date resolves. Reads the tenant-corrected
 * value over `value`, and surfaces confidence + tenant_confirmed.
 *
 * Returns null if no anchor resolves.
 */
export function resolveAnchor(
  caseObj: Case,
  cfg: AnswerWindowConfig,
): ResolvedAnchor | null {
  for (const anchor of cfg.anchor_priority) {
    const field =
      anchor.event === "petition_served" ? "service_date" : "petition_filed_date";

    for (const doc of caseObj.documents) {
      const cv = doc.extracted_fields?.[field];
      if (!cv) continue;

      const raw =
        cv.tenant_corrected_value !== undefined
          ? cv.tenant_corrected_value
          : cv.value;
      if (typeof raw !== "string") continue;
      if (parseCalendarDate(raw) == null) continue;

      return {
        event: anchor.event,
        date: raw,
        confidence: cv.confidence,
        tenant_confirmed: cv.tenant_confirmed,
        // Extracted document dates are never court-verified.
        authoritative_source: false,
      };
    }
  }
  return null;
}

/**
 * Apply the configured window to an anchor date. Returns null if the window
 * config is unpopulated or the math cannot be performed (e.g. court_days past
 * the calendar coverage, per §3.3 step 5 / AT-LR-10).
 */
function applyWindow(
  anchorDate: string,
  cfg: AnswerWindowConfig,
  cal: CourtHolidayCalendar,
): { due: string } | { error: string } {
  const w = cfg.answer_window;
  if (w.count == null || w.unit == null || w.counting_basis == null) {
    return { error: "answer_window is unpopulated (ATTORNEY MUST VALIDATE)" };
  }

  const anchor = parseCalendarDate(anchorDate);
  if (anchor == null) return { error: "anchor date is not a real calendar date" };

  // Inclusive counting consumes one of the days at the anchor.
  const startOffset = w.counting_basis === "from_anchor_inclusive" ? 1 : 0;

  if (w.unit === "calendar_days") {
    let due = addCalendarDays(anchor, w.count - startOffset);
    if (w.weekend_holiday_rule === "roll_forward_to_next_court_day") {
      due = rollForwardToCourtDay(due, cal);
    }
    return guardCoverage(anchor, due, cal);
  }

  // court_days: step forward counting only court days.
  let remaining = w.count - startOffset;
  let cur = anchor;
  let guard = 0;
  while (remaining > 0) {
    cur = addCalendarDays(cur, 1);
    if (isCourtDay(cur, cal)) remaining--;
    if (++guard > 366 * 3) {
      return { error: "court_days window exceeded sane bound" };
    }
  }
  let due = cur;
  if (w.weekend_holiday_rule === "roll_forward_to_next_court_day") {
    due = rollForwardToCourtDay(due, cal);
  }
  return guardCoverage(anchor, due, cal);
}

/**
 * Refuse court-day-sensitive output that crosses the calendar's coverage_until
 * (§1.2.1 / AT-LR-10). If coverage is unpopulated, the calendar cannot be
 * trusted for any holiday counting -> error (fail safe to provisional).
 */
function guardCoverage(
  anchor: Date,
  due: Date,
  cal: CourtHolidayCalendar,
): { due: string } | { error: string } {
  if (cal.coverage_until == null) {
    return { error: "court-holiday calendar coverage_until is unpopulated" };
  }
  const cov = parseCalendarDate(cal.coverage_until);
  if (cov == null) return { error: "court-holiday coverage_until is invalid" };
  if (due.getTime() > cov.getTime()) {
    return { error: "computed window crosses court-calendar coverage_until" };
  }
  return { due: formatCalendarDate(due) };
}

/** Build default (all-false) risk flags. */
function freshRiskFlags(): RiskFlags {
  return {
    is_imminent: false,
    is_missed: false,
    default_risk: false,
    uncertain_anchor: false,
  };
}

/**
 * Compute the answer/response deadline (Rule A). DETERMINISTIC.
 *
 * Behavior matches §3.3:
 *   - Gate on case_type=nonpayment+confirmed (caller may pre-gate; checked here).
 *   - If config unvalidated OR anchor missing OR window unpopulated OR
 *     court_days math impossible -> NOT authoritative. We still return a
 *     provisional Deadline when we have *something* (an anchor + a computable
 *     date) so the tenant can understand; otherwise "insufficient_data" and a
 *     null deadline. We NEVER fabricate a number.
 *
 * @param deadlineId  SYS-generated id (dl_<ULID>) supplied by the caller.
 * @param explanation Optional LLM plain-English explanation (NOT the computation).
 */
export function computeAnswerDeadline(
  caseObj: Case,
  deadlineId: string,
  cfg: DeadlineEngineConfig = UNVALIDATED_DEADLINE_CONFIG,
  explanation: string | null = null,
): AnswerDeadlineResult {
  const reasons: string[] = [];
  const a = cfg.answer_window;

  // Gate: case type.
  if (caseObj.case_type !== "nonpayment" || caseObj.case_type_confirmed !== true) {
    return {
      status: "insufficient_data",
      deadline: null,
      timeline_event: null,
      reasons: ["case is not a confirmed nonpayment case; not computing"],
    };
  }

  // Resolve the anchor.
  const anchor = resolveAnchor(caseObj, a);
  if (anchor == null) {
    return {
      status: "insufficient_data",
      deadline: null,
      timeline_event: null,
      reasons: ["no usable anchor date (petition served/filed) found"],
    };
  }

  // Assess anchor trust (§3.3 step 4).
  let uncertainAnchor = false;
  if (!anchor.authoritative_source) {
    uncertainAnchor = true;
    reasons.push("anchor is LLM-extracted, not court-verified");
  }
  if (!meetsConfidence(anchor.confidence, a.min_anchor_confidence)) {
    uncertainAnchor = true;
    reasons.push(
      `anchor confidence (${anchor.confidence ?? "none"}) below minimum (${a.min_anchor_confidence})`,
    );
  }
  if (!anchor.tenant_confirmed) {
    uncertainAnchor = true;
    reasons.push("anchor not tenant-confirmed");
  }

  // Compute the due date.
  const applied = applyWindow(anchor.date, a, cfg.court_holidays);
  if ("error" in applied) {
    reasons.push(applied.error);
    return {
      status: "insufficient_data",
      deadline: null,
      timeline_event: null,
      reasons,
    };
  }

  // Determine authority: requires attorney-validated config AND a trusted anchor.
  const configValidated = a.attorney_validated_config === true;
  if (!configValidated) {
    uncertainAnchor = true;
    reasons.push(
      "answer-window config is NOT attorney-validated (provisional only)",
    );
  }
  const authoritative = configValidated && !uncertainAnchor;

  const risk: RiskFlags = { ...freshRiskFlags(), uncertain_anchor: uncertainAnchor };

  const deadline: Deadline = {
    deadline_id: deadlineId,
    deadline_type: "answer_due",
    due_date: applied.due,
    computed_by: "deterministic", // HARD INVARIANT
    computation_basis: {
      anchor_event: anchor.event,
      anchor_date: anchor.date,
      statute_rule_id: a.rule_id, // canonical (§1.4)
      rule_version:
        a.answer_window.unit === "court_days"
          ? `${a.rule_version}+cal:${cfg.court_holidays.calendar_id}@${cfg.court_holidays.calendar_version}`
          : a.rule_version,
    },
    tenant_confirmed: false, // must flip true downstream
    attorney_validated: authoritative, // both gates required for fileable use
    risk,
    explanation,
  };

  const timeline_event: Omit<TimelineEvent, "event_id"> = {
    kind: "answer_due", // ONLY this engine emits this kind (§2.2.1)
    date: applied.due,
    date_is_authoritative: authoritative,
    description: "Deadline to answer/respond to the nonpayment petition.",
    deadline_id: deadlineId, // non-null FK required (AT-LR-4)
  };

  return {
    status: authoritative ? "authoritative" : "provisional",
    deadline,
    timeline_event,
    reasons,
  };
}

// ===========================================================================
// RULE B — DEFAULT-RISK DETECTION + "SATISFIED" PREDICATE
// ===========================================================================

/** Risk evaluation status. */
export type RiskStatus = "evaluated" | "uncertain" | "insufficient_data";

/** Output of {@link evaluateDefaultRisk}. */
export interface DefaultRiskResult {
  status: RiskStatus;
  /** Updated risk flags to write onto the deadline. */
  risk: RiskFlags;
  /** True if the rule recommends escalating (review_state="escalated"). */
  should_escalate: boolean;
  /** Whether the satisfied predicate held (and at what strength). */
  satisfied: SatisfactionState;
  reasons: string[];
}

/** Strength of satisfaction (§4.3.1). */
export type SatisfactionState =
  | "not_satisfied"
  | "tenant_attested" // down-grades is_missed but keeps a soft advisory
  | "court_confirmed"; // authoritative satisfier

/**
 * The "satisfied" predicate (§4.3.1). DETERMINISTIC.
 *
 * Disjunction of:
 *  1. Court-sourced docket event (authoritative) — a timeline event whose kind
 *     is in `court_sourced_kinds` AND `date_is_authoritative = true`.
 *  2. Tenant-attested filing marker — a timeline event kind="other" carrying
 *     the configured structured tag, with answer_draft.status="finalized".
 *
 * FAIL-SAFE: default is "not_satisfied" whenever neither predicate holds.
 *
 * Note on the structured tag: the spec rides the tenant-attested marker on a
 * timeline event kind="other" with a structured tag. The canonical
 * TimelineEvent has no tags[] field, so we bind the tag to the event's
 * `description` (the only free-text carrier) as a pragmatic v1 binding; the
 * caller must write the tag verbatim as the entire description when recording
 * the attestation. We require an EXACT match (not a substring) so an incidental
 * occurrence of the tag inside unrelated free-text (e.g. an LLM-generated note
 * that quotes the tag) cannot be mistaken for a legally-operative attestation
 * and wrongly suppress an imminent/missed/default-risk warning — the dangerous
 * direction. TODO: if a structured tag field is added to TimelineEvent,
 * switch to reading it directly.
 */
export function evaluateSatisfied(
  caseObj: Case,
  cfg: DefaultRiskConfig,
): SatisfactionState {
  const sig = cfg.satisfaction_signals;

  // 1. Court-sourced authoritative event.
  const courtConfirmed = caseObj.timeline.some(
    (e) =>
      e.date_is_authoritative === true &&
      sig.court_sourced_kinds.includes(e.kind),
  );
  if (courtConfirmed) return "court_confirmed";

  // 2. Tenant-attested filing marker.
  const tag = sig.tenant_attested_tag;
  const attested =
    !!tag &&
    caseObj.answer_draft?.status === "finalized" &&
    caseObj.timeline.some(
      (e) =>
        e.kind === "other" &&
        e.date_is_authoritative === false &&
        e.description.trim() === tag,
    );
  if (attested && sig.tenant_attested_clears_missed) return "tenant_attested";

  return "not_satisfied";
}

/**
 * Evaluate default risk for a single deadline against "now" (§4.3).
 * DETERMINISTIC. Fail-safe direction: when uncertain, prefer flagging risk.
 *
 * @param nowDate "today" in America/New_York as YYYY-MM-DD (caller supplies).
 */
export function evaluateDefaultRisk(
  caseObj: Case,
  deadline: Deadline,
  nowDate: string,
  cfg: DeadlineEngineConfig = UNVALIDATED_DEADLINE_CONFIG,
): DefaultRiskResult {
  const reasons: string[] = [];
  const b = cfg.default_risk;
  const risk: RiskFlags = { ...deadline.risk };

  const now = parseCalendarDate(nowDate);
  const due = parseCalendarDate(deadline.due_date);
  if (now == null || due == null) {
    return {
      status: "insufficient_data",
      risk,
      should_escalate: false,
      satisfied: "not_satisfied",
      reasons: ["now or due_date is not a real calendar date"],
    };
  }

  // Config gate. Without attorney-validated windows we cannot assert imminent.
  if (b.attorney_validated_config !== true) {
    reasons.push("default-risk config NOT attorney-validated; risk is uncertain");
    // Fail-safe: keep/raise uncertain_anchor; do not assert a confident clock.
    risk.uncertain_anchor = true;
    return {
      status: "uncertain",
      risk,
      should_escalate: false,
      satisfied: evaluateSatisfied(caseObj, b),
      reasons,
    };
  }

  const satisfied = evaluateSatisfied(caseObj, b);
  const isSatisfiedForMissed =
    satisfied === "court_confirmed" ||
    (satisfied === "tenant_attested" && b.satisfaction_signals.tenant_attested_clears_missed);
  const isSatisfiedForImminent = satisfied === "court_confirmed" || satisfied === "tenant_attested";

  // --- is_imminent ---
  if (b.imminent_window.count == null || b.imminent_window.unit == null) {
    reasons.push("imminent_window unpopulated; cannot compute is_imminent");
    risk.uncertain_anchor = true;
    return {
      status: "uncertain",
      risk,
      should_escalate: false,
      satisfied,
      reasons,
    };
  }

  const daysUntilDue = diffCalendarDays(now, due);
  const imminentThreshold = imminentDaysThreshold(b.imminent_window, due, cfg.court_holidays);
  if (imminentThreshold == null) {
    reasons.push("could not measure imminent window (court-day coverage)");
    risk.uncertain_anchor = true;
    return { status: "uncertain", risk, should_escalate: false, satisfied, reasons };
  }

  risk.is_imminent =
    daysUntilDue >= 0 && daysUntilDue <= imminentThreshold && !isSatisfiedForImminent;

  // --- is_missed (now > due + grace) ---
  const graceDays =
    b.missed_grace.count != null ? b.missed_grace.count : 0;
  // For court_days grace we conservatively use calendar days as a lower bound;
  // exact court-day grace requires populated calendar coverage. Fail-safe.
  const missedBoundary = addCalendarDays(due, graceDays);
  risk.is_missed = now.getTime() > missedBoundary.getTime() && !isSatisfiedForMissed;

  // --- default_risk ---
  const typeCarriesRisk = b.default_risk_deadline_types.includes(deadline.deadline_type);
  const unsatisfiedOk = b.default_risk_requires_unsatisfied
    ? !isSatisfiedForMissed
    : true;
  risk.default_risk =
    typeCarriesRisk && (risk.is_imminent || risk.is_missed) && unsatisfiedOk;

  const should_escalate = risk.is_imminent || risk.is_missed;
  if (should_escalate) {
    reasons.push(
      risk.is_missed
        ? "deadline appears missed; escalate to attorney (review_state=escalated)"
        : "deadline imminent; escalate to attorney (review_state=escalated)",
    );
  }
  if (satisfied === "tenant_attested") {
    reasons.push(
      "tenant attested they filed; confirm on the docket (soft advisory retained)",
    );
  }

  return { status: "evaluated", risk, should_escalate, satisfied, reasons };
}

/**
 * Measure the imminent threshold in calendar days from `due`. For
 * `calendar_days` this is just the count; for `court_days` we count backward
 * over court days, requiring calendar coverage. Returns null if it cannot be
 * measured.
 */
function imminentDaysThreshold(
  window: WindowConfig,
  due: Date,
  cal: CourtHolidayCalendar,
): number | null {
  if (window.count == null || window.unit == null) return null;
  if (window.unit === "calendar_days") return window.count;

  // court_days: walk backward `count` court days, return the calendar-day span.
  if (cal.coverage_from == null) return null;
  const from = parseCalendarDate(cal.coverage_from);
  if (from == null) return null;
  let remaining = window.count;
  let cur = due;
  let guard = 0;
  while (remaining > 0) {
    cur = addCalendarDays(cur, -1);
    if (cur.getTime() < from.getTime()) return null; // crossed coverage
    if (isCourtDay(cur, cal)) remaining--;
    if (++guard > 366 * 3) return null;
  }
  return diffCalendarDays(cur, due);
}
