import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";

// #651 activated app-level scope/RBAC enforcement; with AUTH_ENABLED at its
// real default (true) a tokenless supertest request now 401s before reaching
// the route, so this read-only smoke test must disable auth — the same way the
// sibling full-createApp tests (device-clients.test.ts) do. The mock must carry
// every field createApp derefs at module scope, hence the full set below.
vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    FRIGATE_URL: "http://frigate:5000",
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  },
}));

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
