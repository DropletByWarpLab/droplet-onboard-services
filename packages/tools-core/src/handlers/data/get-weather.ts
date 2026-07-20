/**
 * WARP-1436 — `get_weather` LLM tool.
 *
 * Current weather + 7-day forecast for a named place, served by the
 * orchestrator's screened web endpoint (`GET /api/web/weather`, backed
 * by Open-Meteo through the egress screen). The handler validates the
 * location, forwards it as a query param, and maps the endpoint's
 * status codes onto tool errors. Tier-1 read — no writes, no
 * confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const MAX_LOCATION_CHARS = 120;

const EGRESS_GUIDANCE =
  "enable the Weather & currency data channel in the dashboard's off-LAN settings";

const inputSchema = {
  type: "object",
  properties: {
    location: {
      type: "string",
      minLength: 1,
      maxLength: MAX_LOCATION_CHARS,
      description:
        'Place to get weather for — a city name like "Toulouse" or "Portland, USA". Required; the box has no default location yet.',
    },
  },
  required: ["location"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: { code: "INVALID_ARGS", message },
  };
}

function weatherUnavailable(): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "WEATHER_UNAVAILABLE",
      message: "the weather service is not reachable right now",
    },
  };
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const raw = typeof args.location === "string" ? args.location : "";
  const location = raw.trim();
  if (!location) {
    return invalidArgs("location is required and must be a non-empty string");
  }
  if (location.length > MAX_LOCATION_CHARS) {
    return invalidArgs(
      `location must be at most ${MAX_LOCATION_CHARS} characters`,
    );
  }

  let payload: Record<string, unknown>;
  try {
    const res = await ctx.http.orchestrator.get("/api/web/weather", {
      params: { location },
    });
    if (res.status === 451) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "EGRESS_DISABLED",
          message: `web access for weather is turned off — ${EGRESS_GUIDANCE}`,
        },
      };
    }
    if (res.status === 404) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "LOCATION_NOT_FOUND",
          message: `could not find a place matching "${location}"`,
        },
      };
    }
    if (!res.ok) return weatherUnavailable();
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    return weatherUnavailable();
  }

  return {
    ok: true,
    data: {
      type: "get_weather",
      location: payload.location ?? null,
      current: payload.current ?? null,
      daily: Array.isArray(payload.daily) ? payload.daily : [],
      asOf: typeof payload.asOf === "string" ? payload.asOf : null,
      stale: Boolean(payload.stale),
    },
  };
}

const tool: Tool = {
  name: "get_weather",
  description:
    'Get the current weather and a 7-day forecast for a named place via the box\'s screened web access (Open-Meteo). `location` is required — a city name or "city, country"; there is no default location yet. If the box\'s web access for this data is disabled, the user must enable "Weather & currency data" in the dashboard\'s off-LAN settings.',
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
