/**
 * WARP-901 — `timestamp_convert` LLM tool.
 *
 * Misc dev-utility: converts between Unix epoch (seconds or milliseconds)
 * and ISO-8601. Tier-1 read; pure computation, no I/O.
 *
 * The input `value` is auto-detected: an all-digit (optionally signed)
 * string is treated as an epoch number (interpreted per `unit`, default
 * `seconds`); anything else is parsed as an ISO-8601 / RFC-2822 date
 * string via `Date.parse`. The result always reports both epoch forms
 * plus the ISO string so the caller never has to make a second call to
 * get the other representation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const EPOCH_PATTERN = /^-?\d+$/;

const inputSchema = {
  type: "object",
  properties: {
    value: {
      type: "string",
      description:
        "The value to convert: an epoch timestamp (digits only, e.g. '1700000000') or an ISO-8601 / RFC-2822 date string (e.g. '2023-11-14T22:13:20.000Z').",
    },
    unit: {
      type: "string",
      enum: ["seconds", "milliseconds"],
      description:
        "Epoch unit to assume when `value` is an epoch number. Default 'seconds'.",
    },
  },
  required: ["value"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const value = typeof args.value === "string" ? args.value.trim() : "";
  if (!value) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "value is required" },
    };
  }
  const unit = args.unit === "milliseconds" ? "milliseconds" : "seconds";

  let epochMillis: number;
  if (EPOCH_PATTERN.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      return {
        ok: false,
        status: "error",
        error: { code: "INVALID_ARGS", message: "epoch value out of safe integer range" },
      };
    }
    epochMillis = unit === "seconds" ? n * 1000 : n;
  } else {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "UNPARSEABLE_TIMESTAMP",
          message: "value is neither an epoch number nor a parseable date string",
        },
      };
    }
    epochMillis = parsed;
  }

  const date = new Date(epochMillis);
  if (Number.isNaN(date.getTime())) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "resulting date is out of range" },
    };
  }

  return {
    ok: true,
    data: {
      type: "timestamp_convert",
      iso: date.toISOString(),
      epochSeconds: Math.floor(epochMillis / 1000),
      epochMillis,
    },
  };
}

const tool: Tool = {
  name: "timestamp_convert",
  description:
    "Convert a timestamp between Unix epoch and ISO-8601. Pass either an epoch number (digits only; specify `unit` as 'seconds' or 'milliseconds', default seconds) or an ISO-8601/RFC-2822 date string — the tool auto-detects which and returns both epoch forms plus the ISO string. Tier-1 read; pure computation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
