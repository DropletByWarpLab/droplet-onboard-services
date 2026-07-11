/**
 * WARP-900 — `convert_data_format` LLM tool.
 *
 * Data-utility domain (competitive audit, codename Nomad — WARP-898):
 * converts between JSON, CSV, and YAML. Tier-1 read (no write, no
 * confirmation); pure computation, no I/O, no network egress.
 *
 * Type contract (what "lossless where defined" means here):
 *   - JSON <-> YAML round-trips exactly: YAML is a structural superset of
 *     JSON, so any `JSON.parse`-able value survives `stringify -> parse`.
 *   - JSON <-> CSV is lossless ONLY for the well-defined subset: a flat
 *     JSON array of objects whose values are strings. CSV has no native
 *     types, so on the way OUT every value is stringified (numbers/
 *     booleans via `String()`, nested objects/arrays via `JSON.stringify`,
 *     null/undefined as an empty cell); on the way IN every CSV cell comes
 *     back as a JSON string. This tool deliberately does NOT try to guess
 *     a cell's "real" type (repo rule: "no guessing, ever" — CLAUDE.md) —
 *     that's an unreliable heuristic (e.g. a phone number or zip code with
 *     a leading zero would be silently corrupted into a number).
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { parseCsvRows, stringifyCsvRows } from "./_csv.js";

const MAX_INPUT_CHARS = 20_000;

type Format = "json" | "csv" | "yaml";
const VALID_FORMATS: Format[] = ["json", "csv", "yaml"];

interface Failure {
  ok: false;
  code: string;
  message: string;
}

function stringifyCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** JSON value -> CSV text. Requires an array of flat (non-array, non-null)
 *  objects; the header row is the union of keys in first-seen order. */
function jsonArrayToCsv(value: unknown): { ok: true; csv: string } | Failure {
  if (!Array.isArray(value)) {
    return { ok: false, code: "NOT_TABULAR", message: "JSON must be an array of objects to convert to CSV" };
  }
  if (value.length === 0) {
    return { ok: true, csv: "" };
  }
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, code: "NOT_TABULAR", message: "every array element must be a flat JSON object" };
    }
    for (const key of Object.keys(item as Record<string, unknown>)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const rows: string[][] = [headers];
  for (const item of value as Array<Record<string, unknown>>) {
    rows.push(headers.map((h) => stringifyCell(item[h])));
  }
  return { ok: true, csv: stringifyCsvRows(rows) };
}

/** CSV text -> JSON value. First row is the header; every data row must
 *  have the same column count as the header (ragged rows are rejected
 *  rather than silently zero-padded/truncated — "no guessing, ever"). */
function csvToJsonArray(csvText: string): { ok: true; value: unknown } | Failure {
  let rows: string[][];
  try {
    rows = parseCsvRows(csvText);
  } catch (err) {
    return { ok: false, code: "PARSE_FAILED", message: `invalid CSV: ${String((err as Error)?.message ?? err)}` };
  }
  if (rows.length === 0) {
    return { ok: true, value: [] };
  }
  const [header, ...dataRows] = rows;
  const out: Array<Record<string, string>> = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (row.length !== header.length) {
      return {
        ok: false,
        code: "ROW_LENGTH_MISMATCH",
        message: `row ${i + 2} has ${row.length} column(s), expected ${header.length} (matching the header row)`,
      };
    }
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h] = row[idx];
    });
    out.push(obj);
  }
  return { ok: true, value: out };
}

function parseToValue(input: string, format: Format): { ok: true; value: unknown } | Failure {
  if (format === "json") {
    try {
      return { ok: true, value: JSON.parse(input) };
    } catch (err) {
      return { ok: false, code: "PARSE_FAILED", message: `invalid JSON: ${String((err as Error)?.message ?? err)}` };
    }
  }
  if (format === "yaml") {
    try {
      return { ok: true, value: parseYaml(input) };
    } catch (err) {
      return { ok: false, code: "PARSE_FAILED", message: `invalid YAML: ${String((err as Error)?.message ?? err)}` };
    }
  }
  return csvToJsonArray(input);
}

function serializeFromValue(value: unknown, format: Format): { ok: true; text: string } | Failure {
  if (format === "json") {
    return { ok: true, text: JSON.stringify(value, null, 2) };
  }
  if (format === "yaml") {
    try {
      return { ok: true, text: stringifyYaml(value) };
    } catch (err) {
      return {
        ok: false,
        code: "SERIALIZE_FAILED",
        message: `could not serialize to YAML: ${String((err as Error)?.message ?? err)}`,
      };
    }
  }
  const res = jsonArrayToCsv(value);
  if (!res.ok) return res;
  return { ok: true, text: res.csv };
}

const inputSchema = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description: `Source text to convert. Capped at ${MAX_INPUT_CHARS} chars.`,
    },
    from: {
      type: "string",
      enum: VALID_FORMATS,
      description: "Source format.",
    },
    to: {
      type: "string",
      enum: VALID_FORMATS,
      description: "Target format. Must differ from `from` — use format_json to pretty-print/minify JSON in place.",
    },
  },
  required: ["input", "from", "to"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const input = typeof args.input === "string" ? args.input : undefined;
  const from = typeof args.from === "string" ? args.from : undefined;
  const to = typeof args.to === "string" ? args.to : undefined;

  if (input === undefined || from === undefined || to === undefined) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "input, from, and to are required" },
    };
  }
  if (!VALID_FORMATS.includes(from as Format) || !VALID_FORMATS.includes(to as Format)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_FORMAT", message: `from/to must be one of: ${VALID_FORMATS.join(", ")}` },
    };
  }
  if (from === to) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "INVALID_ARGS",
        message: "from and to must differ — use format_json to pretty-print/minify JSON in place",
      },
    };
  }
  if (input.length > MAX_INPUT_CHARS) {
    return {
      ok: false,
      status: "error",
      error: { code: "INPUT_TOO_LONG", message: `input exceeds ${MAX_INPUT_CHARS} chars` },
    };
  }

  const parsed = parseToValue(input, from as Format);
  if (!parsed.ok) {
    return { ok: false, status: "error", error: { code: parsed.code, message: parsed.message } };
  }

  const serialized = serializeFromValue(parsed.value, to as Format);
  if (!serialized.ok) {
    return { ok: false, status: "error", error: { code: serialized.code, message: serialized.message } };
  }

  return {
    ok: true,
    data: { type: "convert_data_format", from, to, output: serialized.text },
  };
}

const tool: Tool = {
  name: "convert_data_format",
  description:
    `Convert data between JSON, CSV, and YAML (from must differ from to). Input capped at ${MAX_INPUT_CHARS} chars. ` +
    "JSON<->YAML round-trips exactly. JSON<->CSV requires a flat array of objects; every value is stringified on " +
    "the way to CSV and returned as a string on the way back (no type-guessing) — lossless for string-only records, " +
    "documented type-widening for numbers/booleans/nested values. Malformed or non-tabular input is rejected with a " +
    "specific error code rather than silently coerced. Tier-1 read; pure computation, no network egress.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
