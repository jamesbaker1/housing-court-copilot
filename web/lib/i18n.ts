/**
 * Lightweight, dependency-free i18n for the copilot UI.
 *
 * Scope (REVIEW fix #6): the backend already accepts a `language` on the Case and
 * threads it into every LLM call; the UI was hardcoded English. This module wires
 * the plumbing — a supported-language list, a tenant-chosen language persisted onto
 * the Case, and a small string catalog for the HIGHEST-TRAFFIC UI strings +
 * disclaimers. Strings not yet translated fall back to English (marked TODO below).
 *
 * We localize the strings a limited-English tenant hits first (landing/upload,
 * the confirm gate, the court-date banner, the key disclaimers, errors). Deep
 * localization of every screen is explicitly OUT OF SCOPE here and is tracked as
 * a TODO — but the plumbing is real, so the model-facing `language` is honored
 * end-to-end and we do NOT make a false multilingual promise: untranslated UI
 * shows English and the page tells the user which strings are still English.
 */

/** The NYC housing-court priority languages (BCP-47-ish tags used by the backend). */
export const SUPPORTED_LANGUAGES = [
  "en",
  "es",
  "zh-Hant",
  "ru",
  "bn",
  "ht",
  "ko",
  "ar",
] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "en";

/** Right-to-left languages (Arabic) — drives `dir` on the container. */
const RTL_LANGUAGES = new Set<Language>(["ar"]);

export function isRtl(lang: Language): boolean {
  return RTL_LANGUAGES.has(lang);
}

export function isSupportedLanguage(v: unknown): v is Language {
  return typeof v === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(v);
}

export function coerceLanguage(v: unknown): Language {
  return isSupportedLanguage(v) ? v : DEFAULT_LANGUAGE;
}

/** Endonym (name of the language in that language) for the selector. */
export const LANGUAGE_ENDONYMS: Record<Language, string> = {
  en: "English",
  es: "Español",
  "zh-Hant": "繁體中文",
  ru: "Русский",
  bn: "বাংলা",
  ht: "Kreyòl Ayisyen",
  ko: "한국어",
  ar: "العربية",
};

/**
 * The localized "talk to a person" / human-routing CTA (M10). The most
 * safety-load-bearing moment in the product — the advice hard-route to a human
 * (the UPL protection) — must be comprehensible to a limited-English tenant.
 * Mirrors the shape of TALK_TO_A_PERSON_CTA in lib/disclaimers.ts; the
 * hotline phone is NOT translated (it's a dialable number).
 */
export interface TalkToAPersonStrings {
  heading: string;
  body: string;
  action: string;
  hotlineName: string;
  hotlineNote: string;
}

/**
 * The localized contextual disclaimer copy (label + body) keyed by the same
 * contexts as lib/disclaimers.DISCLAIMERS, plus the app-wide persistent banner.
 * These are the safety-critical "verify this / not legal advice / talk to a
 * lawyer" affordances — English-only previously, even in Spanish (M10).
 */
export interface DisclaimerStrings {
  persistentBanner: string;
  general: { label: string; body: string };
  answerDraft: { label: string; body: string };
  defense: { label: string; body: string };
  chat: { label: string; body: string };
  deadline: { label: string; body: string };
  eligibility: { label: string; body: string };
}

/**
 * The translation keys we localize. Keep this list small and high-traffic; it is
 * the set of strings a tenant encounters before/at the verify gate, plus errors,
 * plus the safety-critical disclaimers + human-routing copy (M10).
 */
export interface Strings {
  // Language selector
  languageLabel: string;
  /** Shown under the selector when the chosen language is only partly translated. */
  partialTranslationNote: string;

  // Upload / step 1
  uploadIntro: string;
  takePhoto: string;
  uploadFile: string;
  readingPapers: string;
  readingPapersHint: string;
  /**
   * Staged reassurance copy shown (one at a time, ~4s apart) under the upload
   * spinner during the 10-30s+ OCR so the step doesn't read as frozen (S2).
   */
  readingPapersStage1: string;
  readingPapersStage2: string;
  readingPapersStage3: string;
  /** "Use a different photo" — forgiving retake control after an unclear read (S2). */
  retake: string;
  /** Icon-led framing tips shown under the upload buttons (S2). */
  framingTipFlat: string;
  framingTipLight: string;
  framingTipWholePage: string;
  /**
   * Friendly max-payload guard shown when even a downscaled photo is too large
   * to upload safely (S3). Steers toward a fresh, less-detailed photo or a PDF.
   */
  fileTooLarge: string;

  // Confirm / step 2
  confirmIntro: string;
  yesThatsRight: string;
  noFixIt: string;
  enterIt: string;
  continueLabel: string;
  startOver: string;
  confirmCourtDateFirst: string;

  // Court-date banner
  yourCourtDate: string;
  checkAgain: string;

  // Continuity on borrowed phones (S8) — non-blocking, never a hard-fail.
  /** Shown when POST /api/cases is rate-limited (NAT-shared 429): saving is busy. */
  savingUnavailable: string;
  /** Shown when localStorage is blocked (incognito): saving across sessions is off. */
  savingUnavailableBrowser: string;

  // Errors (M7: localized, recoverable failure UX)
  unsupportedFile: string;
  couldNotReadFile: string;
  genericError: string;
  /** Generic "we couldn't reach the assistant/service" message. */
  networkError: string;
  /** Timed-out / hung-upstream message (M6). */
  timeoutError: string;
  /** "Try again" button label (M7 retry escape hatch). */
  retry: string;
  /** Inline "talk to a person" helper shown in error blocks (M7). */
  needHelpNow: string;
  /** Per-surface failure messages (M7). */
  defensesError: string;
  answerError: string;
  buildingError: string;
  chatError: string;
  stipulationError: string;
  /**
   * Shown when the assistant could not be reached because the upstream model is
   * overloaded (Anthropic 429/529). Distinct from {@link chatError}: it frames a
   * TRANSIENT capacity problem ("busy — try again shortly") rather than a generic
   * failure, so a scared tenant doesn't read a temporary blip as "this is broken."
   */
  assistantBusy: string;

  /**
   * Status announced (politely, once) while a chat reply is being prepared
   * server-side. The reply is fully buffered before any text is surfaced (for
   * outbound safety scanning), so the wait can run 10-40s; this single string
   * gives the dedicated screen-reader live region something meaningful to say
   * and backs the animated "working" placeholder (S1/S6).
   */
  chatWorking: string;

  /** Draft Answer packet (mechanical-fill) — button, note, and failure copy. */
  packetDownload: string;
  packetDraftNote: string;
  packetError: string;

  // a11y (M9)
  /** Visually-hidden page title for the stepped flow. */
  copilotPageTitle: string;
  /** "Step N of 7: <label>" template, with {n} and {label} placeholders. */
  stepProgress: string;

  // Disclaimer (short, app-wide framing)
  guideNotLawyer: string;

  // Safety-critical, localized human-routing + disclaimer copy (M10)
  talkToAPerson: TalkToAPersonStrings;
  disclaimers: DisclaimerStrings;
  /** The fixed non-advice reply body shown when a chat turn is hard-routed. */
  routedChatBody: string;
  /** The answer-draft route-to-human notice (step 6). */
  answerRoutedHeading: string;
  answerRoutedBody: string;
}

const en: Strings = {
  languageLabel: "Language",
  partialTranslationNote:
    "Some parts of this tool are still only in English. We're working on it.",

  uploadIntro:
    "Take a clear photo of your court papers, or upload a photo or PDF you already have. We'll read it and show you what it says.",
  takePhoto: "Take a photo",
  uploadFile: "Upload a photo or PDF",
  readingPapers: "Reading your papers…",
  readingPapersHint: "Reading your papers… this can take a few seconds.",
  readingPapersStage1: "Reading the words on your papers…",
  readingPapersStage2: "Finding your court date and case number…",
  readingPapersStage3: "Almost done — this can take up to 30 seconds.",
  retake: "Use a different photo",
  framingTipFlat: "Lay the page flat",
  framingTipLight: "Good light, no shadows",
  framingTipWholePage: "Fit the whole page in the frame",
  fileTooLarge:
    "That photo is very large. Try taking the photo again, a bit further from the page, or upload a PDF.",

  confirmIntro:
    "Here's what we read from your papers. Please check each one against your official documents. Fix anything that's wrong — you know your case best.",
  yesThatsRight: "Yes, that's right",
  noFixIt: "No, fix it",
  enterIt: "Enter it",
  continueLabel: "Looks right — continue",
  startOver: "Start over",
  confirmCourtDateFirst:
    "Please confirm your court date before continuing — it's the most important date.",

  yourCourtDate: "Your court date:",
  checkAgain: "Check again",

  savingUnavailable:
    "Saving isn't available right now (the network is busy). You can keep going — your court notice is the source of truth.",
  savingUnavailableBrowser:
    "Saving across sessions isn't available on this browser, so this case may not be here if you come back. You can keep going — your court notice is the source of truth.",

  unsupportedFile:
    "That file type isn't supported. Please use a JPEG or PNG photo, or a PDF. (If your phone saved a HEIC photo, try taking a screenshot of it first.)",
  couldNotReadFile:
    "We couldn't read that file. Try a clearer photo, or a PDF, and make sure the whole page is visible.",
  genericError: "Something went wrong. You can try again.",
  networkError:
    "We couldn't reach the service just now. Check your connection and try again.",
  timeoutError:
    "That took too long and timed out — the connection may be slow. You can try again.",
  retry: "Try again",
  needHelpNow: "Need help now?",
  defensesError:
    "We couldn't load possible issues right now. You can try again.",
  answerError: "We couldn't build a draft right now. You can try again.",
  buildingError:
    "We couldn't look up your building right now. You can try again.",
  chatError:
    "Something went wrong reaching the assistant. You can try again.",
  stipulationError:
    "Something went wrong reading that document. You can try again.",

  assistantBusy:
    "The assistant is very busy right now. Please wait a moment and try again.",

  chatWorking: "Working on it…",

  packetDownload: "Download my draft Answer",
  packetDraftNote:
    "Creates a draft Answer filled in with your case details. It's a starting " +
    "point, not the official court form — read every line and review it with a " +
    "lawyer or the court Help Center before you file. You are the one filing it.",
  packetError:
    "We couldn't build your draft Answer right now. You can try again.",

  copilotPageTitle: "Housing Court Copilot — your case, step by step",
  stepProgress: "Step {n} of 7: {label}",

  guideNotLawyer: "A guide, not a lawyer — information, not legal advice.",

  talkToAPerson: {
    heading: "Talk to a person",
    body:
      "Questions like “do I have a case?”, “which defense should I use?”, or “what " +
      "will happen?” need a real person who can look at your specific situation. " +
      "We don't answer those here — and that's on purpose. Free help is available.",
    action: "Get free legal help",
    hotlineName: "NYC tenant help line (free)",
    hotlineNote:
      "Call 311 and ask for tenant / eviction help, or Right to Counsel. It's free.",
  },
  disclaimers: {
    persistentBanner:
      "This is a guide, not a lawyer. It gives you information to help you understand " +
      "your case — not legal advice. Always double-check anything important and, when " +
      "you can, talk to a lawyer.",
    general: {
      label: "A guide, not a lawyer",
      body:
        "This is a guide, not a lawyer. It gives you information to help you understand " +
        "your case — not legal advice. Always double-check anything important and, when " +
        "you can, talk to a lawyer.",
    },
    answerDraft: {
      label: "Draft — check every word before you file",
      body:
        "This draft was put together from what you told us and the documents you " +
        "uploaded. It is a starting point, not a finished legal filing. Read every " +
        "line, fix anything that's wrong, and have a lawyer review it before you " +
        "submit it to the court. You are the one filing it.",
    },
    defense: {
      label: "Possible issues to ask about — not advice",
      body:
        "These are possible issues some tenants raise in cases like yours, shown so " +
        "you know what to ask about. Seeing one here does NOT mean it applies to you " +
        "or that you “have a case.” Only a lawyer can tell you which, if any, fit " +
        "your situation. This is information, not advice.",
    },
    chat: {
      label: "Helpful info — double-check it",
      body:
        "This assistant can explain how housing court works and help you organize " +
        "your case, but it can make mistakes and it is not your lawyer. Don't rely " +
        "on it for decisions about your case — verify important things and talk to a " +
        "person when it matters.",
    },
    deadline: {
      label: "Confirm this date — missing it can cause a default",
      body:
        "Court dates and deadlines are calculated by our system and must be " +
        "confirmed by you against your official court papers. A wrong or missed date " +
        "can lead to a default judgment (you can lose automatically). Always trust " +
        "your official court notice and confirm with the court if you're unsure.",
    },
    eligibility: {
      label: "An estimate — programs change",
      body:
        "This is an estimate based on the information you gave us and current program " +
        "rules, which change often (and some programs may be closed or in flux). It " +
        "is not a decision or a guarantee. Confirm with the program or a legal-aid " +
        "provider before relying on it.",
    },
  },
  routedChatBody:
    "That's an important question. I can't tell you what to do or whether you " +
    "have a case — a lawyer needs to answer that. I've flagged your question for " +
    "the legal team so a person can help you.",
  answerRoutedHeading: "Some of what you wrote needs a person",
  answerRoutedBody:
    "Part of your note sounded like a question only a lawyer should answer, so " +
    "we left it out of the draft and flagged it for the legal team.",
};

/**
 * Spanish — the single highest-traffic non-English language in NYC housing court.
 * Other languages currently fall back to English (see CATALOG below). TODO:
 * translate the remaining priority languages (zh-Hant, ru, bn, ht, ko, ar).
 */
const es: Strings = {
  languageLabel: "Idioma",
  partialTranslationNote:
    "Algunas partes de esta herramienta todavía están solo en inglés. Estamos trabajando en ello.",

  uploadIntro:
    "Tome una foto clara de sus documentos judiciales, o suba una foto o PDF que ya tenga. La leeremos y le mostraremos lo que dice.",
  takePhoto: "Tomar una foto",
  uploadFile: "Subir una foto o PDF",
  readingPapers: "Leyendo sus documentos…",
  readingPapersHint: "Leyendo sus documentos… esto puede tardar unos segundos.",
  readingPapersStage1: "Leyendo las palabras de sus documentos…",
  readingPapersStage2: "Buscando su fecha de corte y número de caso…",
  readingPapersStage3: "Casi listo — esto puede tardar hasta 30 segundos.",
  retake: "Usar otra foto",
  framingTipFlat: "Ponga la página plana",
  framingTipLight: "Buena luz, sin sombras",
  framingTipWholePage: "Que toda la página quepa en el cuadro",
  fileTooLarge:
    "Esa foto es muy grande. Intente tomar la foto de nuevo, un poco más lejos de la página, o suba un PDF.",

  confirmIntro:
    "Esto es lo que leímos de sus documentos. Por favor revise cada dato con sus documentos oficiales. Corrija cualquier error — usted conoce su caso mejor que nadie.",
  yesThatsRight: "Sí, es correcto",
  noFixIt: "No, corregir",
  enterIt: "Escribirlo",
  continueLabel: "Está bien — continuar",
  startOver: "Empezar de nuevo",
  confirmCourtDateFirst:
    "Por favor confirme su fecha de corte antes de continuar — es la fecha más importante.",

  yourCourtDate: "Su fecha de corte:",
  checkAgain: "Revisar otra vez",

  savingUnavailable:
    "Guardar no está disponible en este momento (la red está ocupada). Puede continuar — su aviso de la corte es la fuente de verdad.",
  savingUnavailableBrowser:
    "Guardar entre sesiones no está disponible en este navegador, así que este caso puede no estar aquí si regresa. Puede continuar — su aviso de la corte es la fuente de verdad.",

  unsupportedFile:
    "Ese tipo de archivo no es compatible. Use una foto JPEG o PNG, o un PDF. (Si su teléfono guardó una foto HEIC, intente tomar una captura de pantalla primero.)",
  couldNotReadFile:
    "No pudimos leer ese archivo. Intente con una foto más clara, o un PDF, y asegúrese de que se vea toda la página.",
  genericError: "Algo salió mal. Puede intentarlo de nuevo.",
  networkError:
    "No pudimos conectarnos al servicio en este momento. Revise su conexión e inténtelo de nuevo.",
  timeoutError:
    "Tardó demasiado y se agotó el tiempo — la conexión puede estar lenta. Puede intentarlo de nuevo.",
  retry: "Intentar de nuevo",
  needHelpNow: "¿Necesita ayuda ahora?",
  defensesError:
    "No pudimos cargar los posibles problemas en este momento. Puede intentarlo de nuevo.",
  answerError:
    "No pudimos preparar un borrador en este momento. Puede intentarlo de nuevo.",
  buildingError:
    "No pudimos buscar su edificio en este momento. Puede intentarlo de nuevo.",
  chatError:
    "Algo salió mal al conectar con el asistente. Puede intentarlo de nuevo.",
  stipulationError:
    "Algo salió mal al leer ese documento. Puede intentarlo de nuevo.",

  assistantBusy:
    "El asistente está muy ocupado en este momento. Espere un momento e inténtelo de nuevo.",

  chatWorking: "Trabajando en ello…",

  packetDownload: "Descargar mi borrador de Contestación",
  packetDraftNote:
    "Crea un borrador de Contestación con los datos de su caso. Es un punto de " +
    "partida, no el formulario oficial de la corte — lea cada línea y revíselo con " +
    "un abogado o el Centro de Ayuda de la corte antes de presentarlo. Usted es " +
    "quien lo presenta.",
  packetError:
    "No pudimos crear su borrador de Contestación en este momento. Puede intentarlo de nuevo.",

  copilotPageTitle: "Copiloto de la Corte de Vivienda — su caso, paso a paso",
  stepProgress: "Paso {n} de 7: {label}",

  guideNotLawyer: "Una guía, no un abogado — información, no asesoría legal.",

  talkToAPerson: {
    heading: "Hable con una persona",
    body:
      "Preguntas como “¿tengo un caso?”, “¿qué defensa debo usar?” o “¿qué va a " +
      "pasar?” necesitan una persona real que pueda ver su situación específica. " +
      "No las respondemos aquí — y es a propósito. Hay ayuda gratuita disponible.",
    action: "Obtenga ayuda legal gratuita",
    hotlineName: "Línea de ayuda para inquilinos de NYC (gratis)",
    hotlineNote:
      "Llame al 311 y pida ayuda para inquilinos / desalojo, o Right to Counsel. Es gratis.",
  },
  disclaimers: {
    persistentBanner:
      "Esto es una guía, no un abogado. Le da información para ayudarle a entender " +
      "su caso — no asesoría legal. Siempre verifique cualquier cosa importante y, " +
      "cuando pueda, hable con un abogado.",
    general: {
      label: "Una guía, no un abogado",
      body:
        "Esto es una guía, no un abogado. Le da información para ayudarle a entender " +
        "su caso — no asesoría legal. Siempre verifique cualquier cosa importante y, " +
        "cuando pueda, hable con un abogado.",
    },
    answerDraft: {
      label: "Borrador — revise cada palabra antes de presentarlo",
      body:
        "Este borrador se preparó con lo que nos dijo y los documentos que subió. Es " +
        "un punto de partida, no una presentación legal terminada. Lea cada línea, " +
        "corrija lo que esté mal, y haga que un abogado lo revise antes de " +
        "presentarlo ante la corte. Usted es quien lo presenta.",
    },
    defense: {
      label: "Posibles problemas para preguntar — no es asesoría",
      body:
        "Estos son posibles problemas que algunos inquilinos plantean en casos como " +
        "el suyo, mostrados para que sepa qué preguntar. Ver uno aquí NO significa que " +
        "le corresponda ni que “tenga un caso.” Solo un abogado puede decirle cuáles, " +
        "si alguno, encajan en su situación. Esto es información, no asesoría.",
    },
    chat: {
      label: "Información útil — verifíquela",
      body:
        "Este asistente puede explicar cómo funciona la corte de vivienda y ayudarle " +
        "a organizar su caso, pero puede cometer errores y no es su abogado. No " +
        "dependa de él para decisiones sobre su caso — verifique las cosas " +
        "importantes y hable con una persona cuando importe.",
    },
    deadline: {
      label: "Confirme esta fecha — perderla puede causar un fallo en rebeldía",
      body:
        "Las fechas de corte y los plazos los calcula nuestro sistema y usted debe " +
        "confirmarlos con sus documentos oficiales de la corte. Una fecha equivocada " +
        "o perdida puede llevar a un fallo en rebeldía (puede perder automáticamente). " +
        "Siempre confíe en su aviso oficial de la corte y confirme con la corte si no está seguro.",
    },
    eligibility: {
      label: "Una estimación — los programas cambian",
      body:
        "Esto es una estimación basada en la información que nos dio y las reglas " +
        "actuales del programa, que cambian con frecuencia (y algunos programas " +
        "pueden estar cerrados o en cambio). No es una decisión ni una garantía. " +
        "Confirme con el programa o un proveedor de ayuda legal antes de depender de ello.",
    },
  },
  routedChatBody:
    "Esa es una pregunta importante. No puedo decirle qué hacer ni si tiene un " +
    "caso — un abogado debe responder eso. He marcado su pregunta para el equipo " +
    "legal para que una persona pueda ayudarle.",
  answerRoutedHeading: "Parte de lo que escribió necesita una persona",
  answerRoutedBody:
    "Parte de su nota sonó como una pregunta que solo un abogado debería responder, " +
    "así que la dejamos fuera del borrador y la marcamos para el equipo legal.",
};

/**
 * Catalog. Languages without a full translation map to English (fallback). The
 * selector still persists the chosen language onto the Case, so the MODEL output
 * (chat/answer/defenses/explanation) is produced in that language even where the
 * static UI chrome is not yet translated. TODO: add full catalogs for the rest.
 */
const CATALOG: Record<Language, Strings> = {
  en,
  es,
  "zh-Hant": en,
  ru: en,
  bn: en,
  ht: en,
  ko: en,
  ar: en,
};

/** Languages with a complete UI string catalog (the rest fall back to English). */
const FULLY_TRANSLATED = new Set<Language>(["en", "es"]);

export function isFullyTranslated(lang: Language): boolean {
  return FULLY_TRANSLATED.has(lang);
}

export function getStrings(lang: Language): Strings {
  return CATALOG[lang] ?? en;
}

/**
 * Map a caught error to a localized, recoverable failure message (M7). A
 * timeout/idle-stall from lib/fetch.ts surfaces as the timeout copy; anything
 * else falls back to `fallback` (a per-surface message such as `t.chatError`).
 * We detect the timeout by the error's `name` (string-based) so we don't couple
 * to the class identity (and don't risk an import cycle with lib/fetch):
 *   - "FetchTimeoutError" — fetchWithTimeout normalizes the timeout that fires
 *     before the response headers arrive (lib/fetch.ts).
 *   - "TimeoutError" — the NATIVE DOMException AbortSignal.timeout() raises when
 *     the request signal fires DURING streaming (after fetchWithTimeout has
 *     already returned the Response, so its normalization no longer runs — e.g. a
 *     long but steadily-streaming reply over a slow connection hits the total
 *     request budget while the per-chunk idle timer keeps resetting). Without
 *     this branch a genuine timeout would show the generic fallback instead of
 *     the honest, recoverable "slow connection — try again" copy.
 * A caller-driven "AbortError" is deliberately NOT treated as a timeout.
 */
export function errorMessage(t: Strings, err: unknown, fallback: string): string {
  if (err != null && typeof err === "object") {
    const name = (err as { name?: unknown }).name;
    if (name === "FetchTimeoutError" || name === "TimeoutError") {
      return t.timeoutError;
    }
  }
  return fallback;
}

/** Fill the {n} / {label} placeholders in {@link Strings.stepProgress}. */
export function formatStepProgress(t: Strings, n: number, label: string): string {
  return t.stepProgress.replace("{n}", String(n)).replace("{label}", label);
}

/**
 * Resolve a {@link Strings.disclaimers} entry from a DisclaimerContext value
 * (M10). The contexts (lib/disclaimers.DisclaimerContext) are snake_case
 * ("answer_draft"); the localized catalog keys are camelCase ("answerDraft").
 * This maps between them so the contextual "not legal advice / verify this"
 * copy shows in the tenant's language. Unknown contexts fall back to `general`.
 */
export function getLocalizedDisclaimer(
  t: Strings,
  context: string,
): { label: string; body: string } {
  const d = t.disclaimers;
  switch (context) {
    case "answer_draft":
      return d.answerDraft;
    case "defense":
      return d.defense;
    case "chat":
      return d.chat;
    case "deadline":
      return d.deadline;
    case "eligibility":
      return d.eligibility;
    case "general":
    default:
      return d.general;
  }
}
