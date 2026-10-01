/**
 * WARP-3267 — the real app skips its global 100 kb JSON parser for the email
 * ingest route, so a large body is never parsed before auth runs. Driven
 * through createApp, not a hand-built app: an unauthenticated large body gets
 * the auth 401, not the global parser's 413, on every spelling Express routes.
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

describe("email ingest body is parsed only after auth (WARP-3267)", () => {
  const big = JSON.stringify({ pad: "x".repeat(200_000) });

  it.each([
    "/api/email/a1/messages-ingest",
    "/api/email/a1/messages-ingest/",
    "/api/email/a1/Messages-Ingest",
  ])("POST %s unauthenticated with a 200 kb body is 401, not 413", async (path) => {
    const res = await request(app)
      .post(path)
      .set("Content-Type", "application/json")
      .send(big);
    expect(res.status).toBe(401);
  });

  it("any other route still gets the global 100 kb limit", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send(big);
    expect(res.status).toBe(413);
  });
});
