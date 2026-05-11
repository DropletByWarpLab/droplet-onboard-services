/**
 * WARP-230 — integration tests for the admin device-identity routes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

import { createAdminDeviceIdentityRouter } from "../routes/admin-device-identity.js";
import type { DeviceIdentityClient } from "../services/device-identity.client.js";

interface FakeUser {
  username: string;
  role: string;
  lastMfaAt?: Date | string | null;
}

function buildApp(opts: {
  user?: FakeUser;
  client: DeviceIdentityClient;
}) {
  const app = express();
  app.use(express.json());
  // Inject the test user before the router so the routes see a populated
  // (or unpopulated) req.user.
  app.use((req, _res, next) => {
    (req as unknown as { user?: FakeUser }).user = opts.user;
    next();
  });
  app.use("/api", createAdminDeviceIdentityRouter(opts.client));
  return app;
}

describe("admin-device-identity routes", () => {
  let mockClient: DeviceIdentityClient;
  beforeEach(() => {
    mockClient = {
      getDeviceIdentityStatus: vi.fn(async () => ({
        provisioned: true,
        backend: "mock" as const,
        certSubject: "CN=droplet",
        certFingerprint: "sha256:abc",
        certExpiresAt: "2031-05-11T00:00:00Z",
        sealingPcrs: [0, 2, 4, 7],
        sealValid: true,
        lastResealAt: "",
        currentPcrSnapshot: {},
      })),
      signWithDeviceKey: vi.fn(),
      getDeviceCert: vi.fn(),
      requestReseal: vi.fn(async () => ({
        resealed: true,
        sealedAt: "2026-05-11T03:00:00Z",
        newPcrSnapshotIndices: [0, 2, 4, 7],
      })),
    } as unknown as DeviceIdentityClient;
  });

  it("GET /status returns 401 when no user", async () => {
    const app = buildApp({ user: undefined, client: mockClient });
    const res = await request(app).get("/api/admin/device-identity/status");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("auth_required");
  });

  it("GET /status returns 403 when user is not admin", async () => {
    const app = buildApp({
      user: { username: "bob", role: "family", lastMfaAt: new Date() },
      client: mockClient,
    });
    const res = await request(app).get("/api/admin/device-identity/status");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin_required");
  });

  it("GET /status returns the structured payload for an admin", async () => {
    const app = buildApp({
      user: { username: "alice", role: "admin", lastMfaAt: new Date() },
      client: mockClient,
    });
    const res = await request(app).get("/api/admin/device-identity/status");
    expect(res.status).toBe(200);
    expect(res.body.provisioned).toBe(true);
    expect(res.body.sealingPcrs).toEqual([0, 2, 4, 7]);
  });

  it("GET /status also accepts the codebase's 'owner' role", async () => {
    const app = buildApp({
      user: { username: "alice", role: "owner", lastMfaAt: new Date() },
      client: mockClient,
    });
    const res = await request(app).get("/api/admin/device-identity/status");
    expect(res.status).toBe(200);
  });

  it("GET /status returns 503 when the sidecar gRPC client throws", async () => {
    const failing = {
      ...mockClient,
      getDeviceIdentityStatus: vi.fn(async () => {
        throw new Error("UNAVAILABLE");
      }),
    } as unknown as DeviceIdentityClient;
    const app = buildApp({
      user: { username: "alice", role: "admin", lastMfaAt: new Date() },
      client: failing,
    });
    const res = await request(app).get("/api/admin/device-identity/status");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("device_identity_svc_unreachable");
  });

  it("POST /reseal returns 401 without MFA in last 60s", async () => {
    const app = buildApp({
      user: {
        username: "alice",
        role: "admin",
        lastMfaAt: new Date(Date.now() - 120_000),
      },
      client: mockClient,
    });
    const res = await request(app).post("/api/admin/device-identity/reseal");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("mfa_stale");
  });

  it("POST /reseal returns 401 mfa_required when lastMfaAt is null", async () => {
    const app = buildApp({
      user: { username: "alice", role: "admin", lastMfaAt: null },
      client: mockClient,
    });
    const res = await request(app).post("/api/admin/device-identity/reseal");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("mfa_required");
  });

  it("POST /reseal returns 403 when user is not admin", async () => {
    const app = buildApp({
      user: { username: "bob", role: "family", lastMfaAt: new Date() },
      client: mockClient,
    });
    const res = await request(app).post("/api/admin/device-identity/reseal");
    expect(res.status).toBe(403);
  });

  it("POST /reseal succeeds with admin + recent MFA", async () => {
    const app = buildApp({
      user: { username: "alice", role: "admin", lastMfaAt: new Date() },
      client: mockClient,
    });
    const res = await request(app).post("/api/admin/device-identity/reseal");
    expect(res.status).toBe(200);
    expect(res.body.resealed).toBe(true);
    expect(mockClient.requestReseal).toHaveBeenCalled();
    // Nonce passed to the sidecar must be a non-empty string.
    const arg = (mockClient.requestReseal as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(typeof arg).toBe("string");
    expect(arg.length).toBeGreaterThan(0);
  });

  it("POST /reseal returns 503 when the sidecar gRPC client throws", async () => {
    const failing = {
      ...mockClient,
      requestReseal: vi.fn(async () => {
        throw new Error("UNAVAILABLE");
      }),
    } as unknown as DeviceIdentityClient;
    const app = buildApp({
      user: { username: "alice", role: "admin", lastMfaAt: new Date() },
      client: failing,
    });
    const res = await request(app).post("/api/admin/device-identity/reseal");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("device_identity_svc_unreachable");
  });
});
