/**
 * WARP-3526 (ADR-069 WS-10) — CSV cells for the time report export.
 *
 * Two rules beyond joining with commas:
 *
 *   - RFC 4180 quoting: a value containing `,` `"` CR or LF is wrapped in
 *     quotes with its quotes doubled, and records end in CRLF.
 *
 *   - Formula-injection neutralisation (OWASP "CSV injection"): a text cell
 *     whose first character opens a formula in Excel, Sheets or Numbers is
 *     prefixed with a single quote, which makes the spreadsheet show it as
 *     text. That is `=` `+` `-` `@`, and also a leading tab or carriage return
 *     — and a leader hidden behind leading spaces, tabs or CRs, because
 *     spreadsheets trim before deciding. A work item title, a person's display
 *     name and a worklog note are all typed by somebody, so this is
 *     load-bearing, not paranoia. (The dashboard's audit export,
 *     lib/audit-csv.ts, follows the same rule, WARP-1031.)
 *
 * A NUMBER is written as a number: a negative one is data, not a formula, and
 * quoting it would turn a column of minutes into a column of text.
 */

/** `=`, `+`, `-` or `@` — optionally after whitespace — or a leading tab / CR. */
const FORMULA_LEADER = /^[\t\r ]*[=+\-@]|^[\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  let out = value;
  if (FORMULA_LEADER.test(out)) out = `'${out}`;
  if (/[",\r\n]/.test(out)) out = `"${out.replace(/"/g, '""')}"`;
  return out;
}

/** One record: cells joined by commas, ended by CRLF. */
export function csvLine(cells: ReadonlyArray<string | number | null | undefined>): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/** What a report row needs to become a CSV record. Structural, so this file
 *  stays pure and does not import the service that produces the rows. */
export interface TimeReportCsvRow {
  label: string;
  itemKey: string | null;
  minutes: number;
  entries: number;
}

/**
 * The time report as CSV records, one string per line, header first.
 *
 * The columns follow the grouping — a person report leads with `User`, an item
 * report with the key and the title, a day report with the date — then the
 * minutes, the same time as decimal hours (two places, for a spreadsheet that
 * wants to multiply by a rate) and the entry count. Deliberately NO totals row:
 * an export is data to pivot, and a "Total" line in the middle of a column of
 * numbers is the first thing everybody deletes. The JSON report carries the
 * total.
 *
 * A generator, so a caller writes it out as it goes rather than building one
 * big string.
 */
export function* timeReportCsvLines(
  groupBy: "user" | "item" | "day",
  rows: Iterable<TimeReportCsvRow>,
): Generator<string> {
  const lead = groupBy === "item" ? ["Item", "Title"] : [groupBy === "user" ? "User" : "Date"];
  yield csvLine([...lead, "Minutes", "Hours", "Entries"]);
  for (const r of rows) {
    const who = groupBy === "item" ? [r.itemKey ?? "", r.label] : [r.label];
    yield csvLine([...who, r.minutes, (r.minutes / 60).toFixed(2), r.entries]);
  }
}
