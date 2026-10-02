/**
 * `/api/building/*` — device gateway routes (BACnet/Modbus/SNMP/KNX).
 *
 * Pins: who reaches what (real auth guards, a req.user-injecting shim, the
 * MCP principal admitted on the tool routes only), input validation, the
 * gateway's own status/message passed through, and the FAIL-CLOSED audit —
 * the audit row is written before the write, and no row means no write.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DEVICE_GATEWAY_URL: "http://gw.test:8084",
    SERVICE_TOKEN_DEVICE_GATEWAY: "gw-token",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/device-gateway.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/device-gateway.client.js")>();
  return {
    DeviceGatewayError: actual.DeviceGatewayError,
    health: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    putDevice: vi.fn(),
    deleteDevice: vi.fn(),
    readValues: vi.fn(),
    writePoint: vi.fn(),
    discover: vi.fn(),
    templates: vi.fn(),
  };
});

import { createBuildingRouter } from "../routes/building.js";
import * as gateway from "../services/device-gateway.client.js";
import { DeviceGatewayError } from "../services/device-gateway.client.js";
import { recordActivity } from "../services/activity.singleton.js";
import type { AuthUser } from "../middleware/auth.js";
import type { PrismaClient } from "@prisma/client";

const g = vi.mocked(gateway);
const auditCreate = vi.fn();
const prisma = { commandAuditLog: { create: auditCreate } } as unknown as PrismaClient;

const mcp: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };
const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };
const staff: AuthUser = { id: "u-staff", username: "alice", displayName: "alice", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "guest", displayName: "guest", role: "guest" };

function app(user: AuthUser | null) {
  const a = express();
  a.use(express.json());
  a.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  a.use("/api", createBuildingRouter(prisma));
  return a;
}

const DEVICE = {
  id: "rtu-1", name: "Rooftop unit", protocol: "modbus", address: "10.0.0.5",
  points: [{ id: "setpoint", name: "Setpoint", kind: "number", writable: true, min: 16, max: 28 }],
};
const PLAN = { device_id: "rtu-1", point_id: "setpoint", protocol: "modbus", value: 21 };
const WRITE = "/api/building/devices/rtu-1/points/setpoint/write";

beforeEach(() => {
  vi.clearAllMocks();
  auditCreate.mockResolvedValue({ id: "a1" });
  g.listDevices.mockResolvedValue([DEVICE] as never);
  g.readValues.mockResolvedValue({ device_id: "rtu-1", read_at: "t", values: {} });
  g.writePoint.mockResolvedValue({ applied: true, live_writes: true, plan: PLAN, readback: { value: 21, error: null } } as never);
  g.putDevice.mockResolvedValue(DEVICE as never);
  g.discover.mockResolvedValue({ found: [] });
});

describe("reads", () => {
  it.each([mcp, owner, staff])("$id may list devices and read values", async (user) => {
    expect((await request(app(user)).get("/api/building/devices")).status).toBe(200);
    expect((await request(app(user)).get("/api/building/devices/rtu-1/values")).status).toBe(200);
  });

  it("guests may not", async () => {
    expect((await request(app(guest)).get("/api/building/devices")).status).toBe(403);
  });

  it("rejects a non-slug device id before calling the gateway", async () => {
    const res = await request(app(owner)).get("/api/building/devices/..%2Fetc/values");
    expect(res.status).toBe(400);
    expect(g.readValues).not.toHaveBeenCalled();
  });

  it("passes an unreachable device through as 502 with the gateway's message", async () => {
    g.readValues.mockRejectedValue(new DeviceGatewayError("rtu-1: no Modbus answer", 502, "unreachable"));
    const res = await request(app(owner)).get("/api/building/devices/rtu-1/values");
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "rtu-1: no Modbus answer", code: "unreachable" });
  });
});

describe("registry administration is owner/admin in the dashboard only", () => {
  it("owner saves a device and it is recorded as Device control activity", async () => {
    const res = await request(app(owner)).put("/api/building/devices/rtu-1").send(DEVICE);
    expect(res.status).toBe(200);
    expect(g.putDevice).toHaveBeenCalledWith("rtu-1", DEVICE);
    expect(vi.mocked(recordActivity).mock.calls[0][0]).toMatchObject({ kind: "smart_home" });
  });

  it.each([mcp, staff])("$id cannot change the registry or discover", async (user) => {
    expect((await request(app(user)).put("/api/building/devices/rtu-1").send(DEVICE)).status).toBe(403);
    expect((await request(app(user)).delete("/api/building/devices/rtu-1")).status).toBe(403);
    expect((await request(app(user)).post("/api/building/discover").send({ protocol: "bacnet" })).status).toBe(403);
    expect(g.putDevice).not.toHaveBeenCalled();
  });

  it("gateway validation errors come back as 422 with their message", async () => {
    g.putDevice.mockRejectedValue(new DeviceGatewayError("points.0: a writable number needs both min and max", 422, "invalid_device"));
    const res = await request(app(owner)).put("/api/building/devices/rtu-1").send(DEVICE);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/min and max/);
  });

  it("discovery rejects an unknown protocol", async () => {
    const res = await request(app(owner)).post("/api/building/discover").send({ protocol: "zigbee" });
    expect(res.status).toBe(400);
    expect(g.discover).not.toHaveBeenCalled();
  });
});

describe("writes", () => {
  it.each([mcp, owner])("$id may write; the audit row lands before the write", async (user) => {
    const order: string[] = [];
    auditCreate.mockImplementation(async () => { order.push("audit"); return {}; });
    g.writePoint.mockImplementation(async () => {
      order.push("write");
      return { applied: true, live_writes: true, plan: PLAN } as never;
    });
    const res = await request(app(user)).post(WRITE).send({ value: 21 });
    expect(res.status).toBe(200);
    expect(order).toEqual(["audit", "write"]);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      entityId: "building.rtu-1.setpoint", domain: "building", service: "write_point",
      data: { value: 21 }, tier: 2, userId: user.id,
    });
    expect(g.writePoint).toHaveBeenCalledWith("rtu-1", "setpoint", 21);
  });

  it("staff may not write", async () => {
    expect((await request(app(staff)).post(WRITE).send({ value: 21 })).status).toBe(403);
    expect(g.writePoint).not.toHaveBeenCalled();
  });

  it("no audit row, no write (fail closed)", async () => {
    auditCreate.mockRejectedValue(new Error("db down"));
    const res = await request(app(owner)).post(WRITE).send({ value: 21 });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("audit_unavailable");
    expect(g.writePoint).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ value: null }], [{ value: { a: 1 } }], [{ value: [1] }]])(
    "rejects a missing or non-scalar value %j",
    async (body) => {
      expect((await request(app(owner)).post(WRITE).send(body)).status).toBe(400);
      expect(auditCreate).not.toHaveBeenCalled();
    },
  );

  it("a plan-only result (live writes off) is reported as not applied", async () => {
    g.writePoint.mockResolvedValue({ applied: false, live_writes: false, plan: PLAN } as never);
    const res = await request(app(owner)).post(WRITE).send({ value: 21 });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(vi.mocked(recordActivity).mock.calls[0][0].what).toMatch(/live writes off/);
  });

  it("the gateway's guard refusal passes through as 422", async () => {
    g.writePoint.mockRejectedValue(new DeviceGatewayError("setpoint must be at most 28", 422, "write_rejected"));
    const res = await request(app(owner)).post(WRITE).send({ value: 40 });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "setpoint must be at most 28", code: "write_rejected" });
  });
});
