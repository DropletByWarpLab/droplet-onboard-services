/**
 * WARP-1436 — `get_weather` LLM tool.
 *
 * Thin wrapper over the orchestrator's screened weather endpoint
 * (`GET /api/web/weather`): resolves a named place to current
 * conditions + a 7-day forecast (Open-Meteo behind the egress screen).
 * Tier-1 read — no writes, no confirmation.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import getWeather from "../../../src/handlers/data/get-weather.js";
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

const WEATHER_PAYLOAD = {
  location: {
    name: "Paris",
    latitude: 48.8566,
    longitude: 2.3522,
    country: "France",
  },
  current: {
    temperatureC: 21.4,
    apparentC: 20.9,
    humidityPct: 55,
    windKmh: 12.3,
    code: 3,
    description: "Overcast",
  },
  daily: [
    {
      date: "2026-07-20",
      minC: 15.1,
      maxC: 24.8,
      code: 61,
      description: "Slight rain",
    },
    {
      date: "2026-07-21",
      minC: 14.2,
      maxC: 23.0,
      code: 0,
      description: "Clear sky",
    },
  ],
  asOf: "2026-07-20T08:00:00Z",
  stale: true,
};

function jsonGet(
  body: unknown,
  status = 200,
): Mock {
  // Fresh Response per call — a Response body can only be read once.
  return vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );
}

function expectError(
  res: Awaited<ReturnType<typeof getWeather.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("get_weather", () => {
  it("fetches the screened weather endpoint and returns the full report", async () => {
    const get = jsonGet(WEATHER_PAYLOAD);
    const ctx = ctxWith(get);

    const res = await getWeather.handler({ location: "Paris" }, ctx);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/web/weather", {
      params: { location: "Paris" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "get_weather",
        location: WEATHER_PAYLOAD.location,
        current: WEATHER_PAYLOAD.current,
        daily: WEATHER_PAYLOAD.daily,
        asOf: WEATHER_PAYLOAD.asOf,
        stale: true,
      });
    }
  });

  it("passes stale:false through unchanged", async () => {
    const get = jsonGet({ ...WEATHER_PAYLOAD, stale: false });
    const res = await getWeather.handler({ location: "Paris" }, ctxWith(get));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.data as { stale: boolean }).stale).toBe(false);
    }
  });

  it("maps a 451 to EGRESS_DISABLED with off-LAN guidance", async () => {
    const get = jsonGet({ error: "egress_disabled" }, 451);
    const res = await getWeather.handler({ location: "Paris" }, ctxWith(get));
    expectError(res, "EGRESS_DISABLED");
    if (!res.ok) {
      expect(res.error.message).toContain("off-LAN settings");
      expect(res.error.message).toContain("Weather & currency data");
    }
  });

  it("maps a 404 to LOCATION_NOT_FOUND", async () => {
    const get = jsonGet({ error: "location_not_found" }, 404);
    const res = await getWeather.handler(
      { location: "Nowhereville-xyz" },
      ctxWith(get),
    );
    expectError(res, "LOCATION_NOT_FOUND");
  });

  it("maps a 502 to WEATHER_UNAVAILABLE", async () => {
    const get = jsonGet({ error: "weather_unavailable" }, 502);
    const res = await getWeather.handler({ location: "Paris" }, ctxWith(get));
    expectError(res, "WEATHER_UNAVAILABLE");
  });

  it("maps a thrown fetch error to WEATHER_UNAVAILABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await getWeather.handler({ location: "Paris" }, ctxWith(get));
    expectError(res, "WEATHER_UNAVAILABLE");
  });

  it("rejects a missing location with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getWeather.handler({}, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an empty location with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getWeather.handler({ location: "" }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only location with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getWeather.handler({ location: "   " }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a location over 120 characters with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getWeather.handler(
      { location: "x".repeat(121) },
      ctxWith(get),
    );
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a non-string location with INVALID_ARGS (no HTTP call)", async () => {
    const get = vi.fn();
    const res = await getWeather.handler({ location: 42 }, ctxWith(get));
    expectError(res, "INVALID_ARGS");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("get_weather — tool metadata", () => {
  it("is named get_weather and is Tier-1 (no write, no confirm)", () => {
    expect(getWeather.name).toBe("get_weather");
    expect(getWeather.requiresWrite).toBe(false);
    expect(getWeather.requiresConfirmation).toBe(false);
  });

  it("has an additionalProperties:false schema requiring location", () => {
    const schema = getWeather.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["location"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["location"]);
  });
});
