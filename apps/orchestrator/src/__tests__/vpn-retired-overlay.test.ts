/** Retired enrollment APIs stay absent behind the real authentication gate. */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../config.js", () => ({ config: {
  AUTH_ENABLED: true, NEXTCLOUD_URL: "http://nextcloud.test",
  HQ_ISSUANCE_URL: "https://hq.test", DROPLET_DEVICE_ID: "box",
  ROUTING_SERVICE_URL: "http://routing.test", ROUTING_SERVICE_TOKEN: "test",
} }));
vi.mock("../services/jwt.service.js", () => ({
  verifyAccessToken: (token: string) => token === "owner-test-session" ? {
    sub: "owner", username: "owner", displayName: "Owner", role: "owner",
  } : null,
}));
vi.mock("../services/auth-denylist.service.js", () => ({ isUserDenied: async () => false }));

import { authMiddleware } from "../middleware/auth.js";
import { createVpnRouter } from "../routes/vpn.js";

const RETIRED_ROUTES = [
  ["post", "/api/vpn/overlay/devices"],
  ["post", "/api/vpn/overlay/link-tokens"],
  ["post", "/api/vpn/overlay/devices/by-token"],
  ["get", "/api/vpn/overlay/devices/by-token/id/status"],
  ["get", "/api/vpn/overlay/devices/by-token/id/profile"],
  ["get", "/api/vpn/overlay/pending-enrollments"],
  ["post", "/api/vpn/overlay/pending-enrollments/id/approve"],
  ["post", "/api/vpn/overlay/pending-enrollments/id/deny"],
  ["get", "/api/setup/box-name/check"],
  ["post", "/api/setup/box-name"],
  ["post", "/api/setup/box-name/rename"],
] as const;

function app() {
  const result = express();
  result.use(express.json());
  result.use(authMiddleware);
  // Any attempted fleet enrollment query is a failure, even if it later 404s.
  const prisma = new Proxy({}, { get() { throw new Error("Retired route touched the database"); } });
  result.use("/api", createVpnRouter(prisma as never));
  return result;
}

describe("retired fleet remote access routes", () => {
  it.each(RETIRED_ROUTES)("%s %s no longer bypasses authentication", async (method, route) => {
    const response = await request(app())[method](route);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Missing or invalid authentication");
  });

  it.each(RETIRED_ROUTES)("%s %s is absent for an authenticated owner", async (method, route) => {
    const response = await request(app())[method](route).set("Authorization", "Bearer owner-test-session");
    expect(response.status).toBe(404);
  });
});
