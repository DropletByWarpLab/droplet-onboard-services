/**
 * WARP-1443 — `list_vpn_peers` LLM tool.
 *
 * Read-only WireGuard peer listing via the orchestrator's
 * `GET /api/vpn/peers`. Anything key-looking in the response is
 * stripped before it can reach the model. Tier-1 read.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listVpnPeers from "../../../src/handlers/network/list-vpn-peers.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(orchestratorGet: Mock): ToolContext {
  return {
    http: {
      routing: {} as ToolContext["http"]["routing"],
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
      orchestrator: {
        get: orchestratorGet,
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
      },
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

// GET /api/vpn/peers response (vpn.ts:324 — prisma select: id, userId,
// deviceLabel, publicKey, assignedIp, status, mode, createdAt, revokedAt).
const PEERS = [
  {
    id: "peer-1",
    userId: "romain",
    deviceLabel: "Pixel 9",
    publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    assignedIp: "10.13.13.2",
    status: "active",
    mode: "away",
    createdAt: "2026-07-01T09:00:00.000Z",
    revokedAt: null,
  },
  {
    id: "peer-2",
    userId: "sophie",
    deviceLabel: "MacBook",
    publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
    assignedIp: "10.13.13.3",
    status: "revoked",
    mode: "home",
    createdAt: "2026-06-15T10:00:00.000Z",
    revokedAt: "2026-07-10T08:00:00.000Z",
  },
];

function jsonGet(body: unknown, status = 200): Mock {
  return vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(body), { status }),
    );
}

function expectError(
  res: Awaited<ReturnType<typeof listVpnPeers.handler>>,
  code: string,
): void {
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe("error");
    expect(res.error.code).toBe(code);
  }
}

describe("list_vpn_peers", () => {
  it("fetches /api/vpn/peers and returns the peer list minus key-like fields", async () => {
    const get = jsonGet({ peers: PEERS });
    const res = await listVpnPeers.handler({}, ctxWith(get));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/vpn/peers", {
      headers: { Accept: "application/json" },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({
        type: "list_vpn_peers",
        peers: [
          {
            id: "peer-1",
            userId: "romain",
            deviceLabel: "Pixel 9",
            assignedIp: "10.13.13.2",
            status: "active",
            mode: "away",
            createdAt: "2026-07-01T09:00:00.000Z",
            revokedAt: null,
          },
          {
            id: "peer-2",
            userId: "sophie",
            deviceLabel: "MacBook",
            assignedIp: "10.13.13.3",
            status: "revoked",
            mode: "home",
            createdAt: "2026-06-15T10:00:00.000Z",
            revokedAt: "2026-07-10T08:00:00.000Z",
          },
        ],
        count: 2,
      });
    }
  });

  it("strips ANY key-looking field even if the route ever returned one", async () => {
    const get = jsonGet({
      peers: [
        {
          id: "peer-x",
          deviceLabel: "iPad",
          createdAt: "2026-07-19T00:00:00.000Z",
          // None of these are in the route's select today — belt and
          // braces against a future route change leaking key material.
          privateKey: "SECRET-NEVER-SHOW",
          presharedKey: "PSK-NEVER-SHOW",
          publicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=",
          conf: "[Interface]\nPrivateKey = SECRET",
          // Unknown but harmless fields still flow through.
          lastHandshake: "2026-07-20T11:00:00.000Z",
          enabled: true,
        },
      ],
    });
    const res = await listVpnPeers.handler({}, ctxWith(get));
    expect(res.ok).toBe(true);
    if (res.ok) {
      const { peers } = res.data as { peers: Array<Record<string, unknown>> };
      expect(peers).toHaveLength(1);
      const peer = peers[0]!;
      expect(peer).toEqual({
        id: "peer-x",
        deviceLabel: "iPad",
        createdAt: "2026-07-19T00:00:00.000Z",
        lastHandshake: "2026-07-20T11:00:00.000Z",
        enabled: true,
      });
      expect(Object.keys(peer)).not.toContain("privateKey");
      expect(Object.keys(peer)).not.toContain("presharedKey");
      expect(Object.keys(peer)).not.toContain("publicKey");
      expect(Object.keys(peer)).not.toContain("conf");
      expect(JSON.stringify(res.data)).not.toContain("SECRET");
      expect(JSON.stringify(res.data)).not.toContain("PSK-NEVER-SHOW");
    }
  });

  it("returns an empty list with count 0", async () => {
    const get = jsonGet({ peers: [] });
    const res = await listVpnPeers.handler({}, ctxWith(get));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ type: "list_vpn_peers", peers: [], count: 0 });
    }
  });

  it("maps a non-OK response to VPN_UNAVAILABLE", async () => {
    const get = jsonGet({ error: "boom" }, 503);
    const res = await listVpnPeers.handler({}, ctxWith(get));
    expectError(res, "VPN_UNAVAILABLE");
  });

  it("maps a thrown fetch error to VPN_UNAVAILABLE", async () => {
    const get = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await listVpnPeers.handler({}, ctxWith(get));
    expectError(res, "VPN_UNAVAILABLE");
  });

  it("maps a payload without a peers array to VPN_UNAVAILABLE", async () => {
    const get = jsonGet({ nope: true });
    const res = await listVpnPeers.handler({}, ctxWith(get));
    expectError(res, "VPN_UNAVAILABLE");
  });
});

describe("list_vpn_peers — tool metadata", () => {
  it("is named list_vpn_peers and is Tier-1 (no write, no confirm)", () => {
    expect(listVpnPeers.name).toBe("list_vpn_peers");
    expect(listVpnPeers.requiresWrite).toBe(false);
    expect(listVpnPeers.requiresConfirmation).toBe(false);
  });

  it("takes no arguments (additionalProperties:false, empty properties)", () => {
    const schema = listVpnPeers.inputSchema as {
      additionalProperties?: boolean;
      required?: readonly string[];
      properties?: Record<string, unknown>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toBeUndefined();
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
  });

  it("tells the model peer creation from chat is not available yet (WARP-1444)", () => {
    expect(listVpnPeers.description).toContain("WARP-1444");
  });
});
