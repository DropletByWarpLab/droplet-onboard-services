/**
 * WARP-1436 — `currency_convert` LLM tool.
 *
 * Converts an amount between currencies using the orchestrator's
 * cached daily ECB reference rates (`GET /api/web/rates`, fetched over
 * the box's screened web access). Codes are case-insensitive and
 * uppercased before use; same-currency conversions short-circuit
 * without touching the network. Tier-1 read — no writes, no
 * confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

const EGRESS_GUIDANCE =
  "enable the Weather & currency data channel in the dashboard's off-LAN settings";

const inputSchema = {
  type: "object",
  properties: {
    value: {
      type: "number",
      description: "The amount to convert.",
    },
    from: {
      type: "string",
      minLength: 3,
      maxLength: 3,
      pattern: "^[A-Za-z]{3}$",
      description:
        'Source currency as a 3-letter ISO 4217 code, e.g. "USD". Case-insensitive.',
    },
    to: {
      type: "string",
      minLength: 3,
      maxLength: 3,
      pattern: "^[A-Za-z]{3}$",
      description:
        'Target currency as a 3-letter ISO 4217 code, e.g. "EUR". Case-insensitive.',
    },
  },
  required: ["value", "from", "to"],
  additionalProperties: false,
} as const;

function toolError(code: string, message: string): ToolResult {
  return { ok: false, status: "error", error: { code, message } };
}

function unknownCurrency(code: string): ToolResult {
  return toolError(
    "UNKNOWN_CURRENCY",
    `no reference rate is available for currency "${code}"`,
  );
}

function ratesUnavailable(): ToolResult {
  return toolError(
    "RATES_UNAVAILABLE",
    "the exchange-rate service is not reachable right now",
  );
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const value = args.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return toolError("INVALID_VALUE", "value must be a finite number");
  }

  const rawFrom = typeof args.from === "string" ? args.from : "";
  const rawTo = typeof args.to === "string" ? args.to : "";
  if (!CURRENCY_CODE.test(rawFrom) || !CURRENCY_CODE.test(rawTo)) {
    return toolError(
      "INVALID_CURRENCY",
      'from and to must each be a 3-letter currency code like "USD" or "EUR"',
    );
  }
  const from = rawFrom.toUpperCase();
  const to = rawTo.toUpperCase();

  if (from === to) {
    return {
      ok: true,
      data: {
        type: "currency_convert",
        value,
        from,
        to,
        rate: 1,
        result: value,
        ratesAsOf: null,
        stale: false,
      },
    };
  }

  let payload: Record<string, unknown>;
  try {
    const res = await ctx.http.orchestrator.get("/api/web/rates", {
      params: { base: from },
    });
    if (res.status === 451) {
      return toolError(
        "EGRESS_DISABLED",
        `web access for currency rates is turned off — ${EGRESS_GUIDANCE}`,
      );
    }
    if (res.status === 400) return unknownCurrency(from);
    if (!res.ok) return ratesUnavailable();
    payload = (await res.json()) as Record<string, unknown>;
  } catch {
    return ratesUnavailable();
  }

  const rates =
    payload.rates && typeof payload.rates === "object"
      ? (payload.rates as Record<string, unknown>)
      : {};
  const rate = rates[to];
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return unknownCurrency(to);
  }

  return {
    ok: true,
    data: {
      type: "currency_convert",
      value,
      from,
      to,
      rate,
      result: value * rate,
      ratesAsOf: typeof payload.asOf === "string" ? payload.asOf : null,
      stale: Boolean(payload.stale),
    },
  };
}

const tool: Tool = {
  name: "currency_convert",
  description:
    'Convert an amount between currencies using cached daily ECB (European Central Bank) reference rates fetched via the box\'s screened web access. Provide a numeric value plus 3-letter from/to currency codes (case-insensitive). The result includes the applied rate, the rate date (`ratesAsOf`), and a `stale` flag when the box is serving older cached rates. If the box\'s web access for this data is disabled, the user must enable "Weather & currency data" in the dashboard\'s off-LAN settings.',
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
