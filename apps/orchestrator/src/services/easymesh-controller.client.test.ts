/**
 * ADR-024 Phase 4 — prplMesh EasyMesh controller client.
 *
 * The box runs prplMesh in CONTROLLER-ONLY mode (ADR-024 §2 — its mt76
 * radio cannot be an EasyMesh RF agent; the certified third-party AP is the
 * Agent). This client is the orchestrator's typed seam to that local
 * controller's 1905.1 control plane (over its ubus / IPC data model): it
 * lists onboarding Agents from the topology, pushes M1/M2 credentials, reads
 * an Agent's status, and removes an Agent.
 *
 * Same testability discipline as the Phase-3 UniFi client: ALL wire detail
 * lives behind the `EasyMeshControllerClient` interface, so the discovery
 * source + onboarding handler unit-test against a MOCK of it (there is no
 * prplMesh controller on the dev laptop, and prplMesh-on-mt76 is the ADR's
 * open hardware risk). These tests pin the concrete impl's CONTRACT —
 * configured-URL targeting, error classification, NOT_CONFIGURED on empty
 * config — not the exact ubus call shapes, which carry
 * `// VALIDATE against real prplMesh controller` markers and are confirmed on
 * real hardware in the lab later.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    DROPLET_AP_EASYMESH_CONTROLLER_URL: "http://controller.test:8080",
    DROPLET_AP_EASYMESH_ENABLED: true,
  },
}));

import {
  createEasyMeshControllerClient,
  EasyMeshControllerError,
  type EasyMeshControllerClient,
} from "./easymesh-controller.client.js";

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

describe("createEasyMeshControllerClient — base URL + transport", () => {
  it("targets the configured controller URL", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client: EasyMeshControllerClient = createEasyMeshControllerClient();
    await client.listOnboardingAgents();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("http://controller.test:8080");
  });

  it("classifies a non-2xx controller response as a typed EasyMeshControllerError (status preserved)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "forbidden" }, 403)),
    );
    const client = createEasyMeshControllerClient();
    await expect(client.listOnboardingAgents()).rejects.toBeInstanceOf(
      EasyMeshControllerError,
    );
    await expect(client.listOnboardingAgents()).rejects.toMatchObject({
      status: 403,
    });
  });

  it("classifies a network-layer throw as a typed EasyMeshControllerError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const client = createEasyMeshControllerClient();
    await expect(client.listOnboardingAgents()).rejects.toBeInstanceOf(
      EasyMeshControllerError,
    );
  });
});

describe("createEasyMeshControllerClient — topology + onboard + status + remove", () => {
  it("listOnboardingAgents maps the 1905.1 topology to typed agents (AL-MAC, vendor)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          { al_mac: "aa:bb:cc:00:00:01", manufacturer: "TP-Link", model: "RE700X" },
          { al_mac: "aa:bb:cc:00:00:02" },
        ]),
      ),
    );
    const client = createEasyMeshControllerClient();
    const agents = await client.listOnboardingAgents();

    expect(agents).toHaveLength(2);
    expect(agents[0]).toMatchObject({
      alMac: "AA:BB:CC:00:00:01",
      vendor: "TP-Link",
      model: "RE700X",
    });
    // No device info on the second agent → vendor undefined, not guessed.
    expect(agents[1]).toMatchObject({ alMac: "AA:BB:CC:00:00:02" });
    expect(agents[1]!.vendor).toBeUndefined();
  });

  it("onboardAgent POSTs the AL-MAC + the SSID/key M1/M2 credentials", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createEasyMeshControllerClient();
    await client.onboardAgent("AA:BB:CC:00:00:01", {
      ssid: "Droplet",
      key: "longenoughpw",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).method).toBe("POST");
    const body = String((init as RequestInit).body);
    expect(body).toContain("AA:BB:CC:00:00:01");
    expect(body).toContain("Droplet");
    expect(body).toContain("longenoughpw");
  });

  it("getAgentStatus maps the controller state for an AL-MAC", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          { al_mac: "aa:bb:cc:00:00:01", state: "onboarded" },
        ]),
      ),
    );
    const client = createEasyMeshControllerClient();
    const status = await client.getAgentStatus("AA:BB:CC:00:00:01");
    expect(status).toMatchObject({ alMac: "AA:BB:CC:00:00:01", state: "onboarded" });
  });

  it("getAgentStatus returns null when the controller doesn't know the AL-MAC", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([])));
    const client = createEasyMeshControllerClient();
    expect(await client.getAgentStatus("AA:BB:CC:00:00:09")).toBeNull();
  });

  it("removeAgent issues the controller remove call for the AL-MAC", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ status: "ok" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createEasyMeshControllerClient();
    await client.removeAgent("AA:BB:CC:00:00:01");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(String((init as RequestInit).body)).toContain("AA:BB:CC:00:00:01");
  });
});

describe("EasyMeshControllerError + NOT_CONFIGURED", () => {
  it("toJSON exposes code + message + status", () => {
    const err = EasyMeshControllerError.notConfigured();
    const json = err.toJSON();
    expect(json.code).toBe("NOT_CONFIGURED");
    expect(typeof json.message).toBe("string");
    expect(json.status).toBe(503);
  });
});
