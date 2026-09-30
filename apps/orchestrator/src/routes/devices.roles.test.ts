/**
 * WARP-3378 (Romain, 2026-09-30: an external guest gets nothing of the
 * company's data unless it is shared with them) — `GET /api/devices` answers
 * the box's own Device row: hostname, hardware revision, network mode and IP.
 * It had no role guard, so any signed-in principal read it. A guest is refused;
 * owner, admin and member keep the read (the dashboard's header chip and the
 * Settings card use it).
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

  it.each(["owner", "admin", "family"])("a %s gets the device row", async (role) => {
    const res = await request(appAs(role)).get("/api/devices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([ROW]);
  });
});
