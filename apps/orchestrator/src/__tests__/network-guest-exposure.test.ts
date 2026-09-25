/**
 * WARP-3091 / WARP-3092 — what the Network API shows to whom, and what a
 * device block leaves behind.
 *
 *  - No role ever reads the Wi-Fi passphrase off `GET /network/status`
 *    (`status.wireless`) or `GET /network/wifi`; the latter is owner/admin.
 *  - The device roster (`/network/devices`, `/:mac`, `/events`, DHCP leases)
 *    is for employees: owner/admin/family, never an external guest.
 *  - WARP-3118: groups, schedules, overrides and schedule events name staff
 *    devices too, so they follow the same owner/admin/family floor.
 *  - `manualBlock` writes an activity row with actor, MAC, old and new state.
 *  - `GET /network/audit?userId=` for someone else is owner/admin only.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

const { cache, recordActivityMock, auditLogMock } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  recordActivityMock: vi.fn().mockResolvedValue(null),
  auditLogMock: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(async (key: string) => cache.get(key)),
  cacheSet: vi.fn(async (key: string, value: unknown) => {
    cache.set(key, value);
  }),
  cacheDel: vi.fn(async (key: string) => {
    cache.delete(key);
  }),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => recordActivityMock(...a),
}));

vi.mock("../services/network-safety.service.js", async () => {
  const actual = await vi.importActual<object>("../services/network-safety.service.js");
  return { ...actual, getNetworkAuditLog: auditLogMock };
});

import * as openwrt from "../services/openwrt.client.js";
import { stripWirelessSecrets } from "../services/network.service.js";
import { registerWifiRoutes } from "../routes/network-wifi.routes.js";
import { registerStatusRoutes } from "../routes/network-status.routes.js";
import { registerDeviceRoutes } from "../routes/network-devices.routes.js";
import { registerScheduleRoutes } from "../routes/network-schedules.routes.js";
import type { AuthUser } from "../middleware/auth.js";

const PSK = "correct-horse-battery-staple";

/** A router wireless status with the passphrase in every shape OpenWrt uses. */
const WIRELESS = {
  radio0: {
    up: true,
    config: { channel: "6", htmode: "HE20" },
    interfaces: [
      {
        section: "default_radio0",
        ifname: "phy0-ap0",
        config: {
          mode: "ap",
          ssid: "Workspace",
          encryption: "psk2+ccmp",
          key: PSK,
          psk: PSK,
          psk2: PSK,
          sae_password: PSK,
          wpa_passphrase: PSK,
          auth_secret: PSK,
          nested: { deeper: [{ password: PSK, wep_key1: PSK }] },
        },
      },
    ],
  },
};

const DEVICE = { mac: "AA:BB:CC:DD:EE:01", displayName: "Stefan's laptop" };

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const role = (req.header("x-test-role") ?? "owner") as AuthUser["role"];
    const id = req.header("x-test-user") ?? `u-${role}`;
    (req as Request & { user: AuthUser }).user = {
      id,
      username: id,
      displayName: id,
      role,
    };
    next();
  });
  const router = express.Router();
  const prisma = { apDevice: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaClient;
  const networkDeviceService = {
    listDevices: vi.fn().mockResolvedValue([DEVICE]),
    getDevice: vi.fn().mockResolvedValue(DEVICE),
    listGroups: vi.fn().mockResolvedValue([{ id: "g1", name: "Staff", members: [DEVICE] }]),
  };
  const scheduleApi = {
    setManualBlock: vi.fn(async (mac: string, blocked: boolean) => ({
      mac,
      manualBlock: blocked,
      previousManualBlock: !blocked,
    })),
    listSchedules: vi.fn().mockResolvedValue([{ id: "s1", deviceMac: DEVICE.mac }]),
    getSchedule: vi.fn().mockResolvedValue({ id: "s1", deviceMac: DEVICE.mac }),
    listOverrides: vi.fn().mockResolvedValue([{ id: "o1", deviceMac: DEVICE.mac }]),
    listScheduleEvents: vi.fn().mockResolvedValue([{ id: "e1", deviceMac: DEVICE.mac }]),
  };
  registerWifiRoutes(router, { prisma });
  registerStatusRoutes(router, { prisma, networkDeviceService } as never);
  registerDeviceRoutes(router, { networkDeviceService } as never);
  registerScheduleRoutes(router, { scheduleApi } as never);
  app.use("/api", router);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  cache.clear();
  vi.spyOn(openwrt, "fetchInterfaces").mockResolvedValue({} as never);
  vi.spyOn(openwrt, "fetchWirelessStatus").mockResolvedValue(WIRELESS as never);
  vi.spyOn(openwrt, "fetchSystemInfo").mockResolvedValue({} as never);
  vi.spyOn(openwrt, "fetchDhcpLeases").mockResolvedValue([
    { mac: DEVICE.mac, hostname: "laptop", ip: "10.0.0.5" },
  ] as never);
  vi.spyOn(openwrt, "healthCheck").mockResolvedValue(true);
});

describe("stripWirelessSecrets", () => {
  it("removes every secret-named key at any depth and keeps the rest", () => {
    const out = stripWirelessSecrets(WIRELESS);
    expect(JSON.stringify(out)).not.toContain(PSK);
    const cfg = out.radio0.interfaces[0].config;
    expect(cfg).toMatchObject({ ssid: "Workspace", encryption: "psk2+ccmp", mode: "ap" });
    expect(out.radio0.config.channel).toBe("6");
    // Pure: the input is untouched.
    expect(WIRELESS.radio0.interfaces[0].config.key).toBe(PSK);
  });
});

describe("GET /api/network/status never carries the Wi-Fi passphrase", () => {
  for (const role of ["owner", "admin", "family", "guest"]) {
    it(`${role}: status.wireless has no secret`, async () => {
      const res = await request(buildApp()).get("/api/network/status").set("x-test-role", role);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(PSK);
      expect(res.body.wireless.radio0.interfaces[0].config.ssid).toBe("Workspace");
    });
  }
});

describe("GET /api/network/wifi", () => {
  it.each(["owner", "admin"])("%s gets radios without the passphrase", async (role) => {
    const res = await request(buildApp()).get("/api/network/wifi").set("x-test-role", role);
    expect(res.status).toBe(200);
    expect(res.body.radio0.config.channel).toBe("6");
    expect(JSON.stringify(res.body)).not.toContain(PSK);
  });

  it.each(["family", "guest"])("%s is refused", async (role) => {
    const res = await request(buildApp()).get("/api/network/wifi").set("x-test-role", role);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(PSK);
  });

  it("the MCP principal (get_wifi_settings) still reads it, stripped", async () => {
    const res = await request(buildApp())
      .get("/api/network/wifi")
      .set("x-test-role", "service")
      .set("x-test-user", "_service:mcp");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(PSK);
  });
});

describe("the device roster is for employees, not guests", () => {
  const paths = [
    "/api/network/devices",
    "/api/network/devices?legacy=1",
    `/api/network/devices/${DEVICE.mac}`,
    "/api/network/dhcp/leases",
  ];

  it.each(paths)("guest gets 403 and no device row on %s", async (path) => {
    const res = await request(buildApp()).get(path).set("x-test-role", "guest");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(DEVICE.mac);
  });

  it("guest cannot open the device-change stream", async () => {
    const res = await request(buildApp())
      .get("/api/network/devices/events")
      .set("x-test-role", "guest");
    expect(res.status).toBe(403);
  });

  it.each(["owner", "admin", "family"])("%s lists devices", async (role) => {
    const res = await request(buildApp()).get("/api/network/devices").set("x-test-role", role);
    expect(res.status).toBe(200);
    expect(res.body.devices[0].mac).toBe(DEVICE.mac);
  });

  it("guest keeps the status read", async () => {
    const res = await request(buildApp()).get("/api/network/status").set("x-test-role", "guest");
    expect(res.status).toBe(200);
  });
});

describe("groups and schedules are for employees, not guests (WARP-3118)", () => {
  const paths = [
    "/api/network/groups",
    "/api/network/schedules",
    "/api/network/schedules/s1",
    "/api/network/overrides",
    "/api/network/overrides?active=1",
    "/api/network/schedule-events",
  ];

  it.each(paths)("guest gets 403 and no device MAC on %s", async (path) => {
    const res = await request(buildApp()).get(path).set("x-test-role", "guest");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(DEVICE.mac);
  });

  for (const role of ["owner", "admin", "family"]) {
    it.each(paths)(`${role} reads %s`, async (path) => {
      const res = await request(buildApp()).get(path).set("x-test-role", role);
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).toContain(DEVICE.mac);
    });
  }

  it("the MCP principal still reads schedules", async () => {
    const res = await request(buildApp())
      .get("/api/network/schedules")
      .set("x-test-role", "service")
      .set("x-test-user", "_service:mcp");
    expect(res.status).toBe(200);
  });
});

describe("POST /api/network/devices/:mac/manualBlock is audited", () => {
  it.each([
    [true, "Device blocked"],
    [false, "Device unblocked"],
  ])("blocked=%s records actor, MAC, old and new state", async (blocked, what) => {
    const res = await request(buildApp())
      .post(`/api/network/devices/${DEVICE.mac}/manualBlock`)
      .set("x-test-role", "admin")
      .set("x-test-user", "u-admin-1")
      .send({ blocked });
    expect(res.status).toBe(200);
    // Response shape unchanged for clients.
    expect(res.body).toEqual({ mac: DEVICE.mac, manualBlock: blocked });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const row = recordActivityMock.mock.calls[0][0];
    expect(row).toMatchObject({
      kind: "network",
      what,
      refs: { deviceId: DEVICE.mac, previousManualBlock: !blocked, manualBlock: blocked },
    });
    expect(row.actor).toMatchObject({ id: "u-admin-1" });
  });
});

describe("GET /api/network/audit?userId=", () => {
  it.each(["family", "guest"])("%s cannot read another user's audit", async (role) => {
    const res = await request(buildApp())
      .get("/api/network/audit?userId=someone-else")
      .set("x-test-role", role);
    expect(res.status).toBe(403);
    expect(auditLogMock).not.toHaveBeenCalled();
  });

  it("a member reads their own audit (explicit or implied userId)", async () => {
    const app = buildApp();
    const own = await request(app)
      .get("/api/network/audit?userId=u-family")
      .set("x-test-role", "family");
    const implied = await request(app).get("/api/network/audit").set("x-test-role", "family");
    expect(own.status).toBe(200);
    expect(implied.status).toBe(200);
    expect(auditLogMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ userId: "u-family" }));
  });

  it.each(["owner", "admin"])("%s reads anyone's audit", async (role) => {
    const res = await request(buildApp())
      .get("/api/network/audit?userId=someone-else")
      .set("x-test-role", role);
    expect(res.status).toBe(200);
    expect(auditLogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "someone-else" }));
  });
});
