/**
 * WARP-3097 — every /api response is `Cache-Control: no-store` by default.
 *
 * `private, max-age` still lets the client's own cache keep the body, and
 * Apple's URLCache or a browser disk cache writes it to disk: Wi-Fi passwords,
 * keys, company data and camera footage at rest after sign-out. The default is
 * set in app.ts ahead of every /api router, so this drives the real app.
 *
 * Unauthenticated requests are enough to prove the composition: the header is
 * set before auth runs, so it rides the 401 too. That a HANDLER does not
 * loosen it again is pinned per route (the route tests assert no override, the
 * camera footage routes assert `private, no-store` in cameras-view-gate).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, AUTH_ENABLED: true } };
});
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

import { createApp } from "../app.js";

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  app = createApp(new PrismaClient());
});

describe("every /api response is no-store (WARP-3097)", () => {
  it.each([
    // Wi-Fi and guest passwords
    "/api/network/wifi/current",
    "/api/network/wifi/guest",
    "/api/network/wifi/ap",
    // company data listings
    "/api/network/devices",
    "/api/files",
    // camera footage
    "/api/cameras/front/snapshot",
    "/api/cameras/events/abc/thumbnail",
    // unknown path — the 404 carries it too
    "/api/definitely-not-a-route",
  ])("GET %s answers no-store", async (path) => {
    const res = await request(app).get(path);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("a public /api route answers no-store as well", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
