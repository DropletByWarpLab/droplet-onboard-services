import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createWebResearchRouter } from "./web-research.js";

const state = vi.hoisted(() => ({ token: "service-token", limit: 1 as number | null, recorder: true, auditReject: false, attempts: vi.fn(), outcomes: vi.fn() }));
vi.mock("../lib/internal-tls.js", () => ({
  internalBaseUrl: (url: string) => process.env.DROPLET_INTERNAL_TLS === "1" ? url.replace(/^http:/, "https:") : url,
  internalFetch: (url: string, init: RequestInit) => fetch(url, init),
}));
vi.mock("../config.js", () => ({ config: { get WEB_FETCH_SERVICE_TOKEN() { return state.token; }, WEB_FETCH_URL: "http://web-fetch:8010" } }));
vi.mock("../services/cache.service.js", () => ({ cacheIncr: vi.fn(async () => state.limit) }));
vi.mock("../services/activity.service.js", () => ({ actorFromRequest: () => ({ type: "user", userId: "u-1", username: "tester" }) }));
vi.mock("../services/activity.singleton.js", () => ({
  getActivityRecorder: () => state.recorder ? { record: async (data: unknown) => { state.attempts(data); if (state.auditReject) throw new Error("audit down"); return {}; } } : null,
  recordActivity: async (data: unknown) => { state.outcomes(data); return null; },
}));
vi.mock("../middleware/auth.js", () => ({ requireRole: (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || !roles.includes(req.user.role)) { res.status(403).json({ error: "Forbidden" }); return; }
  next();
} }));

let gate = vi.fn();
let sample = vi.fn();
let upstream = vi.fn();
function app(role = "owner") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (role) req.user = { id: "u-1", username: "tester", role } as Request["user"]; next(); });
  app.use("/api", createWebResearchRouter({ offLanAllowlistChannel: { findUnique: gate }, offLanEgressSample: { create: sample } } as unknown as PrismaClient));
  return app;
}
const page = { url: "https://example.com/source", title: "Source", text: "Evidence", bytes: 1024, retrievedAt: "2026-10-08T10:00:00Z", sourceId: "test-source", truncated: false };
beforeEach(() => {
  state.token = "service-token"; state.limit = 1; state.recorder = true; state.auditReject = false;
  state.attempts.mockClear(); state.outcomes.mockClear();
  gate = vi.fn().mockResolvedValue({ enabled: true }); sample = vi.fn().mockResolvedValue({});
  upstream = vi.fn().mockImplementation(async () => new globalThis.Response(JSON.stringify(page), { status: 200 }));
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.DROPLET_INTERNAL_TLS; });

describe("screened public web routes", () => {
  it("uses the certificate-presenting internal client and TLS scheme when enabled", async () => {
    process.env.DROPLET_INTERNAL_TLS = "1";
    const res = await request(app()).post("/api/web/fetch").send({ url: page.url });
    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith("https://web-fetch:8010/fetch", expect.objectContaining({ headers: { "Content-Type": "application/json", Authorization: "Bearer service-token" } }));
  });
  it("requires a known principal", async () => {
    expect((await request(app("")).post("/api/web/fetch").send({ url: page.url })).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([null, { enabled: false }])("missing/closed gate refuses before upstream", async (row) => {
    gate.mockResolvedValue(row);
    const res = await request(app()).post("/api/web/fetch").send({ url: page.url });
    expect(res.status).toBe(451); expect(upstream).not.toHaveBeenCalled();
    expect(gate).toHaveBeenCalledWith({ where: { key: "web_fetch" } });
    expect(state.outcomes.mock.calls[0][0].refs.outcome).toBe("egress_disabled");
  });
  it("gate outage fails closed", async () => {
    gate.mockRejectedValue(new Error("db down"));
    expect((await request(app()).post("/api/web/search").send({ query: "public" })).status).toBe(451);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["https://example.com/?q=alice%40example.com", "https://example.com/?token=private", "http://example.com", "https://example.com:1234", "https://user:pass@example.com"]) ("screens %s before edge forwarding", async (url) => {
    expect((await request(app()).post("/api/web/fetch").send({ url })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each(["alice@example.com", "password=verysecret", "MRN: 1234"]) ("screens private query %s locally", async (query) => {
    expect((await request(app()).post("/api/web/search").send({ query })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([{ query: "hello", count: true }, { query: "hello", count: 11 }, { query: "hello", extra: true }, { query: "word ".repeat(76) }]) ("strict search args %j", async (body) => {
    expect((await request(app()).post("/api/web/search").send(body)).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it.each([null, 21])("rate limiter blocks count %s", async (limit) => {
    state.limit = limit;
    expect((await request(app()).post("/api/web/fetch").send({ url: page.url })).status).toBe(limit === null ? 503 : 429);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("guest budget is smaller", async () => {
    state.limit = 7;
    expect((await request(app("guest")).post("/api/web/fetch").send({ url: page.url })).status).toBe(429);
  });
  it.each(["no_token", "no_recorder", "audit_down"])("no unaudited egress when %s", async (failure) => {
    if (failure === "no_token") state.token = "";
    if (failure === "no_recorder") state.recorder = false;
    if (failure === "audit_down") state.auditReject = true;
    expect((await request(app()).post("/api/web/fetch").send({ url: page.url })).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("calls only authenticated boundary, meters public response and preserves source metadata", async () => {
    const res = await request(app()).post("/api/web/fetch").send({ url: page.url });
    expect(res.status).toBe(200); expect(res.body.url).toBe(page.url); expect(res.body.retrievedAt).toBe(page.retrievedAt);
    expect(res.body.trust).toBe("untrusted_web");
    expect(upstream).toHaveBeenCalledWith("http://web-fetch:8010/fetch", expect.objectContaining({ method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: "Bearer service-token" } }));
    expect(state.attempts).toHaveBeenCalledOnce();
    expect(sample).toHaveBeenCalledWith({ data: { channel: "web_fetch", bytes: 1024n } });
    expect(state.outcomes.mock.calls[0][0].refs.dst).toBe("example.com");
    expect(JSON.stringify(state.outcomes.mock.calls)).not.toContain("/source");
  });
  it("normalizes search data and redacts inbound credential shapes again", async () => {
    upstream.mockImplementation(async () => new globalThis.Response(JSON.stringify({ results: [{ url: page.url, title: "Source", snippet: "password=verysecretvalue" }], bytes: 20 }), { status: 200 }));
    const res = await request(app()).post("/api/web/search").send({ query: "public data", count: 1 });
    expect(res.status).toBe(200); expect(res.body.results[0].snippet).not.toContain("verysecretvalue");
  });
  it.each([400, 413, 429, 503])("maps screened service error %s", async (status) => {
    upstream.mockImplementation(async () => new globalThis.Response(JSON.stringify({ detail: status === 503 ? "search_not_configured" : "blocked_destination" }), { status }));
    const res = await request(app()).post("/api/web/search").send({ query: "public data" });
    expect(res.status).toBe(status);
  });
  it("does not echo arbitrary edge error strings", async () => {
    upstream.mockImplementation(async () => new globalThis.Response(JSON.stringify({ detail: "secret=veryprivate" }), { status: 500 }));
    const res = await request(app()).post("/api/web/fetch").send({ url: page.url });
    expect(res.status).toBe(502); expect(res.body.error).toBe("web_unavailable");
  });
  it.each([{ ...page, text: "x".repeat(24001) }, { ...page, url: "http://localhost" }, { results: [{ url: page.url, title: "Source", snippet: "x".repeat(2001) }] }])("rejects malformed edge response", async (payload) => {
    upstream.mockImplementation(async () => new globalThis.Response(JSON.stringify(payload)));
    expect((await request(app()).post("/api/web/" + ("results" in payload ? "search" : "fetch")).send("results" in payload ? { query: "public" } : { url: page.url })).status).toBe(502);
  });
  it("bounds edge response before JSON parsing", async () => {
    upstream.mockImplementation(async () => new globalThis.Response("x".repeat(128 * 1024 + 1)));
    expect((await request(app()).post("/api/web/fetch").send({ url: page.url })).status).toBe(502);
  });
  it("returns structured failure on edge outage", async () => {
    upstream.mockRejectedValue(new Error("network error"));
    expect((await request(app()).post("/api/web/fetch").send({ url: page.url })).status).toBe(502);
  });
});
