/**
 * WARP-850 — sidecar HTTP API tests.
 *
 * Covers the auth wall (X-Droplet-Auth shared token, device-bridge
 * precedent, fail-closed on empty token), the route surface the
 * orchestrator client consumes, the structured error pass-through that
 * keeps translateCommissionError() + the WARP-851 tests working, and
 * the SSE event fan-out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { EventEmitter } from "node:events";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import type { MatterControllerCore } from "../src/controller.js";

const TOKEN = "test-token-32-bytes-aaaaaaaaaaaa";

function fakeCore(overrides: Partial<MatterControllerCore> = {}): MatterControllerCore {
  return {
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    isInitialized: vi.fn().mockReturnValue(true),
    discover: vi.fn().mockResolvedValue([]),
    commission: vi.fn().mockResolvedValue({ nodeId: "7" }),
    decommission: vi.fn().mockResolvedValue(true),
    listDevices: vi.fn().mockResolvedValue({
      lights: [], switches: [], sensors: [], climate: [],
      media: [], covers: [], locks: [], other: [],
    }),
    getDevice: vi.fn().mockResolvedValue(null),
    sendCommand: vi.fn().mockResolvedValue({ status: "ok" }),
    events: new EventEmitter(),
    ...overrides,
  };
}

function buildApp(core: MatterControllerCore, token = TOKEN) {
  return createApp({
    core,
    authToken: token,
    capabilities: { bleCommissioning: true, reason: "BLE commissioning enabled on hci0" },
  });
}

describe("auth wall (X-Droplet-Auth)", () => {
  it("rejects requests without the header", async () => {
    const res = await request(buildApp(fakeCore())).get("/capabilities");
    expect(res.status).toBe(401);
  });

  it("rejects requests with a wrong token", async () => {
    const res = await request(buildApp(fakeCore()))
      .get("/capabilities")
      .set("X-Droplet-Auth", "wrong");
    expect(res.status).toBe(401);
  });

  it("fails CLOSED when no token is configured — even an empty header never matches", async () => {
    const res = await request(buildApp(fakeCore(), ""))
      .get("/capabilities")
      .set("X-Droplet-Auth", "");
    expect(res.status).toBe(401);
  });

  it("accepts the configured token", async () => {
    const res = await request(buildApp(fakeCore()))
      .get("/capabilities")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(200);
  });

  it("leaves /health open for liveness probes", async () => {
    const res = await request(buildApp(fakeCore())).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, initialized: true });
  });
});

describe("GET /capabilities", () => {
  it("reports the process-start BLE registration result", async () => {
    const res = await request(buildApp(fakeCore()))
      .get("/capabilities")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.body).toEqual({
      bleCommissioning: true,
      reason: "BLE commissioning enabled on hci0",
    });
  });

  it("answers even when the controller has not initialized (wizard boots before controller)", async () => {
    const core = fakeCore({ isInitialized: vi.fn().mockReturnValue(false) });
    const res = await request(buildApp(core))
      .get("/capabilities")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(200);
  });
});

describe("commissioning", () => {
  it("commissions with a pairing code", async () => {
    const core = fakeCore();
    const res = await request(buildApp(core))
      .post("/commission")
      .set("X-Droplet-Auth", TOKEN)
      .send({ pairing_code: "34970112332" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodeId: "7" });
    expect(core.commission).toHaveBeenCalledWith("34970112332");
  });

  it("400s on a missing pairing_code", async () => {
    const res = await request(buildApp(fakeCore()))
      .post("/commission")
      .set("X-Droplet-Auth", TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });

  it("passes raw matter.js error class + message through structurally (WARP-851 contract)", async () => {
    class CommissionableDeviceDiscoveryFailedError extends Error {}
    const raw = new CommissionableDeviceDiscoveryFailedError(
      'No device discovered using identifier {"shortDiscriminator":7}! Please check that the relevant device is online.',
    );
    const core = fakeCore({ commission: vi.fn().mockRejectedValue(raw) });
    const res = await request(buildApp(core))
      .post("/commission")
      .set("X-Droplet-Auth", TOKEN)
      .send({ pairing_code: "1602-004-8090" });
    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe("CommissionableDeviceDiscoveryFailedError");
    expect(res.body.errorMessage).toBe(raw.message);
    expect(res.body.error).toBe(raw.message);
  });

  it("503s with a structured body when the controller is not initialized", async () => {
    const core = fakeCore({ isInitialized: vi.fn().mockReturnValue(false) });
    const res = await request(buildApp(core))
      .post("/commission")
      .set("X-Droplet-Auth", TOKEN)
      .send({ pairing_code: "34970112332" });
    expect(res.status).toBe(503);
    expect(res.body.errorMessage).toMatch(/not initialized/i);
  });
});

describe("device routes", () => {
  it("lists grouped devices", async () => {
    const res = await request(buildApp(fakeCore()))
      .get("/devices")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.lights).toEqual([]);
  });

  it("404s for an unknown device", async () => {
    const res = await request(buildApp(fakeCore()))
      .get("/devices/42")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(404);
  });

  it("400s on a malformed nodeId", async () => {
    const res = await request(buildApp(fakeCore()))
      .get("/devices/notanumber")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(400);
  });

  it("dispatches commands and returns the result", async () => {
    const core = fakeCore();
    const res = await request(buildApp(core))
      .post("/devices/7/command")
      .set("X-Droplet-Auth", TOKEN)
      .send({ command: "turn_on", data: { brightness: 50 } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
    expect(core.sendCommand).toHaveBeenCalledWith("7", "turn_on", { brightness: 50 });
  });

  it("decommissions a device", async () => {
    const core = fakeCore();
    const res = await request(buildApp(core))
      .delete("/devices/7")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(200);
    expect(core.decommission).toHaveBeenCalledWith("7");
  });

  it("404s when decommissioning a node that isn't commissioned", async () => {
    // Same contract as GET /devices/:nodeId — uncommissioned is a 404
    // condition, not the untyped getNode throw → 500 it used to be
    // (pr-reviewer finding 4, 2026-06-11).
    const core = fakeCore({
      decommission: vi.fn().mockResolvedValue(false),
    });
    const res = await request(buildApp(core))
      .delete("/devices/7")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(404);
    expect(res.body.errorClass).toBe("NotFoundError");
  });

  it("400s on a 20-digit nodeId above the uint64 ceiling", async () => {
    // /^\d{1,20}$/ alone admits 99999999999999999999 > uint64 max, which
    // blows up inside NodeId() as a 500 (pr-reviewer finding 5).
    const core = fakeCore();
    const res = await request(buildApp(core))
      .get("/devices/99999999999999999999")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(400);
    expect(core.getDevice).not.toHaveBeenCalled();
  });

  it("accepts the exact uint64 maximum as a nodeId", async () => {
    // The ceiling itself (18446744073709551615, 20 digits) is a VALID
    // node id — a 19-digit cap would wrongly reject it.
    const core = fakeCore();
    const res = await request(buildApp(core))
      .get("/devices/18446744073709551615")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(404); // getDevice fake returns null
    expect(core.getDevice).toHaveBeenCalledWith("18446744073709551615");
  });

  it("runs discovery with a clamped timeout", async () => {
    const core = fakeCore();
    const res = await request(buildApp(core))
      .get("/discover?timeout=999999")
      .set("X-Droplet-Auth", TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ devices: [], count: 0 });
    expect(core.discover).toHaveBeenCalledWith(60000);
  });
});

describe("GET /events (SSE)", () => {
  let server: Server;
  let baseUrl: string;
  const core = fakeCore();

  beforeEach(async () => {
    server = createHttpServer(buildApp(core));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("streams controller events as SSE frames", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, {
      headers: { "X-Droplet-Auth": TOKEN },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // First frame: the connected handshake.
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('"type":"connected"');

    core.events.emit("state_changed", {
      nodeId: "7",
      path: "1/onOff/onOff",
      value: false,
    });
    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain('"type":"state_changed"');
    expect(second).toContain('"nodeId":"7"');

    controller.abort();
  });

  it("requires auth like every other data route", async () => {
    const res = await fetch(`${baseUrl}/events`);
    expect(res.status).toBe(401);
    // Drain so the socket releases.
    await res.text();
  });
});
