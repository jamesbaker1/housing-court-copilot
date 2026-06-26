/**
 * Mechanical-fill Answer packet — deterministic field mapping + PDF render.
 *
 * UPL-safe contract (GUARDRAILS §2.2): this engine TRANSCRIBES tenant-confirmed
 * facts only. It carries NO defense selection and makes NO legal judgment — the
 * common nonpayment defenses are printed as an UNCHECKED checklist for the tenant
 * and their lawyer to choose from. A valid PDF is always produced: missing values
 * render as blank fill-lines (never a silently empty document), and the page is
 * stamped "DRAFT — not the official court form; have a lawyer review before filing".
 *
 * No LLM is involved here. This is a pure transform over a schema-valid Case.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { Case } from "@/lib/case";

/** A blank fill-line shown when a value is missing — never an empty string. */
const BLANK = "__________________________";

/**
 * The mechanical caption/field mapping. Deliberately contains NO `defenses`
 * field: a defense is a legal judgment the tenant/lawyer makes, not something
 * this transcription engine decides.
 */
export interface AnswerFields {
  indexNumber: string;
  county: string;
  petitioner: string;
  respondent: string;
  premises: string;
  respondentPhone: string;
}

/**
 * Common NYC nonpayment-proceeding defenses, printed UNCHECKED for the tenant to
 * select. These are INFORMATION, not a recommendation — asserting that any apply
 * is a legal conclusion this tool never makes (LLM-ARCHITECTURE boundary).
 */
export const DEFENSE_CHECKLIST: readonly string[] = [
  "General denial — I deny the allegations in the petition.",
  "I already paid some or all of the rent the petition claims I owe.",
  "The amount of rent the petition demands is wrong.",
  "There are conditions in my apartment that need repair (warranty of habitability).",
  "I was not properly served with the court papers.",
  "The petitioner is not the proper party or does not own/manage the building.",
  "The building is not properly registered with HPD.",
  "I never received a proper written rent demand.",
  "I tried to pay the rent and the landlord refused to accept it.",
  "I believe I was overcharged / I have a rent-stabilization claim.",
  "Other (describe in your own words).",
];

const DRAFT_DISCLAIMER =
  "DRAFT — this is NOT the official court Answer form and has not been filed. " +
  "Review every line, correct anything that is wrong, and have a lawyer or the " +
  "court Help Center review it before you file. Filing deadlines are strict.";

function orBlank(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return v.length > 0 ? v : BLANK;
}

/**
 * Map a Case onto the mechanical Answer caption fields. Pure; no side effects.
 * Missing values become blank fill-lines so the rendered form is always usable.
 */
export function buildAnswerFields(c: Case): AnswerFields {
  const county = c.court?.county ?? null;
  const landlordName = c.parties?.landlord?.name ?? null;
  // Respondent name: the tenant party, falling back to the contact full_name.
  const respondentName = c.parties?.tenant?.name ?? c.contact?.full_name ?? null;

  const addr = c.property?.address ?? null;
  const unit = c.property?.apartment_unit ?? null;
  const premisesParts: string[] = [];
  if (addr?.line1) premisesParts.push(addr.line1);
  if (unit) premisesParts.push(`Apt ${unit}`);
  const cityStateZip = [addr?.city, addr?.state, addr?.postal_code]
    .filter((p): p is string => Boolean(p))
    .join(" ");
  if (cityStateZip) premisesParts.push(cityStateZip);

  return {
    indexNumber: orBlank(c.court?.index_number ?? null),
    county: county ? `County of ${county}` : BLANK,
    petitioner: orBlank(landlordName),
    respondent: orBlank(respondentName),
    premises: premisesParts.length > 0 ? premisesParts.join(", ") : BLANK,
    respondentPhone: orBlank(c.contact?.phone_e164 ?? null),
  };
}

// ---------------------------------------------------------------------------
// PDF rendering (pdf-lib, no network, deterministic layout).
// ---------------------------------------------------------------------------

const PAGE_W = 612; // US Letter, points
const PAGE_H = 792;
const MARGIN = 54;
const LINE = 16;

interface Cursor {
  page: PDFPage;
  y: number;
}

/** Word-wrap `text` to `maxWidth` at `size` using `font` metrics. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines.length > 0 ? lines : [""];
}

export interface AnswerPdfOptions {
  /** Today's date label for the signature block (caller-supplied; no Date.now in lib). */
  dateLabel?: string;
}

/**
 * Render the DRAFT nonpayment Answer to PDF bytes. Always returns a valid,
 * non-empty document — even for an almost-empty Case (every field a blank line).
 */
export async function generateAnswerDraftPdf(
  c: Case,
  opts: AnswerPdfOptions = {},
): Promise<Uint8Array> {
  const fields = buildAnswerFields(c);
  const doc = await PDFDocument.create();
  doc.setTitle("Draft Answer — Nonpayment Proceeding");
  doc.setProducer("Housing Court Copilot");
  doc.setCreator("Housing Court Copilot (draft assembly)");

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const maxW = PAGE_W - MARGIN * 2;

  const cur: Cursor = { page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  const ensureRoom = (needed: number) => {
    if (cur.y - needed < MARGIN) {
      cur.page = doc.addPage([PAGE_W, PAGE_H]);
      cur.y = PAGE_H - MARGIN;
    }
  };

  const draw = (
    text: string,
    o: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; gap?: number } = {},
  ) => {
    const f = o.font ?? font;
    const size = o.size ?? 11;
    for (const ln of wrap(text, f, size, maxW)) {
      ensureRoom(LINE);
      cur.page.drawText(ln, {
        x: MARGIN,
        y: cur.y,
        size,
        font: f,
        color: o.color ?? rgb(0, 0, 0),
      });
      cur.y -= LINE;
    }
    if (o.gap) cur.y -= o.gap;
  };

  // Draft banner.
  draw("DRAFT — REVIEW BEFORE FILING", { font: bold, size: 13, color: rgb(0.6, 0, 0) });
  for (const ln of wrap(DRAFT_DISCLAIMER, font, 9, maxW)) {
    ensureRoom(12);
    cur.page.drawText(ln, { x: MARGIN, y: cur.y, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
    cur.y -= 12;
  }
  cur.y -= 8;

  // Caption.
  draw("CIVIL COURT OF THE CITY OF NEW YORK", { font: bold, size: 12 });
  draw(`${fields.county} : Housing Part`, { font: bold, size: 11, gap: 6 });
  draw(`Index No. ${fields.indexNumber}`, { font: bold, gap: 6 });

  draw(`${fields.petitioner},`, { font: bold });
  draw("                                        Petitioner (Landlord),", { size: 10 });
  draw("            - against -", { gap: 2 });
  draw(`${fields.respondent},`, { font: bold });
  draw("                                        Respondent (Tenant).", { size: 10, gap: 10 });

  draw("ANSWER TO PETITION (NONPAYMENT)", { font: bold, size: 12, gap: 8 });

  // Respondent identifying fields.
  draw(`Premises: ${fields.premises}`);
  draw(`Respondent phone: ${fields.respondentPhone}`, { gap: 10 });

  // Defenses — printed UNCHECKED. The tenant/lawyer selects.
  draw("My defenses (check only those that apply to your situation):", { font: bold, gap: 4 });
  draw(
    "If you are not sure whether a defense applies, do NOT guess — ask a lawyer or the court Help Center.",
    { size: 9, color: rgb(0.4, 0.4, 0.4), gap: 4 },
  );
  for (const item of DEFENSE_CHECKLIST) {
    draw(`[  ]  ${item}`, { size: 10 });
  }
  cur.y -= 12;

  // Signature block.
  draw(`Dated: ${opts.dateLabel ?? "______________________"}`, { gap: 6 });
  draw("Signature: ______________________________", { gap: 4 });
  draw(`Print name: ${fields.respondent}`, { gap: 4 });
  draw("Address: __________________________________________________");

  const bytes = await doc.save();
  return bytes;
}
