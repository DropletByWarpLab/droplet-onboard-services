/**
 * WARP-3612 — an open events socket re-checks its session on every tick and is
 * closed with 4401 once the token, session or user is no longer valid; an
 * upgrade from a foreign Origin is refused with 403.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

const validateTokenForWs = vi.fn();
vi.mock("../middleware/auth.js", () => ({
  SESSION_COOKIE_NAME: "droplet_session",
  validateTokenForWs: (...a: unknown[]) => validateTokenForWs(...a),
}));
vi.mock("./mqtt.service.js", () => ({
  subscribeToTopic: vi.fn(() => () => undefined),
}));
vi.mock("../config.js", () => ({
  config: { corsAllowedOrigins: ["https://droplet-ai.local"] },
}));

import { attachWsBridge } from "./ws-bridge.service.js";

const USER = { id: "u1", username: "alice", displayName: "Alice", role: "family" };
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
  // Clear after closing connections: an accepted socket may have a keepalive
  // revalidation already in flight while the HTTP server is shutting down.
  vi.clearAllMocks();
});

async function connect(headers: Record<string, string>, protocol?: string) {
  server = createServer();
  attachWsBridge(server, { pingIntervalMs: 50 });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return new Promise<{ status: number | "open"; closeCode?: number }>((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws/events`,
      protocol ? [protocol] : [],
      { headers },
    );
    const safetyTimer = setTimeout(() => ws.terminate(), 1000);
    ws.on("open", () => {
      ws.on("close", (code) => {
        clearTimeout(safetyTimer);
        resolve({ status: "open", closeCode: code });
      });
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(safetyTimer);
      resolve({ status: res.statusCode ?? 0 });
    });
    ws.on("error", () => undefined);
  });
}

describe("ws-bridge — WARP-3612 session re-validation", () => {
  it("closes with 4401 once the session is revoked after the upgrade", async () => {
    validateTokenForWs.mockResolvedValueOnce(USER).mockResolvedValue(null);
    const r = await connect({ cookie: "droplet_session=jwt" });
    expect(r).toEqual({ status: "open", closeCode: 4401 });
    // The periodic re-check must not slide the idle window.
    expect(validateTokenForWs).toHaveBeenLastCalledWith("jwt", { touch: false });
  });

  it("stays open while the session remains valid", async () => {
    validateTokenForWs.mockResolvedValue(USER);
    const r = await connect({ cookie: "droplet_session=jwt" });
    expect(r.closeCode).not.toBe(4401);
    expect(validateTokenForWs.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("ws-bridge — WARP-3612 Origin check", () => {
  it("rejects a foreign Origin with 403 before authenticating", async () => {
    validateTokenForWs.mockResolvedValue(USER);
    const r = await connect({ cookie: "droplet_session=jwt", origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(validateTokenForWs).not.toHaveBeenCalled();
  });

  it("accepts an allowlisted Origin", async () => {
    validateTokenForWs.mockResolvedValue(USER);
    const r = await connect({ cookie: "droplet_session=jwt", origin: "https://droplet-ai.local" });
    expect(r.status).toBe("open");
  });

  it("accepts the request's own host as Origin (same-origin)", async () => {
    validateTokenForWs.mockResolvedValue(USER);
    const r = await connect({ cookie: "droplet_session=jwt", origin: "https://127.0.0.1" });
    expect(r.status).toBe("open");
  });

  it("accepts a native client that sends no Origin and uses the bearer subprotocol", async () => {
    validateTokenForWs.mockResolvedValue(USER);
    const r = await connect({}, "bearer.native-jwt");
    expect(r.status).toBe("open");
    expect(validateTokenForWs).toHaveBeenCalledWith("native-jwt");
  });
});
