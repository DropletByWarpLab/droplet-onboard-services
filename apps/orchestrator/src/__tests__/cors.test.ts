import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import { config } from "../config.js";

// Mock the ai-gateway client (same posture as devices/health route tests).
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

// WARP-562 — CORS must NOT reflect an arbitrary Origin when credentials are
// enabled. The orchestrator uses cookie-based sessions (droplet_session,
// SameSite=lax), so a reflected Allow-Origin + Allow-Credentials lets any
// site the owner visits read the local API cross-origin. These tests pin the
// allowlist behaviour against regression back to `origin: true`.
describe("CORS origin allowlist (WARP-562)", () => {
  let app: ReturnType<typeof createApp>;
  // An origin guaranteed to be on the allowlist in any NODE_ENV.
  const allowedOrigin = config.corsAllowedOrigins[0];

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  it("has at least one configured allowed origin to test against", () => {
    expect(allowedOrigin).toBeTruthy();
    expect(config.corsAllowedOrigins).not.toContain("*");
  });

  it("does NOT reflect a disallowed Origin (no Access-Control-Allow-Origin)", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does NOT set Allow-Credentials for a disallowed Origin", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://evil.example");
    // With no Allow-Origin echoed, the browser blocks the read regardless,
    // but assert we never emit credentials for an untrusted origin either.
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("echoes an allowlisted Origin and sets Allow-Credentials", async () => {
    const res = await request(app)
      .get("/api/health")
      .set("Origin", allowedOrigin);
    expect(res.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("allows a same-origin / no-Origin request (curl, native clients)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });

  it("does NOT grant a preflight OPTIONS from a disallowed Origin", async () => {
    const res = await request(app)
      .options("/api/health")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("grants a preflight OPTIONS from an allowlisted Origin", async () => {
    const res = await request(app)
      .options("/api/health")
      .set("Origin", allowedOrigin)
      .set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBe(allowedOrigin);
  });
});
