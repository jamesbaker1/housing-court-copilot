/**
 * GET /api/provider/cases — the provider triage inbox.
 *
 * Returns Case Objects for which a valid `handoff_to_provider` consent exists
 * (granted, not revoked, not expired) for a legal-aid provider. Each row is a
 * lightweight triage projection (NOT the full Case) suitable for the queue:
 * case_type, court date + urgency, advice_routed / review_state, triage score,
 * and completeness signals.
 *
 * This is the provider surface (capacity multiplier). It is read-mostly over the
 * CONSENTED subset only — a Case with no granted handoff_to_provider consent is
 * never listed here.
 *
 * SECURITY TODO (v1 BLOCKER): there is NO authentication / authorization on this
 * route. A real deployment MUST gate this behind provider authn (a `provider_*`
 * principal per API-CONTRACTS §2) AND scope each row to the requesting provider's
 * `prv` id (consent.recipient.recipient_id == prv), and redact fields outside the
 * consented `data_categories`. Do NOT expose this route to real tenant data until
 * that is in place. See API-CONTRACTS §4.1.
 */

import { NextResponse } from "next/server";

import { listCases, getCase } from "@/lib/store";
import { toTriageRow, type TriageRow } from "@/components/provider/TriageList";
import {
  readProviderPrincipal,
  hasVisibleHandoffConsent,
} from "@/lib/auth/provider-principal";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<NextResponse> {
  // PER-PROVIDER SCOPING (§2.2): only rows whose handoff consent is addressed to
  // THIS provider (or unscoped) are listed. prv comes from the verified Access
  // token (forwarded by middleware as x-access-prv); null prv ⇒ no scoping.
  const { prv } = readProviderPrincipal(req);
  const summaries = await listCases();

  const rows: TriageRow[] = [];
  for (const s of summaries) {
    const c = await getCase(s.case_id);
    if (!c) continue;
    if (!hasVisibleHandoffConsent(c, prv)) continue;
    rows.push(toTriageRow(c));
  }

  rows.sort(compareTriageRows);

  return NextResponse.json({ intakes: rows, count: rows.length });
}

/** Soonest court date first; cases with no court date sink to the bottom. */
function compareTriageRows(a: TriageRow, b: TriageRow): number {
  if (a.court_date && b.court_date) {
    return a.court_date < b.court_date ? -1 : a.court_date > b.court_date ? 1 : 0;
  }
  if (a.court_date) return -1;
  if (b.court_date) return 1;
  return a.updated_at < b.updated_at ? 1 : -1;
}
