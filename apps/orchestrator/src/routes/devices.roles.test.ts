/**
 * WARP-3378 (Romain, 2026-09-30) — `GET /api/devices` answers the box's own
 * Device row: hostname, hardware revision, network mode and IP. It had no role
 * guard, so any signed-in principal read it. Network mode and the IP are for
 * owner and admin only; a member gets the hostname and hardware revision (the
 * dashboard's header chip and the Settings card), and an external guest gets
 * nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

const { listDevices } = vi.hoisted(() => ({ listDevices: vi.fn() }));
vi.mock("../services/device.service.js", () => ({ listDevices }));

import { createDevicesRouter } from "./devices.js";

const ROW = {
  id: "d1",
  deviceId: "droplet-001",
  hostname: "droplet",
  hardwareRev: "rev-b",
  networkMode: "dhcp",
  ip: "192.168.1.100",
  lastSeen: "2026-09-30T00:00:00.000Z",
};

function appAs(role: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    if (role !== null) {
      (req as unknown as { user: unknown }).user = { id: `u-${role}`, username: role, displayName: role, role };
    }
    next();
  });
  app.use("/api", createDevicesRouter());
  return app;
}

describe("GET /api/devices — the box's own device row (WARP-3378)", () => {
  beforeEach(() => {
    listDevices.mockReset().mockResolvedValue([ROW]);
  });

  it("an external guest is refused, and the row is never read", async () => {
    const res = await request(appAs("guest")).get("/api/devices");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/192\.168|dhcp|rev-b|droplet-001/);
    expect(listDevices).not.toHaveBeenCalled();
  });

  it.each(["service", null])("a %s principal is refused too", async (role) => {
    expect((await request(appAs(role)).get("/api/devices")).status).toBe(403);
    expect(listDevices).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin"])("an %s gets the whole device row", async (role) => {
    const res = await request(appAs(role)).get("/api/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([ROW]);
  });

  it("a member gets who the box is, but neither its IP address nor its network mode", async () => {
    const res = await request(appAs("family")).get("/api/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "d1", deviceId: "droplet-001", hostname: "droplet", hardwareRev: "rev-b", lastSeen: "2026-09-30T00:00:00.000Z" },
    ]);
    expect(Object.keys(res.body[0])).not.toContain("ip");
    expect(Object.keys(res.body[0])).not.toContain("networkMode");
    expect(JSON.stringify(res.body)).not.toMatch(/192\.168|dhcp/);
  });

  it("a column added to the row later is withheld from a member until someone decides otherwise", async () => {
    listDevices.mockResolvedValue([{ ...ROW, wanIp: "203.0.113.9", serial: "SN-1" }]);
    const res = await request(appAs("family")).get("/api/devices");
    expect(Object.keys(res.body[0]).sort()).toEqual(["deviceId", "hardwareRev", "hostname", "id", "lastSeen"]);
    const operator = await request(appAs("admin")).get("/api/devices");
    expect(operator.body[0].wanIp).toBe("203.0.113.9");
  });
});
