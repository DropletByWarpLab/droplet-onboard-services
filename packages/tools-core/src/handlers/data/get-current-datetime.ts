/**
 * WARP-1424 — `get_current_datetime` LLM tool.
 *
 * The agent's clock: LLMs hallucinate the current date, so this returns
 * the box's real "now", optionally rendered in a requested IANA timezone.
 * Tier-1 read; pure computation, no I/O.
 *
 * The `iso` field is local-time-in-zone with a numeric UTC offset
 * (e.g. `2026-07-19T08:00:00-04:00`), built from `Intl.DateTimeFormat`
 * `formatToParts` — Node has no native "ISO string in an arbitrary zone".
 * `utcIso` is the same instant in UTC, truncated to whole seconds to
 * match `epochSeconds` granularity.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const inputSchema = {
  type: "object",
  properties: {
    timezone: {
      type: "string",
      description:
        'IANA timezone name to render the current time in (e.g. "Europe/Paris"). Defaults to the system timezone.',
    },
  },
  additionalProperties: false,
} as const;

/** `timeZoneName: "longOffset"` yields "GMT-07:00" / "GMT+05:30", or bare
 *  "GMT"/"UTC" when the offset is zero. Normalize to "-07:00" / "+00:00". */
function normalizeOffset(longOffset: string): string {
  const stripped = longOffset.replace(/^(GMT|UTC)/, "");
  return stripped === "" ? "+00:00" : stripped;
}

/** ISO-8601 local time in `timeZone` with numeric offset, second precision. */
function formatIsoInZone(date: Date, timeZone: string): string {
  // en-CA renders Y-M-D digit order; hourCycle "h23" avoids the "24:00"
  // midnight quirk some ICU builds produce with hour12: false.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const offset = normalizeOffset(get("timeZoneName"));
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

async function handler(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const rawTz = args.timezone;
  let timezone: string;
  if (rawTz === undefined) {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } else {
    if (typeof rawTz !== "string" || rawTz.trim() === "") {
      return {
        ok: false,
        status: "error",
        error: {
          code: "INVALID_TIMEZONE",
          message: `Invalid timezone ${JSON.stringify(rawTz)}: must be an IANA timezone name like "Europe/Paris".`,
        },
      };
    }
    timezone = rawTz.trim();
    try {
      // Constructing a formatter is the canonical IANA-name validity check.
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      return {
        ok: false,
        status: "error",
        error: {
          code: "INVALID_TIMEZONE",
          message: `Invalid timezone "${timezone}": must be an IANA timezone name like "Europe/Paris".`,
        },
      };
    }
  }

  const now = new Date();

  return {
    ok: true,
    data: {
      type: "get_current_datetime",
      iso: formatIsoInZone(now, timezone),
      utcIso: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      epochSeconds: Math.floor(now.getTime() / 1000),
      timezone,
      weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(now),
      humanReadable: new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZoneName: "short",
      }).format(now),
    },
  };
}

const tool: Tool = {
  name: "get_current_datetime",
  description:
    "Get the current date and time — the agent's clock. LLMs hallucinate the current date; call this for the real \"now\". Optional `timezone` (IANA name like \"Europe/Paris\") renders the time in that zone; defaults to the system timezone. Returns ISO-8601 with offset, UTC ISO, epoch seconds, weekday, and a human-readable form. Tier-1 read; pure computation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
