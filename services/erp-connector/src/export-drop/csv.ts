/**
 * WARP-1964 — delimited-text reader for the export-drop track.
 *
 * Practice-management systems export reports as delimited text, and which
 * delimiter you get depends on the product, the report, and which button the
 * front desk pressed. So this reader sniffs the separator rather than assuming
 * a comma, and follows RFC 4180 quoting for whichever one it picks.
 *
 * Hand-written rather than pulled from npm on purpose: `@droplet/erp-connector`
 * has **no runtime dependencies** today (only devDependencies), and the whole
 * point of this track is that it runs where the other two cannot — including an
 * ARM box with no native driver available. A parser is ~150 lines; a dependency
 * is a supply-chain edge on the path that reads a practice's patient data.
 *
 * PURE: no I/O. The caller supplies decoded text (see `decodeExportBytes`).
 */

/** Delimiters we sniff between, in preference order on a tie. */
const CANDIDATE_DELIMITERS = [",", "\t", "|", ";"] as const;

/** A parsed delimited table. `headers` keeps the source spelling — normalization
 *  for matching happens in the profile layer, and diagnostics need the original. */
export interface DelimitedTable {
  headers: string[];
  rows: string[][];
  /** The delimiter that was sniffed, for diagnostics. */
  delimiter: string;
}

/** Thrown when a file exceeds a configured bound. The caller skips the file and
 *  records a diagnostic — an oversized export must never OOM the orchestrator. */
export class DelimitedLimitError extends Error {
  readonly code = "DELIMITED_LIMIT";
  constructor(message: string) {
    super(message);
    this.name = "DelimitedLimitError";
  }
}

/**
 * Decode raw export bytes to a string, honouring a byte-order mark.
 *
 * Windows PMS exports are frequently UTF-16LE (that is what a .NET
 * `StreamWriter` writes by default), and decoding those as UTF-8 yields a
 * header row full of NUL bytes that matches no profile — a silent
 * "unrecognized file" for a file that is perfectly well-formed. Sniffing the
 * BOM costs three bytes and removes that failure mode.
 *
 * A UTF-8 BOM is stripped: it would otherwise glue itself to the first header
 * name and break the match on the very first column.
 */
export function decodeExportBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE: Node has no utf16be decoder, so byte-swap into LE first.
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  const text = bytes.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Count occurrences of `delimiter` in the first record, ignoring anything
 * inside quotes. Quote-aware because a single unquoted-looking comma inside
 * `"Smith, John"` would otherwise outvote a genuine tab separator.
 */
function countInFirstRecord(text: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    if (!inQuotes && ch === delimiter) count += 1;
  }
  return count;
}

/**
 * Pick the delimiter that splits the header row into the most fields. Ties go
 * to the earlier candidate, so a plain comma-separated file is never
 * reinterpreted. Zero hits for every candidate means a single-column file;
 * comma is returned and the file will simply fail to match a profile.
 */
export function sniffDelimiter(text: string): string {
  let best: string = CANDIDATE_DELIMITERS[0];
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = countInFirstRecord(text, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

export interface ParseOptions {
  /** Override the sniffed delimiter (used by tests and operator profiles). */
  delimiter?: string;
  /** Hard ceiling on data rows; exceeding it throws {@link DelimitedLimitError}. */
  maxRows?: number;
}

/**
 * Parse delimited text into a header row plus data rows (RFC 4180).
 *
 * Handles quoted fields containing the delimiter, embedded newlines, doubled
 * quotes as a literal quote, and CRLF or LF record separators. A trailing
 * newline does not produce a phantom empty record.
 *
 * Short rows are left short rather than padded: the profile layer reads fields
 * by header index and treats a missing one as absent, which is the same thing a
 * NULL column means on the SQL track.
 */
export function parseDelimited(text: string, options: ParseOptions = {}): DelimitedTable {
  const delimiter = options.delimiter ?? sniffDelimiter(text);
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let recordHasContent = false;

  const endField = (): void => {
    record.push(field);
    field = "";
  };
  const endRecord = (): void => {
    endField();
    // Skip a record that is entirely empty (the trailing-newline case). A row
    // of genuine empty fields has length > 1 and is kept.
    if (recordHasContent || record.length > 1) {
      records.push(record);
      // headers are records[0]; every later record is a data row.
      if (records.length - 1 > maxRows) {
        throw new DelimitedLimitError(`export exceeds the ${maxRows}-row ceiling`);
      }
    }
    record = [];
    recordHasContent = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
        continue;
      }
      // Normalize CRLF inside a quoted field so a value's line breaks do not
      // depend on which platform wrote the export.
      if (ch === "\r" && text[i + 1] === "\n") {
        field += "\n";
        i += 1;
        continue;
      }
      field += ch;
      recordHasContent = true;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      recordHasContent = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      endRecord();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endRecord();
      continue;
    }
    field += ch;
    recordHasContent = true;
  }

  // Flush whatever the file ended on. An unterminated quoted field is flushed
  // as-is rather than throwing: a truncated export should degrade to a short
  // last row, and the stability guard upstream is what stops us reading a file
  // mid-write in the first place.
  if (recordHasContent || record.length > 0 || field !== "") endRecord();

  const headers = records.shift() ?? [];
  return { headers, rows: records, delimiter };
}
