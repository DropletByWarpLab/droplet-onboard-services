/** Exercise the real application order, including its global body parsers. */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, config: { ...actual.config, AUTH_ENABLED: true } };
});
vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true), listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(), saveKey: vi.fn(), listKeys: vi.fn().mockResolvedValue([]), deleteKey: vi.fn(),
}));
vi.mock("../middleware/request-logger.js", () => ({
  requestLogger: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createApp } from "../app.js";
import { config } from "../config.js";
import { requestLogger } from "../middleware/request-logger.js";
let app: ReturnType<typeof createApp>;
beforeAll(() => { app = createApp(new PrismaClient()); });
beforeEach(() => { vi.mocked(requestLogger).mockClear(); });

describe("hosted-app security at the real app boundary", () => {
  it.each(["/api/workspace", "/API/WORKSPACE"])("rejects a hosted-origin cookie write before parsing its malformed body: %s", async (path) => {
    const res = await request(app).post(path)
      .set("Host", "droplet.example").set("X-Forwarded-Proto", "https")
      .set("Origin", "https://droplet.example:8443").set("Cookie", "droplet_session=invalid")
      .set("Content-Type", "application/json").send("not-json");
    expect(res.status).toBe(403);
  });

  it("a Bearer exemption still reaches normal authentication", async () => {
    const res = await request(app).post("/api/workspace")
      .set("Host", "droplet.example").set("X-Forwarded-Proto", "https")
      .set("Origin", "https://native-client.example").set("Authorization", "Bearer invalid-jwt")
      .send({ name: "Unauthorized app" });
    expect(res.status).toBe(401);
  });

  it.each([
    ["post", "/api/auth/login"],
    ["post", "/api/auth/setup"],
    ["post", "/api/auth/refresh"],
    ["post", "/api/auth/invites/accept/example"],
    ["post", "/api/auth/webauthn/authenticate/options"],
    ["patch", "/api/setup/state"],
    ["post", "/api/setup/claim"],
    ["post", "/api/setup/org"],
  ])("rejects app-origin public writes with an unverified Bearer even if CORS includes the app origin: %s %s", async (method, path) => {
    const origin = "https://droplet.example:8443";
    const previous = config.corsAllowedOrigins;
    try {
      config.corsAllowedOrigins = [...previous, origin];
      const call = method === "patch" ? request(app).patch(path) : request(app).post(path);
      const res = await call.set("Origin", origin).set("Authorization", "Bearer invalid-jwt")
        .set("Cookie", "droplet_session=ambient-session; droplet_refresh=ambient-refresh")
        .set("Content-Type", "application/json").send("not-json");
      // Public auth/setup routers run before authMiddleware. Neither their
      // handlers nor the global body parser may receive this app-origin write.
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "foreign_origin_refused" });
    } finally { config.corsAllowedOrigins = previous; }
  });

  it("rejects direct hosted relay requests before the dashboard JSON parser", async () => {
    const res = await request(app).post("/api/hosted/relay/test/path")
      .set("X-Forwarded-Proto", "https").set("X-Forwarded-Port", "8443")
      .set("Content-Type", "application/json").send("x".repeat(200_000));
    // It cannot become the global parser's 413 or authMiddleware's 401.
    expect(res.status).toBe(404);
  });

  it("keeps app management behind dashboard authentication", async () => {
    expect((await request(app).get("/api/hosted")).status).toBe(401);
    expect((await request(app).post("/api/hosted/test/session").send({})).status).toBe(401);
  });

  it("does not log exchange codes through mixed-case relay routes", async () => {
    const res = await request(app).get("/API/HOSTED/RELAY/test/_droplet/session?code=private-code");
    expect(res.status).toBe(404);
    expect(requestLogger).not.toHaveBeenCalled();
  });

  it.each(["/api/hosted/relay/test/path", "/API/HOSTED/RELAY/test/path"])("dashboard CORS cannot short-circuit hosted relay preflight authentication: %s", async (path) => {
    const res = await request(app).options(path)
      .set("Origin", config.corsAllowedOrigins[0]).set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(404);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
