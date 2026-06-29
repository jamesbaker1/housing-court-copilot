import Link from "next/link";
import Disclaimer from "@/components/Disclaimer";
import { DisclaimerContext } from "@/lib/disclaimers";
import { HELP_RESOURCES, telHref, type HelpResource } from "@/lib/resources";

/**
 * Landing page. Calm, reassuring, low-literacy-friendly, mobile-first.
 *
 * Audience: a scared NYC tenant — often on a borrowed phone, multilingual,
 * sometimes undocumented — holding nonpayment court papers. The job of this page
 * is to (1) calm them, (2) give them the one action that matters most (photograph
 * the papers → /copilot), and (3) surface REAL, free, human help they can reach
 * right now.
 *
 * Hard rules honored here:
 *  - Information, not advice. We never say a tenant "has a case," pick a defense,
 *    or predict an outcome (UPL). Eligibility is always "you may qualify" (§8.7).
 *  - The court date is the thing not to miss — reinforced, but never invented.
 *  - Every phone is a real <a href="tel:…"> and every number/URL comes from the
 *    vetted directory in `@/lib/resources` (no hardcoded contact info here).
 *  - The persistent "guide, not a lawyer" framing lives in the layout banner;
 *    we reinforce it as a trust feature, not legal boilerplate.
 *
 * Server component (no "use client") — the directory is rendered by mapping over
 * `HELP_RESOURCES`. <Disclaimer> is a client component rendered as a child.
 */

const STARTING_POINT_IDS = ["nyc-311-tenant-helpline", "right-to-counsel-nyc"];

const byIds = (ids: string[]): HelpResource[] =>
  ids
    .map((id) => HELP_RESOURCES.find((r) => r.id === id))
    .filter((r): r is HelpResource => Boolean(r));

const byCategory = (categories: HelpResource["category"][]): HelpResource[] =>
  HELP_RESOURCES.filter((r) => categories.includes(r.category));

/**
 * One free-help resource, rendered as a calm card with tap-to-call + open-site
 * actions. All contact data comes from the resource object — never hardcoded.
 */
function ResourceCard({ resource }: { resource: HelpResource }) {
  const tel = telHref(resource.phone);
  return (
    <div className="rounded-lg border border-trust-200 bg-white px-4 py-3">
      <h3 className="text-base font-semibold text-trust-900">{resource.name}</h3>
      <p className="mt-1 text-sm leading-relaxed text-trust-800">
        {resource.description}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {tel && resource.phone && (
          <a
            href={tel}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md bg-trust-600 px-4 py-2.5 text-sm font-semibold text-white no-underline hover:bg-trust-700 focus:outline-none focus:ring-2 focus:ring-trust-400 focus:ring-offset-1"
            aria-label={`Call ${resource.name} at ${resource.phone}`}
          >
            <span aria-hidden="true">📞</span> Call {resource.phone}
          </a>
        )}
        {resource.url && (
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-trust-300 bg-white px-4 py-2.5 text-sm font-medium text-trust-700 no-underline hover:bg-trust-50 focus:outline-none focus:ring-2 focus:ring-trust-400 focus:ring-offset-1"
            aria-label={`Open ${resource.name} website (opens in a new tab)`}
          >
            Open website <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
    </div>
  );
}

/** Small uppercase "eyebrow" label that introduces a group of resources. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wide text-trust-600">
      {children}
    </p>
  );
}

export default function HomePage() {
  const startingPoints = byIds(STARTING_POINT_IDS);
  const legalHelp = byCategory(["tenant_rights", "legal_aid"]);
  const helpCenters = byCategory(["court_help_center"]);
  const rentHelp = byCategory(["emergency_rent"]);

  return (
    <div className="space-y-8">
      {/* 01 — Headline + primary call to action. Warm first, action second. */}
      <header className="space-y-3 text-center">
        <h1 className="text-3xl">You&rsquo;re not alone in this.</h1>
        <p className="text-base leading-relaxed text-trust-800">
          Got court papers about rent your landlord says you owe? We&rsquo;ll
          help you understand what they say, what your dates are, and how to get
          free help &mdash; in plain language, one step at a time.
        </p>
      </header>

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
          You can also upload a photo or PDF you already have. It&rsquo;s free,
          and your information stays private.
        </p>
      </section>

      {/* 02 — What to do right now. Calm orientation, not alarm. */}
      <section className="space-y-3">
        <h2>What to do right now</h2>
        <p className="text-base leading-relaxed text-trust-800">
          Getting court papers is scary. But here&rsquo;s what matters: there are
          free lawyers in New York who help tenants, and there are real steps you
          can take starting today.
        </p>
        <div className="space-y-3">
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3">
            <p className="font-semibold text-trust-900">
              <span aria-hidden="true" className="mr-1.5">
                📅
              </span>
              Don&rsquo;t miss your court date
            </p>
            <p className="mt-1 text-sm leading-relaxed text-trust-800">
              The date on your papers is the most important thing. If you
              don&rsquo;t show up, you can lose your case automatically (this is
              called a &ldquo;default&rdquo;). Write your court date in your phone
              or calendar right now.
            </p>
          </div>
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3">
            <p className="font-semibold text-trust-900">
              <span aria-hidden="true" className="mr-1.5">
                📞
              </span>
              Free legal help exists
            </p>
            <p className="mt-1 text-sm leading-relaxed text-trust-800">
              You may not have to pay for a lawyer. Call 311 and ask about tenant
              help or &ldquo;Right to Counsel.&rdquo; It&rsquo;s free, and they
              speak many languages. Don&rsquo;t wait.
            </p>
          </div>
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3">
            <p className="font-semibold text-trust-900">
              <span aria-hidden="true" className="mr-1.5">
                🛡️
              </span>
              You have rights
            </p>
            <p className="mt-1 text-sm leading-relaxed text-trust-800">
              Getting papers does not mean you have to move out. You have the
              right to go to court, explain your situation, and ask for time to
              pay if you can. A judge decides what happens &mdash; not your
              landlord.
            </p>
          </div>
        </div>
      </section>

      {/* 03 — How it works. The four steps after the CTA. */}
      <section className="space-y-3">
        <h2>How it works</h2>
        <p className="text-sm leading-relaxed text-trust-800">
          Here&rsquo;s what happens when you upload your court papers:
        </p>
        <ol className="space-y-3 text-sm leading-relaxed text-trust-800">
          <li className="flex gap-2">
            <span className="font-semibold text-trust-600">1.</span>
            <span>
              <strong>Show us your papers.</strong> Snap a photo with your phone,
              or upload a PDF you already have. Take photos of the first page and
              any pages with important dates or amounts.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-semibold text-trust-600">2.</span>
            <span>
              <strong>Confirm the important parts.</strong> We pull out key
              information like your court date and what the landlord says you owe.
              You check every detail against your real papers &mdash; we never
              trust a date until you confirm it.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-semibold text-trust-600">3.</span>
            <span>
              <strong>Understand your case in plain language.</strong> We explain
              what the papers mean, what happens next, and what deadlines matter.
              You can ask questions and see your next steps.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="font-semibold text-trust-600">4.</span>
            <span>
              <strong>Get connected to free legal help.</strong> We show you how
              to reach real lawyers and legal-aid groups &mdash; people who can
              give you real legal advice and help you get ready for court.
            </span>
          </li>
        </ol>
      </section>

      {/* 04 — Get free help. The vetted directory, tap-to-call. */}
      <section className="space-y-5">
        <div className="space-y-2">
          <h2>Get free help</h2>
          <p className="text-base leading-relaxed text-trust-800">
            You don&rsquo;t have to figure this out alone. These are real places
            in New York that help tenants for free. Some have phone lines you can
            call right now.
          </p>
        </div>

        <div className="space-y-3">
          <GroupLabel>Start here</GroupLabel>
          {startingPoints.map((r) => (
            <ResourceCard key={r.id} resource={r} />
          ))}
        </div>

        <div className="space-y-3">
          <GroupLabel>Talk to someone about your case</GroupLabel>
          {legalHelp.map((r) => (
            <ResourceCard key={r.id} resource={r} />
          ))}
        </div>

        <div className="space-y-3">
          <GroupLabel>Help Centers at the courthouse</GroupLabel>
          <p className="text-sm leading-relaxed text-trust-800">
            If you go to court without a lawyer, the courthouse has a Help Center
            for forms, filing, and what to expect. Here are the Help Centers for
            each borough &mdash; check your court papers for the right courthouse.
          </p>
          {helpCenters.map((r) => (
            <ResourceCard key={r.id} resource={r} />
          ))}
        </div>
      </section>

      {/* 05 — Know your rights. Plain facts, framed as information not advice. */}
      <section className="space-y-3">
        <h2>Know your rights</h2>
        <p className="text-base leading-relaxed text-trust-800">
          Here are some basic facts about housing court and eviction in New York.
          These are not instructions &mdash; every case is different. But you
          should know them:
        </p>
        <div className="space-y-3">
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm leading-relaxed text-trust-800">
            <strong className="text-trust-900">
              You may have the right to a free lawyer.
            </strong>{" "}
            If your income is low enough, the city may pay for a lawyer to help
            you fight the eviction. Ask about &ldquo;Right to Counsel&rdquo; when
            you call 311 or a legal-aid group.
          </div>
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm leading-relaxed text-trust-800">
            <strong className="text-trust-900">
              Getting papers does not mean you have to move out.
            </strong>{" "}
            Court papers don&rsquo;t mean the landlord can evict you. You have the
            right to go to court and tell your side of the story. A judge makes
            the decision.
          </div>
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm leading-relaxed text-trust-800">
            <strong className="text-trust-900">
              Only a court can order an eviction.
            </strong>{" "}
            Your landlord cannot evict you themselves. Only a court, and then a
            city marshal, can remove you from your home. Anything else &mdash;
            like changing the locks or taking your things &mdash; is illegal.
          </div>
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm leading-relaxed text-trust-800">
            <strong className="text-trust-900">Going to court matters.</strong>{" "}
            If you don&rsquo;t show up, you can lose automatically without ever
            being heard. Make sure your court date is in your phone.
          </div>
          <div className="rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm leading-relaxed text-trust-800">
            <strong className="text-trust-900">
              You can ask the judge for time to pay.
            </strong>{" "}
            In housing court you can ask for time to pay your rent, or for a
            payment plan. The judge can say yes or no, but it&rsquo;s something
            you can ask for.
          </div>
        </div>
        <Disclaimer context={DisclaimerContext.General} variant="chip" />
      </section>

      {/* 06 — What to bring to court. Reassuring, optional checklist. */}
      <section className="space-y-3">
        <h2>What to bring to court</h2>
        <p className="text-sm leading-relaxed text-trust-800">
          When you go to your court date, bring these things. You don&rsquo;t need
          everything on this list &mdash; bring what you have:
        </p>
        <ul className="space-y-2 rounded-lg border border-trust-200 bg-white px-4 py-3 text-sm leading-relaxed text-trust-800">
          {[
            "Your court papers — the summons and petition the landlord gave you.",
            "Your lease, if you have a copy.",
            "Proof you paid rent — receipts, bank statements, or screenshots from payment apps.",
            "Proof of what you owe, if you think the amount is wrong.",
            "Photos of your apartment if things are broken — no heat, mold, holes, or pests.",
            "Any 311 or HPD complaint numbers if you reported repairs.",
            "A photo ID.",
            "A copy of this guide, or any notes you made.",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 shrink-0 text-trust-400">
                ☐
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-trust-700">
          If a lawyer or legal-aid group is helping you, they&rsquo;ll tell you
          what else to bring. Tip: take a screenshot of this list before you go.
        </p>
      </section>

      {/* 07 — Need rent money? Honest, no false hope; eligibility = "may". */}
      <section className="space-y-3">
        <h2>Need rent money?</h2>
        <p className="text-base leading-relaxed text-trust-800">
          If you&rsquo;re behind on rent, there are programs that may help. They
          can be limited and the rules change, so nothing is guaranteed &mdash;
          but it&rsquo;s free to ask. Start by calling 311, or reach one of these
          directly:
        </p>
        <div className="space-y-3">
          {rentHelp.map((r) => (
            <ResourceCard key={r.id} resource={r} />
          ))}
        </div>
        <p className="text-sm leading-relaxed text-trust-700">
          These programs are real but not guaranteed, and not everyone qualifies.
          Don&rsquo;t count on them instead of getting legal help and going to
          court &mdash; but do ask. A legal-aid lawyer or 311 can tell you what
          you might qualify for.
        </p>
        <Disclaimer context={DisclaimerContext.Eligibility} variant="chip" />
      </section>

      {/* 08 — Language access & privacy. Reassurance for vulnerable users. */}
      <section
        className="space-y-3 rounded-lg border border-trust-200 bg-trust-50 px-4 py-3"
        aria-label="Language access and privacy"
      >
        <h2 className="text-base">More support</h2>
        <p className="text-sm leading-relaxed text-trust-800">
          <span aria-hidden="true">🌐 </span>
          <strong>
            <span lang="es">Español</span> / <span lang="zh-Hant">繁體中文</span> /{" "}
            <span lang="ru">Русский</span> / <span lang="ht">Kreyòl</span> /{" "}
            <span lang="bn">বাংলা</span> / <span lang="ko">한국어</span> /{" "}
            <span lang="ar" dir="rtl">العربية</span>:
          </strong>{" "}
          When you upload your court papers, you can pick your language at the top
          of the page, and the assistant will answer in that language. Some
          buttons and labels are still being translated.
        </p>
        <p className="text-sm leading-relaxed text-trust-800">
          <span aria-hidden="true">🔒 </span>
          <strong>Your privacy:</strong> This page does not ask for your name,
          email, or phone number. When you upload your papers, we keep your
          information private and don&rsquo;t share your case with your landlord
          or anyone else without your permission.
        </p>
        <p className="text-sm leading-relaxed text-trust-800">
          If you&rsquo;d rather not upload photos, you can call 311 or any of the
          free hotlines above and talk to a person over the phone instead.
        </p>
      </section>

      {/* 09 — Persistent "guide, not a lawyer" backstop at page level. */}
      <Disclaimer context={DisclaimerContext.General} variant="panel" />
    </div>
  );
}
