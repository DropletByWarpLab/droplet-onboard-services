import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// ADR-023 PR-1 — adapters: bridge FQDN persister + routing DNS registrar.
//
// The pure state-machine is unit-tested with fakes in
// tls-issuance.service.test.ts. Here we cover the two NEW production adapters:
//   - createBridgeFqdnPersister()  → POST /host/public-fqdn to the device-bridge
//   - createRoutingDnsRegistrar()  → POST /dhcp/hostnames via the routing client
// Both are best-effort + warn-not-throw, mirroring bridgeNginxReloader /
// setup_public_fqdn_dns.
// ---------------------------------------------------------------------------

const ROUTING_CALLS: Array<{ path: string; init: unknown }> = [];
// Mock the routing client so the registrar's ROUTING_MODE short-circuit + the
// /dhcp/hostnames payload are observable without a live routing service.
vi.mock("./openwrt.client.js", () => ({
  routingFetch: vi.fn(async (path: string, init: unknown) => {
    ROUTING_CALLS.push({ path, init });
    return { ok: true, status: 200, text: async () => "" } as unknown as Response;
  }),
}));

import { routingFetch } from "./openwrt.client.js";
import {
  createBridgeFqdnPersister,
  createRoutingDnsRegistrar,
} from "./tls-issuance.adapters.js";

const FQDN = "d-abc123def4567890.devices.warp-lab.ai";

describe("createRoutingDnsRegistrar", () => {
  beforeEach(() => {
    ROUTING_CALLS.length = 0;
    (routingFetch as ReturnType<typeof vi.fn>).mockClear();
  });

  it("POSTs {hostname, ip} to /dhcp/hostnames via the routing client", async () => {
    const reg = createRoutingDnsRegistrar();
    await reg.register(FQDN);

    expect(routingFetch).toHaveBeenCalledTimes(1);
    const [path, init] = (routingFetch as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(path).toBe("/dhcp/hostnames");
    expect((init as { method: string }).method).toBe("POST");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.hostname).toBe(FQDN);
    // Default DROPLET_PUBLIC_FQDN_IP — the WG gateway.
    expect(body.ip).toBe("192.168.20.1");
  });

  it("never throws when the routing client rejects (DNS is best-effort)", async () => {
    (routingFetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Router supervision disabled"),
    );
    const reg = createRoutingDnsRegistrar();
    await expect(reg.register(FQDN)).resolves.toBeUndefined();
  });
});

describe("createBridgeFqdnPersister", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    process.env.BRIDGE_AUTH_TOKEN = "pytest-bridge-token";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.BRIDGE_AUTH_TOKEN;
  });

  it("POSTs the fqdn to the bridge /host/public-fqdn with the X-Droplet-Auth header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => "" } as Response;
    }) as unknown as typeof fetch;

    const persist = createBridgeFqdnPersister();
    await persist(FQDN);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/host/public-fqdn");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["X-Droplet-Auth"]).toBe("pytest-bridge-token");
    expect(JSON.parse(calls[0].init.body as string).fqdn).toBe(FQDN);
  });

  it("warns (does not throw) when the bridge auth token is unconfigured", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const persist = createBridgeFqdnPersister();
    await expect(persist(FQDN)).resolves.toBeUndefined();
    // With no token we never even reach out — fail-closed, but never throw.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("warns (does not throw) when the bridge returns a non-2xx", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => "bad gateway",
    })) as unknown as typeof fetch;

    const persist = createBridgeFqdnPersister();
    await expect(persist(FQDN)).resolves.toBeUndefined();
  });

  it("warns (does not throw) when the bridge is unreachable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const persist = createBridgeFqdnPersister();
    await expect(persist(FQDN)).resolves.toBeUndefined();
  });
});
