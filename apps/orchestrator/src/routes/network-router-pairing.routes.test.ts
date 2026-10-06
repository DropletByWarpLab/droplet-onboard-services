/**
 * ADR-071 slice B — the three router-pairing routes.
 *
 * Role gating, response shape, and the one invariant that matters most: the
 * password never appears in a response. The service is faked (its own behaviour,
 * audit row included, is pinned in router-pairing.service.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    NEXTCLOUD_URL: "http://nextcloud.test",
    NODE_ENV: "test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { errorHandler } from "../middleware/error-handler.js";
import { registerRouterPairingRoutes } from "./network-router-pairing.routes.js";

const PASSWORD = "0123456789abcdef0123456789abcdef";

function fakeService() {
  return {
    getPairingView: vi.fn(async () => ({
      available: true,
      state: "open",
      windowEndsAt: "2026-10-07T00:00:00Z",
      pairedBox: null,
      pairedElsewhere: false,
      pendingPersist: false,
      routerErrorCode: "AUTH",
      host: "192.168.9.1",
      model: null,
    })),
    pair: vi.fn(async (_userId?: string) => ({
      ok: true,
      persisted: true,
      host: "192.168.9.1",
      model: "RB5009",
      paired_at: "2026-10-06T10:00:00Z",
      httpStatus: 200,
      // A buggy service must still not leak: the route whitelists fields.
      password: PASSWORD,
    })),
    persistPending: vi.fn(async (_userId?: string) => ({ ok: true, persisted: true, httpStatus: 200 })),
    publishIdentity: vi.fn(),
    noteForeignPairing: vi.fn(),
    reconcile: vi.fn(),
  };
}

function buildApp(role: "owner" | "admin" | "family" | "guest", service = fakeService()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "u1", username: "u", displayName: "U", role };
    next();
  });
  const router = express.Router();
  registerRouterPairingRoutes(router, { prisma: {} as never, service: service as never });
  app.use(router);
  app.use(errorHandler);
  return { app, service };
}

describe("GET /network/router/pairing", () => {
  it.each(["owner", "admin", "family"] as const)("is readable by %s", async (role) => {
    const { app, service } = buildApp(role);
    const res = await request(app).get("/network/router/pairing");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, state: "open", routerErrorCode: "AUTH" });
    expect(service.getPairingView).toHaveBeenCalledOnce();
  });

  it("is refused for a guest", async () => {
    const { app, service } = buildApp("guest");
    const res = await request(app).get("/network/router/pairing");
    expect(res.status).toBe(403);
    expect(service.getPairingView).not.toHaveBeenCalled();
  });
});

describe("POST /network/router/pair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["owner", "admin"] as const)("%s pairs; the response never carries the password", async (role) => {
    const { app, service } = buildApp(role);
    const res = await request(app).post("/network/router/pair").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      persisted: true,
      host: "192.168.9.1",
      model: "RB5009",
      paired_at: "2026-10-06T10:00:00Z",
    });
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    expect(res.text).not.toMatch(/password/i);
    expect(service.pair).toHaveBeenCalledWith("u1");
  });

  it.each(["family", "guest"] as const)("%s cannot pair", async (role) => {
    const { app, service } = buildApp(role);
    const res = await request(app).post("/network/router/pair").send({});
    expect(res.status).toBe(403);
    expect(service.pair).not.toHaveBeenCalled();
  });

  it("claim ok but not persisted answers 200 ok:true persisted:false with the explanation", async () => {
    const service = fakeService();
    service.pair.mockResolvedValueOnce({
      ok: true,
      persisted: false,
      host: "192.168.9.1",
      model: "RB5009",
      paired_at: "t",
      error: "Paired, but the password could not be saved. It will be lost on the next restart.",
      httpStatus: 200,
    } as never);
    const { app } = buildApp("owner", service);
    const res = await request(app).post("/network/router/pair").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, persisted: false });
    expect(res.body.error).toMatch(/could not be saved/);
  });

  it("a refused claim carries the service status and code", async () => {
    const service = fakeService();
    service.pair.mockResolvedValueOnce({
      ok: false,
      persisted: false,
      code: "PAIR_WINDOW_CLOSED",
      error: "The router is not accepting a pairing right now.",
      httpStatus: 409,
    } as never);
    const { app } = buildApp("admin", service);
    const res = await request(app).post("/network/router/pair").send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "PAIR_WINDOW_CLOSED" });
  });
});

describe("POST /network/router/pair/persist", () => {
  it("owner retries step 4 only", async () => {
    const { app, service } = buildApp("owner");
    const res = await request(app).post("/network/router/pair/persist").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, persisted: true });
    expect(service.persistPending).toHaveBeenCalledWith("u1");
    expect(service.pair).not.toHaveBeenCalled();
  });

  it("family cannot", async () => {
    const { app, service } = buildApp("family");
    expect((await request(app).post("/network/router/pair/persist").send({})).status).toBe(403);
    expect(service.persistPending).not.toHaveBeenCalled();
  });
});
