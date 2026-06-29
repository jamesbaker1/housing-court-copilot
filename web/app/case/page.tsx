"use client";

/**
 * The persistent "your case" home (ROADMAP ★5b).
 *
 * A tenant who already has a case lands here to see, at a glance and mobile-first:
 *   - the NEXT recommended action + the court-date COUNTDOWN front-and-center
 *     (the countdown shows ONLY when a court date is confirmed — the human
 *     confirm gate is preserved; an unconfirmed/extracted date is never treated
 *     as authoritative), then
 *   - compact sections: Timeline, Evidence, Documents/Packet, Reminders, and
 *     Handoff/Provider status — each links back into the matching /copilot step.
 *
 * ANONYMOUS-FIRST: this is NOT a wall. A brand-new visitor with no stored case
 * is sent straight to /copilot to start the intake (no account, no login). A
 * returning tenant on the SAME device authenticates to read their own gated
 * case using the per-case capability token minted at create (Authorization:
 * Bearer), persisted in localStorage alongside the case_id — see lib/caseClient
 * and lib/auth/session.ts. CROSS-DEVICE resume is the optional ResumeByPhone
 * (OTP -> owner session) at the bottom; never required.
 *
 * Safety backstops are intact: the court-date confirm gate, every contextual
 * Disclaimer, the language selector, and the "guide, not a lawyer" framing. This
 * page only READS the Case (plus a fire-and-forget language PATCH); it never
 * writes any safety-owned field.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import Disclaimer, { TalkToAPersonLink } from "@/components/Disclaimer";
import ResumeByPhone from "@/components/ResumeByPhone";
import { DisclaimerContext, TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";
import type { Case } from "@/lib/case";
import {
  tenantEligibilityRows,
  eligibilitySummary,
} from "@/lib/eligibility-display";
import {
  buildCourtPrepChecklist,
  groupPrepItems,
  PREP_CATEGORY_LABEL,
  type PrepCategory,
} from "@/lib/court-prep";
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
import {
  CASE_ID_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
  caseAuthHeaders,
  readStoredCaseId,
  readStoredCaseToken,
  storeCaseCredentials,
} from "@/lib/caseClient";

type LoadState = "loading" | "ready" | "none" | "error";

// --- small date helpers (display only; never authoritative) -----------------

/** Whole days from today (local) to an ISO YYYY-MM-DD date. Negative = past. */
function daysUntil(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ms = target.getTime() - today.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function formatLongDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function countdownLabel(days: number): string {
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

export default function CaseHomePage() {
  const router = useRouter();

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [caseId, setCaseId] = useState<string | null>(null);
  const [caseToken, setCaseToken] = useState<string | null>(null);
  const [persistedCase, setPersistedCase] = useState<Case | null>(null);

  const caseTokenRef = useRef<string | null>(null);
  caseTokenRef.current = caseToken;
  // OTP-verified owner session (cross-device resume) — auth fallback when this
  // device doesn't hold the per-case capability token.
  const ownerSessionRef = useRef<string | null>(null);

  const [language, setLanguage] = useState<Language>(DEFAULT_LANGUAGE);
  const t = getStrings(language);

  // ----- Load (or bounce to intake) on mount -------------------------------

  useEffect(() => {
    let cancelled = false;

    try {
      const storedLang = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
      if (storedLang) setLanguage(coerceLanguage(storedLang));
    } catch {
      /* ignore */
    }

    const existing = readStoredCaseId();
    const existingToken = readStoredCaseToken();

    // Anonymous-first: no case on this device -> start the intake immediately.
    if (!existing) {
      router.replace("/copilot");
      return;
    }

    async function load(id: string, token: string | null) {
      try {
        const res = await fetch(`/api/cases/${id}`, {
          headers: caseAuthHeaders({ caseToken: token }),
        });
        if (res.ok) {
          const data = (await res.json()) as { case?: Case };
          if (!cancelled && data.case) {
            setCaseId(data.case.case_id);
            setCaseToken(token);
            setPersistedCase(data.case);
            if (data.case.language) setLanguage(coerceLanguage(data.case.language));
            setLoadState("ready");
            return;
          }
        }
        if (res.status === 403 || res.status === 404) {
          // The stored id/token is stale or forbidden on this device. Don't trap
          // the tenant on an empty hub — send them to the intake to start fresh.
          if (!cancelled) {
            setLoadState("none");
            router.replace("/copilot");
          }
          return;
        }
        if (!cancelled) setLoadState("error");
      } catch {
        if (!cancelled) setLoadState("error");
      }
    }

    void load(existing, existingToken);
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Fire-and-forget language PATCH (the only write this page makes). Uses the
  // same-device capability token / owner-session auth contract.
  function changeLanguage(next: Language) {
    setLanguage(next);
    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    const id = caseId;
    if (!id) return;
    void (async () => {
      try {
        const res = await fetch(`/api/cases/${id}`, {
          method: "PATCH",
          headers: caseAuthHeaders({
            caseToken: caseTokenRef.current,
            ownerSession: ownerSessionRef.current,
            json: true,
          }),
          body: JSON.stringify({ language: next }),
        });
        if (res.ok) {
          const data = (await res.json()) as { case?: Case };
          if (data.case) setPersistedCase(data.case);
        }
      } catch {
        /* best-effort */
      }
    })();
  }

  // ----- Render states -----------------------------------------------------

  if (loadState === "loading" || loadState === "none") {
    return (
      <div className="space-y-4" aria-busy="true">
        <p className="text-sm text-trust-700" aria-live="polite">
          Loading your case…
        </p>
      </div>
    );
  }

  if (loadState === "error" || !persistedCase) {
    return (
      <div className="space-y-4">
        <p className="rounded-md bg-deadline-50 px-3 py-2 text-sm text-deadline-700">
          We couldn&apos;t load your case right now. You can try again, or start
          where you left off.
        </p>
        <Link
          href="/copilot"
          className="inline-block rounded-md bg-trust-600 px-4 py-2 text-sm font-semibold text-white no-underline hover:bg-trust-700"
        >
          Go to my case steps
        </Link>
      </div>
    );
  }

  const c = persistedCase;

  // The court-date GATE: a countdown is shown ONLY for a tenant-confirmed date.
  // court_date_verified true means it was confirmed against the official court
  // system (eTrack/NYSCEF); a tenant-entered date is confirmed-by-the-tenant but
  // NOT authoritative, so we label it honestly and still never present it as
  // official. A date the tenant has not confirmed at all surfaces only as a
  // "confirm your court date" call to action.
  const courtDate = c.court?.court_date ?? null;
  const courtDateConfirmed =
    !!courtDate &&
    (c.court?.court_date_verified === true ||
      c.court?.court_date_source === "tenant_entered");
  const courtDateAuthoritative = c.court?.court_date_verified === true;
  const days = courtDate ? daysUntil(courtDate) : null;

  const evidence = c.evidence ?? [];
  const timeline = c.timeline ?? [];
  const documents = c.documents ?? [];
  const reminders = c.reminders ?? [];
  const deadlines = c.deadlines ?? [];
  const answerDraft = c.answer_draft;
  const review = c.review;
  const adviceRouted = review?.advice_routed === true;
  const reviewState = review?.review_state ?? "unassigned";

  const scheduledReminders = reminders.filter((r) => r.state === "scheduled");
  const eligibilityRows = tenantEligibilityRows(c.eligibility);
  const prep = buildCourtPrepChecklist(c);
  const prepGroups = groupPrepItems(prep.items);

  // The single NEXT recommended action — a simple, honest priority ladder that
  // never advises on the merits, only on what to do next in the tool.
  const next = computeNextAction({
    courtDate,
    courtDateConfirmed,
    hasDraft: !!answerDraft && (answerDraft.factual_statements?.length ?? 0) > 0,
    hasReminders: scheduledReminders.length > 0,
    adviceRouted,
  });

  return (
    <div
      className="space-y-5"
      dir={isRtl(language) ? "rtl" : "ltr"}
      lang={language}
    >
      {/* Header + language selector */}
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl">Your case</h1>
        <LanguageSelector
          value={language}
          onChange={changeLanguage}
          label={t.languageLabel}
        />
      </div>

      {!isFullyTranslated(language) && (
        <p className="rounded-md bg-trust-50 px-3 py-2 text-xs text-trust-700">
          {t.partialTranslationNote}
        </p>
      )}

      {/* ---------------- Court-date countdown (gated) ---------------- */}
      {courtDateConfirmed && courtDate ? (
        <section className="hcc-deadline space-y-1 rounded-lg" aria-label="Court date">
          <p className="text-xs font-semibold uppercase tracking-wide">
            <span aria-hidden="true">📅 </span>
            {t.yourCourtDate}
          </p>
          <p className="text-2xl font-bold leading-tight">
            {days != null ? countdownLabel(days) : formatLongDate(courtDate)}
          </p>
          <p className="text-sm">{formatLongDate(courtDate)}</p>
          {!courtDateAuthoritative && (
            <p className="mt-1 text-xs">
              This is the date you entered. Always trust your official court
              notice — we only treat a date as confirmed when it comes from the
              court system (eTrack/NYSCEF).
            </p>
          )}
          <Link
            href="/copilot"
            className="mt-1 inline-block text-xs font-medium underline underline-offset-2"
          >
            {t.checkAgain}
          </Link>
        </section>
      ) : (
        <section className="hcc-verify space-y-1 rounded-lg" aria-label="Court date">
          <p className="font-medium">
            <span aria-hidden="true">📅 </span>
            Confirm your court date
          </p>
          <p className="text-sm">
            The most important thing is the date you must be in court. We never
            show it as confirmed until you check it against your official papers.
          </p>
          <Link
            href="/copilot"
            className="mt-1 inline-block text-sm font-medium text-trust-700 underline underline-offset-2"
          >
            Check my court date
          </Link>
        </section>
      )}

      {/* ---------------- Next recommended action ---------------- */}
      <section className="space-y-2 rounded-xl border border-trust-200 bg-white px-4 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-trust-600">
          Your next step
        </h2>
        <p className="text-base font-medium text-trust-900">{next.title}</p>
        {next.body && <p className="text-sm text-trust-700">{next.body}</p>}
        <Link
          href={next.href}
          className="inline-block rounded-lg bg-trust-600 px-5 py-2.5 text-sm font-semibold text-white no-underline hover:bg-trust-700 focus:outline-none focus:ring-2 focus:ring-trust-400"
        >
          {next.cta}
        </Link>
      </section>

      {/* ---------------- Court-date discrepancy / escalation ---------------- */}
      {/* When a court source (eTrack/NYSCEF/vendor) reports a date that DISAGREES
          with the tenant-entered date, the connector escalates for human review
          and NEVER overwrites. Surface that honestly so the tenant knows their
          date is in question and a person is looking. We do not show the
          conflicting dates here (the official notice is the source of truth). */}
      {reviewState === "escalated" && !courtDateAuthoritative && courtDate && (
        <section className="hcc-deadline space-y-1 rounded-lg text-sm" aria-label="Court date needs review">
          <p className="font-semibold">
            <span aria-hidden="true">⚠️ </span>
            We need to double-check your court date
          </p>
          <p>
            The court system shows a different date than the one on file, so we
            flagged it for a person to review. Until it&apos;s sorted out, trust
            your official court notice — do not rely on the date shown above.
          </p>
          <p>
            <TalkToAPersonLink />
          </p>
        </section>
      )}

      {/* ---------------- Handoff / advice routing status ---------------- */}
      {adviceRouted && (
        <section className="hcc-deadline space-y-1 rounded-lg text-sm">
          <p className="font-semibold">
            <span aria-hidden="true">🤝 </span>
            A question of yours is with the legal team
          </p>
          <p>
            Something you asked needs a person, so we flagged it for free legal
            help{reviewState !== "unassigned" ? ` (status: ${humanReviewState(reviewState)})` : ""}.
          </p>
          <p>
            <TalkToAPersonLink />
          </p>
        </section>
      )}

      {/* ---------------- Compact sections ---------------- */}
      <div className="space-y-3">
        <HubSection
          icon="🗓️"
          title="Timeline"
          href="/copilot"
          summary={
            timeline.length > 0
              ? `${timeline.length} event${timeline.length === 1 ? "" : "s"} on record`
              : "No timeline events yet"
          }
        >
          {timeline.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {timeline
                .slice()
                .sort((a, b) => a.date.localeCompare(b.date))
                .slice(0, 4)
                .map((ev) => (
                  <li
                    key={ev.event_id}
                    className="flex items-start justify-between gap-3 text-sm"
                  >
                    <span className="text-trust-800">{ev.description}</span>
                    <span className="shrink-0 text-right text-xs text-trust-600">
                      {formatLongDate(ev.date)}
                      {!ev.date_is_authoritative && (
                        <span className="block text-[10px] text-verify-800">
                          unconfirmed
                        </span>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
          )}
          {deadlines.length > 0 && (
            <p className="mt-2 text-xs text-trust-700">
              {deadlines.length} deadline
              {deadlines.length === 1 ? "" : "s"} computed. Always confirm dates
              against your official court notice.
            </p>
          )}
        </HubSection>

        <HubSection
          icon="📎"
          title="Evidence"
          href="/copilot"
          summary={
            evidence.length > 0
              ? `${evidence.length} item${evidence.length === 1 ? "" : "s"} saved`
              : "No evidence saved yet"
          }
        >
          {evidence.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {evidence.slice(0, 4).map((e) => (
                <li key={e.evidence_id} className="text-sm text-trust-800">
                  <span className="font-medium">{humanLabel(e.evidence_type)}</span>
                  {e.summary ? <span className="text-trust-600"> — {e.summary}</span> : null}
                  {e.open_data?.verify_before_file?.state === "unverified" && (
                    <span className="ml-1 text-xs text-verify-800">(verify before filing)</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </HubSection>

        <HubSection
          icon="📄"
          title="Documents & answer packet"
          href="/copilot"
          summary={packetSummary(documents.length, answerDraft)}
        >
          {answerDraft && (
            <p className="mt-2 text-sm text-trust-700">
              Your answer is a <strong>draft</strong> (status:{" "}
              {humanLabel(answerDraft.status)}). Read every line and have a lawyer
              review it before you file — you are the one filing it.
            </p>
          )}
        </HubSection>

        <HubSection
          icon="🔔"
          title="Reminders"
          href="/copilot"
          summary={
            scheduledReminders.length > 0
              ? `${scheduledReminders.length} reminder${scheduledReminders.length === 1 ? "" : "s"} scheduled`
              : courtDateConfirmed
                ? "Set up text reminders"
                : "Confirm your court date to set reminders"
          }
        >
          {scheduledReminders.length === 0 && (
            <p className="mt-2 text-xs text-trust-700">
              We only schedule reminders once your court date is confirmed from
              the official court system. Until then, rely on your court notice.
            </p>
          )}
        </HubSection>

        <HubSection
          icon="📋"
          title="Get ready for court"
          href="/case"
          summary={
            prep.hasCourtDate
              ? "Your court-day checklist: what to bring and what to expect"
              : "Confirm your court date, then see your court-day checklist"
          }
        >
          <div className="mt-2 space-y-3">
            {(["bring", "timing", "expect", "protect"] as PrepCategory[]).map(
              (cat) =>
                prepGroups[cat].length > 0 && (
                  <div key={cat}>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-trust-600">
                      {PREP_CATEGORY_LABEL[cat]}
                    </h4>
                    <ul className="mt-1 space-y-1">
                      {prepGroups[cat].map((item) => (
                        <li key={item.id} className="text-sm text-trust-800">
                          <span aria-hidden="true">☐ </span>
                          {item.text}
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
            )}
            <p className="text-xs text-trust-600">
              This is practical court-day information, not legal advice. For
              questions about your case, talk to a free lawyer.
            </p>
          </div>
        </HubSection>

        <HubSection
          icon="✅"
          title="What free help you may qualify for"
          href="/copilot"
          summary={eligibilitySummary(c.eligibility)}
        >
          {eligibilityRows.length > 0 ? (
            <ul className="mt-2 space-y-1.5">
              {eligibilityRows.map((row) => (
                <li key={row.label} className="text-sm text-trust-800">
                  <span aria-hidden="true">
                    {row.tone === "positive" ? "✅ " : row.tone === "unavailable" ? "▫️ " : "•  "}
                  </span>
                  <strong>{row.label}:</strong> {row.status}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-trust-700">
              We haven&apos;t checked what programs you may qualify for yet. A
              lawyer can help you figure this out — it&apos;s free to ask.
            </p>
          )}
          <p className="mt-2 text-xs text-trust-600">
            This is general information, not a decision about your case. Only a
            lawyer or the program can confirm what you qualify for.
          </p>
        </HubSection>

        <HubSection
          icon="🤝"
          title="Free legal help"
          href="/copilot"
          summary={
            adviceRouted
              ? `With the legal team (${humanReviewState(reviewState)})`
              : "Talk to a real person for free"
          }
        >
          <p className="mt-2 text-sm text-trust-800">
            {TALK_TO_A_PERSON_CTA.body}
          </p>
          <p className="mt-1 text-sm text-trust-800">
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
        </HubSection>
      </div>

      {/* App-wide framing: a guide, not a lawyer. */}
      <Disclaimer context={DisclaimerContext.General} variant="panel" />

      {/* ---------------- Optional cross-device resume ---------------- */}
      {caseId && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-trust-600">
            Come back on another device
          </h2>
          <ResumeByPhone
            caseId={caseId}
            onLinked={() => {
              // Keep this device's same-device credentials intact.
              storeCaseCredentials(caseId, caseTokenRef.current);
            }}
            onSession={({ token }) => {
              // Hold the owner session so writes authorize even if this device
              // doesn't carry the per-case capability token.
              ownerSessionRef.current = token;
            }}
          />
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Next-action ladder (tool navigation, never legal advice on the merits)
// ---------------------------------------------------------------------------

interface NextAction {
  title: string;
  body?: string;
  cta: string;
  href: string;
}

function computeNextAction(args: {
  courtDate: string | null;
  courtDateConfirmed: boolean;
  hasDraft: boolean;
  hasReminders: boolean;
  adviceRouted: boolean;
}): NextAction {
  const { courtDate, courtDateConfirmed, hasDraft, hasReminders } = args;

  if (!courtDate || !courtDateConfirmed) {
    return {
      title: "Confirm your court date",
      body: "This is the most important step. Check the date on your official court papers and confirm it.",
      cta: "Check my court date",
      href: "/copilot",
    };
  }
  if (!hasDraft) {
    return {
      title: "Start your draft answer",
      body: "Tell us what happened in your own words and we'll write it down for you to review with a lawyer.",
      cta: "Start my draft answer",
      href: "/copilot",
    };
  }
  if (!hasReminders) {
    return {
      title: "Set up court-date reminders",
      body: "We can text you before your court date so you don't miss it.",
      cta: "Set up reminders",
      href: "/copilot",
    };
  }
  return {
    title: "Review your case and get free legal help",
    body: "You've covered the basics. A lawyer can review everything with you for free.",
    cta: "Open my case steps",
    href: "/copilot",
  };
}

function humanReviewState(state: string): string {
  return state.replace(/_/g, " ");
}

function humanLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function packetSummary(
  docCount: number,
  answerDraft: Case["answer_draft"],
): string {
  if (answerDraft && (answerDraft.factual_statements?.length ?? 0) > 0) {
    return `Draft answer started${docCount > 0 ? ` · ${docCount} document${docCount === 1 ? "" : "s"}` : ""}`;
  }
  if (docCount > 0) {
    return `${docCount} document${docCount === 1 ? "" : "s"} on file`;
  }
  return "No documents or draft yet";
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function HubSection({
  icon,
  title,
  summary,
  href,
  children,
}: {
  icon: string;
  title: string;
  summary: string;
  href: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-trust-200 bg-white px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-trust-900">
            <span aria-hidden="true" className="mr-1.5">
              {icon}
            </span>
            {title}
          </h3>
          <p className="mt-0.5 text-sm text-trust-700">{summary}</p>
        </div>
        <Link
          href={href}
          className="shrink-0 text-sm font-medium text-trust-700 underline underline-offset-2 hover:text-trust-900"
        >
          Open →
        </Link>
      </div>
      {children}
    </section>
  );
}

/** Compact language picker — same behavior as the copilot's selector. */
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
