"use client";

/**
 * The main copilot flow — a single-page, mobile-first, stepped experience.
 *
 * Steps:
 *   1. Upload / photo            -> POST /api/intake (vision extraction)
 *   2. Confirm extracted fields  -> the verify gate (backstop #1: court date)
 *   3. Plain-English summary + timeline
 *   4. Copilot chat              -> POST /api/chat (NDJSON stream; advice hard-route)
 *   5. Possible defenses         -> POST /api/defenses (information, not advice)
 *   6. Answer draft              -> POST /api/answer (editable DRAFT)
 *   7. Reminders opt-in + free-help hotline
 *
 * Trust UX is everywhere: every LLM-touching surface carries a contextual
 * Disclaimer; the court date is a hard human-confirm gate; advice questions are
 * routed to a person by the chat route, not answered here.
 *
 * API CONTRACTS (verified against the app/api route handlers):
 *  - POST /api/intake  body { base64Data, mediaType, language? }
 *      -> { extractedFields: Record<field, {value,confidence,...}>,
 *           classification: { case_type, ... } | null,
 *           explanation: { summary, refused, disclaimer } | null,
 *           routeToReview?: boolean }
 *  - POST /api/defenses body { candidate_defense_codes?, narrative?, language? }
 *      -> { defenses_checklist: DefenseChecklistItem[], route_to_human, disclaimer }
 *  - POST /api/answer   body { raw_statements, language?, general_denial? }
 *      -> { answer_draft: { factual_statements: FactualStatement[], ... },
 *           advice_requests: string[], route_to_human, disclaimer }
 *  - POST /api/chat     (see components/ChatPanel.tsx) — NDJSON stream.
 *
 * NOTE: the intake route is stateless (no server-side case persistence / no
 * confirm PATCH route exists in v1), so field confirmation is held in client
 * state and is the human gate for this UI. The DET persistence + reminder
 * scheduling endpoints are a later phase (see manifest TODOs). All model values
 * are treated as unconfirmed until the tenant confirms, and no date is ever
 * presented as authoritative on the model's say-so.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import Disclaimer, { TalkToAPersonLink } from "@/components/Disclaimer";
import ConfirmField from "@/components/ConfirmField";
import ChatPanel from "@/components/ChatPanel";
import BuildingIntel, { type BuildingIntelFindings } from "@/components/BuildingIntel";
import StipReview from "@/components/StipReview";
import ResumeByPhone from "@/components/ResumeByPhone";
import Turnstile from "@/components/Turnstile";
import RegisterInEtrack from "@/components/RegisterInEtrack";
import { DisclaimerContext, TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";
import type { Case, CaseType, ConfidenceLevel, EvidenceItem } from "@/lib/case";
import {
  type Language,
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  LANGUAGE_ENDONYMS,
  coerceLanguage,
  getStrings,
  isFullyTranslated,
  isRtl,
} from "@/lib/i18n";
// Same-device auth contract (per-case capability token in localStorage,
// presented as Authorization: Bearer on every gated /api/cases call). Shared
// with the persistent /case dashboard via lib/caseClient so the two surfaces
// stay consistent. See lib/auth/session.ts.
import {
  CASE_ID_STORAGE_KEY,
  CASE_TOKEN_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
} from "@/lib/caseClient";


// ---------------------------------------------------------------------------
// Wire shapes (projections of the real route responses).
// ---------------------------------------------------------------------------

interface ExtractedValue {
  value: unknown;
  confidence: ConfidenceLevel;
}
type ExtractedFieldsMap = Record<string, ExtractedValue | null | undefined>;

interface IntakeResponse {
  extractedFields?: ExtractedFieldsMap;
  classification?: { case_type?: string } | null;
  explanation?: { summary?: string; refused?: boolean } | null;
  routeToReview?: boolean;
}

interface DefenseChecklistItem {
  defense_code: string;
  explanation?: string | null;
  relevance_signal?: "possible" | "evidence_present" | "not_indicated" | null;
}
interface DefensesResponse {
  defenses_checklist?: DefenseChecklistItem[];
  route_to_human?: boolean;
}

interface FactualStatement {
  statement_id: string;
  text: string;
}
interface AnswerResponse {
  answer_draft?: { factual_statements?: FactualStatement[] };
  advice_requests?: string[];
  route_to_human?: boolean;
}

// UI model for a confirmable field.
interface UiField {
  key: string;
  label: string;
  /** Human-readable rendering shown on screen (e.g. "Monday, June 30, 2026"). */
  displayValue: string;
  /**
   * The RAW, machine-shaped value (ISO date "YYYY-MM-DD", dollar string, borough
   * slug, etc.) used to build the Case patch. The court-date persistence bug
   * (REVIEW fix #4) was passing `displayValue` to fieldToCasePatch, which only
   * accepts ISO — the long-form display string failed the round-trip and the
   * patch was silently dropped. We keep the raw value here and patch with it.
   */
  rawValue: string;
  confidence: ConfidenceLevel;
  critical?: boolean;
  inputType?: "date" | "text" | "money";
  hint?: string;
  confirmed?: boolean;
}

/**
 * Coerce an extracted field value into the RAW string shape fieldToCasePatch
 * expects (ISO date, a plain number/string for money, the borough slug, etc.).
 * This is the value that PERSISTS; renderValue() is for display only.
 */
function rawValueOf(key: string, raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    // Money: keep dollars as a plain numeric string (toCents parses it).
    if (typeof obj.amount_cents === "number") {
      return (obj.amount_cents / 100).toString();
    }
    if (typeof obj.amount === "number") return obj.amount.toString();
    // Address object → line1 (the patch only records line1 today).
    if (typeof obj.line1 === "string") return obj.line1;
    return "";
  }
  // Strings (ISO dates, names, borough slugs, index numbers) pass through raw.
  return typeof raw === "string" ? raw : String(raw);
}

// ---------------------------------------------------------------------------
// Field presentation metadata + value rendering.
// ---------------------------------------------------------------------------

const FIELD_META: Record<
  string,
  { label: string; critical?: boolean; inputType?: "date" | "text" | "money"; hint?: string }
> = {
  court_date: {
    label: "Your next court date",
    critical: true,
    inputType: "date",
    hint: "Look for the date you must come to court on your court notice (sometimes called the “return date”).",
  },
  index_number: { label: "Court case (index) number", inputType: "text" },
  borough: { label: "Borough", inputType: "text" },
  claimed_arrears: {
    label: "Rent the landlord says you owe",
    inputType: "money",
  },
  monthly_rent: { label: "Your monthly rent", inputType: "money" },
  landlord_name: { label: "Landlord / owner name", inputType: "text" },
  petitioner_name: { label: "Who is suing you (petitioner)", inputType: "text" },
  respondent_name: { label: "Your name on the papers", inputType: "text" },
  premises_address: { label: "Your apartment address", inputType: "text" },
  apartment_unit: { label: "Apartment number", inputType: "text" },
  rent_demand_date: { label: "Date of the rent demand notice", inputType: "date" },
  petition_filed_date: { label: "Date the case was filed", inputType: "date" },
  service_date: { label: "Date you were served the papers", inputType: "date" },
};

// Display order — court date first, then the most useful fields.
const FIELD_ORDER = [
  "court_date",
  "index_number",
  "claimed_arrears",
  "monthly_rent",
  "respondent_name",
  "petitioner_name",
  "landlord_name",
  "premises_address",
  "apartment_unit",
  "borough",
  "rent_demand_date",
  "petition_filed_date",
  "service_date",
];

function renderValue(key: string, raw: unknown): string {
  if (raw == null) return "Not found";
  // Money: { amount_cents, currency } or { amount, ... }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.amount_cents === "number") {
      return `$${(obj.amount_cents / 100).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    // Address object → join the parts we have.
    const parts = [obj.line1, obj.line2, obj.city, obj.state, obj.postal_code]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(", ");
    if (parts) return parts;
    return JSON.stringify(raw);
  }
  if (typeof raw === "string") {
    // Dates render nicely if ISO.
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const d = new Date(`${raw}T00:00:00`);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      }
    }
    // Money fields whose raw value is a plain numeric string ("1234.56") render
    // as currency (the rawValue we persist for money is a dollar number string).
    if (
      (key === "claimed_arrears" || key === "monthly_rent") &&
      /^\d+(\.\d+)?$/.test(raw.trim())
    ) {
      const n = Number.parseFloat(raw);
      if (!Number.isNaN(n)) {
        return `$${n.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}`;
      }
    }
    if (key === "borough") {
      return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, " ");
    }
    return raw;
  }
  return String(raw);
}

function mapFields(map: ExtractedFieldsMap | undefined): UiField[] {
  if (!map) return [];
  const out: UiField[] = [];
  for (const key of FIELD_ORDER) {
    const entry = map[key];
    if (!entry) continue;
    const meta = FIELD_META[key] ?? { label: key, inputType: "text" as const };
    out.push({
      key,
      label: meta.label,
      displayValue: renderValue(key, entry.value),
      rawValue: rawValueOf(key, entry.value),
      confidence: entry.confidence ?? "unreadable",
      critical: meta.critical,
      inputType: meta.inputType,
      hint: meta.hint,
    });
  }
  return out;
}

/** Read a File as base64 (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") return reject(new Error("read failed"));
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

const SUPPORTED_MEDIA = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const STEP_LABELS: Record<Step, string> = {
  1: "Your papers",
  2: "Check the details",
  3: "What it means",
  4: "Ask questions",
  5: "Possible issues",
  6: "Your answer",
  7: "Stay on track",
};

// Client-side session id — used to scope the chat conversation. The intake
// route does not mint a case_id in v1; persistence is a later phase.
function newSessionId() {
  return `sess_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// Borough display string -> Case borough enum.
function toBoroughEnum(
  v: string,
): "manhattan" | "bronx" | "brooklyn" | "queens" | "staten_island" | null {
  const k = v.trim().toLowerCase().replace(/\s+/g, "_");
  if (
    k === "manhattan" ||
    k === "bronx" ||
    k === "brooklyn" ||
    k === "queens" ||
    k === "staten_island"
  ) {
    return k;
  }
  return null;
}

// Parse a money display string ("$1,234.56") into integer cents.
function toCents(v: string): number | null {
  const digits = v.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = Number.parseFloat(digits);
  if (Number.isNaN(n)) return null;
  return Math.round(n * 100);
}

// "YYYY-MM-DD" if the string is (or contains) an ISO calendar date.
function toIsoDate(v: string): string | null {
  const m = v.match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? v : null;
}

// Best-effort US phone -> E.164 (+1XXXXXXXXXX). Returns null if it can't.
function toE164(v: string): string | null {
  const digits = v.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (v.trim().startsWith("+") && digits.length >= 8) return `+${digits}`;
  return null;
}

// A KB citation surfaced alongside the chat step (from POST /api/kb).
interface KbSource {
  id: string;
  topic: string;
  source_name: string;
  source_url: string;
  plain_english_answer?: string;
}
interface KbResponse {
  results?: KbSource[];
}

export default function CopilotPage() {
  const [step, setStep] = useState<Step>(1);
  const [sessionId] = useState(newSessionId);
  // The real persisted case_id (mints on mount). Falls back to sessionId until set.
  const [caseId, setCaseId] = useState<string | null>(null);
  // The per-case capability token presented on every cases-route call.
  const [caseToken, setCaseToken] = useState<string | null>(null);
  // The last-known persisted Case — passed to chat as schema-valid grounding.
  const [persistedCase, setPersistedCase] = useState<Case | null>(null);
  const caseIdRef = useRef<string | null>(null);
  caseIdRef.current = caseId;
  const caseTokenRef = useRef<string | null>(null);
  caseTokenRef.current = caseToken;
  // An OTP-verified owner session token (from resume-by-phone), used as an auth
  // fallback to the cases route when the per-case capability token isn't held.
  const ownerSessionRef = useRef<string | null>(null);

  // Tenant-chosen language. Persisted onto the Case and threaded into every LLM
  // call (intake/chat/defenses/answer) so a limited-English tenant gets output
  // in their language. Defaults to a stored choice or English.
  const [language, setLanguage] = useState<Language>(DEFAULT_LANGUAGE);
  const languageRef = useRef<Language>(language);
  languageRef.current = language;
  const t = getStrings(language);

  // Turnstile tokens for the two public entry points (single-use; null until solved).
  const [intakeTurnstile, setIntakeTurnstile] = useState<string | null>(null);

  const [intake, setIntake] = useState<IntakeResponse | null>(null);
  const [fields, setFields] = useState<UiField[]>([]);

  const [intakeBusy, setIntakeBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Defenses
  const [defenses, setDefenses] = useState<DefenseChecklistItem[] | null>(null);
  const [defensesBusy, setDefensesBusy] = useState(false);

  // Answer
  const [narrative, setNarrative] = useState("");
  const [answerText, setAnswerText] = useState("");
  const [answerLoaded, setAnswerLoaded] = useState(false);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [answerRouted, setAnswerRouted] = useState(false);

  // Reminders
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  const [reminderSaved, setReminderSaved] = useState(false);
  const [reminderBusy, setReminderBusy] = useState(false);
  const [reminderNote, setReminderNote] = useState<string | null>(null);

  // Building intelligence (open-data lookup)
  const [buildingFindings, setBuildingFindings] = useState<BuildingIntelFindings | null>(null);
  const [buildingBusy, setBuildingBusy] = useState(false);
  const [buildingOpen, setBuildingOpen] = useState(false);

  // Settlement (stipulation) reviewer entry
  const [stipOpen, setStipOpen] = useState(false);

  // KB citations for the chat step (sources panel via /api/kb)
  const [kbSources, setKbSources] = useState<KbSource[]>([]);

  const courtDateField = fields.find((f) => f.key === "court_date");
  // Evidence currently on the persisted Case (drives the open-data verify gates).
  const evidence: EvidenceItem[] = persistedCase?.evidence ?? [];
  // The upload action is enabled once Turnstile has produced a token (in dev the
  // widget emits a sentinel immediately, so this is true right away locally).
  const intakeReady = intakeTurnstile != null;

  // ----- Persistence: mint or rehydrate a Case on mount --------------------

  useEffect(() => {
    let cancelled = false;

    // Restore a previously chosen language (the Case is the source of truth once
    // loaded, but this avoids a flash of English for a returning tenant).
    try {
      const storedLang = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (storedLang) setLanguage(coerceLanguage(storedLang));
    } catch {
      /* ignore */
    }

    async function init() {
      let existing: string | null = null;
      let existingToken: string | null = null;
      try {
        existing = window.localStorage.getItem(CASE_ID_STORAGE_KEY);
        existingToken = window.localStorage.getItem(CASE_TOKEN_STORAGE_KEY);
      } catch {
        existing = null;
      }

      if (existing) {
        try {
          // Present the capability token; the route is owner-gated now.
          const res = await fetch(
            `/api/cases/${existing}`,
            existingToken
              ? { headers: { Authorization: `Bearer ${existingToken}` } }
              : undefined,
          );
          if (res.ok) {
            const data = (await res.json()) as { case?: Case };
            if (!cancelled && data.case) {
              setCaseId(data.case.case_id);
              if (existingToken) setCaseToken(existingToken);
              setPersistedCase(data.case);
              if (data.case.language) setLanguage(coerceLanguage(data.case.language));
              const rehydrated = caseToUiFields(data.case);
              if (rehydrated.length > 0) {
                setFields(rehydrated);
                // Resume past the upload step if the tenant already confirmed
                // their court date in a previous session.
                if (rehydrated.some((f) => f.key === "court_date" && f.confirmed)) {
                  setStep((s) => (s === 1 ? 2 : s));
                }
              }
              return;
            }
          }
          // Stored id is stale/forbidden on the server — fall through to create.
        } catch {
          // Network error — fall through to create a fresh case.
        }
      }

      try {
        const res = await fetch("/api/cases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: languageRef.current }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            case_id: string;
            case: Case;
            case_token?: string | null;
          };
          if (!cancelled) {
            setCaseId(data.case_id);
            setPersistedCase(data.case);
            if (data.case.language) setLanguage(coerceLanguage(data.case.language));
            try {
              window.localStorage.setItem(CASE_ID_STORAGE_KEY, data.case_id);
              if (data.case_token) {
                setCaseToken(data.case_token);
                window.localStorage.setItem(CASE_TOKEN_STORAGE_KEY, data.case_token);
              } else {
                window.localStorage.removeItem(CASE_TOKEN_STORAGE_KEY);
              }
            } catch {
              /* ignore storage failures */
            }
          }
        }
      } catch {
        // Persistence unavailable — the flow still works in-memory.
      }
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  // Headers for any /api/cases/[id] call: JSON + the capability token (Bearer),
  // and/or an OTP-verified owner session (x-owner-session) as a fallback.
  function caseAuthHeaders(json = true): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h["Content-Type"] = "application/json";
    const tok = caseTokenRef.current;
    if (tok) h["Authorization"] = `Bearer ${tok}`;
    const sess = ownerSessionRef.current;
    if (sess) h["x-owner-session"] = sess;
    return h;
  }

  // Fire-and-forget PATCH that records the latest Case subtree(s) server-side.
  function persistPatch(patch: Partial<Case>) {
    const id = caseIdRef.current;
    if (!id) return;
    void (async () => {
      try {
        const res = await fetch(`/api/cases/${id}`, {
          method: "PATCH",
          headers: caseAuthHeaders(),
          body: JSON.stringify(patch),
        });
        if (res.ok) {
          const data = (await res.json()) as { case?: Case };
          if (data.case) setPersistedCase(data.case);
        } else {
          console.error("persistPatch failed", res.status);
        }
      } catch (err) {
        console.error("persistPatch error", err);
      }
    })();
  }

  // Change the UI language AND persist it onto the Case so every server-side LLM
  // call (chat/answer/defenses/explanation) is grounded to the chosen language.
  function changeLanguage(next: Language) {
    setLanguage(next);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    if (caseIdRef.current) persistPatch({ language: next } as Partial<Case>);
  }

  // The chat route grounds on a schema-valid Case; pass the persisted Case when
  // we have one. The SERVER is the sole writer of review.advice_routed now (the
  // chat route persists it), so the client no longer PATCHes it back.
  const caseObject = persistedCase;

  // ----- Step 1: upload / photo -> /api/intake -----------------------------

  async function onFile(file: File) {
    setError(null);
    const mediaType = file.type;
    if (!SUPPORTED_MEDIA.has(mediaType)) {
      setError(t.unsupportedFile);
      return;
    }
    setIntakeBusy(true);
    try {
      const base64Data = await fileToBase64(file);
      const res = await fetch("/api/intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64Data,
          mediaType,
          language: languageRef.current,
          ...(intakeTurnstile ? { turnstileToken: intakeTurnstile } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Intake failed (${res.status}).`);
      const data = (await res.json()) as IntakeResponse;
      setIntake(data);
      setFields(mapFields(data.extractedFields));
      setStep(2);
    } catch {
      setError(t.couldNotReadFile);
    } finally {
      // A Turnstile token is single-use; force a re-solve before the next upload.
      setIntakeTurnstile(null);
      setIntakeBusy(false);
    }
  }

  // ----- Step 2: confirm/correct fields (client-side human gate) -----------

  function confirmField(key: string, correctedValue?: string) {
    // The RAW value is what persists. On confirm-as-read we use the field's raw
    // value (ISO date, dollar string, slug); on correct we use exactly what the
    // tenant typed (ConfirmField hands back the raw input, e.g. an ISO date from
    // the <input type="date">). renderValue() is used ONLY for the on-screen
    // string. (REVIEW fix #4: passing the long-form display string here dropped
    // the patch because toIsoDate failed the round-trip.)
    const corrected =
      correctedValue != null && correctedValue !== "" ? correctedValue : null;
    let rawForPatch = corrected ?? "";

    setFields((prev) =>
      prev.map((f) => {
        if (f.key !== key) return f;
        const rawValue = corrected ?? f.rawValue;
        rawForPatch = rawValue;
        const displayValue = renderValue(key, rawValue);
        return { ...f, confirmed: true, rawValue, displayValue };
      }),
    );

    // Map the confirmed field onto the persisted Case (fire-and-forget).
    // Pass the current Case so subtree patches (court/parties/property) merge
    // with already-confirmed fields rather than clobbering them (the store
    // replaces whole sub-objects, so we pre-merge here).
    const patch = fieldToCasePatch(key, rawForPatch, persistedCase);
    if (patch) persistPatch(patch);
  }

  // ----- Step 5: defenses -> /api/defenses ---------------------------------

  async function loadDefenses() {
    if (defenses || defensesBusy) return;
    setDefensesBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/defenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          language: languageRef.current,
          narrative: fields
            .filter((f) => f.confirmed)
            .map((f) => `${f.label}: ${f.displayValue}`)
            .join("\n"),
        }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as DefensesResponse;
      setDefenses(data.defenses_checklist ?? []);
    } catch {
      setError("We couldn't load possible issues right now. You can try again.");
      setDefenses([]);
    } finally {
      setDefensesBusy(false);
    }
  }

  // ----- Step 6: answer -> /api/answer -------------------------------------

  async function buildDraft() {
    const raw = narrative.trim();
    if (!raw || answerBusy) return;
    setAnswerBusy(true);
    setAnswerRouted(false);
    setError(null);
    try {
      const res = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw_statements: raw, language: languageRef.current }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as AnswerResponse;
      const statements = data.answer_draft?.factual_statements ?? [];
      const assembled = statements.map((s) => `• ${s.text}`).join("\n\n");
      setAnswerText(assembled);
      setAnswerLoaded(true);
      if (data.route_to_human) setAnswerRouted(true);
    } catch {
      setError("We couldn't build a draft right now. You can try again.");
    } finally {
      setAnswerBusy(false);
    }
  }

  async function saveReminder() {
    if (!smsConsent || !phone.trim() || !courtDateField?.confirmed) return;
    const id = caseIdRef.current;
    const e164 = toE164(phone);
    if (!id) {
      setReminderNote(
        "We couldn't save your reminders right now (no case on file). You can still call the free hotline below.",
      );
      return;
    }
    if (!e164) {
      setReminderNote(
        "That number didn't look like a valid US mobile number. Please enter 10 digits, e.g. (212) 555-0123.",
      );
      return;
    }
    setReminderBusy(true);
    setReminderNote(null);
    try {
      const res = await fetch("/api/reminders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_id: id, phone_e164: e164, consent: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        scheduled_count?: number;
        court_date_verified?: boolean;
        dry_run?: boolean;
        message?: string;
      };
      if (!res.ok) {
        setReminderNote(data?.message ?? "We couldn't save your reminders right now.");
        return;
      }
      setReminderSaved(true);
      // Court date is tenant-entered (unverified), so the deterministic scheduler
      // will NOT anchor reminders off it yet (backstop #1). Be honest about that.
      if (!data.court_date_verified || (data.scheduled_count ?? 0) === 0) {
        setReminderNote(
          "We saved your number and your consent to be texted. We only schedule reminders once your court date is confirmed from the official court system (eTrack/NYSCEF) — until then, please rely on your court notice for the date.",
        );
      } else if (data.dry_run) {
        setReminderNote(
          "Reminders are scheduled. (Text sending isn't switched on in this environment yet, so no message will be sent until the service is live.)",
        );
      }
    } catch {
      setReminderNote("Network error saving your reminders. You can try again.");
    } finally {
      setReminderBusy(false);
    }
  }

  // ----- Building intelligence: open-data lookup ---------------------------

  async function lookupBuilding() {
    const id = caseIdRef.current;
    if (buildingBusy) return;
    setBuildingOpen(true);
    setBuildingBusy(true);
    setError(null);
    // Prefer the persisted case (server reads property.address); fall back to
    // the confirmed address field for a preview if no case is persisted.
    const addressField = fields.find((f) => f.key === "premises_address");
    const body: Record<string, unknown> = {};
    if (id) body.case_id = id;
    else if (addressField?.confirmed) body.address = addressField.displayValue;

    if (!body.case_id && !body.address) {
      setBuildingBusy(false);
      setError(
        "Confirm your apartment address first so we can look up your building's public record.",
      );
      return;
    }
    try {
      const res = await fetch("/api/building", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as {
        findings?: BuildingIntelFindings;
        case?: Case;
      };
      setBuildingFindings(data.findings ?? null);
      // The route persists evidence with verify_before_file = unverified; pick up
      // the refreshed Case so the verify gates render against real evidence.
      if (data.case) setPersistedCase(data.case);
    } catch {
      setError("We couldn't look up your building right now. You can try again.");
    } finally {
      setBuildingBusy(false);
    }
  }

  // ----- KB citations for the chat step ------------------------------------

  async function loadKbSources() {
    const confirmed = fields.filter((f) => f.confirmed);
    const query =
      [
        intake?.classification?.case_type === "nonpayment"
          ? "nonpayment case answer court date"
          : "housing court case what to do",
        confirmed.map((f) => f.label).join(" "),
      ]
        .join(" ")
        .trim() || "housing court nonpayment case basics";
    try {
      const res = await fetch("/api/kb", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, k: 4 }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as KbResponse;
      setKbSources(data.results ?? []);
    } catch {
      // Sources are a nice-to-have; failure is silent.
    }
  }

  function goTo(next: Step) {
    setError(null);
    if (next === 5) void loadDefenses();
    if (next === 4 && kbSources.length === 0) void loadKbSources();
    setStep(next);
  }

  return (
    <div className="space-y-5" dir={isRtl(language) ? "rtl" : "ltr"} lang={language}>
      <StepHeader step={step} />

      <div className="flex items-center justify-between gap-2">
        <LanguageSelector
          value={language}
          onChange={changeLanguage}
          label={t.languageLabel}
        />
        <div className="flex items-center gap-3">
          <Link
            href="/case"
            className="text-xs text-trust-700 underline underline-offset-2 hover:text-trust-900"
          >
            Your case home →
          </Link>
          <Link
            href="/provider"
            className="text-xs text-trust-600 underline underline-offset-2 hover:text-trust-800"
          >
            Legal-aid provider view →
          </Link>
        </div>
      </div>

      {!isFullyTranslated(language) && (
        <p className="rounded-md bg-trust-50 px-3 py-2 text-xs text-trust-700">
          {t.partialTranslationNote}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="rounded-md bg-deadline-50 px-3 py-2 text-sm text-deadline-700"
        >
          {error}
        </p>
      )}

      {step > 2 && courtDateField?.confirmed && (
        <div className="hcc-deadline flex items-center justify-between gap-2 rounded-lg">
          <p className="text-sm">
            <span aria-hidden="true">📅 </span>
            <strong>{t.yourCourtDate}</strong> {courtDateField.displayValue}
          </p>
          <button
            type="button"
            onClick={() => setStep(2)}
            className="shrink-0 text-xs font-medium text-trust-700 underline underline-offset-2"
          >
            {t.checkAgain}
          </button>
        </div>
      )}

      {/* ---------------- Step 1: Upload ---------------- */}
      {step === 1 && (
        <section className="space-y-4">
          <p className="text-trust-800">{t.uploadIntro}</p>

          <div className="space-y-3">
            <label
              className={[
                "block w-full rounded-xl bg-trust-600 px-6 py-5 text-center text-lg font-semibold text-white focus-within:ring-2 focus-within:ring-trust-400",
                intakeBusy || !intakeReady
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer hover:bg-trust-700",
              ].join(" ")}
            >
              <span aria-hidden="true" className="mr-2 text-2xl">
                📷
              </span>
              {intakeBusy ? t.readingPapers : t.takePhoto}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                disabled={intakeBusy || !intakeReady}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
            </label>

            <label
              className={[
                "block w-full rounded-xl border border-trust-400 bg-white px-6 py-4 text-center text-base font-semibold text-trust-800 focus-within:ring-2 focus-within:ring-trust-400",
                intakeBusy || !intakeReady
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer hover:bg-trust-50",
              ].join(" ")}
            >
              <span aria-hidden="true" className="mr-2">
                📄
              </span>
              {t.uploadFile}
              <input
                type="file"
                accept="image/*,application/pdf"
                className="sr-only"
                disabled={intakeBusy || !intakeReady}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
            </label>
          </div>

          {/* Bot protection for the public intake action. Dev renders a no-op
              placeholder and emits a sentinel token so local dev still works. */}
          <Turnstile onToken={setIntakeTurnstile} action="intake" />

          {intakeBusy && (
            <p className="text-center text-sm text-trust-700" aria-live="polite">
              {t.readingPapersHint}
            </p>
          )}

          <Disclaimer context={DisclaimerContext.General} variant="chip" />
        </section>
      )}

      {/* ---------------- Step 2: Confirm fields ---------------- */}
      {step === 2 && (
        <section className="space-y-4">
          <p className="text-trust-800">{t.confirmIntro}</p>

          {fields.length === 0 && (
            <div className="hcc-verify rounded-lg">
              <p className="font-medium">We couldn&apos;t pull out clear details.</p>
              <p className="mt-1">
                Try a clearer photo or PDF.{" "}
                <button
                  type="button"
                  className="font-medium text-trust-700 underline underline-offset-2"
                  onClick={() => setStep(1)}
                >
                  Upload again
                </button>
              </p>
            </div>
          )}

          {courtDateField && (
            <ConfirmField
              label={courtDateField.label}
              readValue={courtDateField.displayValue}
              confidence={courtDateField.confidence}
              critical
              inputType="date"
              confirmed={courtDateField.confirmed}
              hint={courtDateField.hint}
              onConfirm={() => confirmField("court_date")}
              onCorrect={(v) => confirmField("court_date", v)}
              confirmLabel={t.yesThatsRight}
              correctLabel={t.noFixIt}
              enterLabel={t.enterIt}
            />
          )}

          {/* eTrack registration affordance — the sanctioned, tenant-driven path
              to a court-VERIFIED date. A tenant-entered date is never
              authoritative; eTrack's official reminder email is. Purely
              informational (no scraping, no stored credentials). */}
          {courtDateField && (
            <RegisterInEtrack
              verified={persistedCase?.court?.court_date_verified === true}
            />
          )}

          {fields
            .filter((f) => f.key !== "court_date")
            .map((f) => (
              <ConfirmField
                key={f.key}
                label={f.label}
                readValue={f.displayValue}
                confidence={f.confidence}
                inputType={f.inputType}
                confirmed={f.confirmed}
                hint={f.hint}
                onConfirm={() => confirmField(f.key)}
                onCorrect={(v) => confirmField(f.key, v)}
                confirmLabel={t.yesThatsRight}
                correctLabel={t.noFixIt}
                enterLabel={t.enterIt}
              />
            ))}

          <Disclaimer context={DisclaimerContext.Deadline} variant="panel" />

          <NavButtons
            onBack={() => setStep(1)}
            backLabel={t.startOver}
            onNext={() => goTo(3)}
            nextLabel={t.continueLabel}
            nextDisabled={!courtDateField?.confirmed}
            nextHint={
              !courtDateField?.confirmed ? t.confirmCourtDateFirst : undefined
            }
          />
        </section>
      )}

      {/* ---------------- Step 3: Summary + timeline ---------------- */}
      {step === 3 && (
        <section className="space-y-4">
          <h2 className="text-lg">What your papers mean</h2>

          {intake?.explanation?.summary && !intake.explanation.refused ? (
            <div className="space-y-2">
              <Disclaimer context={DisclaimerContext.Chat} variant="chip" />
              <div className="whitespace-pre-wrap rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm leading-relaxed text-trust-900">
                {intake.explanation.summary}
              </div>
            </div>
          ) : (
            <p className="text-sm text-trust-700">
              We don&apos;t have a plain-English summary for this one — you can
              still ask the copilot questions in the next step.
            </p>
          )}

          {/* A confirmed-facts recap doubles as a simple timeline anchor. */}
          {fields.some((f) => f.confirmed) && (
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-trust-900">
                What you confirmed
              </h3>
              <ul className="space-y-1.5">
                {fields
                  .filter((f) => f.confirmed)
                  .map((f) => (
                    <li
                      key={f.key}
                      className="flex justify-between gap-3 rounded-lg border border-trust-200 bg-white px-3 py-2 text-sm"
                    >
                      <span className="text-trust-700">{f.label}</span>
                      <span className="text-right font-medium text-trust-900">
                        {f.displayValue}
                      </span>
                    </li>
                  ))}
              </ul>
              <p className="text-xs text-trust-700">
                Always trust your official court notice over anything shown here.
              </p>
            </div>
          )}

          {/* Look up my building — open-data (HPD + ownership) lookup */}
          <div className="space-y-3 rounded-lg border border-trust-200 bg-white px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-trust-900">
                  Look up my building
                </h3>
                <p className="mt-1 text-sm text-trust-700">
                  See public NYC records about your building and landlord —
                  open HPD violations, complaints, and who owns it.
                </p>
              </div>
              <button
                type="button"
                onClick={lookupBuilding}
                disabled={buildingBusy}
                className="shrink-0 rounded-md border border-trust-400 bg-white px-4 py-2 text-sm font-semibold text-trust-800 hover:bg-trust-50 disabled:opacity-50"
              >
                {buildingBusy
                  ? "Looking up…"
                  : buildingFindings
                    ? "Refresh"
                    : "Look it up"}
              </button>
            </div>

            {buildingOpen && (
              <BuildingIntel
                caseId={caseId}
                caseToken={caseToken}
                findings={buildingFindings}
                evidence={evidence}
                onEvidenceUpdate={(next) =>
                  setPersistedCase((prev) =>
                    prev ? ({ ...prev, evidence: next } as Case) : prev,
                  )
                }
              />
            )}
          </div>

          <NavButtons
            onBack={() => setStep(2)}
            onNext={() => goTo(4)}
            nextLabel="Ask the copilot a question"
          />
        </section>
      )}

      {/* ---------------- Step 4: Chat ---------------- */}
      {step === 4 && (
        <section className="space-y-4">
          <h2 className="text-lg">Ask anything about how this works</h2>
          {/* The chat route is now the SOLE server-side writer of
              review.advice_routed + the audit event (REVIEW fix #3). The client
              no longer PATCHes the review subtree back — it would be an untrusted
              writer of a safety signal. */}
          <ChatPanel caseId={caseId ?? sessionId} caseObject={caseObject} />

          {kbSources.length > 0 && (
            <div className="rounded-lg border border-trust-200 bg-trust-50 px-4 py-3">
              <h3 className="text-sm font-semibold text-trust-900">
                Where this information comes from
              </h3>
              <p className="mt-1 text-xs text-trust-700">
                General, non-advice info from vetted public sources. These are the
                kinds of pages the copilot draws on — always trust your official
                court notice and a lawyer over anything here.
              </p>
              <ul className="mt-2 space-y-1.5">
                {kbSources.map((s) => (
                  <li key={s.id} className="text-sm">
                    <a
                      href={s.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-trust-700 underline underline-offset-2"
                    >
                      {s.source_name}
                    </a>
                    <span className="text-trust-700"> — {s.topic}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Review a settlement offer (stipulation reviewer) */}
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-trust-900">
                  Review a settlement offer
                </h3>
                <p className="mt-1 text-sm text-trust-700">
                  Were you handed a settlement or stipulation to sign? Upload it and
                  we&apos;ll explain what each part generally means — never whether
                  to sign it.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setStipOpen((v) => !v)}
                className="shrink-0 rounded-md border border-trust-400 bg-white px-4 py-2 text-sm font-semibold text-trust-800 hover:bg-trust-50"
              >
                {stipOpen ? "Hide" : "Review an offer"}
              </button>
            </div>
            {stipOpen && (
              <div className="mt-3">
                <StipReview caseId={caseId ?? undefined} />
              </div>
            )}
          </div>

          <NavButtons
            onBack={() => setStep(3)}
            onNext={() => goTo(5)}
            nextLabel="See possible issues to ask about"
          />
        </section>
      )}

      {/* ---------------- Step 5: Defenses ---------------- */}
      {step === 5 && (
        <section className="space-y-4">
          <h2 className="text-lg">Possible issues to ask a lawyer about</h2>
          <Disclaimer context={DisclaimerContext.Defense} variant="panel" />

          {defensesBusy && (
            <p className="text-sm text-trust-700" aria-live="polite">
              Looking for issues some tenants raise in cases like yours…
            </p>
          )}

          {defenses && defenses.length === 0 && !defensesBusy && (
            <p className="text-sm text-trust-700">
              We didn&apos;t surface anything specific to ask about here. That
              doesn&apos;t mean there&apos;s nothing — a lawyer can review your
              situation.
            </p>
          )}

          {defenses && defenses.length > 0 && (
            <ul className="space-y-3">
              {defenses.map((d) => (
                <li
                  key={d.defense_code}
                  className="rounded-lg border border-trust-200 bg-white px-4 py-3"
                >
                  <p className="font-semibold text-trust-900">
                    {humanizeDefense(d.defense_code)}
                  </p>
                  {d.explanation && (
                    <p className="mt-1 text-sm text-trust-800">{d.explanation}</p>
                  )}
                  <p className="mt-2 text-xs text-verify-800">
                    This is a question to raise — not a conclusion that it
                    applies to you.
                  </p>
                </li>
              ))}
            </ul>
          )}

          <div className="rounded-lg border border-trust-200 bg-trust-50 px-4 py-3 text-sm">
            <p className="text-trust-800">
              Whether any of these fit your case is a legal question.
            </p>
            <p className="mt-2">
              <TalkToAPersonLink />
            </p>
          </div>

          <NavButtons
            onBack={() => setStep(4)}
            onNext={() => goTo(6)}
            nextLabel="Start a draft answer"
          />
        </section>
      )}

      {/* ---------------- Step 6: Answer draft ---------------- */}
      {step === 6 && (
        <section className="space-y-4">
          <h2 className="text-lg">Your draft answer</h2>
          <Disclaimer context={DisclaimerContext.AnswerDraft} variant="panel" />

          {!answerLoaded && (
            <div className="space-y-2">
              <label
                htmlFor="hcc-narrative"
                className="block text-sm font-medium text-trust-900"
              >
                In your own words, what happened? (For example: did you pay rent
                the landlord says you didn&apos;t? Are there repairs that
                weren&apos;t made? Write it however feels natural — any language
                is fine.)
              </label>
              <textarea
                id="hcc-narrative"
                value={narrative}
                onChange={(e) => setNarrative(e.target.value)}
                rows={6}
                placeholder="Tell us what happened…"
                className="w-full rounded-lg border border-trust-300 bg-white px-3 py-2 text-base leading-relaxed focus:border-trust-500 focus:outline-none focus:ring-2 focus:ring-trust-400"
              />
              <button
                type="button"
                onClick={buildDraft}
                disabled={!narrative.trim() || answerBusy}
                className="rounded-md bg-trust-600 px-4 py-2 text-sm font-semibold text-white hover:bg-trust-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {answerBusy ? "Writing your draft…" : "Make a draft"}
              </button>
              <p className="text-xs text-trust-700">
                We&apos;ll write down what you tell us, word for word — we
                don&apos;t add legal arguments or opinions.
              </p>
            </div>
          )}

          {answerLoaded && (
            <div className="space-y-2">
              {answerRouted && (
                <div className="hcc-deadline rounded-lg text-sm">
                  <p className="font-semibold">
                    <span aria-hidden="true">🤝 </span>
                    Some of what you wrote needs a person
                  </p>
                  <p className="mt-1">
                    Part of your note sounded like a question only a lawyer
                    should answer, so we left it out of the draft and flagged it
                    for the legal team. <TalkToAPersonLink />
                  </p>
                </div>
              )}
              <label
                htmlFor="hcc-answer-draft"
                className="block text-sm font-medium text-trust-900"
              >
                This is a DRAFT. Read every line, fix anything wrong, and have a
                lawyer review it before you file it. You are the one filing it.
              </label>
              <textarea
                id="hcc-answer-draft"
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
                rows={12}
                className="w-full rounded-lg border border-trust-300 bg-white px-3 py-2 text-base leading-relaxed focus:border-trust-500 focus:outline-none focus:ring-2 focus:ring-trust-400"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(answerText);
                  }}
                  className="rounded-md border border-trust-400 bg-white px-4 py-2 text-sm font-semibold text-trust-800 hover:bg-trust-50"
                >
                  Copy draft
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAnswerLoaded(false);
                    setAnswerText("");
                  }}
                  className="rounded-md border border-trust-300 bg-white px-4 py-2 text-sm font-medium text-trust-700 hover:bg-trust-50"
                >
                  Start over
                </button>
              </div>
              <div className="hcc-verify rounded-lg text-sm">
                <p className="font-medium">
                  <span aria-hidden="true">ⓘ </span>
                  Before you file this
                </p>
                <p className="mt-1">
                  A lawyer can review it for free. We strongly recommend it.{" "}
                  <TalkToAPersonLink />
                </p>
              </div>
            </div>
          )}

          <NavButtons
            onBack={() => setStep(5)}
            onNext={() => goTo(7)}
            nextLabel="Set up reminders"
          />
        </section>
      )}

      {/* ---------------- Step 7: Reminders + free help ---------------- */}
      {step === 7 && (
        <section className="space-y-4">
          <h2 className="text-lg">Don&apos;t miss your court date</h2>

          {courtDateField?.confirmed ? (
            <div className="hcc-deadline rounded-lg text-sm">
              <p>
                <span aria-hidden="true">📅 </span>
                <strong>Your court date:</strong> {courtDateField.displayValue}
              </p>
              <p className="mt-1">
                We can text you reminders before this date so you don&apos;t miss
                it. Reminders only use a date you&apos;ve confirmed.
              </p>
            </div>
          ) : (
            <div className="hcc-verify rounded-lg text-sm">
              <p>
                Confirm your court date first so we only remind you of a date you
                checked.{" "}
                <button
                  type="button"
                  className="font-medium text-trust-700 underline underline-offset-2"
                  onClick={() => setStep(2)}
                >
                  Go check it
                </button>
              </p>
            </div>
          )}

          {!reminderSaved ? (
            <div className="space-y-3 rounded-lg border border-trust-200 bg-white px-4 py-3">
              <div>
                <label
                  htmlFor="hcc-phone"
                  className="block text-sm font-medium text-trust-900"
                >
                  Your mobile number (for text reminders)
                </label>
                <input
                  id="hcc-phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="(555) 555-5555"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 w-full rounded-md border border-trust-300 bg-white px-3 py-2 text-base focus:border-trust-500 focus:outline-none focus:ring-2 focus:ring-trust-400"
                />
              </div>
              <label className="flex items-start gap-2 text-sm text-trust-800">
                <input
                  type="checkbox"
                  checked={smsConsent}
                  onChange={(e) => setSmsConsent(e.target.checked)}
                  className="mt-1 h-4 w-4"
                />
                <span>
                  Yes, text me reminders about my court date and deadlines. I can
                  reply STOP any time. Message and data rates may apply.
                </span>
              </label>
              <button
                type="button"
                onClick={() => void saveReminder()}
                disabled={
                  reminderBusy ||
                  !smsConsent ||
                  !phone.trim() ||
                  !courtDateField?.confirmed
                }
                className="rounded-md bg-trust-600 px-4 py-2 text-sm font-semibold text-white hover:bg-trust-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {reminderBusy ? "Saving…" : "Set up reminders"}
              </button>
              {reminderNote && (
                <p className="rounded-md bg-trust-50 px-3 py-2 text-xs text-trust-800">
                  {reminderNote}
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-trust-200 bg-trust-50 px-4 py-3 text-sm text-trust-800">
              <p className="font-medium">
                <span aria-hidden="true">✓ </span>
                You&apos;re set up for reminders.
              </p>
              <p className="mt-1">
                We&apos;ll text you before your court date. Reply STOP any time to
                stop.
              </p>
              {reminderNote && (
                <p className="mt-2 rounded-md bg-white px-3 py-2 text-xs text-trust-800">
                  {reminderNote}
                </p>
              )}
            </div>
          )}

          {/*
            OPTIONAL resume-on-another-device affordance. Collapsed by default
            and never a wall: the copilot works fully without it. Only offered
            once a real case_id has been minted (persistence is live); falls
            back silently when persistence isn't available.
          */}
          {caseId && (
            <ResumeByPhone
              caseId={caseId}
              onLinked={() => {
                window.localStorage.setItem(CASE_ID_STORAGE_KEY, caseId);
              }}
              onSession={({ token }) => {
                // Hold the owner session so cases-route calls authorize from a
                // device that doesn't carry the per-case capability token.
                ownerSessionRef.current = token;
              }}
            />
          )}

          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm">
            <p className="font-semibold text-trust-900">
              {TALK_TO_A_PERSON_CTA.heading}
            </p>
            <p className="mt-1 text-trust-800">{TALK_TO_A_PERSON_CTA.body}</p>
            <p className="mt-2 text-trust-800">
              <strong>{TALK_TO_A_PERSON_CTA.hotlineName}:</strong>{" "}
              {TALK_TO_A_PERSON_CTA.hotlineNote}
            </p>
            <a
              href={`tel:${TALK_TO_A_PERSON_CTA.hotlinePhone}`}
              className="mt-2 inline-block font-semibold text-trust-700 underline underline-offset-2"
            >
              <span aria-hidden="true">💬 </span>
              Call {TALK_TO_A_PERSON_CTA.hotlinePhone} for free help
            </a>
          </div>

          <NavButtons onBack={() => setStep(6)} nextLabel="" />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function humanizeDefense(code: string): string {
  return code
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Compact language picker. Persists the choice onto the Case via the parent. */
function LanguageSelector({
  value,
  onChange,
  label,
}: {
  value: Language;
  onChange: (lang: Language) => void;
  label: string;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-trust-700">
      <span aria-hidden="true">🌐</span>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Language)}
        aria-label={label}
        className="rounded-md border border-trust-300 bg-white px-2 py-1 text-xs text-trust-900 focus:border-trust-500 focus:outline-none focus:ring-2 focus:ring-trust-400"
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang} value={lang}>
            {LANGUAGE_ENDONYMS[lang]}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Map a confirmed UI field (by key + display string) onto a Case patch.
 * The court date is recorded as tenant_entered + unverified — it is NEVER
 * marked verified here (backstop #1: only eTrack/NYSCEF verify a court date).
 */
function fieldToCasePatch(
  key: string,
  display: string,
  current: Case | null,
): Partial<Case> | null {
  // Pre-merge against the current subtree so a per-field patch doesn't clobber
  // sibling fields the tenant already confirmed (the store replaces sub-objects).
  const court = { ...(current?.court ?? {}), court_date_verified: false };
  const landlord = { ...(current?.parties?.landlord ?? {}) };
  const property = { ...(current?.property ?? {}) };

  switch (key) {
    case "court_date": {
      const d = toIsoDate(display);
      if (!d) return null;
      return {
        court: {
          ...court,
          court_date: d,
          court_date_source: "tenant_entered",
          court_date_verified: false,
        },
      };
    }
    case "index_number":
      return { court: { ...court, index_number: display } };
    case "borough": {
      const b = toBoroughEnum(display);
      if (!b) return null;
      return { court: { ...court, borough: b } };
    }
    case "claimed_arrears": {
      const cents = toCents(display);
      if (cents == null) return null;
      return { claimed_arrears: { amount_cents: cents, currency: "USD" } };
    }
    case "landlord_name":
      return { parties: { ...current?.parties, landlord: { ...landlord, name: display } } };
    case "premises_address":
      return {
        property: { ...property, address: { line1: display } },
      };
    case "case_type": {
      const ct = display.trim().toLowerCase() as CaseType;
      return { case_type: ct, case_type_confirmed: true };
    }
    default:
      return null;
  }
}

/**
 * Rehydrate confirmed UI fields from a persisted Case so a reload resumes.
 * Only fields the Case actually carries are produced, all marked confirmed.
 */
function caseToUiFields(c: Case): UiField[] {
  const out: UiField[] = [];
  const push = (key: string, raw: unknown) => {
    const meta = FIELD_META[key] ?? { label: key, inputType: "text" as const };
    out.push({
      key,
      label: meta.label,
      displayValue: renderValue(key, raw),
      rawValue: rawValueOf(key, raw),
      confidence: "high",
      critical: meta.critical,
      inputType: meta.inputType,
      hint: meta.hint,
      confirmed: true,
    });
  };

  if (c.court?.court_date) push("court_date", c.court.court_date);
  if (c.court?.index_number) push("index_number", c.court.index_number);
  if (c.court?.borough) push("borough", c.court.borough);
  if (c.claimed_arrears) push("claimed_arrears", c.claimed_arrears);
  if (c.parties?.landlord?.name) push("landlord_name", c.parties.landlord.name);
  if (c.property?.address) push("premises_address", c.property.address);

  // Preserve display order from FIELD_ORDER.
  out.sort((a, b) => FIELD_ORDER.indexOf(a.key) - FIELD_ORDER.indexOf(b.key));
  return out;
}

function StepHeader({ step }: { step: Step }) {
  const steps: Step[] = [1, 2, 3, 4, 5, 6, 7];
  return (
    <header className="space-y-2">
      <ol
        className="flex items-center gap-1.5"
        aria-label={`Step ${step} of 7: ${STEP_LABELS[step]}`}
      >
        {steps.map((s) => (
          <li
            key={s}
            aria-current={s === step ? "step" : undefined}
            className={[
              "h-1.5 flex-1 rounded-full",
              s < step
                ? "bg-trust-500"
                : s === step
                  ? "bg-trust-600"
                  : "bg-trust-200",
            ].join(" ")}
          />
        ))}
      </ol>
      <p className="text-sm font-medium text-trust-700">
        Step {step} of 7 — {STEP_LABELS[step]}
      </p>
    </header>
  );
}

function NavButtons({
  onBack,
  backLabel = "Back",
  onNext,
  nextLabel,
  nextDisabled,
  nextHint,
}: {
  onBack?: () => void;
  backLabel?: string;
  onNext?: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  nextHint?: string;
}) {
  return (
    <div className="space-y-2 pt-2">
      <div className="flex items-center justify-between gap-3">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="rounded-md border border-trust-300 bg-white px-4 py-2 text-sm font-medium text-trust-700 hover:bg-trust-50 focus:outline-none focus:ring-2 focus:ring-trust-400"
          >
            {backLabel}
          </button>
        ) : (
          <span />
        )}
        {onNext && nextLabel && (
          <button
            type="button"
            onClick={onNext}
            disabled={nextDisabled}
            className="rounded-md bg-trust-600 px-5 py-2 text-sm font-semibold text-white hover:bg-trust-700 disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-trust-400"
          >
            {nextLabel}
          </button>
        )}
      </div>
      {nextHint && <p className="text-xs text-verify-800">{nextHint}</p>}
    </div>
  );
}
