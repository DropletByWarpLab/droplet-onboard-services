/**
 * ADR-071 slice C — the switch and per-AP pairing routes. Same contract as the
 * router's (network-router-pairing.routes.test.ts): role gating, response shape,
 * and the one invariant that matters most: the password never appears in a
 * response. The service is faked (its behaviour, audit rows included, is pinned
 * in device-pairing.service.test.ts).
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
import { registerApPairingRoutes, registerSwitchPairingRoutes } from "./network-device-pairing.routes.js";

const PASSWORD = "0123456789abcdef0123456789abcdef";
const MAC = "AA:BB:CC:DD:EE:01";

function fakeService() {
  return {
    getPairingView: vi.fn(async (_id?: string) => ({
      available: true,
      state: "open",
      windowEndsAt: "2026-10-07T00:00:00Z",
      pairedBox: null,
      pairedElsewhere: false,
      pendingPersist: false,
      routerErrorCode: null,
      host: "192.168.9.42",
      model: null,
    })),
    pair: vi.fn(async (_userId?: string, _id?: string) => ({
      ok: true,
      persisted: true,
      host: "192.168.9.42",
      model: "NWA50BE",
      paired_at: "2026-10-06T10:00:00Z",
      httpStatus: 200,
      // A buggy service must still not leak: the route whitelists fields.
      password: PASSWORD,
    })),
    persistPending: vi.fn(async (_userId?: string, _id?: string) => ({ ok: true, persisted: true, httpStatus: 200 })),
    publishIdentity: vi.fn(),
    noteForeignPairing: vi.fn(),
    reconcile: vi.fn(),
  };
}

function buildApp(
  role: "owner" | "admin" | "family" | "guest",
  register: typeof registerSwitchPairingRoutes,
  service = fakeService(),
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: "u1", username: "u", displayName: "U", role };
    next();
  });
  const router = express.Router();
  register(router, { prisma: {} as never, service: service as never });
  app.use(router);
  app.use(errorHandler);
  return { app, service };
}

describe("switch routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["owner", "admin", "family"] as const)("GET /network/switch/pairing is readable by %s", async (role) => {
    const { app, service } = buildApp(role, registerSwitchPairingRoutes);
    const res = await request(app).get("/network/switch/pairing");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, state: "open" });
    expect(service.getPairingView).toHaveBeenCalledWith();
  });

  it("GET is refused for a guest", async () => {
    const { app, service } = buildApp("guest", registerSwitchPairingRoutes);
    expect((await request(app).get("/network/switch/pairing")).status).toBe(403);
    expect(service.getPairingView).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"] as const)("%s pairs the switch; the response never carries the password", async (role) => {
    const { app, service } = buildApp(role, registerSwitchPairingRoutes);
    const res = await request(app).post("/network/switch/pair").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      persisted: true,
      host: "192.168.9.42",
      model: "NWA50BE",
      paired_at: "2026-10-06T10:00:00Z",
    });
    expect(res.text).not.toContain(PASSWORD);
    expect(res.text).not.toMatch(/password/i);
    expect(service.pair).toHaveBeenCalledWith("u1");
  });

  it.each(["family", "guest"] as const)("%s cannot pair or retry the persist", async (role) => {
    const { app, service } = buildApp(role, registerSwitchPairingRoutes);
    expect((await request(app).post("/network/switch/pair").send({})).status).toBe(403);
    expect((await request(app).post("/network/switch/pair/persist").send({})).status).toBe(403);
    expect(service.pair).not.toHaveBeenCalled();
    expect(service.persistPending).not.toHaveBeenCalled();
  });

  it("a refusal keeps its status and machine code, still without a password", async () => {
    const service = fakeService();
    service.pair.mockResolvedValueOnce({
      ok: false,
      persisted: false,
      httpStatus: 409,
      code: "SWITCH_PAIRED_ELSEWHERE",
      error: "This switch is paired to another device.",
      password: PASSWORD,
    } as never);
    const { app } = buildApp("owner", registerSwitchPairingRoutes, service);
    const res = await request(app).post("/network/switch/pair").send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: "SWITCH_PAIRED_ELSEWHERE" });
    expect(res.text).not.toContain(PASSWORD);
  });

  it("POST /network/switch/pair/persist re-runs the persist leg", async () => {
    const { app, service } = buildApp("admin", registerSwitchPairingRoutes);
    const res = await request(app).post("/network/switch/pair/persist").send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, persisted: true });
    expect(service.persistPending).toHaveBeenCalledWith("u1");
  });
});

describe("AP routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["owner", "admin", "family"] as const)("GET /network/aps/:mac/pairing is readable by %s", async (role) => {
    const { app, service } = buildApp(role, registerApPairingRoutes);
    const res = await request(app).get(`/network/aps/${MAC}/pairing`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: true, state: "open", host: "192.168.9.42" });
    expect(service.getPairingView).toHaveBeenCalledWith(MAC);
  });

  it("GET is refused for a guest", async () => {
    const { app, service } = buildApp("guest", registerApPairingRoutes);
    expect((await request(app).get(`/network/aps/${MAC}/pairing`)).status).toBe(403);
    expect(service.getPairingView).not.toHaveBeenCalled();
  });

  it("the MAC is canonicalised (lowercase, dashes) before it reaches the service", async () => {
    const { app, service } = buildApp("owner", registerApPairingRoutes);
    await request(app).post("/network/aps/aa-bb-cc-dd-ee-01/pair").send({});
    expect(service.pair).toHaveBeenCalledWith("u1", MAC);
  });

  it.each(["owner", "admin"] as const)("%s pairs one AP; the response never carries the password", async (role) => {
    const { app, service } = buildApp(role, registerApPairingRoutes);
    const res = await request(app).post(`/network/aps/${MAC}/pair`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      persisted: true,
      host: "192.168.9.42",
      model: "NWA50BE",
      paired_at: "2026-10-06T10:00:00Z",
    });
    expect(res.text).not.toContain(PASSWORD);
    expect(service.pair).toHaveBeenCalledWith("u1", MAC);
  });

  it.each(["family", "guest"] as const)("%s cannot pair an AP", async (role) => {
    const { app, service } = buildApp(role, registerApPairingRoutes);
    expect((await request(app).post(`/network/aps/${MAC}/pair`).send({})).status).toBe(403);
    expect(service.pair).not.toHaveBeenCalled();
  });

  it("an invalid MAC is a 404 on every verb and never reaches the service", async () => {
    const { app, service } = buildApp("owner", registerApPairingRoutes);
    for (const res of [
      await request(app).get("/network/aps/not-a-mac/pairing"),
      await request(app).post("/network/aps/not-a-mac/pair").send({}),
      await request(app).post("/network/aps/not-a-mac/pair/persist").send({}),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ ok: false, code: "AP_NOT_FOUND" });
    }
    expect(service.getPairingView).not.toHaveBeenCalled();
    expect(service.pair).not.toHaveBeenCalled();
    expect(service.persistPending).not.toHaveBeenCalled();
  });

  it("POST /network/aps/:mac/pair/persist re-runs the persist leg", async () => {
    const { app, service } = buildApp("owner", registerApPairingRoutes);
    const res = await request(app).post(`/network/aps/${MAC}/pair/persist`).send({});
    expect(res.status).toBe(200);
    expect(service.persistPending).toHaveBeenCalledWith("u1", MAC);
  });
});
