import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
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

describe("GET /api/health", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("includes version string", async () => {
    const res = await request(app).get("/api/health");
    expect(res.body.version).toBe("0.1.0");
  });

  it("includes service health fields", async () => {
    const res = await request(app).get("/api/health");
    expect(res.body.services).toHaveProperty("db");
    expect(res.body.services).toHaveProperty("redis");
    expect(res.body.services).toHaveProperty("aiGateway");
  });

  it("reports uptime as a number", async () => {
    const res = await request(app).get("/api/health");
    expect(typeof res.body.uptime).toBe("number");
    expect(res.body.uptime).toBeGreaterThanOrEqual(0);
  });
});

/**
 * WARP-1926 — /api/health names the inference runtime.
 *
 * The dashboard had no way to learn which engine a box serves from, so
 * Settings hardcoded "Ollama (on-device)" and every Docker-Model-Runner box
 * (the shipped default since WARP-1870) misreported itself to its owner.
 */
describe("GET /api/health — inferenceRuntime (WARP-1926)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  it("reports dmr when INFERENCE_RUNTIME=dmr", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "dmr");
    const res = await request(app).get("/api/health");
    expect(res.body.inferenceRuntime).toBe("dmr");
    vi.unstubAllEnvs();
  });

  it("reports ollama when INFERENCE_RUNTIME=ollama", async () => {
    vi.stubEnv("INFERENCE_RUNTIME", "ollama");
    const res = await request(app).get("/api/health");
    expect(res.body.inferenceRuntime).toBe("ollama");
    vi.unstubAllEnvs();
  });

  it("is always present — an absent field would silently degrade the label", async () => {
    const res = await request(app).get("/api/health");
    expect(res.body).toHaveProperty("inferenceRuntime");
    expect(["dmr", "ollama"]).toContain(res.body.inferenceRuntime);
  });
});
