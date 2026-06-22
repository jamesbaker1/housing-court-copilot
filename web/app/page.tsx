import Link from "next/link";
import Disclaimer, { TalkToAPersonLink } from "@/components/Disclaimer";
import { DisclaimerContext, TALK_TO_A_PERSON_CTA } from "@/lib/disclaimers";

/**
 * Landing page. Calm, reassuring, low-literacy-friendly. One primary action:
 * "Take a photo of your court papers." The persistent "guide, not a lawyer"
 * framing is in the layout banner; here we reinforce it as a trust feature and
 * surface the code-backed court-date backstop up front.
 */
export default function HomePage() {
  return (
    <div className="space-y-7">
      <header className="space-y-3 text-center">
        <h1 className="text-3xl">You&apos;re not alone in this.</h1>
        <p className="text-base leading-relaxed text-trust-800">
          Got court papers about rent you owe? We&apos;ll help you understand
          what they say, what your dates are, and how to get free help — in
          plain language, one step at a time.
        </p>
      </header>

      {/* Primary action — big, friendly, single call-to-action. */}
      <section className="space-y-3 text-center">
        <Link
          href="/copilot"
          className="block w-full rounded-xl bg-trust-600 px-6 py-5 text-lg font-semibold text-white no-underline shadow-sm hover:bg-trust-700 focus:outline-none focus:ring-2 focus:ring-trust-400 focus:ring-offset-2"
        >
          <span aria-hidden="true" className="mr-2 text-2xl">
            📷
          </span>
          Take a photo of your court papers
        </Link>
        <p className="text-sm text-trust-700">
          You can also upload a photo or PDF you already have. It&apos;s free,
          and your information stays private.
        </p>
      </section>

      {/* What this is — the trust framing, contextual. */}
      <Disclaimer context={DisclaimerContext.General} variant="panel" />

      {/* Backstop #1 surfaced up front: the court date is the thing not to miss. */}
      <section className="space-y-2">
        <h2 className="text-lg">How it works</h2>
        <ol className="space-y-2 text-sm text-trust-800">
          <li className="flex gap-2">
            <span className="font-semibold text-trust-600">1.</span>
            <span>
              <strong>Show us your papers.</strong> Snap a photo or upload a PDF.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-semibold text-trust-600">2.</span>
            <span>
              <strong>Confirm the important parts</strong> — especially your
              court date. We never trust a date until you check it against your
              official papers.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-semibold text-trust-600">3.</span>
            <span>
              <strong>Understand your case</strong> in plain language, ask
              questions, and see your next steps and deadlines.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-semibold text-trust-600">4.</span>
            <span>
              <strong>Get free help.</strong> We connect you to real people who
              can give you legal advice.
            </span>
          </li>
        </ol>
      </section>

      {/* Language hint — multilingual audience. */}
      <section
        className="rounded-lg border border-trust-200 bg-trust-50 px-3 py-2 text-sm text-trust-800"
        aria-label="Language options"
      >
        <p>
          <span aria-hidden="true">🌐 </span>
          <strong>Otros idiomas / 其他語言 / Lòt lang:</strong> You can use this
          in your language. Tell the copilot which language you prefer, or change
          it any time.
        </p>
      </section>

      {/* Free-help escape hatch, always available. */}
      <section className="rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm">
        <p className="font-semibold text-trust-900">
          {TALK_TO_A_PERSON_CTA.heading}
        </p>
        <p className="mt-1 text-trust-800">{TALK_TO_A_PERSON_CTA.body}</p>
        <p className="mt-2 text-trust-800">
          <strong>{TALK_TO_A_PERSON_CTA.hotlineName}:</strong>{" "}
          {TALK_TO_A_PERSON_CTA.hotlineNote}
        </p>
        <p className="mt-2">
          <TalkToAPersonLink />
        </p>
      </section>
    </div>
  );
}
