/**
 * GET /api/capabilities (WARP-1154/WARP-1155) — the module-capability probe
 * every authenticated principal may read. Drives the dashboard's Projects
 * nav/route gating, so the contract is pinned here:
 *
 *   - 401 without an authenticated principal.
 *   - 200 { projects: true } for every human role AND the service principal —
 *     the native PM module (ADR-026) ships ON for the single-box product.
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";

import { createCapabilitiesRouter } from "./capabilities.js";

function appWithUser(user?: { role: string }) {
  const app = express();
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: { role: string } }).user = user;
    next();
  });
  app.use("/api", createCapabilitiesRouter());
  return app;
}

describe("GET /api/capabilities", () => {
  it("401s without an authenticated principal", async () => {
    const res = await request(appWithUser(undefined)).get("/api/capabilities");
    expect(res.status).toBe(401);
  });

  it.each(["owner", "admin", "family", "guest", "service"])(
    "answers projects:true for role %s",
    async (role) => {
      const res = await request(appWithUser({ role })).get("/api/capabilities");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ projects: true });
    },
  );

  it("allows brief private caching so the nav doesn't re-probe every mount", async () => {
    const res = await request(appWithUser({ role: "family" })).get(
      "/api/capabilities",
    );
    expect(res.headers["cache-control"]).toBe("private, max-age=30");
  });
});
