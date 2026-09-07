/**
 * WARP-2730 (ADR-048) — the deterministic PHI screen, layer 1 of four.
 *
 * This runs on the path, the filename and the extracted text BEFORE any model
 * call. It is not the clever layer — the classifier's CLEAN/MENTIONS/RECORD
 * verdict is (layer 2), and the zod `.strict()` allow-lists are the structural
 * control (layer 3). This one exists because it is the only layer that can
 * refuse a document *without sending it anywhere*, and because filenames are
 * themselves PHI (WARP-1983): `J Smith perio chart.pdf` is protected before
 * anyone opens it.
 *
 * DELIBERATELY OVER-BROAD. A false skip is one visible line in the Skipped tab
 * that an owner can re-open; a false pass is a headline. Every threshold here
 * is tuned in that direction, and the eval corpus (WARP-2732) carries three
 * dental decoys with a zero-tolerance false-negative floor precisely so a later
 * "let's loosen this" has to argue with a measurement.
 *
 * WHAT THIS IS NOT: a classifier. It is a regex list plus a path denylist. A
 * dental letter that mentions no chart number, no CDT code and no date of birth
 * will pass it — which is why `CREATE_CONTACT` never auto-applies in any mode,
 * and why the folder allow-list is the real blast-radius control on a practice
 * box (decision D2).
 */

/** Where a hit was found. Reported so the Skipped tab can say which layer refused. */
export type PhiScreenSite = "path" | "filename" | "text";

/**
 * Signal CODES only, never the matched text.
 *
 * The screen must be able to explain itself in an audit row and on a card
 * without quoting the thing it just refused to let through — quoting it would
 * copy the PHI into `IngestProposal.evidence`, `ActivityRow.refs` and the
 * dashboard, which is the exact leak the screen exists to prevent.
 */
export type PhiSignal =
  | "dob"
  | "chart_no"
  | "tooth_or_cdt_code"
  | "insurance_id"
  | "treatment_note"
  | "rx"
  | "clinical_image"
  | "path_denylist";

export interface PhiScreenResult {
  /** True when the source must never reach a model. */
  blocked: boolean;
  signals: PhiSignal[];
  site: PhiScreenSite | null;
}

/**
 * Default path/filename denylist. Owner-editable via
 * `AutoFilingSetting.pathDenylist`; these are the defaults a practice box gets
 * before anybody configures anything.
 *
 * Matched case-insensitively against the whole stored path, so a folder named
 * `Patients/` blocks everything beneath it.
 */
export const DEFAULT_PATH_DENYLIST: readonly string[] = [
  "patient",
  "patients",
  "chart",
  "charts",
  "clinical",
  "xray",
  "x-ray",
  "radiograph",
  "treatment",
  "insurance-claim",
  "insurance claims",
  "perio",
  "medical",
];

/**
 * Content patterns. Each is deliberately anchored to a NEARBY LABEL rather than
 * to a bare shape, because a bare shape matches far too much: an invoice number
 * is digits, a due date is a date, and a purchase order is an alphanumeric code.
 * Requiring the label is what keeps a legitimate vendor invoice out of the
 * denylist while still catching a chart note.
 */
const TEXT_PATTERNS: ReadonlyArray<{ signal: PhiSignal; re: RegExp }> = [
  // "DOB: 12/03/1984", "Date of Birth 1984-03-12", "born 3 Dec 1984"
  {
    signal: "dob",
    re: /\b(?:d\.?o\.?b\.?|date\s+of\s+birth|birth\s*date|born)\b[\s:.\-]{0,4}(?:\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}|\d{1,2}\s+\w{3,9}\s+\d{4})/i,
  },
  // "Chart #4471", "Patient ID: 22-8891", "MRN 99312"
  {
    signal: "chart_no",
    re: /\b(?:chart|patient)\s*(?:#|no\.?|number|id)\b[\s:.\-]{0,4}[A-Z0-9][A-Z0-9\-]{2,}|\bMRN\b[\s:.\-]{0,4}[A-Z0-9\-]{3,}/i,
  },
  // CDT procedure codes (D0120, D2740) and tooth/quadrant notation.
  {
    signal: "tooth_or_cdt_code",
    re: /\bD\d{4}\b|\b(?:tooth|teeth)\s*#?\s*\d{1,2}\b|\b(?:UR|UL|LR|LL)\s*[1-8]\b|\bquadrant\s*[1-4]\b/i,
  },
  // "Member ID", "Subscriber ID", "Group #", "Policy No" + a value.
  {
    signal: "insurance_id",
    re: /\b(?:member|subscriber|policy|group)\s*(?:#|no\.?|number|id)\b[\s:.\-]{0,4}[A-Z0-9][A-Z0-9\-]{3,}/i,
  },
  // Clinical prose that no vendor invoice carries.
  {
    signal: "treatment_note",
    re: /\b(?:diagnosis|prognosis|chief\s+complaint|clinical\s+(?:note|finding)|treatment\s+plan|anesthe(?:sia|tic)|extraction\s+of|restoration\s+of)\b/i,
  },
  { signal: "rx", re: /\b(?:rx|prescription|prescribed|sig\.|dispense)\b/i },
  {
    signal: "clinical_image",
    re: /\b(?:bitewing|panoramic|periapical|intraoral|cephalometric)\b/i,
  },
];

function normalise(s: string): string {
  return s.toLowerCase();
}

/**
 * Screen a path/filename against the denylist.
 *
 * Separate from the text screen because it is the half that costs nothing and
 * can run before a file's content has even been read — and because the
 * denylist is the control an owner actually reasons about ("don't look in
 * Patients/"), so its result is reported distinctly.
 */
export function screenPath(
  storedPath: string,
  denylist: readonly string[] = DEFAULT_PATH_DENYLIST,
): PhiScreenResult {
  const hay = normalise(storedPath);
  for (const term of denylist) {
    const t = normalise(term).trim();
    if (t.length > 0 && hay.includes(t)) {
      return {
        blocked: true,
        signals: ["path_denylist"],
        site: hay.lastIndexOf("/") >= 0 && hay.indexOf(t) > hay.lastIndexOf("/")
          ? "filename"
          : "path",
      };
    }
  }
  return { blocked: false, signals: [], site: null };
}

/**
 * Screen extracted text.
 *
 * Returns EVERY signal found, not just the first: the count is what the
 * classifier prompt is told about, and a document tripping four different
 * signals is a different thing from one tripping a single ambiguous match.
 */
export function screenText(text: string): PhiScreenResult {
  const signals: PhiSignal[] = [];
  for (const { signal, re } of TEXT_PATTERNS) {
    if (re.test(text) && !signals.includes(signal)) signals.push(signal);
  }
  return { blocked: signals.length > 0, signals, site: signals.length ? "text" : null };
}

/**
 * The full layer-1 screen: path first (cheapest, and blocks before any read),
 * then text.
 *
 * `blocked === true` means the source is terminal `skipped/phi_path` or
 * `skipped/phi_record` and **the model is never called**.
 */
export function screenSource(args: {
  storedPath: string;
  text?: string;
  denylist?: readonly string[];
}): PhiScreenResult {
  const path = screenPath(args.storedPath, args.denylist);
  if (path.blocked) return path;
  if (args.text === undefined) return { blocked: false, signals: [], site: null };
  return screenText(args.text);
}

/**
 * The output post-filter (design layer "Output post-filter").
 *
 * Every string that would be PERSISTED in a proposal payload — a company name,
 * an evidence quote, an email subject used as a timeline caption — is re-run
 * through the text screen. A hit drops the field rather than the document,
 * because by this point the document has already been judged CLEAN or MENTIONS
 * and the question is narrower: does this particular string carry something it
 * should not.
 *
 * Returns the surviving value, or null if it must be dropped.
 */
export function screenPersistedString(value: string): string | null {
  return screenText(value).blocked ? null : value;
}
