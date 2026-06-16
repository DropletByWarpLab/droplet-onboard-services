/**
 * WARP (SCIM directory sync) — dedicated SCIM provisioning-bearer middleware.
 *
 * SCIM's trust boundary is SEPARATE from the human session + the
 * SERVICE_TOKEN_* service principals:
 *   - it authenticates with one dedicated secret (DROPLET_SCIM_BEARER_TOKEN),
 *   - validated constant-time (timingSafeEqual) on EVERY request,
 *   - FAIL CLOSED when the secret is unset (an un-provisioned appliance must
 *     reject every /scim/v2/* call, never accept an empty bearer),
 *   - rejections render the SCIM Error envelope with a 401 status,
 *   - the token is NEVER logged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockConfig: Record<string, unknown> = { DROPLET_SCIM_BEARER_TOKEN: "scim-secret-token" };
vi.mock("../config.js", () => ({
  get config() {
    return mockConfig;
  },
}));

import { scimAuthMiddleware } from "./scim-auth.js";
import { SCIM_ERROR_SCHEMA } from "../services/scim-resource.js";

function appWithGuard() {
  const app = express();
  app.use(express.json());
  app.use("/scim/v2", scimAuthMiddleware);
  app.get("/scim/v2/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  for (const k of Object.keys(mockConfig)) delete mockConfig[k];
  mockConfig.DROPLET_SCIM_BEARER_TOKEN = "scim-secret-token";
});

describe("scimAuthMiddleware", () => {
  it("allows a request bearing the configured token", async () => {
    const res = await request(appWithGuard())
      .get("/scim/v2/ping")
      .set("Authorization", "Bearer scim-secret-token");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects a missing Authorization header with 401 + SCIM error envelope", async () => {
    const res = await request(appWithGuard()).get("/scim/v2/ping");
    expect(res.status).toBe(401);
    expect(res.body.schemas).toEqual([SCIM_ERROR_SCHEMA]);
    expect(res.body.status).toBe("401");
  });

  it("rejects a wrong token with 401", async () => {
    const res = await request(appWithGuard())
      .get("/scim/v2/ping")
      .set("Authorization", "Bearer not-the-token");
    expect(res.status).toBe(401);
  });

  it("rejects a non-Bearer scheme with 401", async () => {
    const res = await request(appWithGuard())
      .get("/scim/v2/ping")
      .set("Authorization", "Basic c2NpbTpzY2lt");
    expect(res.status).toBe(401);
  });

  it("FAILS CLOSED when the SCIM token is unset — every request 401s, even an empty bearer", async () => {
    mockConfig.DROPLET_SCIM_BEARER_TOKEN = "";
    const withEmpty = await request(appWithGuard())
      .get("/scim/v2/ping")
      .set("Authorization", "Bearer ");
    expect(withEmpty.status).toBe(401);
    const withAnything = await request(appWithGuard())
      .get("/scim/v2/ping")
      .set("Authorization", "Bearer anything");
    expect(withAnything.status).toBe(401);
  });

  it("does not leak the token in the response body on rejection", async () => {
    const res = await request(appWithGuard())
      .get("/scim/v2/ping")
      .set("Authorization", "Bearer wrong");
    expect(JSON.stringify(res.body)).not.toContain("scim-secret-token");
  });
});
