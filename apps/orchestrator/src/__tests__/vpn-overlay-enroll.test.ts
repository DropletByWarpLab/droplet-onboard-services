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
  // WARP-1882 removed two cases that used to live here. Both are behaviour
  // changes, not tidying:
  //
  //   * "owner enrolls: delegates to the bridge and returns its result" — the
  //     route no longer returns HQ's raw result. It now provisions the wg0
  //     peer and returns a usable profile, because returning the vouch alone
  //     registered a device that could never build a tunnel.
  //   * "rejects a non-owner caller (owner-JWT gate)" — that gate is gone on
  //     purpose. A family member enrolling their own device is the ordinary
  //     case, and the peer is scoped to them.
  //
  // Both behaviours are covered in vpn-overlay-qr-enroll.test.ts under
  // "sign-in enrollment (WARP-1882)", which has the routing + prisma harness
  // this suite deliberately lacks — it passes `{} as any` for prisma, which is
  // why the old cases could not be updated in place.


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
