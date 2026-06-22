/**
 * ADR-024 Phase 3 — official local UniFi Network API client.
 *
 * The box is a pure API CLIENT to a UniFi Network controller the customer
 * already runs (ADR-024 §"Open decision" Option B — we never bundle or
 * redistribute the controller). All wire detail lives behind the
 * `UniFiNetworkClient` interface so the discovery source + onboarding
 * handler unit-test against a MOCK of it (same pattern the routing service
 * uses with its mock router). These tests pin the concrete HTTP impl's
 * contract: API-key header auth, base URL from config, and the typed-error
 * translation — exactly the seam a real controller validates later.
 *
 * The official-API REST shapes (endpoint paths + body keys) carry a
 * `// VALIDATE against real controller` comment in the impl; they are NOT
 * asserted byte-for-byte here (no controller on this laptop), only that the
 * client speaks API-key auth + classifies failures.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    DROPLET_AP_UNIFI_CONTROLLER_URL: "https://controller.test:8443",
    DROPLET_AP_UNIFI_API_KEY: "test-api-key",
    DROPLET_AP_UNIFI_ENABLED: true,
  },
}));

import {
  createUniFiNetworkClient,
  UniFiClientError,
  type UniFiNetworkClient,
} from "./unifi-network.client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createUniFiNetworkClient — API-key auth + base URL", () => {
  it("sends the API key as a header on every call and targets the configured base URL", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client: UniFiNetworkClient = createUniFiNetworkClient();
    await client.listPendingDevices();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://controller.test:8443");
    const headers = (init as RequestInit).headers as Record<string, string>;
    // Official local API authenticates with an API key in a header, NOT the
    // legacy :8443 login-cookie flow (ADR-024 §3).
    const headerValues = Object.values(headers).join(" ");
    expect(headerValues).toContain("test-api-key");
  });

  it("classifies a non-2xx controller response as a typed UniFiClientError (status preserved)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "unauthorized" }, 401)),
    );
    const client = createUniFiNetworkClient();
    await expect(client.listPendingDevices()).rejects.toBeInstanceOf(
      UniFiClientError,
    );
    await expect(client.listPendingDevices()).rejects.toMatchObject({
      status: 401,
    });
  });

  it("classifies a network-layer throw as a typed UniFiClientError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const client = createUniFiNetworkClient();
    await expect(client.listPendingDevices()).rejects.toBeInstanceOf(
      UniFiClientError,
    );
  });
});

describe("createUniFiNetworkClient — adopt + WLAN push + status + forget", () => {
  it("adoptDevice POSTs the MAC and resolves the controller device_id", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ device_id: "unifi-dev-123", mac: "aa:bb:cc:dd:ee:ff" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createUniFiNetworkClient();
    const result = await client.adoptDevice("AA:BB:CC:DD:EE:FF");

    expect(result.deviceId).toBe("unifi-dev-123");
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    expect(String((init as RequestInit).body)).toContain("AA:BB:CC:DD:EE:FF");
  });

  it("pushWlanConfig POSTs ssid + key for the device", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createUniFiNetworkClient();
    await client.pushWlanConfig({
      mac: "AA:BB:CC:DD:EE:FF",
      ssid: "Droplet",
      key: "longenoughpw",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    const body = String((init as RequestInit).body);
    expect(body).toContain("Droplet");
    expect(body).toContain("longenoughpw");
  });

  it("getDeviceStatus maps the controller state for a MAC", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          { mac: "aa:bb:cc:dd:ee:ff", state: "connected", device_id: "d1" },
        ]),
      ),
    );
    const client = createUniFiNetworkClient();
    const status = await client.getDeviceStatus("AA:BB:CC:DD:EE:FF");
    expect(status).toMatchObject({ mac: "AA:BB:CC:DD:EE:FF", state: "connected" });
  });

  it("forgetDevice issues the controller forget/remove call", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createUniFiNetworkClient();
    await client.forgetDevice("AA:BB:CC:DD:EE:FF");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(String((init as RequestInit).body)).toContain("AA:BB:CC:DD:EE:FF");
  });
});
