/**
 * WARP-900 — `format_json` LLM tool.
 *
 * Pretty-print or minify a JSON document in place (same format in/out,
 * unlike `convert_data_format`). Tier-1 read (no write, no confirmation);
 * pure computation, no I/O, no network egress.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_INPUT_CHARS = 20_000;
const MIN_INDENT = 1;
const MAX_INDENT = 8;
const DEFAULT_INDENT = 2;

type Mode = "pretty" | "minify";
const VALID_MODES: Mode[] = ["pretty", "minify"];

const inputSchema = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description: `JSON text to reformat. Capped at ${MAX_INPUT_CHARS} chars.`,
    },
    mode: {
      type: "string",
      enum: VALID_MODES,
      description: "'pretty' indents with `indent` spaces; 'minify' strips all insignificant whitespace.",
    },
    indent: {
      type: "integer",
      minimum: MIN_INDENT,
      maximum: MAX_INDENT,
      description: `Spaces per indent level for 'pretty' mode (default ${DEFAULT_INDENT}). Ignored for 'minify'.`,
    },
  },
  required: ["input", "mode"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const input = typeof args.input === "string" ? args.input : undefined;
  const mode = typeof args.mode === "string" ? args.mode : undefined;

  if (input === undefined || mode === undefined) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "input and mode are required" },
    };
  }
  if (!VALID_MODES.includes(mode as Mode)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_MODE", message: `mode must be one of: ${VALID_MODES.join(", ")}` },
    };
  }
  if (input.length > MAX_INPUT_CHARS) {
    return {
      ok: false,
      status: "error",
      error: { code: "INPUT_TOO_LONG", message: `input exceeds ${MAX_INPUT_CHARS} chars` },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: { code: "PARSE_FAILED", message: `invalid JSON: ${String((err as Error)?.message ?? err)}` },
    };
  }

  let output: string;
  if (mode === "minify") {
    output = JSON.stringify(parsed);
  } else {
    const indent =
      typeof args.indent === "number" && Number.isFinite(args.indent)
        ? Math.max(MIN_INDENT, Math.min(MAX_INDENT, Math.floor(args.indent)))
        : DEFAULT_INDENT;
    output = JSON.stringify(parsed, null, indent);
  }

  return {
    ok: true,
    data: { type: "format_json", mode, output },
  };
}

const tool: Tool = {
  name: "format_json",
  description:
    `Pretty-print or minify a JSON document in place. 'pretty' indents with an optional \`indent\` (${MIN_INDENT}-${MAX_INDENT} ` +
    `spaces, default ${DEFAULT_INDENT}); 'minify' strips all insignificant whitespace. Input capped at ${MAX_INPUT_CHARS} chars; ` +
    "malformed JSON is rejected as PARSE_FAILED. Tier-1 read; pure computation, no network egress.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
