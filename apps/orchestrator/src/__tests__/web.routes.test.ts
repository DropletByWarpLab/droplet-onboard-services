// WARP-1436 — GET /api/web/weather + GET /api/web/rates route tests.
//
// Scaffolding copied from `llm-complete.test.ts` (auth stub reading
// `x-test-role` with an ENFORCING requireRole, supertest against
// createApp). The `ambient_data` off-LAN gate, the Redis cache, the
// activity recorder, and the global `fetch` to services/web-fetch are
// all mocked so every sovereignty branch is exercised deterministically:
// refused_gate (451), allowed (fresh + cached), served_stale,
// provider_error, and the missing-WEB_FETCH_SERVICE_TOKEN fail-closed 502.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { config } from "../config.js";

vi.mock("../middleware/auth.js", () => ({
  authMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    const role = req.headers["x-test-role"];
    if (typeof role === "string" && role.length > 0) {
      (
        req as unknown as { user?: { id: string; username: string; role: string } }
      ).user = { id: "u-1", username: "test", role };
    }
    next();
  },
  // Enforcing stub — same contract as the real requireRole (403 when the
  // session has no role or the role is not in the route's allowed list).
  requireRole:
    (...allowed: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as unknown as { user?: { role?: string } }).user?.role;
      if (typeof role !== "string" || !allowed.includes(role)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    },
  requireRoleOrMcpService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireRoleOrService: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePasswordChangeGate: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  setAuthPrisma: () => {},
}));

// Stub ChatPersistenceService so createLlmRouter constructs without a live
// Postgres connection (same shape as llm-complete.test.ts; /api/web never
// touches persistence).
vi.mock("../services/chat-persistence.service.js", () => ({
  ChatPersistenceService: vi.fn().mockImplementation(() => ({
    renameConversationForUser: vi.fn(),
    createTurnRows: vi.fn(),
    finalizeAssistantMessage: vi.fn(),
    listConversationsForUser: vi.fn().mockResolvedValue([]),
    getConversationForUser: vi.fn().mockResolvedValue(null),
    deleteConversationForUser: vi.fn().mockResolvedValue(false),
    ensureConversation: vi.fn().mockResolvedValue({ id: "conv-1", created: true }),
  })),
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn().mockResolvedValue(undefined),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn().mockResolvedValue(undefined),
  isTimeoutError: () => false,
}));

vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: {
    listTools: vi.fn().mockResolvedValue([]),
    callTool: vi.fn(),
  },
  ensureMcpStarted: vi.fn().mockResolvedValue(undefined),
  stopMcp: vi.fn().mockResolvedValue(undefined),
}));

// The `ambient_data` off-LAN gate — the sovereignty branch under test.
// `outboundEmailGate` must stay exported: app.ts imports it by name.
const mockGate = vi.fn();
vi.mock("../services/off-lan-gate.service.js", () => ({
  outboundEmailGate: vi.fn().mockResolvedValue(true),
  ambientDataGate: (...args: unknown[]) => mockGate(...args),
}));

// Redis cache — controllable per test.
const mockCacheGet = vi.fn();
const mockCacheSet = vi.fn();
vi.mock("../services/cache.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../services/cache.service.js")
  >("../services/cache.service.js");
  return {
    ...actual,
    cacheGet: (...args: unknown[]) => mockCacheGet(...args),
    cacheSet: (...args: unknown[]) => mockCacheSet(...args),
  };
});

// WARP-456 activity recorder — every /api/web request must land one row.
const mockRecord = vi.fn();
vi.mock("../services/activity.singleton.js", () => ({
  initActivityRecorder: vi.fn(),
  recordActivity: (...args: unknown[]) => {
    mockRecord(...args);
    return Promise.resolve(null);
  },
  getActivitySigner: () => null,
  _setActivityRecorderForTests: vi.fn(),
}));

// Upstream (services/web-fetch) contract fixtures.
const WEATHER_BODY = {
  location: { name: "Paris", latitude: 48.85, longitude: 2.35, country: "France" },
  current: {
    temperatureC: 21.4,
    apparentC: 20.9,
    humidityPct: 55,
    windKmh: 12,
    code: 1,
    description: "Mainly clear",
  },
  daily: [{ date: "2026-07-20", minC: 15, maxC: 25, code: 1, description: "Mainly clear" }],
  asOf: "2026-07-20T10:00:00Z",
};
const RATES_BODY = { base: "EUR", asOf: "2026-07-20", rates: { USD: 1.09, GBP: 0.85 } };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as globalThis.Response;
}

/** Shorthand for asserting the audited refs of the LAST recorded row. */
function lastAuditRefs(): Record<string, unknown> {
  expect(mockRecord).toHaveBeenCalled();
  const params = mockRecord.mock.calls.at(-1)![0] as {
    kind: string;
    sub: string;
    refs: Record<string, unknown>;
  };
  expect(params.kind).toBe("network");
  expect(params.sub).toBe("web_egress");
  return params.refs;
}

const mockFetch = vi.fn();

/**
 * createApp starts background pollers (screen-qr → display service) whose
 * fetches can land mid-test once the global fetch is stubbed. Scope every
 * upstream assertion to calls that actually target web-fetch.
 */
function webFetchCalls(): Array<[string, RequestInit]> {
  return mockFetch.mock.calls.filter(
    (c): c is [string, RequestInit] =>
      typeof c[0] === "string" && (c[0] as string).startsWith("http://web-fetch:8010"),
  );
}
const FRESH_ENTRY = () => ({ data: WEATHER_BODY, fetchedAt: Date.now() });
const STALE_WEATHER_ENTRY = () => ({
  data: WEATHER_BODY,
  fetchedAt: Date.now() - 16 * 60 * 1000, // > 15 min freshness window
});
const STALE_RATES_ENTRY = () => ({
  data: RATES_BODY,
  fetchedAt: Date.now() - 25 * 60 * 60 * 1000, // > 24 h freshness window
});

describe("GET /api/web/*", () => {
  let app: ReturnType<typeof createApp>;
  let savedToken: string;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
    savedToken = config.WEB_FETCH_SERVICE_TOKEN;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    config.WEB_FETCH_SERVICE_TOKEN = "test-web-token";
    mockGate.mockResolvedValue(true);
    mockCacheGet.mockResolvedValue(null);
    mockCacheSet.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    config.WEB_FETCH_SERVICE_TOKEN = savedToken;
  });

  describe("ambient_data gate (fail-closed)", () => {
    it("weather → 451 egress_disabled + audited refusal when the channel is closed", async () => {
      mockGate.mockResolvedValue(false);
      const res = await request(app)
        .get("/api/web/weather?location=Paris")
        .set("x-test-role", "owner");

      expect(res.status).toBe(451);
      expect(res.body).toEqual({ error: "egress_disabled" });
      expect(webFetchCalls()).toHaveLength(0);
      expect(lastAuditRefs()).toMatchObject({
        channel: "ambient_data",
        route: "weather",
        dst: "api.open-meteo.com",
        outcome: "refused_gate",
        httpStatus: 451,
        userId: "u-1",
      });
    });

    it("rates → 451 egress_disabled + audited refusal when the channel is closed", async () => {
      mockGate.mockResolvedValue(false);
      const res = await request(app).get("/api/web/rates").set("x-test-role", "admin");

      expect(res.status).toBe(451);
      expect(res.body).toEqual({ error: "egress_disabled" });
      expect(webFetchCalls()).toHaveLength(0);
      expect(lastAuditRefs()).toMatchObject({
        channel: "ambient_data",
        route: "rates",
        dst: "www.ecb.europa.eu",
        outcome: "refused_gate",
        httpStatus: 451,
      });
    });
  });

  describe("weather", () => {
    it("happy path: calls web-fetch with bearer auth, caches, returns stale:false, audits allowed", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, WEATHER_BODY));
      const res = await request(app)
        .get("/api/web/weather?location=Paris")
        .set("x-test-role", "owner");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...WEATHER_BODY, stale: false });

      expect(webFetchCalls()).toHaveLength(1);
      const [url, init] = webFetchCalls()[0];
      expect(url).toBe("http://web-fetch:8010/weather?location=Paris");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-web-token",
      );
      expect(init.signal).toBeInstanceOf(AbortSignal);

      // Cached under the normalized (lowercased) location.
      expect(mockCacheSet).toHaveBeenCalledTimes(1);
      const [key, entry] = mockCacheSet.mock.calls[0] as [
        string,
        { data: unknown; fetchedAt: number },
      ];
      expect(key).toBe("web:weather:paris");
      expect(entry.data).toEqual(WEATHER_BODY);

      expect(lastAuditRefs()).toMatchObject({
        channel: "ambient_data",
        route: "weather",
        dst: "api.open-meteo.com",
        outcome: "allowed",
        httpStatus: 200,
        userId: "u-1",
      });
    });

    it("fresh cache hit does NOT call upstream", async () => {
      mockCacheGet.mockResolvedValue(FRESH_ENTRY());
      const res = await request(app)
        .get("/api/web/weather?location=Paris")
        .set("x-test-role", "family");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...WEATHER_BODY, stale: false });
      expect(webFetchCalls()).toHaveLength(0);
      expect(lastAuditRefs()).toMatchObject({ outcome: "allowed", httpStatus: 200 });
    });

    it("maps upstream 404 to 404 location_not_found", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(404, { detail: "location_not_found" }));
      const res = await request(app)
        .get("/api/web/weather?location=Nowhereville")
        .set("x-test-role", "owner");

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "location_not_found" });
      expect(lastAuditRefs()).toMatchObject({ outcome: "allowed", httpStatus: 404 });
    });

    it("upstream down + retained cache → 200 stale:true, audited served_stale", async () => {
      mockCacheGet.mockResolvedValue(STALE_WEATHER_ENTRY());
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED web-fetch"));
      const res = await request(app)
        .get("/api/web/weather?location=Paris")
        .set("x-test-role", "owner");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...WEATHER_BODY, stale: true });
      expect(webFetchCalls()).toHaveLength(1); // it DID try to refresh
      expect(lastAuditRefs()).toMatchObject({
        outcome: "served_stale",
        httpStatus: 200,
      });
    });

    it("upstream down + no cache → 502 weather_unavailable, audited provider_error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED web-fetch"));
      const res = await request(app)
        .get("/api/web/weather?location=Paris")
        .set("x-test-role", "owner");

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "weather_unavailable" });
      expect(lastAuditRefs()).toMatchObject({
        outcome: "provider_error",
        httpStatus: 502,
      });
    });

    it("rejects a missing location with 400 (no upstream call)", async () => {
      const res = await request(app).get("/api/web/weather").set("x-test-role", "owner");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_location" });
      expect(webFetchCalls()).toHaveLength(0);
    });

    it("rejects a location over 120 chars with 400", async () => {
      const res = await request(app)
        .get(`/api/web/weather?location=${"x".repeat(121)}`)
        .set("x-test-role", "owner");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_location" });
      expect(webFetchCalls()).toHaveLength(0);
    });
  });

  describe("rates", () => {
    it("defaults the base to EUR", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, RATES_BODY));
      const res = await request(app).get("/api/web/rates").set("x-test-role", "owner");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...RATES_BODY, stale: false });
      const [url, init] = webFetchCalls()[0];
      expect(url).toBe("http://web-fetch:8010/rates?base=EUR");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer test-web-token",
      );
      expect(mockCacheSet).toHaveBeenCalledWith(
        "web:rates:EUR",
        expect.objectContaining({ data: RATES_BODY }),
        expect.any(Number),
      );
      expect(lastAuditRefs()).toMatchObject({
        route: "rates",
        dst: "www.ecb.europa.eu",
        outcome: "allowed",
        httpStatus: 200,
      });
    });

    it("normalizes a lowercase base to uppercase", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, { ...RATES_BODY, base: "USD" }));
      const res = await request(app)
        .get("/api/web/rates?base=usd")
        .set("x-test-role", "owner");

      expect(res.status).toBe(200);
      const [url] = webFetchCalls()[0];
      expect(url).toBe("http://web-fetch:8010/rates?base=USD");
    });

    it("rejects a malformed base with 400 unknown_currency (no upstream call)", async () => {
      const res = await request(app)
        .get("/api/web/rates?base=money")
        .set("x-test-role", "owner");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "unknown_currency" });
      expect(webFetchCalls()).toHaveLength(0);
    });

    it("maps an upstream 400 to 400 unknown_currency", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(400, { detail: "unknown_currency" }));
      const res = await request(app)
        .get("/api/web/rates?base=XXX")
        .set("x-test-role", "owner");
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "unknown_currency" });
      expect(lastAuditRefs()).toMatchObject({ outcome: "allowed", httpStatus: 400 });
    });

    it("upstream down + retained cache → 200 stale:true", async () => {
      mockCacheGet.mockResolvedValue(STALE_RATES_ENTRY());
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED web-fetch"));
      const res = await request(app).get("/api/web/rates").set("x-test-role", "guest");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ...RATES_BODY, stale: true });
      expect(lastAuditRefs()).toMatchObject({
        outcome: "served_stale",
        httpStatus: 200,
      });
    });

    it("upstream down + no cache → 502 rates_unavailable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED web-fetch"));
      const res = await request(app).get("/api/web/rates").set("x-test-role", "owner");

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "rates_unavailable" });
      expect(lastAuditRefs()).toMatchObject({
        outcome: "provider_error",
        httpStatus: 502,
      });
    });
  });

  describe("missing WEB_FETCH_SERVICE_TOKEN (fail-closed)", () => {
    it("weather → 502 without calling upstream", async () => {
      config.WEB_FETCH_SERVICE_TOKEN = "";
      const res = await request(app)
        .get("/api/web/weather?location=Paris")
        .set("x-test-role", "owner");

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "weather_unavailable" });
      expect(webFetchCalls()).toHaveLength(0);
      expect(lastAuditRefs()).toMatchObject({
        outcome: "provider_error",
        httpStatus: 502,
      });
    });

    it("rates → 502 without calling upstream", async () => {
      config.WEB_FETCH_SERVICE_TOKEN = "";
      const res = await request(app).get("/api/web/rates").set("x-test-role", "owner");

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "rates_unavailable" });
      expect(webFetchCalls()).toHaveLength(0);
    });
  });

  describe("role guard", () => {
    it("admits the service principal (role=service)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, WEATHER_BODY));
      const res = await request(app)
        .get("/api/web/weather?location=Paris")
        .set("x-test-role", "service");
      expect(res.status).toBe(200);
    });

    it.each(["owner", "admin", "family", "guest"])("admits the %s role", async (role) => {
      mockFetch.mockResolvedValueOnce(jsonResponse(200, WEATHER_BODY));
      const res = await request(app)
        .get("/api/web/weather?location=Paris")
        .set("x-test-role", role);
      expect(res.status).toBe(200);
    });

    it("rejects an unauthenticated request (no role) with 403 before the gate", async () => {
      const res = await request(app).get("/api/web/weather?location=Paris");
      expect(res.status).toBe(403);
      expect(mockGate).not.toHaveBeenCalled();
      expect(webFetchCalls()).toHaveLength(0);
    });

    it("rejects a role outside the allowed list", async () => {
      const res = await request(app)
        .get("/api/web/rates")
        .set("x-test-role", "stranger");
      expect(res.status).toBe(403);
      expect(webFetchCalls()).toHaveLength(0);
    });
  });
});
