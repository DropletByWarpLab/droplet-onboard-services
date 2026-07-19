/**
 * WARP-1391 — createVpnPeer must mint HOME mode from user-facing surfaces.
 *
 * The interim remote-access bug (verified live on .87 2026-07-18): the dashboard
 * POSTed `{ deviceLabel }` with NO `mode`, so the orchestrator route fell back to
 * its byte-identical compat default `mode: "away"` (vpn.ts). Away bakes
 * `Endpoint=<public FQDN>:51820` — a split-horizon / public-NXDOMAIN address
 * (WARP-954 / ADR-023) that the stock WireGuard app can't handshake, so the peer
 * shows keepalive but ZERO handshakes: a silent dead config.
 *
 * The decided fix (do NOT flip the API default — it's a deliberate compat
 * contract) is that the CALLERS send `mode: "home"` explicitly, which bakes
 * `Endpoint=<box LAN IP>` and works today on the home network.
 *
 * This test exercises the REAL fetch path (WARP-1288 lesson: no seam-mocked dead
 * code — we mock the transport `authFetch`, NOT `createVpnPeer` itself) and reads
 * the actual serialized POST body to prove `mode:"home"` reaches the wire.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createVpnPeer } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function okCreated(): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      peer: {
        id: "p1",
        userId: "owner",
        deviceLabel: "This device",
        publicKey: "PUB=",
        assignedIp: "10.13.13.2",
        status: "active",
        createdAt: "now",
      },
      conf: "[Interface]\nPrivateKey=abc\n",
    }),
  } as unknown as Response;
}

/** Read the actual JSON body serialized onto the POST — the on-the-wire shape. */
function sentBody(call: number = 0): Record<string, unknown> {
  const init = authFetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

beforeEach(() => {
  authFetchMock.mockReset();
  authFetchMock.mockResolvedValue(okCreated());
});

describe("createVpnPeer (WARP-1391)", () => {
  it("POSTs mode:'home' to /api/vpn/peers by default (user-facing surfaces)", async () => {
    await createVpnPeer("This device");

    expect(authFetchMock).toHaveBeenCalledWith(
      "/api/vpn/peers",
      expect.objectContaining({ method: "POST" }),
    );
    const body = sentBody();
    expect(body.deviceLabel).toBe("This device");
    // The load-bearing assertion: the wire carries HOME mode, so the conf's
    // Endpoint is the box LAN IP, not the public-NXDOMAIN FQDN.
    expect(body.mode).toBe("home");
  });

  it("sends the explicit mode when a caller passes one (operator away path stays reachable)", async () => {
    await createVpnPeer("Ops laptop", "away");
    expect(sentBody().mode).toBe("away");
  });

  it("still returns the created peer + one-shot conf", async () => {
    const result = await createVpnPeer("This device", "home");
    expect(result.peer.id).toBe("p1");
    expect(result.conf).toContain("[Interface]");
  });
});
