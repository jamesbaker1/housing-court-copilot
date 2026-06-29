/**
 * Provider principal + authorization scoping (API-CONTRACTS §2.2).
 *
 * The middleware verifies the Cloudflare Access JWT and forwards the provider's
 * identity + authorization claims as trusted, non-spoofable headers
 * (x-access-email / x-access-prv / x-access-roles — inbound copies are stripped
 * first). These pure helpers read those headers and enforce two rules the spec
 * makes load-bearing:
 *
 *   1. PER-PROVIDER SCOPING: a provider may see a case only if the granting
 *      handoff consent is addressed to THEM (consent.recipient.recipient_id ==
 *      prv) or is an unscoped/broadcast referral (recipient_id null).
 *   2. ATTORNEY-ONLY ADVICE LINE: advancing referred → represented requires the
 *      `provider_attorney` role.
 *
 * `verified` distinguishes a real Access context (middleware ran, header present)
 * from a dev/test/no-Access call. Routes enforce when verified; when not, they
 * fall back to the prior dev behavior so local `next dev` + tests keep working.
 *
 * Pure: no I/O. Reads only the trusted headers the middleware set.
 */
import type { Case, Consent } from "@/lib/case";

export const ATTORNEY_ROLE = "provider_attorney";

export interface ProviderPrincipal {
  email: string | null;
  /** Provider org id; null in dev/no-claim. */
  prv: string | null;
  roles: string[];
  /** True when this came from a verified Access context (middleware set headers). */
  verified: boolean;
}

/** Read the trusted provider principal off a request (middleware-set headers). */
export function readProviderPrincipal(req: Request): ProviderPrincipal {
  const email = req.headers.get("x-access-email");
  const prv = req.headers.get("x-access-prv");
  const rolesHeader = req.headers.get("x-access-roles");
  return {
    email: email && email.trim() ? email.trim() : null,
    prv: prv && prv.trim() ? prv.trim() : null,
    // A present (even empty) roles header is the signal that middleware verified
    // the Access token — the marker of a real provider context.
    verified: rolesHeader !== null,
    roles:
      rolesHeader && rolesHeader.trim()
        ? rolesHeader.split(",").map((r) => r.trim()).filter(Boolean)
        : [],
  };
}

/** True iff the principal carries the attorney role. */
export function hasAttorneyRole(p: ProviderPrincipal): boolean {
  return p.roles.includes(ATTORNEY_ROLE);
}

/**
 * Is a single handoff consent visible to a caller with org id `prv`?
 * - recipient_id null  → unscoped/broadcast referral, visible to any provider.
 * - recipient_id == prv → addressed to this provider, visible.
 * - otherwise           → addressed to a DIFFERENT provider, hidden.
 * When `prv` is null (dev/single-tenant/no-claim) every consent is visible —
 * scoping is only enforced once the IdP supplies a prv claim.
 */
export function consentVisibleToPrv(cn: Consent, prv: string | null): boolean {
  if (prv == null) return true;
  const rid = cn.recipient?.recipient_id ?? null;
  return rid == null || rid === prv;
}

/**
 * Whether a Case carries a granted, live handoff_to_provider consent VISIBLE to
 * the given provider org id (prv). Combines the consent-validity check with
 * per-provider scoping. `prv = null` ⇒ no scoping (visible if any valid consent).
 */
export function hasVisibleHandoffConsent(
  c: Case,
  prv: string | null,
  asOf: string = new Date().toISOString(),
): boolean {
  const now = Date.parse(asOf);
  return (c.consents ?? []).some((cn) => {
    if (cn.scope !== "handoff_to_provider") return false;
    if (cn.recipient.recipient_type !== "legal_aid_provider") return false;
    if (!cn.granted) return false;
    if (cn.revoked_at && Date.parse(cn.revoked_at) <= now) return false;
    if (cn.expires_at && Date.parse(cn.expires_at) <= now) return false;
    return consentVisibleToPrv(cn, prv);
  });
}

/**
 * Decide whether the attorney-gated transition (referred → represented) should
 * happen. Requires BOTH the INTENT to represent (the client's attorney_confirmed)
 * AND the PERMISSION: in a verified Access context the provider_attorney role; in
 * dev/test (unverified) the intent alone suffices so local flows still work.
 * Requiring intent means a verified attorney who merely accepts a referred case
 * (without confirming representation) does not silently auto-advance it.
 */
export function attorneyAdvanceAllowed(
  p: ProviderPrincipal,
  attorneyConfirmed: boolean,
): boolean {
  if (!attorneyConfirmed) return false;
  return p.verified ? hasAttorneyRole(p) : true;
}
