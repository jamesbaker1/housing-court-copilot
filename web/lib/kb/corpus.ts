/**
 * CITATION-GROUNDED KNOWLEDGE BASE — curated corpus (the accuracy moat).
 *
 * A small, hand-curated set of citable entries on NYC nonpayment-case basics.
 * The copilot retrieves from this corpus and is instructed to ground its GENERAL,
 * plain-language explanations ONLY in these vetted entries and to cite the
 * `source_name`. If the answer is not here, the copilot says it is not sure and
 * routes the tenant to a person. This is what replaces hallucination with
 * grounded, attributable information.
 *
 * SCOPE (hard rule): every entry is GENERAL, PUBLIC, NON-ADVICE information about
 * how the process works or what a term means. NOTHING here tells a specific
 * tenant what to do, whether they have a case, which defense applies, or predicts
 * an outcome. The copilot's UPL firewall (lib/llm/copilot.ts) still applies on
 * top of this — grounding never loosens it.
 *
 * SOURCES are reputable public NYC/NY tenant resources:
 *  - NY CourtHelp (NY State Unified Court System): https://www.nycourts.gov/courthelp
 *  - Housing Court Answers (HCA): https://housingcourtanswers.org
 *  - LawHelpNY: https://www.lawhelpny.org
 *  - NYC HRA (Human Resources Administration) / Office of Civil Justice
 *
 * ⚠️ SEED CONTENT — FOR ATTORNEY REVIEW BEFORE PRODUCTION USE.
 * These entries are seeded by engineering as a starting point. Each MUST be
 * reviewed and approved by a supervising attorney, and each `source_url` MUST be
 * re-verified as live and accurate, before this corpus is relied on with real
 * tenants. Treat `CORPUS_REVIEW_STATUS` as the gate.
 */

/** Review gate for the whole corpus. Flip to "attorney_reviewed" only after sign-off. */
export const CORPUS_REVIEW_STATUS = "seed_pending_attorney_review" as const;

/** A single curated, citable knowledge-base entry. */
export interface KbEntry {
  /** Stable id (kebab-case slug). */
  id: string;
  /** Short topic label, for grouping / a sources panel. */
  topic: string;
  /** The general question this entry answers ("what is a stipulation?"). */
  question: string;
  /** Plain-English, 6th-grade-reading-level, GENERAL (non-advice) answer. */
  plain_english_answer: string;
  /** Human-readable source name to cite (e.g. "NY CourtHelp"). */
  source_name: string;
  /** Public URL of the source. MUST be re-verified before production use. */
  source_url: string;
  /** Keywords for keyword retrieval. */
  tags: string[];
}

/**
 * The curated corpus. Keep entries GENERAL and citable. Add/edit only after
 * confirming the source supports the plain-English summary.
 */
export const KB_CORPUS: readonly KbEntry[] = [
  {
    id: "what-is-nonpayment",
    topic: "Nonpayment case basics",
    question: "What is a nonpayment case in housing court?",
    plain_english_answer:
      "A nonpayment case is a type of eviction case a landlord starts in housing court when they say a tenant owes back rent. The landlord asks the court for the unpaid rent and, if it is not paid, for the right to evict. The tenant gets a chance to respond and to be heard in court.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/Homes/nonpayment.shtml",
    tags: [
      "nonpayment",
      "eviction",
      "back rent",
      "arrears",
      "petition",
      "what is",
      "case type",
    ],
  },
  {
    id: "rent-demand-basics",
    topic: "Rent demand",
    question: "What is a rent demand?",
    plain_english_answer:
      "Before a landlord can start most nonpayment cases, they usually have to give the tenant a rent demand. This is a notice that says how much rent the landlord says is owed and gives the tenant a set amount of time to pay it or respond. The rent demand is a separate step that comes before the court case.",
    source_name: "Housing Court Answers",
    source_url: "https://housingcourtanswers.org/glossary/",
    tags: [
      "rent demand",
      "notice",
      "demand for rent",
      "before court",
      "what is",
      "petition",
    ],
  },
  {
    id: "the-petition",
    topic: "Court papers",
    question: "What are the petition and notice of petition?",
    plain_english_answer:
      "The petition is the paper the landlord files that explains why they are bringing the case and what they are asking for. The notice of petition tells the tenant that a case has been started and when or how to respond. Together these are the main papers that begin a nonpayment case.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/Homes/nonpayment.shtml",
    tags: [
      "petition",
      "notice of petition",
      "court papers",
      "served",
      "what is",
      "documents",
    ],
  },
  {
    id: "the-answer",
    topic: "Responding to the case",
    question: "What is an answer and how does a tenant respond?",
    plain_english_answer:
      "An answer is the tenant's formal response to the case. In it, the tenant can tell the court their side and raise reasons (called defenses) why they may not owe what is claimed. A tenant can usually answer in writing or, in some courts, in person at the clerk's office. There is generally a deadline to answer, so it helps to act early.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/Homes/nonpaymentAnswer.shtml",
    tags: [
      "answer",
      "respond",
      "response",
      "defenses",
      "deadline",
      "what is",
      "how do i",
    ],
  },
  {
    id: "what-to-bring-to-court",
    topic: "Going to court",
    question: "What should a tenant bring to court?",
    plain_english_answer:
      "It generally helps to bring all your court papers, your photo ID, your lease if you have one, any rent receipts or proof of payments, and any letters or photos that relate to your apartment. Having your papers organized makes it easier to talk with the court and with any lawyer who helps you. Plan to arrive early.",
    source_name: "Housing Court Answers",
    source_url: "https://housingcourtanswers.org/answers/going-to-court/",
    tags: [
      "what to bring",
      "court",
      "documents",
      "evidence",
      "receipts",
      "lease",
      "id",
      "prepare",
    ],
  },
  {
    id: "what-happens-first-appearance",
    topic: "Going to court",
    question: "What happens at the first court appearance?",
    plain_english_answer:
      "At the first appearance the court checks in the people in the case and may send them to talk about whether the case can be settled. Many housing cases are first handled in a settlement part before going before a judge. The tenant may be able to ask for time, ask for a lawyer, or talk about an agreement. Nothing is decided just by showing up.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/Homes/housingCourt.shtml",
    tags: [
      "first appearance",
      "court date",
      "what happens",
      "settlement part",
      "hearing",
      "going to court",
    ],
  },
  {
    id: "what-is-a-stipulation",
    topic: "Stipulations / agreements",
    question: "What is a stipulation (agreement) in housing court?",
    plain_english_answer:
      "A stipulation is a written agreement between the tenant and the landlord that the court approves. It can set out things like how much will be paid and by when, or other terms. A stipulation is binding once signed, so it is a serious document. Because it can affect your rights and what you owe, it is strongly recommended to talk to a lawyer before signing one — do not sign without getting advice.",
    source_name: "Housing Court Answers",
    source_url: "https://housingcourtanswers.org/answers/for-tenants/stipulations/",
    tags: [
      "stipulation",
      "agreement",
      "settlement",
      "sign",
      "do not sign",
      "binding",
      "what is",
    ],
  },
  {
    id: "what-is-a-default",
    topic: "Missing court / default",
    question: "What does a default mean?",
    plain_english_answer:
      "A default generally means the court can make a decision against a person because they did not respond in time or did not come to court when they were supposed to. In an eviction case, a default can lead to a judgment for the landlord. Because of this, it is important to respond by the deadline and to go to scheduled court dates, and to act quickly if you missed something.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/GoingToCourt/default.shtml",
    tags: [
      "default",
      "missed court",
      "did not respond",
      "judgment",
      "what does it mean",
      "deadline",
    ],
  },
  {
    id: "adjournments",
    topic: "Adjournments",
    question: "What is an adjournment?",
    plain_english_answer:
      "An adjournment is when a court date is moved to a later date. People sometimes ask for an adjournment to get more time — for example, to find a lawyer, to gather papers, or because they could not make it. The court decides whether to grant it. If a date is adjourned, it is important to write down the new date and to confirm it against your court papers.",
    source_name: "Housing Court Answers",
    source_url: "https://housingcourtanswers.org/glossary/",
    tags: [
      "adjournment",
      "postpone",
      "more time",
      "new court date",
      "reschedule",
      "what is",
    ],
  },
  {
    id: "repairs-and-conditions",
    topic: "Repairs and conditions",
    question: "What can a tenant do about repairs or bad conditions?",
    plain_english_answer:
      "Tenants generally have a right to a safe and livable home. If there are repair problems, tenants often start by telling the landlord in writing and keeping a record. In NYC, tenants can also report conditions to HPD (the Department of Housing Preservation and Development), including by calling 311. Conditions and repairs can sometimes come up in a housing court case, but how that works depends on the situation.",
    source_name: "Housing Court Answers",
    source_url: "https://housingcourtanswers.org/answers/for-tenants/repairs/",
    tags: [
      "repairs",
      "conditions",
      "hpd",
      "311",
      "habitability",
      "heat",
      "mold",
      "violations",
      "what can i do",
    ],
  },
  {
    id: "hpd-complaints",
    topic: "Repairs and conditions",
    question: "How do you report bad conditions to HPD or 311?",
    plain_english_answer:
      "In New York City, you can report problems in your apartment or building — like no heat or hot water, leaks, or pests — to HPD. The most common way is to call 311 or use the City's 311 online service. HPD can inspect and record violations. Keeping a copy of your complaint and any complaint number is a good idea.",
    source_name: "NYC HRA / NYC 311",
    source_url: "https://portal.311.nyc.gov/article/?kanumber=KA-01102",
    tags: [
      "hpd",
      "311",
      "complaint",
      "report",
      "no heat",
      "hot water",
      "violations",
      "inspection",
      "how do i",
    ],
  },
  {
    id: "right-to-counsel",
    topic: "Free legal help",
    question: "Is there free legal help or a right to a lawyer?",
    plain_english_answer:
      "New York City has a Right to Counsel program that provides free legal help to many tenants facing eviction in housing court, based on things like where they live and their income. Even if you are not sure you qualify, free legal help and tenant hotlines are available. It is worth asking the court or calling a free help line about a lawyer as early as you can.",
    source_name: "NYC HRA Office of Civil Justice",
    source_url: "https://www.nyc.gov/site/hra/help/legal-services-for-tenants.page",
    tags: [
      "right to counsel",
      "rtc",
      "free lawyer",
      "free legal help",
      "attorney",
      "hra",
      "tenant help",
      "represent",
    ],
  },
  {
    id: "find-free-help",
    topic: "Free legal help",
    question: "How can a tenant find free legal help?",
    plain_english_answer:
      "There are free resources that help tenants find legal help and understand the process. LawHelpNY lists free legal services across New York. Housing Court Answers runs information tables and a hotline for housing court questions. You can also ask the court clerk about the help desk for unrepresented people. Reaching out early gives you the most options.",
    source_name: "LawHelpNY",
    source_url: "https://www.lawhelpny.org/issues/housing",
    tags: [
      "free help",
      "legal aid",
      "lawhelpny",
      "hotline",
      "find a lawyer",
      "resources",
      "where to get help",
      "how do i",
    ],
  },
  {
    id: "what-is-a-judgment",
    topic: "Outcomes / terms",
    question: "What is a judgment and a warrant of eviction?",
    plain_english_answer:
      "A judgment is a court's formal decision in the case. In a nonpayment case, a money judgment can say how much is owed. A warrant of eviction is a separate court paper that can allow an eviction to be carried out, and it is handled by a marshal or sheriff. These are later steps in a case, and there are usually notices along the way.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/Homes/evictionProcess.shtml",
    tags: [
      "judgment",
      "warrant",
      "eviction",
      "marshal",
      "sheriff",
      "what is",
      "outcome",
    ],
  },
  {
    id: "paying-rent-into-court",
    topic: "Paying rent / arrears",
    question: "What does it mean to pay rent or arrears in a case?",
    plain_english_answer:
      "In a nonpayment case, the rent the landlord says is owed is sometimes called arrears. There can be different ways money comes up — for example, a tenant may make payments, or there may be programs that help pay rent arrears. How and when to pay can affect a case, so it is a good topic to discuss with a lawyer or free help line.",
    source_name: "Housing Court Answers",
    source_url: "https://housingcourtanswers.org/answers/for-tenants/rent-arrears/",
    tags: [
      "rent",
      "arrears",
      "pay",
      "payment",
      "back rent",
      "money owed",
      "rent assistance",
    ],
  },
  {
    id: "being-served",
    topic: "Court papers",
    question: "What does it mean to be served with court papers?",
    plain_english_answer:
      "Being served means the court papers are delivered to you in the way the law requires, so you know about the case. In housing cases there are rules about how papers must be delivered. The way you were served, and the dates on the papers, can matter, so it is a good idea to keep everything and note when you received it — and to confirm the details with a lawyer.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/GoingToCourt/beingServed.shtml",
    tags: [
      "served",
      "service",
      "delivered papers",
      "notice",
      "received",
      "what does it mean",
    ],
  },
  {
    id: "confirm-your-court-date",
    topic: "Court dates and deadlines",
    question: "How do you confirm your court date and deadlines?",
    plain_english_answer:
      "The dates that matter — your court date and any deadline to respond — come from your official court papers and the court's records. Always check the date printed on your notice and, if you are unsure, confirm with the court clerk. Do not rely on a guessed or estimated date. Writing the confirmed date down and setting a reminder can help you not miss it.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/Homes/housingCourt.shtml",
    tags: [
      "court date",
      "deadline",
      "confirm",
      "when is",
      "calendar",
      "reminder",
      "how do i",
    ],
  },
  {
    id: "ada-and-language-help",
    topic: "Accessibility and language",
    question: "Can a tenant get an interpreter or accessibility help in court?",
    plain_english_answer:
      "Courts provide free interpreters in many languages so people can understand and be understood. Courts also provide accommodations for people with disabilities. If you need an interpreter or an accommodation, you can ask the court clerk ahead of time or when you arrive. This help is free.",
    source_name: "NY CourtHelp",
    source_url: "https://www.nycourts.gov/courthelp/goingtocourt/interpreter.shtml",
    tags: [
      "interpreter",
      "language",
      "translation",
      "disability",
      "accommodation",
      "ada",
      "access",
      "help",
    ],
  },
] as const;
