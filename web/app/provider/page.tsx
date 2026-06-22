/**
 * /provider — the legal-aid provider TRIAGE CONSOLE (capacity multiplier).
 *
 * A SEPARATE surface from the tenant PWA: a legal-aid worker scans pre-screened
 * intakes (only Cases with a granted handoff_to_provider consent), soonest court
 * date first, and opens one to triage. This is the two-sided value of the
 * product — one screened intake here is many minutes saved per case.
 *
 * Server component: reads the consented subset straight from the file store and
 * renders the queue. No tenant PII beyond what the consent authorizes is needed
 * for the queue view.
 *
 * SECURITY TODO (v1 BLOCKER): NO authn/authz yet. Before any real data, this
 * surface MUST require a provider principal (API-CONTRACTS §2) and scope rows to
 * the requesting provider's `prv`. Treat this as an internal prototype only.
 */

import { listCases, getCase } from "@/lib/store";
import TriageList, {
  hasGrantedHandoffConsent,
  toTriageRow,
  type TriageRow,
} from "@/components/provider/TriageList";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function loadQueue(): Promise<TriageRow[]> {
  const summaries = await listCases();
  const rows: TriageRow[] = [];
  for (const s of summaries) {
    const c = await getCase(s.case_id);
    if (!c) continue;
    if (!hasGrantedHandoffConsent(c)) continue;
    rows.push(toTriageRow(c));
  }
  rows.sort((a, b) => {
    if (a.court_date && b.court_date) {
      return a.court_date < b.court_date ? -1 : a.court_date > b.court_date ? 1 : 0;
    }
    if (a.court_date) return -1;
    if (b.court_date) return 1;
    return a.updated_at < b.updated_at ? 1 : -1;
  });
  return rows;
}

export default async function ProviderQueuePage() {
  const rows = await loadQueue();

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-trust-300 bg-trust-100 px-2 py-0.5 text-xs font-semibold text-trust-800">
            Provider console
          </span>
          <span className="text-xs text-gray-500">Separate surface — not the tenant app</span>
        </div>
        <h1 className="text-2xl font-semibold text-gray-900">Triage queue</h1>
        <p className="text-sm text-gray-600">
          Pre-screened intakes from tenants who consented to a handoff. Sorted by
          court date (soonest first). {rows.length} in queue.
        </p>
      </header>

      {/* This is pre-screened intake, not legal advice. */}
      <div
        role="note"
        className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
      >
        <p className="font-semibold">This is pre-screened intake, not legal advice.</p>
        <p className="mt-1">
          Everything below was assembled from what the tenant provided and from
          public data. Surfaced issues and triage scores are information to help a
          human triage — not legal conclusions, not assertions that a tenant
          &ldquo;has a case.&rdquo; A person reviews and decides.
        </p>
      </div>

      {/* v1 security warning, visible in-product. */}
      <div
        role="note"
        className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800"
      >
        <strong>Prototype — no authentication.</strong> This console has no login
        or per-provider scoping yet. Do not use with real tenant data until
        provider authn/authz is implemented.
      </div>

      <TriageList rows={rows} />
    </div>
  );
}
