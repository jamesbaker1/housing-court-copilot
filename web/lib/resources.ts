/**
 * Static, typed directory of NYC free-help resources.
 *
 * This is the "route to existing help" data layer — no partner dependency, no
 * network calls, no LLM. It backs both the conversational "talk to a person"
 * hard-route (advice-seeking turns) and any always-on resource panel.
 *
 * Product framing: this product is a guide, not a lawyer. These are the real,
 * free, human places a NYC tenant facing a nonpayment case can go. Keep this
 * list short, accurate, and tap-to-call friendly.
 *
 * MAINTENANCE / TODO: phone numbers and URLs change. Before launch, verify each
 * entry against the current NYC Office of Civil Justice / OCA listings. The
 * canonical free-help entry point (311 / Right to Counsel) is mirrored in
 * `@/lib/disclaimers` (`TALK_TO_A_PERSON_CTA`); keep the two in sync.
 */

import { BoroughSchema, type Borough } from "@/lib/case";

/** What kind of help a resource provides — drives grouping/iconography in UI. */
export type ResourceCategory =
  | "hotline" // phone-first intake / triage line
  | "right_to_counsel" // City-funded RTC eviction representation intake
  | "legal_aid" // free legal services / self-help legal information
  | "court_help_center"; // in-courthouse Help Center (pro se assistance)

export interface HelpResource {
  /** Stable slug, used as a React key and for analytics. */
  id: string;
  /** Display name. */
  name: string;
  category: ResourceCategory;
  /** One-line, plain-English description of what they do. */
  description: string;
  /**
   * Dialable phone string in human format (e.g. "311" or "(212) 577-3300").
   * Rendered tap-to-call. Null when the resource is web-only.
   */
  phone: string | null;
  /** Homepage / intake URL. Null when phone-only. */
  url: string | null;
  /**
   * Boroughs served. Empty array = citywide / all boroughs. Used to surface the
   * nearest Help Center first when the case borough is known.
   */
  boroughs: Borough[];
  /** True for the single canonical "start here" free-help entry point (311 / RTC). */
  isPrimary?: boolean;
}

/**
 * The directory. Ordered roughly by "where most tenants should start."
 *
 * NOTE: Housing Court Help Center phone numbers route through the borough
 * Civil Court clerk lines; tenants generally walk in. URLs point at the
 * NY Courts Help Center pages. Verify before launch (see file header).
 */
export const HELP_RESOURCES: HelpResource[] = [
  {
    id: "nyc-311-tenant-helpline",
    name: "NYC 311 Tenant Helpline / Right to Counsel",
    category: "hotline",
    description:
      "Call 311 and ask for tenant or eviction help, or Right to Counsel. Free, " +
      "citywide, multilingual — the place to start.",
    phone: "311",
    url: "https://www.nyc.gov/site/hra/help/legal-services-for-tenants.page",
    boroughs: [],
    isPrimary: true,
  },
  {
    id: "right-to-counsel-nyc",
    name: "Right to Counsel NYC Coalition",
    category: "right_to_counsel",
    description:
      "Information on NYC's Right to Counsel law — free legal representation for " +
      "income-eligible tenants facing eviction in Housing Court.",
    phone: null,
    url: "https://www.righttocounselnyc.org/",
    boroughs: [],
  },
  {
    id: "lawhelpny",
    name: "LawHelpNY",
    category: "legal_aid",
    description:
      "Free statewide directory of legal-aid providers, self-help guides, and " +
      "court forms for tenants. Find help near you.",
    phone: null,
    url: "https://www.lawhelpny.org/",
    boroughs: [],
  },
  {
    id: "help-center-manhattan",
    name: "Manhattan Housing Court Help Center",
    category: "court_help_center",
    description:
      "In-courthouse Help Center for tenants without a lawyer — forms, filing, and " +
      "what-to-expect guidance. 111 Centre Street, New York, NY.",
    phone: "(646) 386-5500",
    url: "https://www.nycourts.gov/courts/nyc/housing/index.shtml",
    boroughs: ["manhattan"],
  },
  {
    id: "help-center-bronx",
    name: "Bronx Housing Court Help Center",
    category: "court_help_center",
    description:
      "In-courthouse Help Center for pro se tenants — forms, filing, and guidance. " +
      "1118 Grand Concourse, Bronx, NY.",
    phone: "(718) 466-3000",
    url: "https://www.nycourts.gov/courts/nyc/housing/index.shtml",
    boroughs: ["bronx"],
  },
  {
    id: "help-center-brooklyn",
    name: "Brooklyn Housing Court Help Center",
    category: "court_help_center",
    description:
      "In-courthouse Help Center for pro se tenants — forms, filing, and guidance. " +
      "141 Livingston Street, Brooklyn, NY.",
    phone: "(347) 404-9133",
    url: "https://www.nycourts.gov/courts/nyc/housing/index.shtml",
    boroughs: ["brooklyn"],
  },
  {
    id: "help-center-queens",
    name: "Queens Housing Court Help Center",
    category: "court_help_center",
    description:
      "In-courthouse Help Center for pro se tenants — forms, filing, and guidance. " +
      "89-17 Sutphin Boulevard, Jamaica, NY.",
    phone: "(718) 262-7100",
    url: "https://www.nycourts.gov/courts/nyc/housing/index.shtml",
    boroughs: ["queens"],
  },
  {
    id: "help-center-staten-island",
    name: "Staten Island Housing Court Help Center",
    category: "court_help_center",
    description:
      "In-courthouse Help Center for pro se tenants — forms, filing, and guidance. " +
      "927 Castleton Avenue, Staten Island, NY.",
    phone: "(718) 675-8452",
    url: "https://www.nycourts.gov/courts/nyc/housing/index.shtml",
    boroughs: ["staten_island"],
  },
];

/** The single canonical "start here" resource (311 / Right to Counsel). */
export function primaryResource(): HelpResource {
  const primary = HELP_RESOURCES.find((r) => r.isPrimary);
  // Guaranteed present by the static list above; fall back to the first entry.
  return primary ?? HELP_RESOURCES[0]!;
}

/**
 * Resources relevant to a borough: all citywide entries plus any Help Center for
 * that borough. When `borough` is null/unknown, returns the full directory.
 * The borough-specific Help Center is sorted to appear right after citywide
 * entries so the nearest courthouse surfaces first.
 */
export function resourcesForBorough(
  borough: Borough | null | undefined,
): HelpResource[] {
  const parsed = borough ? BoroughSchema.safeParse(borough) : null;
  if (!parsed || !parsed.success) {
    return [...HELP_RESOURCES];
  }
  const b = parsed.data;
  return HELP_RESOURCES.filter(
    (r) => r.boroughs.length === 0 || r.boroughs.includes(b),
  );
}

/** Convert a human phone string to a `tel:` href. Null when no phone. */
export function telHref(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "");
  if (!digits) return null;
  // US numbers: prefix +1 for 10-digit; leave short codes (311) bare.
  return digits.length === 10 ? `tel:+1${digits}` : `tel:${digits}`;
}
