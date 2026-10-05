/**
 * WARP-3038 — on a WebSocket upgrade that carries BOTH a session cookie and a
 * `bearer.<jwt>` subprotocol, the Bearer wins (same rule as authMiddleware).
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
vi.mock("../config.js", () => ({
  config: { corsAllowedOrigins: ["https://droplet-ai.local"] },
}));
vi.mock("./mqtt.service.js", () => ({
  subscribeToTopic: vi.fn(() => () => undefined),
}));

import { attachWsBridge } from "./ws-bridge.service.js";

let server: Server | undefined;

afterEach(async () => {
  vi.clearAllMocks();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function upgrade(opts: { cookie?: string; protocol?: string }): Promise<void> {
  server = createServer();
  attachWsBridge(server);
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws/events`,
      opts.protocol ? [opts.protocol] : [],
      { headers: opts.cookie ? { cookie: opts.cookie } : {} },
    );
    ws.on("open", () => {
      ws.close();
      resolve();
    });
    ws.on("error", () => resolve());
    ws.on("unexpected-response", () => resolve());
  });
}

describe("ws-bridge — WARP-3038 Bearer beats cookie", () => {
  it("validates the Bearer subprotocol token, not the cookie, when both are sent", async () => {
    validateTokenForWs.mockResolvedValue(null);
    await upgrade({ cookie: "droplet_session=bob-jwt", protocol: "bearer.alice-jwt" });
    expect(validateTokenForWs).toHaveBeenCalledWith("alice-jwt");
  });

  it("falls back to the cookie when no Bearer is presented (browser path)", async () => {
    validateTokenForWs.mockResolvedValue(null);
    await upgrade({ cookie: "droplet_session=bob-jwt" });
    expect(validateTokenForWs).toHaveBeenCalledWith("bob-jwt");
  });
});
