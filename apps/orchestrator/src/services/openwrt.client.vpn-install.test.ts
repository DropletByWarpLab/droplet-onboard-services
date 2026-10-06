import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({ config: {
  ROUTING_SERVICE_URL: "http://routing.test", ROUTING_SERVICE_TOKEN: "test-token",
  ROUTING_MODE: "real", agentMaxIter: { defaultIter: 5, capIter: 10 },
} }));

import { installVpnPeer } from "./openwrt.client.js";

describe("installVpnPeer routing contract", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: "ok", applied: true, interface: "wg0", public_key: "SAVEDKEY",
      allowed_ips: ["10.13.13.9/32"], persistent_keepalive: 25,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores a saved public-key peer without a configured remote endpoint", async () => {
    const response = await installVpnPeer({
      interface: "wg0", publicKey: "SAVEDKEY", allowedIps: ["10.13.13.9/32"],
      persistentKeepalive: 25, description: "Laptop",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://routing.test/vpn/peers/install");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      interface: "wg0", public_key: "SAVEDKEY", allowed_ips: ["10.13.13.9/32"],
      persistent_keepalive: 25, description: "Laptop",
    });
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(response.applied).toBe(true);
  });

  it("preserves a staged installation result for the caller", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      status: "staged", applied: false, interface: "wg0", public_key: "SAVEDKEY",
      allowed_ips: ["10.13.13.9/32"], persistent_keepalive: 25,
    }), { status: 200 }));
    const response = await installVpnPeer({ publicKey: "SAVEDKEY", allowedIps: ["10.13.13.9/32"] });
    expect(response.status).toBe("staged");
    expect(response.applied).toBe(false);
  });
});
