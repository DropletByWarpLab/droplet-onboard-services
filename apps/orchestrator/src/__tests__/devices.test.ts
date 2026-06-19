import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

// GET /api/devices is an authenticated route, and `config.AUTH_ENABLED`
// now defaults to ON (WARP-580: `resolveAuthEnabled` only disables auth on
// an EXPLICIT `AUTH_ENABLED=false` in a non-production env). This unit test
// exercises the device router itself, not the auth pipeline, so it runs with
// auth disabled — `authMiddleware` then injects a dev `owner` session and the
// request reaches the handler. Spread the real config so every field the full
// app derefs at module load stays present; flip only AUTH_ENABLED.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, AUTH_ENABLED: false } };
});

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

describe("GET /api/devices", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  it("returns 200 with an array of devices", async () => {
    const res = await request(app).get("/api/devices");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("includes the seeded device", async () => {
    const res = await request(app).get("/api/devices");
    expect(res.body.length).toBeGreaterThan(0);
    const device = res.body[0];
    expect(device).toHaveProperty("deviceId");
    expect(device).toHaveProperty("hostname");
    expect(device).toHaveProperty("hardwareRev");
  });

  it("device has expected fields", async () => {
    const res = await request(app).get("/api/devices");
    const device = res.body[0];
    expect(device.deviceId).toBe("droplet-dev-001");
    expect(device.hostname).toBe("droplet-dev");
    expect(device.networkMode).toBe("dhcp");
    expect(device.ip).toBe("192.168.1.100");
  });
});
