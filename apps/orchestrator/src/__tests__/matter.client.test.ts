/**
 * WARP-850 — orchestrator-side matter-controller sidecar client.
 *
 * The matter.js CommissioningController moved into the host-network
 * services/matter-controller sidecar; matter.service.ts kept its module
 * path and export surface but is now an HTTP client. These tests pin
 * the client behaviors the extraction must preserve:
 *
 *  1. every call carries the X-Droplet-Auth shared token
 *     (device-bridge precedent, token from DROPLET_MATTER_SERVICE_TOKEN);
 *  2. sidecar error bodies ({ errorClass, errorMessage }) are
 *     reconstructed into local Errors with the RAW matter.js message,
 *     so translateCommissionError() and the WARP-851 mappings keep
 *     working unchanged;
 *  3. getMatterCapabilities proxies the sidecar's real state and
 *     degrades to bleCommissioning=false when the sidecar is down;
 *  4. the WARP-456 signed ActivityRow wrappers stay orchestrator-side;
 *  5. init/health reachability drives isMatterInitialized();
 *  6. the SSE event bridge re-emits sidecar events through
 *     subscribeStateChanges/subscribeConnectionChanges.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    DROPLET_MATTER_SERVICE_URL: "http://sidecar.test:8083",
    DROPLET_MATTER_SERVICE_TOKEN: "tok-warp-850",
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  initMatterService,
  shutdownMatterService,
  isMatterInitialized,
  getMatterCapabilities,
  getCommissionedDevices,
  commissionDevice,
  decommissionDevice,
  sendMatterCommand,
  discoverDevices,
  subscribeStateChanges,
  subscribeConnectionChanges,
} from "../services/matter.service.js";

// WARP-1010: the emitters now take a required actor; these contract tests
// pass the AI surface and don't assert on it (attribution has its own tests).
const AI_ACTOR = { type: "ai", id: null } as const;

const RAW_DISCOVERY_MESSAGE =
  'No device discovered using identifier {"shortDiscriminator":7}! Please check that the relevant device is online.';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An /events SSE stream that stays open until the test ends. */
function openEventStream(frames: string[] = []): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(`data: {"type":"connected"}\n\n`));
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      // Leave the stream open — the bridge holds it like a live SSE.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function installFetchMock(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
) {
  const mock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (u.includes(suffix)) return handler(init);
    }
    throw new Error(`fetch mock: unrouted URL ${u}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(async () => {
  await shutdownMatterService();
  vi.unstubAllGlobals();
  recordActivityMock.mockClear();
});

describe("auth header (X-Droplet-Auth)", () => {
  it("presents the shared token on every data call", async () => {
    const mock = installFetchMock({
      "/devices": () =>
        jsonResponse({
          lights: [], switches: [], sensors: [], climate: [],
          media: [], covers: [], locks: [], other: [],
        }),
    });
    await getCommissionedDevices();
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe("http://sidecar.test:8083/devices");
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe(
      "tok-warp-850",
    );
  });
});

describe("error pass-through (WARP-851 contract)", () => {
  it("rethrows the sidecar's raw matter.js message and class name", async () => {
    installFetchMock({
      "/commission": () =>
        jsonResponse(
          {
            error: RAW_DISCOVERY_MESSAGE,
            errorClass: "CommissionableDeviceDiscoveryFailedError",
            errorMessage: RAW_DISCOVERY_MESSAGE,
          },
          500,
        ),
    });
    let thrown: Error | null = null;
    await commissionDevice("1602-004-8090", AI_ACTOR).catch((err) => (thrown = err));
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toBe(RAW_DISCOVERY_MESSAGE);
    expect(thrown!.name).toBe("CommissionableDeviceDiscoveryFailedError");
  });

  it("falls back to a status-bearing message when the sidecar body is not JSON", async () => {
    installFetchMock({
      "/commission": () => new Response("boom", { status: 502 }),
    });
    await expect(commissionDevice("34970112332", AI_ACTOR)).rejects.toThrow(/502/);
  });
});

describe("getMatterCapabilities — sidecar proxy", () => {
  it("passes through the sidecar's real BLE state", async () => {
    installFetchMock({
      "/capabilities": () =>
        jsonResponse({
          bleCommissioning: true,
          reason: "BLE commissioning enabled on hci0",
        }),
    });
    expect(await getMatterCapabilities()).toEqual({
      bleCommissioning: true,
      wifiProvisioning: false,
      apSsid: null,
    });
  });

  it("degrades to all-false when the sidecar is unreachable", async () => {
    installFetchMock({
      "/capabilities": () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(await getMatterCapabilities()).toEqual({
      bleCommissioning: false,
      wifiProvisioning: false,
      apSsid: null,
    });
  });
});

describe("WARP-456 activity wrappers stay orchestrator-side", () => {
  it("records a smart_home activity row on successful commission, attributed to the passed actor (WARP-1010)", async () => {
    installFetchMock({
      "/commission": () => jsonResponse({ nodeId: "7" }),
    });
    const result = await commissionDevice("34970112332", {
      type: "user",
      id: "u-1",
    });
    expect(result).toEqual({ nodeId: "7" });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "smart_home",
        what: "Commissioned Matter device",
        actor: { type: "user", id: "u-1" },
      }),
    );
  });

  it("records a warn row on decommission with the caller's actor", async () => {
    installFetchMock({
      "/devices/7": () => jsonResponse({ status: "decommissioned", nodeId: "7" }),
    });
    await decommissionDevice("7", { type: "user", id: "u-1" });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "smart_home",
        severity: "warn",
        what: "Decommissioned Matter device",
        actor: { type: "user", id: "u-1" },
      }),
    );
  });

  it("records success and failure rows for commands, preserving an ai actor", async () => {
    installFetchMock({
      "/devices/7/command": () => jsonResponse({ status: "ok" }),
    });
    await sendMatterCommand("7", "turn_on", { type: "ai", id: null });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "ok",
        what: "Matter turn_on",
        actor: { type: "ai", id: null },
      }),
    );

    recordActivityMock.mockClear();
    installFetchMock({
      "/devices/7/command": () =>
        jsonResponse(
          {
            error: "Device 7 is not connected",
            errorClass: "Error",
            errorMessage: "Device 7 is not connected",
          },
          500,
        ),
    });
    await expect(
      sendMatterCommand("7", "turn_on", { type: "ai", id: null }),
    ).rejects.toThrow(/not connected/);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "err",
        what: "Matter turn_on failed",
        actor: { type: "ai", id: null },
      }),
    );
  });
});

describe("audit failures never change a Matter operation's outcome (pr-reviewer findings 1-3)", () => {
  it("commission still succeeds when the audit row write throws", async () => {
    // The sidecar already commissioned the device — a Prisma hiccup
    // here must not surface as a false 500 (retry would then hit
    // "already commissioned" and the device looks orphaned).
    installFetchMock({
      "/commission": () => jsonResponse({ nodeId: "7" }),
    });
    recordActivityMock.mockRejectedValueOnce(new Error("prisma down"));
    await expect(commissionDevice("34970112332", AI_ACTOR)).resolves.toEqual({
      nodeId: "7",
    });
  });

  it("decommission still succeeds when the audit row write throws", async () => {
    installFetchMock({
      "/devices/7": () =>
        jsonResponse({ status: "decommissioned", nodeId: "7" }),
    });
    recordActivityMock.mockRejectedValueOnce(new Error("prisma down"));
    await expect(decommissionDevice("7", AI_ACTOR)).resolves.toBe(true);
  });

  it("a failing audit row in the command finally block does not mask the matter.js error", async () => {
    // finally-block semantics: a throw there REPLACES the in-flight
    // error — the client must still see the translatable matter error,
    // never the Prisma one.
    installFetchMock({
      "/devices/7/command": () =>
        jsonResponse(
          {
            error: "Device 7 is not connected",
            errorClass: "Error",
            errorMessage: "Device 7 is not connected",
          },
          500,
        ),
    });
    recordActivityMock.mockRejectedValueOnce(new Error("prisma down"));
    await expect(sendMatterCommand("7", "turn_on", AI_ACTOR)).rejects.toThrow(
      /not connected/,
    );
  });

  it("command success survives a failing audit row", async () => {
    installFetchMock({
      "/devices/7/command": () => jsonResponse({ status: "ok" }),
    });
    recordActivityMock.mockRejectedValueOnce(new Error("prisma down"));
    await expect(sendMatterCommand("7", "turn_on", AI_ACTOR)).resolves.toEqual({
      status: "ok",
    });
  });

  it("decommission maps the sidecar's 404 to false without writing an audit row", async () => {
    // Mirrors getDevice's null contract — the route layer turns false
    // into its own 404 (pr-reviewer finding 4 companion).
    installFetchMock({
      "/devices/7": () =>
        jsonResponse(
          {
            error: "Device not found",
            errorClass: "NotFoundError",
            errorMessage: "Device not found",
          },
          404,
        ),
    });
    await expect(decommissionDevice("7", AI_ACTOR)).resolves.toBe(false);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe("init / health / events bridge", () => {
  beforeEach(() => {
    expect(isMatterInitialized()).toBe(false);
  });

  it("initMatterService resolves and flips isMatterInitialized when the sidecar is healthy", async () => {
    installFetchMock({
      "/health": () => jsonResponse({ ok: true, initialized: true }),
      "/events": () => openEventStream(),
    });
    await initMatterService();
    expect(isMatterInitialized()).toBe(true);
  });

  it("initMatterService rejects (non-fatal at boot) when the sidecar is down", async () => {
    installFetchMock({
      "/health": () => {
        throw new Error("ECONNREFUSED");
      },
      "/events": () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(initMatterService()).rejects.toThrow();
    expect(isMatterInitialized()).toBe(false);
  });

  it("surfaces a sidecar whose own controller failed init as not-initialized", async () => {
    installFetchMock({
      "/health": () => jsonResponse({ ok: true, initialized: false }),
      "/events": () => openEventStream(),
    });
    await expect(initMatterService()).rejects.toThrow(/not initialized/i);
    expect(isMatterInitialized()).toBe(false);
  });

  it("re-emits sidecar SSE frames through the local subscribe API", async () => {
    installFetchMock({
      "/health": () => jsonResponse({ ok: true, initialized: true }),
      "/events": () =>
        openEventStream([
          `data: {"type":"state_changed","nodeId":"7","path":"1/onOff/onOff","value":false}\n\n`,
          `data: {"type":"connection_changed","nodeId":"7","connectionState":1}\n\n`,
        ]),
    });

    const stateEvents: unknown[] = [];
    const connEvents: unknown[] = [];
    const unsubState = subscribeStateChanges((e) => stateEvents.push(e));
    const unsubConn = subscribeConnectionChanges((e) => connEvents.push(e));

    await initMatterService();
    // Bridge consumes the stream asynchronously — give it a beat.
    await vi.waitFor(() => {
      expect(stateEvents).toHaveLength(1);
      expect(connEvents).toHaveLength(1);
    });

    expect(stateEvents[0]).toEqual({
      nodeId: "7",
      path: "1/onOff/onOff",
      value: false,
    });
    expect(connEvents[0]).toEqual({ nodeId: "7", connectionState: 1 });

    unsubState();
    unsubConn();
  });

  it("passes the discovery timeout through to the sidecar", async () => {
    const mock = installFetchMock({
      "/discover": () => jsonResponse({ devices: [], count: 0 }),
    });
    await discoverDevices(20_000);
    expect(String(mock.mock.calls[0][0])).toContain("timeout=20000");
  });
});
