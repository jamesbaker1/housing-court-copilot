/**
 * StipReview — the stipulation / settlement reviewer UI (INFORMATION ONLY).
 *
 * Flow: the tenant uploads a proposed stipulation (PDF or photo); the component
 * POSTs it to /api/stipulation and renders a term-by-term, plain-English
 * breakdown of WHAT THE DOCUMENT SAYS, with a per-term "verify with a lawyer"
 * affordance and a prominent, always-visible "Do not sign before a lawyer
 * reviews this" banner.
 *
 * This UI never tells the tenant whether to sign. It surfaces information + the
 * "ask a lawyer about this" flags + the "talk to a person before signing" CTA.
 * The banner and binding notice are fixed product copy (not LLM-authored).
 */
"use client";

import { useState } from "react";
import Disclaimer, { TalkToAPersonLink } from "@/components/Disclaimer";
import { DisclaimerContext, TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";

// ---------------------------------------------------------------------------
// Wire types (mirror app/api/stipulation/route.ts response).
// ---------------------------------------------------------------------------

interface StipTerm {
  category: string;
  heading: string;
  what_it_says: string;
  what_it_generally_means: string;
  ask_a_lawyer: boolean;
  ask_a_lawyer_about: string | null;
}

interface StipFlag {
  category: string;
  heading: string;
  ask_a_lawyer_about: string | null;
}

interface TalkToAPerson {
  heading: string;
  body: string;
  action: string;
  hotlineName: string;
  hotlinePhone: string;
  hotlineNote: string;
}

interface StipResponse {
  route_to_human: boolean;
  is_stipulation: boolean | null;
  review: {
    document_overview: string;
    terms: StipTerm[];
    needs_legal_review: boolean;
  } | null;
  flags: StipFlag[];
  binding_notice: string;
  talk_to_a_person: TalkToAPerson;
  disclaimer?: { label: string; body: string };
  message?: string;
}

export interface StipReviewProps {
  /** Optional case_id to attach the review note / escalation to server-side. */
  caseId?: string;
  className?: string;
}

const ACCEPTED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

// ---------------------------------------------------------------------------
// File -> base64 (strip the data: URI prefix; the route tolerates it either way).
// ---------------------------------------------------------------------------

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

const CATEGORY_LABELS: Record<string, string> = {
  payment_amount: "Payment amount",
  payment_schedule: "Payment schedule",
  move_out: "Moving out / giving up the apartment",
  probationary: "Probation clause (what happens if you miss a payment)",
  jurisdiction_waiver: "Giving up rights or defenses",
  repairs_or_conditions: "Repairs / conditions",
  attorney_fees_or_costs: "Fees and costs",
  judgment_or_warrant: "Judgment / warrant of eviction",
  confession_or_admission: "Admitting you owe money",
  other: "Other terms",
};

function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? "Term";
}

// ---------------------------------------------------------------------------
// The prominent "do not sign" banner — always shown once a review surfaces.
// Fixed product copy; not LLM-authored.
// ---------------------------------------------------------------------------

function DoNotSignBanner({ bindingNotice }: { bindingNotice: string }) {
  return (
    <div
      role="alert"
      className="hcc-deadline rounded-lg"
      aria-label="Do not sign before a lawyer reviews this"
    >
      <p className="flex items-start gap-1.5 text-base font-bold">
        <span aria-hidden="true">✋</span>
        <span>Do not sign before a lawyer reviews this.</span>
      </p>
      <p className="mt-1 text-sm">{bindingNotice}</p>
      <p className="mt-2">
        <TalkToAPersonLink />
      </p>
    </div>
  );
}

export default function StipReview({ caseId, className = "" }: StipReviewProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StipResponse | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  async function handleFile(file: File) {
    setError(null);
    setData(null);
    setFileName(file.name);

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError(
        "Please upload a PDF or a clear photo (JPEG/PNG). Convert HEIC photos to JPEG first.",
      );
      return;
    }

    setBusy(true);
    try {
      const base64Data = await fileToBase64(file);
      const res = await fetch("/api/stipulation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base64Data,
          mediaType: file.type,
          ...(caseId ? { case_id: caseId } : {}),
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(payload?.error ?? `Upload failed (${res.status}).`);
      }
      const payload = (await res.json()) as StipResponse;
      setData(payload);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong reading that document. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={["space-y-4", className].filter(Boolean).join(" ")}>
      <div>
        <h2 className="text-lg font-semibold text-trust-900">
          Understand a settlement offer (stipulation)
        </h2>
        <p className="mt-1 text-sm text-trust-700">
          Upload a proposed agreement and we&apos;ll explain, in plain English,
          what each part of it says. We can&apos;t tell you whether to sign it —
          a lawyer does that.
        </p>
      </div>

      {/* Upload control */}
      <label
        className={[
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-trust-300 bg-trust-50 px-4 py-8 text-center",
          "hover:bg-trust-100 focus-within:ring-2 focus-within:ring-trust-400",
          busy ? "pointer-events-none opacity-60" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span aria-hidden="true" className="text-2xl">
          📄
        </span>
        <span className="text-sm font-medium text-trust-800">
          {busy
            ? "Reading your document…"
            : "Tap to upload the stipulation (PDF or photo)"}
        </span>
        {fileName && !busy && (
          <span className="text-xs text-trust-600">{fileName}</span>
        )}
        <input
          type="file"
          accept={ACCEPTED_TYPES.join(",")}
          className="sr-only"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
      </label>

      {error && (
        <p
          role="alert"
          className="rounded-md bg-deadline-50 px-3 py-2 text-sm text-deadline-700"
        >
          {error}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          {/* Always-visible "do not sign" banner */}
          <DoNotSignBanner bindingNotice={data.binding_notice} />

          {/* Could-not-review / route-to-human path */}
          {data.review === null ? (
            <div className="hcc-verify rounded-lg">
              <p className="font-semibold">
                <span aria-hidden="true">ⓘ </span>
                We couldn&apos;t fully review this document
              </p>
              <p className="mt-1 text-sm">
                {data.message ??
                  "A person can help. Try re-uploading a clearer photo or PDF — and do not sign anything before a lawyer reviews it."}
              </p>
            </div>
          ) : (
            <>
              {/* Overview */}
              <div className="rounded-lg border border-trust-200 bg-white p-3">
                <p className="text-xs font-medium uppercase tracking-wide text-trust-500">
                  What this document is
                </p>
                <p className="mt-1 text-sm text-trust-900">
                  {data.review.document_overview}
                </p>
              </div>

              {/* "Ask a lawyer about" summary flags */}
              {data.flags.length > 0 && (
                <div className="hcc-deadline rounded-lg">
                  <p className="font-semibold">
                    <span aria-hidden="true">⚠️ </span>
                    Ask a lawyer about these before signing
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {data.flags.map((f, i) => (
                      <li key={`${f.category}-${i}`}>
                        <span className="font-medium">{f.heading}.</span>{" "}
                        {f.ask_a_lawyer_about ??
                          "This kind of term can have serious consequences — have a lawyer review it."}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Term-by-term breakdown */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-trust-900">
                  What each part says
                </h3>
                {data.review.terms.map((t, i) => (
                  <div
                    key={`${t.category}-${i}`}
                    className="rounded-lg border border-trust-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-trust-900">{t.heading}</p>
                      <span className="shrink-0 rounded-full bg-trust-100 px-2 py-0.5 text-xs text-trust-700">
                        {categoryLabel(t.category)}
                      </span>
                    </div>

                    <p className="mt-2 text-sm text-trust-900">
                      <span className="font-medium">What it says: </span>
                      {t.what_it_says}
                    </p>
                    <p className="mt-1 text-sm text-trust-700">
                      <span className="font-medium">
                        What this kind of term usually means:{" "}
                      </span>
                      {t.what_it_generally_means}
                    </p>

                    {t.ask_a_lawyer && (
                      <p className="mt-2 rounded-md bg-deadline-50 px-2 py-1.5 text-sm text-deadline-800">
                        <span aria-hidden="true">⚠️ </span>
                        <span className="font-semibold">
                          Verify with a lawyer.{" "}
                        </span>
                        {t.ask_a_lawyer_about ??
                          "Have a lawyer review this before you sign."}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {/* Disclaimer that this is information, not advice */}
              <Disclaimer context={DisclaimerContext.AnswerDraft} variant="panel" />
            </>
          )}

          {/* Talk-to-a-person CTA (always, for any surfaced review) */}
          <div className="hcc-verify rounded-lg">
            <p className="font-semibold">
              <span aria-hidden="true">🤝 </span>
              {data.talk_to_a_person.heading}
            </p>
            <p className="mt-1 text-sm">{data.talk_to_a_person.body}</p>
            <div className="mt-2 rounded-md bg-white/60 px-2 py-1.5 text-xs text-trust-900">
              <p className="font-medium">{data.talk_to_a_person.hotlineName}</p>
              <p className="mt-0.5">{data.talk_to_a_person.hotlineNote}</p>
              <a
                href={`tel:${data.talk_to_a_person.hotlinePhone}`}
                className="mt-1 inline-block font-semibold text-trust-700 underline underline-offset-2"
              >
                Call {data.talk_to_a_person.hotlinePhone}
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Static framing even before upload */}
      {!data && (
        <p className="text-xs text-trust-600">
          A stipulation is a binding agreement. {TALK_TO_A_PERSON_CTA.hotlineNote}
        </p>
      )}
    </div>
  );
}
