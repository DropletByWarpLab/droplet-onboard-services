/**
 * WARP-901 — `timestamp_convert` LLM tool.
 *
 * Misc dev-utility: converts between Unix epoch (seconds or milliseconds)
 * and ISO-8601. Tier-1 read; pure computation, no I/O.
 *
 * The input `value` is auto-detected: an all-digit (optionally signed)
 * string is treated as an epoch number; anything else is parsed as an
 * ISO-8601 / RFC-2822 date string via `Date.parse`. For an epoch number
 * the `unit` may be given explicitly ("seconds" | "milliseconds"); when
 * omitted it is inferred by magnitude — a value >= 1e12 (13+ digits) is
 * milliseconds, otherwise seconds. The result always reports both epoch
 * forms plus the ISO string so the caller never has to make a second
 * call to get the other representation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const EPOCH_PATTERN = /^-?\d+$/;
/** When `unit` is omitted, auto-detect by magnitude: a value at or above
 *  the smallest 13-digit integer (1e12) is read as milliseconds. 1e12
 *  seconds is the year 33658, whereas 1e12 ms is 2001 — so any real epoch
 *  of this magnitude is milliseconds. Ten-digit second epochs (~1.7e9)
 *  stay seconds. Robust against leading zeros (magnitude, not char count). */
const MS_MAGNITUDE_THRESHOLD = 1e12;

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
        "Epoch unit to assume when `value` is an epoch number. When omitted, the unit is auto-detected by magnitude: values with 13+ digits (>= 1e12) are milliseconds, otherwise seconds. Pass explicitly to override the heuristic.",
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
  // Only undefined | "seconds" | "milliseconds" are valid. Anything else
  // (e.g. "ms", "s", "sec") is an error — silently coercing it to seconds
  // and ×1000-ing a millisecond value produces a wildly wrong date.
  const rawUnit = args.unit;
  if (rawUnit !== undefined && rawUnit !== "seconds" && rawUnit !== "milliseconds") {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "unit must be 'seconds' or 'milliseconds'" },
    };
  }

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
    // Explicit unit wins; otherwise auto-detect by magnitude.
    const effectiveUnit =
      rawUnit === "seconds" || rawUnit === "milliseconds"
        ? rawUnit
        : Math.abs(n) >= MS_MAGNITUDE_THRESHOLD
          ? "milliseconds"
          : "seconds";
    epochMillis = effectiveUnit === "seconds" ? n * 1000 : n;
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
    "Convert a timestamp between Unix epoch and ISO-8601. Pass either an epoch number (digits only) or an ISO-8601/RFC-2822 date string — the tool auto-detects which. For an epoch number, give `unit` as 'seconds' or 'milliseconds'; when omitted the unit is inferred by magnitude (values with 13+ digits are milliseconds, otherwise seconds). An unrecognized unit is rejected. Returns both epoch forms plus the ISO string. Tier-1 read; pure computation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
