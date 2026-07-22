import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

// Mock config BEFORE importing the route (env-validated config would need real
// env). HQ_ISSUANCE_URL is set so the happy path doesn't 503.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    HQ_ISSUANCE_URL: "https://hq.test",
    DROPLET_DEVICE_ID: "droplet-abc",
    ROUTING_MODE: "real",
    ROUTING_SERVICE_URL: "http://routing.test",
    ROUTING_SERVICE_TOKEN: "test-token",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { createVpnRouter } from "../routes/vpn.js";
import { config } from "../config.js";

const VALID_WG_KEY = "A".repeat(43) + "="; // 43 base64 chars + '='
const VALID_PEM =
  "-----BEGIN PUBLIC KEY-----\nMOCKKEYMATERIAL\n-----END PUBLIC KEY-----\n";

function buildApp(overlayEnroll: any, user = { username: "alice", role: "owner" }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: user.username, ...user, displayName: user.username };
    next();
  });
  // prisma is unused by the enroll route; pass a bare stub.
  app.use("/api", createVpnRouter({} as any, { overlayEnroll }));
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "internal" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  (config as any).HQ_ISSUANCE_URL = "https://hq.test";
});

describe("POST /api/vpn/overlay/devices (WARP-1385 Part D)", () => {
  it("owner enrolls: delegates to the box→HQ bridge and returns its result", async () => {
    const overlayEnroll = vi.fn(async () => ({ status: "enrolled", device_ref: "dev-1" }));
    const app = buildApp(overlayEnroll);
    const res = await request(app)
      .post("/api/vpn/overlay/devices")
      .send({ wg_public_key: VALID_WG_KEY, sign_public_key_pem: VALID_PEM, label: "Alice iPhone" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "enrolled", device_ref: "dev-1" });
    // Route maps the snake_case body onto the service input shape verbatim.
    expect(overlayEnroll).toHaveBeenCalledTimes(1);
    expect(overlayEnroll).toHaveBeenCalledWith({
      wgPublicKey: VALID_WG_KEY,
      signPublicKeyPem: VALID_PEM,
      label: "Alice iPhone",
    });
  });

  it("rejects a non-owner caller (owner-JWT gate)", async () => {
    const overlayEnroll = vi.fn(async () => ({ status: "enrolled" }));
    const app = buildApp(overlayEnroll, { username: "bob", role: "family" });
    const res = await request(app)
      .post("/api/vpn/overlay/devices")
      .send({ wg_public_key: VALID_WG_KEY, sign_public_key_pem: VALID_PEM, label: "Bob phone" });
    expect(res.status).toBe(403);
    expect(overlayEnroll).not.toHaveBeenCalled();
  });

  it("400s on a malformed WireGuard public key", async () => {
    const overlayEnroll = vi.fn(async () => ({}));
    const app = buildApp(overlayEnroll);
    const res = await request(app)
      .post("/api/vpn/overlay/devices")
      .send({ wg_public_key: "not-a-key", sign_public_key_pem: VALID_PEM, label: "x" });
    expect(res.status).toBe(400);
    expect(overlayEnroll).not.toHaveBeenCalled();
  });

  it("503s when HQ is not yet configured", async () => {
    (config as any).HQ_ISSUANCE_URL = "";
    const overlayEnroll = vi.fn(async () => ({}));
    const app = buildApp(overlayEnroll);
    const res = await request(app)
      .post("/api/vpn/overlay/devices")
      .send({ wg_public_key: VALID_WG_KEY, sign_public_key_pem: VALID_PEM, label: "x" });
    expect(res.status).toBe(503);
    expect(overlayEnroll).not.toHaveBeenCalled();
  });
});
