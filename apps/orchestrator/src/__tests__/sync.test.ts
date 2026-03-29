import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import * as path from "node:path";
import * as os from "node:os";
import * as fsp from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
import { initFileService } from "../services/file.service.js";
import { initDeviceService } from "../services/device.service.js";

// Mock the ai-gateway client
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

const TEST_FILES_ROOT = path.join(os.tmpdir(), "droplet-sync-test");

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    FILES_ROOT: path.join(os.tmpdir(), "droplet-sync-test"),
    MAX_UPLOAD_SIZE_MB: 10,
  },
}));

describe("Sync Target Routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await fsp.mkdir(TEST_FILES_ROOT, { recursive: true });
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    initFileService(prisma);
    app = createApp(prisma);
  });

  describe("GET /api/sync/targets", () => {
    it("returns an array", async () => {
      const res = await request(app).get("/api/sync/targets");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe("POST /api/sync/targets", () => {
    it("creates a sync target", async () => {
      await fsp.mkdir(path.join(TEST_FILES_ROOT, "docs"), { recursive: true });

      const res = await request(app)
        .post("/api/sync/targets")
        .send({ path: "/docs", label: "Documents", intervalMin: 15 });

      expect(res.status).toBe(201);
      expect(res.body.label).toBe("Documents");
      expect(res.body.path).toBe("/docs");
      expect(res.body.intervalMin).toBe(15);
      expect(res.body.id).toBeDefined();
    });

    it("returns 400 for missing fields", async () => {
      const res = await request(app)
        .post("/api/sync/targets")
        .send({ path: "/docs" }); // missing label
      expect(res.status).toBe(400);
    });

    it("returns 400 for path traversal", async () => {
      const res = await request(app)
        .post("/api/sync/targets")
        .send({ path: "/../../../etc", label: "Evil" });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/sync/trigger", () => {
    it("returns 400 for missing targetId", async () => {
      const res = await request(app).post("/api/sync/trigger").send({});
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid UUID", async () => {
      const res = await request(app)
        .post("/api/sync/trigger")
        .send({ targetId: "not-a-uuid" });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/sync/status", () => {
    it("returns targets array", async () => {
      const res = await request(app).get("/api/sync/status");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("targets");
      expect(Array.isArray(res.body.targets)).toBe(true);
    });
  });
});
