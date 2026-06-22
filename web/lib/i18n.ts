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
 * The translation keys we localize. Keep this list small and high-traffic; it is
 * the set of strings a tenant encounters before/at the verify gate, plus errors.
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

  // Errors
  unsupportedFile: string;
  couldNotReadFile: string;
  genericError: string;

  // Disclaimer (short, app-wide framing)
  guideNotLawyer: string;
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

  unsupportedFile:
    "That file type isn't supported. Please use a JPEG or PNG photo, or a PDF. (If your phone saved a HEIC photo, try taking a screenshot of it first.)",
  couldNotReadFile:
    "We couldn't read that file. Try a clearer photo, or a PDF, and make sure the whole page is visible.",
  genericError: "Something went wrong. You can try again.",

  guideNotLawyer: "A guide, not a lawyer — information, not legal advice.",
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

  unsupportedFile:
    "Ese tipo de archivo no es compatible. Use una foto JPEG o PNG, o un PDF. (Si su teléfono guardó una foto HEIC, intente tomar una captura de pantalla primero.)",
  couldNotReadFile:
    "No pudimos leer ese archivo. Intente con una foto más clara, o un PDF, y asegúrese de que se vea toda la página.",
  genericError: "Algo salió mal. Puede intentarlo de nuevo.",

  guideNotLawyer: "Una guía, no un abogado — información, no asesoría legal.",
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
