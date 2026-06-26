/**
 * GET /api/health — readiness probe (Ops).
 *
 * Confirms the app is wired up enough to safely serve tenants: (a) D1 is
 * reachable and the `cases` table exists (a real `SELECT 1` against it), and
 * (b) every required secret / binding is PRESENT. Returns 200 only when all
 * checks pass; otherwise a non-200 with a small JSON body of presence booleans
 * naming which checks failed.
 *
 * HARD RULE: this endpoint reports PRESENCE ONLY. It never reads, echoes, logs,
 * or otherwise leaks a secret value or any PII — just `true`/`false` per check.
 * It must therefore stay safe to expose to an uptime monitor.
 *
 * Binding/secret access mirrors the rest of the app: on Cloudflare Workers,
 * secrets + bindings live on the request context `env` (getCloudflareContext().
 * env, same accessor lib/store.ts uses for env.DB); locally they come from
 * process.env (as lib/turnstile.ts and lib/auth/access.ts read them). We treat a
 * value present in EITHER place as present.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Minimal shape of the D1 binding we probe (avoids a hard dep on @cloudflare/workers-types). */
interface D1PreparedStatement {
  first<T = unknown>(colName?: string): Promise<T | null>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

/**
 * Resolve the Cloudflare context `env` if we're on Workers, else null. Graceful:
 * outside a Workers/OpenNext context getCloudflareContext throws and we fall back
 * to process.env only. Same detection style as lib/store.ts getDB().
 */
async function getCfEnv(): Promise<Record<string, unknown> | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const ctx = await mod.getCloudflareContext({ async: true });
    return (ctx?.env as Record<string, unknown> | undefined) ?? null;
  } catch {
    return null;
  }
}

/** True if `name` resolves to a non-empty value on the Workers env or process.env. */
function present(
  cfEnv: Record<string, unknown> | null,
  name: string,
): boolean {
  const fromCf = cfEnv?.[name];
  if (typeof fromCf === "string" && fromCf.trim() !== "") return true;
  const fromProc = process.env[name];
  return typeof fromProc === "string" && fromProc.trim() !== "";
}

export async function GET(): Promise<NextResponse> {
  const cfEnv = await getCfEnv();

  // PRESENCE-ONLY secret/binding checks. The DB binding lives only on the
  // Workers env; the rest may come from either env (Wrangler SECRET) or
  // process.env (local dev). We record booleans, never the values.
  const db = (cfEnv?.DB as D1Database | undefined) ?? undefined;
  const checks: Record<string, boolean> = {
    DB: Boolean(db),
    ANTHROPIC_API_KEY: present(cfEnv, "ANTHROPIC_API_KEY"),
    TURNSTILE_SECRET_KEY: present(cfEnv, "TURNSTILE_SECRET_KEY"),
    CF_ACCESS_TEAM_DOMAIN: present(cfEnv, "CF_ACCESS_TEAM_DOMAIN"),
    CF_ACCESS_AUD: present(cfEnv, "CF_ACCESS_AUD"),
    CASE_PII_KEY: present(cfEnv, "CASE_PII_KEY"),
  };

  // D1 reachability: only meaningful if the binding is present. A real
  // `SELECT 1 FROM cases` proves both that D1 answers AND that the `cases`
  // table exists; any throw (binding down, table missing) is a failed probe.
  let d1Reachable = false;
  if (db) {
    try {
      await db.prepare("SELECT 1 FROM cases LIMIT 1").first();
      d1Reachable = true;
    } catch {
      d1Reachable = false;
    }
  }
  checks.d1_reachable = d1Reachable;

  const failed = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  const ok = failed.length === 0;

  // 200 only when everything passes; otherwise 503 (Service Unavailable) so an
  // orchestrator/monitor treats the instance as not-ready.
  return NextResponse.json(
    { ok, checks, failed },
    { status: ok ? 200 : 503 },
  );
}
