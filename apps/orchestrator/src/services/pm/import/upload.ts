/**
 * WARP-3527 — bytes in, `ImportTable` out, for whichever of the six presets
 * the file is. The format is read from the CONTENT (JSON object vs delimited
 * text), never from the filename or the browser's MIME guess.
 */

import { ImportParseError, parseCsvTable } from "./csv.js";
import { SOURCES, detectCsvSource } from "./sources.js";
import { trelloToTable } from "./trello.js";
import type { ImportSource, ImportTable } from "./types.js";

export type UploadFormat = "csv" | "json";

/** `{`/`[` after an optional BOM and whitespace is JSON; anything else is delimited text. */
export function sniffFormat(buf: Buffer): UploadFormat {
  let i = 0;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) i = 3;
  while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x0a || buf[i] === 0x0d || buf[i] === 0x09)) i += 1;
  return buf[i] === 0x7b || buf[i] === 0x5b ? "json" : "csv";
}

/** Read a file as the given source. A preset that wants the other format is refused in words. */
export function loadTable(buf: Buffer, source: ImportSource): ImportTable {
  const wants = SOURCES[source].format;
  const has = sniffFormat(buf);
  if (wants !== has) {
    throw new ImportParseError(
      "wrong_format",
      wants === "json"
        ? `${SOURCES[source].label} needs the board's JSON export, but this file is CSV.`
        : `${SOURCES[source].label} needs a CSV file, but this file is JSON.`,
    );
  }
  return wants === "json" ? trelloToTable(buf) : parseCsvTable(buf);
}

export interface ParsedUpload {
  /** What was asked for, else what the content looks like. */
  source: ImportSource;
  /** What the content looks like. */
  detected: ImportSource;
  table: ImportTable;
}

export function parseUpload(buf: Buffer, requested?: ImportSource): ParsedUpload {
  const format = sniffFormat(buf);
  if (format === "json") {
    const source = requested ?? "TRELLO_JSON";
    return { source, detected: "TRELLO_JSON", table: loadTable(buf, source) };
  }
  // CSV: read once with the generic parser to find the headers, then settle on a preset.
  const table = parseCsvTable(buf);
  const detected = detectCsvSource(table.headers);
  const source = requested ?? detected;
  if (SOURCES[source].format !== "csv") {
    throw new ImportParseError("wrong_format", `${SOURCES[source].label} needs the board's JSON export, but this file is CSV.`);
  }
  return { source, detected, table };
}
