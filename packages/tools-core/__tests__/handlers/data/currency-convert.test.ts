/**
 * WARP-1436 — `currency_convert` LLM tool.
 *
 * Converts an amount between currencies using the orchestrator's
 * screened, cached daily ECB reference rates (`GET /api/web/rates`).
 * Same-currency conversions short-circuit without touching the
 * network. Tier-1 read — no writes, no confirmation.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import currencyConvert from "../../../src/handlers/data/currency-convert.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(orchestratorGet: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: orchestratorGet,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

function jsonGet(body: unknown, status = 200): Mock {
  // Fresh Response per call — a Response body can only be read once.
  return vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );
}

function expectError(
  res: Awaited<ReturnType<typeof currencyConvert.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("currency_convert", () => {
  it("uppercases codes, fetches rates for the base, and applies the rate", async () => {
    const get = jsonGet({
      base: "USD",
      asOf: "2026-07-18",
      rates: { EUR: 0.5, GBP: 0.4 },
      stale: true,
    });
    const ctx = ctxWith(get);

    const res = await currencyConvert.handler(
      { value: 100, from: "usd", to: "eur" },
      ctx,
    );

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/web/rates", {
      params: { base: "USD" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "currency_convert",
        value: 100,
        from: "USD",
        to: "EUR",
        rate: 0.5,
        result: 50,
        ratesAsOf: "2026-07-18",
        stale: true,
      });
    }
  });

  it("short-circuits same-currency conversions without an HTTP call", async () => {
    const get = vi.fn();
    const res = await currencyConvert.handler(
      { value: 42.5, from: "eur", to: "EUR" },
      ctxWith(get),
    );

    expect(get).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "currency_convert",
        value: 42.5,
        from: "EUR",
        to: "EUR",
        rate: 1,
        result: 42.5,
        ratesAsOf: null,
        stale: false,
      });
    }
  });

  it("maps a 400 (unknown base) to UNKNOWN_CURRENCY naming the from code", async () => {
    const get = jsonGet({ error: "unknown_currency" }, 400);
    const res = await currencyConvert.handler(
      { value: 10, from: "ZZZ", to: "EUR" },
      ctxWith(get),
    );
    expectError(res, "UNKNOWN_CURRENCY");
    if (!res.ok) {
      expect(res.error.message).toContain("ZZZ");
    }
  });

  it("maps a target code missing from the rates map to UNKNOWN_CURRENCY naming the to code", async () => {
    const get = jsonGet({
      base: "USD",
      asOf: "2026-07-18",
      rates: { EUR: 0.5 },
      stale: false,
    });
    const res = await currencyConvert.handler(
      { value: 10, from: "USD", to: "JPY" },
      ctxWith(get),
    );
    expectError(res, "UNKNOWN_CURRENCY");
    if (!res.ok) {
      expect(res.error.message).toContain("JPY");
    }
  });

  it("maps a 451 to EGRESS_DISABLED with off-LAN guidance", async () => {
    const get = jsonGet({ error: "egress_disabled" }, 451);
    const res = await currencyConvert.handler(
      { value: 10, from: "USD", to: "EUR" },
      ctxWith(get),
    );
    expectError(res, "EGRESS_DISABLED");
    if (!res.ok) {
      expect(res.error.message).toContain("off-LAN settings");
      expect(res.error.message).toContain("Weather & currency data");
    }
  });

  it("maps a 502 to RATES_UNAVAILABLE", async () => {
    const get = jsonGet({ error: "rates_unavailable" }, 502);
    const res = await currencyConvert.handler(
      { value: 10, from: "USD", to: "EUR" },
      ctxWith(get),
    );
    expectError(res, "RATES_UNAVAILABLE");
  });

  it("maps a thrown fetch error to RATES_UNAVAILABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await currencyConvert.handler(
      { value: 10, from: "USD", to: "EUR" },
      ctxWith(get),
    );
    expectError(res, "RATES_UNAVAILABLE");
  });

  it("rejects a missing value with INVALID_VALUE (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await currencyConvert.handler(
      { from: "USD", to: "EUR" },
      ctxWith(get),
    );
    expectError(res, "INVALID_VALUE");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a NaN value with INVALID_VALUE", async () => {
    const res = await currencyConvert.handler(
      { value: Number.NaN, from: "USD", to: "EUR" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_VALUE");
  });

  it("rejects an infinite value with INVALID_VALUE", async () => {
    const res = await currencyConvert.handler(
      { value: Number.POSITIVE_INFINITY, from: "USD", to: "EUR" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_VALUE");
  });

  it("rejects a string value with INVALID_VALUE", async () => {
    const res = await currencyConvert.handler(
      { value: "100", from: "USD", to: "EUR" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_VALUE");
  });

  it("rejects a non-3-letter from code with INVALID_CURRENCY (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await currencyConvert.handler(
      { value: 10, from: "EURO", to: "USD" },
      ctxWith(get),
    );
    expectError(res, "INVALID_CURRENCY");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a non-alphabetic to code with INVALID_CURRENCY", async () => {
    const res = await currencyConvert.handler(
      { value: 10, from: "USD", to: "12A" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_CURRENCY");
  });

  it("rejects a missing from code with INVALID_CURRENCY", async () => {
    const res = await currencyConvert.handler(
      { value: 10, to: "EUR" },
      ctxWith(vi.fn()),
    );
    expectError(res, "INVALID_CURRENCY");
  });
});

describe("currency_convert — tool metadata", () => {
  it("is named currency_convert and is Tier-1 (no write, no confirm)", () => {
    expect(currencyConvert.name).toBe("currency_convert");
    expect(currencyConvert.requiresWrite).toBe(false);
    expect(currencyConvert.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema requiring value + from + to", () => {
    const schema = currencyConvert.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["value", "from", "to"]);
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "value",
      "from",
      "to",
    ]);
  });
});
