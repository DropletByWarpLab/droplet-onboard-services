/**
 * WARP-900 — minimal RFC 4180 CSV parse/stringify shared by
 * `convert-format.ts`. No new dependency: the repo's "no guessing, ever"
 * coding standard (CLAUDE.md) argues against a heuristic type-inferring CSV
 * library here too — every cell round-trips as a string (see
 * `convert-format.ts` for the JSON<->CSV type contract), so a small
 * hand-rolled quote-aware splitter is all that's needed and it's easy to
 * reason about exhaustively.
 */

/** Parses CSV text into rows of string cells. Handles quoted fields
 *  (embedded commas/newlines/escaped `""` quotes) and both `\n`/`\r\n` line
 *  endings. Throws on an unterminated quoted field. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAnyField = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawAnyField = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawAnyField = true;
    } else if (c === "\r") {
      // swallow; \n (below) closes the row
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAnyField = false;
    } else {
      field += c;
      sawAnyField = true;
    }
  }
  if (inQuotes) {
    throw new Error("unterminated quoted field");
  }
  if (sawAnyField || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Escapes a single CSV field: wraps in quotes (doubling embedded quotes)
 *  when it contains a comma, quote, or newline. */
function escapeCsvField(field: string): string {
  if (/[",\r\n]/.test(field)) {
    return `"${field.replace(/"/g, '""')}"`;
  }
  return field;
}

/** Serializes rows of string cells back to CSV text (CRLF line endings, per RFC 4180). */
export function stringifyCsvRows(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvField).join(",")).join("\r\n");
}
