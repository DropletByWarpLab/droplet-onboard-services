import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config BEFORE importing the client so BASE_URL / TOKEN / ROUTING_MODE are
// the fixture, not the env-validated production object.
vi.mock("../config.js", () => ({
  config: {
    ROUTING_SERVICE_URL: "http://routing.test",
    ROUTING_SERVICE_TOKEN: "test-token",
    ROUTING_MODE: "real",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { installOverlayVpnPeer } from "./openwrt.client.js";

describe("installOverlayVpnPeer — routing wire shape (WARP-1385)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          interface: "wg0",
          public_key: "PHONEKEY",
          endpoint: "203.0.113.7:51820",
          allowed_ips: ["10.13.13.9/32"],
          persistent_keepalive: 25,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the phone key + observed endpoint + keepalive to /vpn/peers/overlay", async () => {
    const res = await installOverlayVpnPeer({
      interface: "wg0",
      publicKey: "PHONEKEY",
      endpoint: "203.0.113.7:51820",
      allowedIps: ["10.13.13.9/32"],
      persistentKeepalive: 25,
      description: "overlay sess-42",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/vpn\/peers\/overlay$/);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      interface: "wg0",
      public_key: "PHONEKEY",
      endpoint: "203.0.113.7:51820",
      allowed_ips: ["10.13.13.9/32"],
      persistent_keepalive: 25,
      description: "overlay sess-42",
    });
    // Bearer token carried from config.
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
    expect(res.status).toBe("ok");
    expect(res.endpoint).toBe("203.0.113.7:51820");
  });
});
