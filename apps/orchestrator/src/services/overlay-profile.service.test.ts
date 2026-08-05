/**
 * WARP-1757 — overlay profile provisioning + issuance.
 *
 * The route tests cover the HTTP surface; these pin the behaviours that are
 * invisible from there: call ORDERING (which is what makes the first overlay
 * peer on a fresh box work), address reuse across re-approval, and the
 * candidate ordering contract clients will depend on.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildOverlayProfile,
  provisionOverlayPeer,
  type OverlayEndpointCandidate,
  type ProvisionOverlayPeerDeps,
} from "./overlay-profile.service.js";

const WG_KEY = "A".repeat(43) + "=";

function deps(overrides: Partial<ProvisionOverlayPeerDeps> = {}) {
  const calls: string[] = [];
  const rows: any[] = [];
  const d: ProvisionOverlayPeerDeps = {
    prisma: {
      vpnPeer: {
        findUnique: vi.fn(async ({ where }: any) => {
          return rows.find((r) => r.publicKey === where.publicKey) ?? null;
        }),
        create: vi.fn(async ({ data }: any) => {
          calls.push("create");
          const row = { id: `vp-${rows.length + 1}`, ...data };
          rows.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          calls.push("update");
          const row = rows.find((r) => r.publicKey === where.publicKey);
          Object.assign(row, data);
          return row;
        }),
      },
    },
    router: {
      setup: vi.fn(async () => {
        calls.push("setup");
        return { public_key: "SRVPUB=" };
      }),
      installPeer: vi.fn(async () => {
        calls.push("installPeer");
        return {};
      }),
    },
    allocateIp: vi.fn(async () => "10.66.0.7"),
    config: {
      listenPort: 51820,
      serverAddress: "10.66.0.1/24",
      vpnInterface: "wg0",
      keepaliveSeconds: 25,
    },
    now: () => new Date("2026-08-05T00:00:00Z"),
    ...overrides,
  };
  return { d, calls, rows };
}

const input = {
  wgPublicKey: WG_KEY,
  label: "Phone",
  linkTokenId: "tok-1",
  linkTokenEnrolledBy: "owner-1",
};

describe("provisionOverlayPeer", () => {
  // wg0 setup MUST precede the peer install. Without it, the very first
  // overlay peer on a box that never minted a legacy static peer fails with
  // "wg0 not configured" — the new flow would silently depend on the old one
  // having been used at least once.
  it("ensures wg0 exists BEFORE installing the peer", async () => {
    const { d, calls } = deps();
    await provisionOverlayPeer(d, input);
    expect(calls.indexOf("setup")).toBeLessThan(calls.indexOf("installPeer"));
  });

  // The row must be durable first: a crash can leave a row with no router peer
  // (self-heals on re-provision) but never a router peer no row accounts for.
  it("persists the peer row BEFORE installing it router-side", async () => {
    const { d, calls } = deps();
    await provisionOverlayPeer(d, input);
    expect(calls.indexOf("create")).toBeLessThan(calls.indexOf("installPeer"));
  });

  it("returns the allocated address and the interface's own public key", async () => {
    const { d } = deps();
    const out = await provisionOverlayPeer(d, input);
    expect(out).toEqual({ assignedIp: "10.66.0.7", serverPublicKey: "SRVPUB=" });
  });

  it("installs the client's OWN key with a matching /32 and no endpoint", async () => {
    const { d } = deps();
    await provisionOverlayPeer(d, input);
    expect(d.router.installPeer).toHaveBeenCalledWith({
      interface: "wg0",
      publicKey: WG_KEY,
      allowedIps: ["10.66.0.7/32"],
      persistentKeepalive: 25,
      description: "Phone",
    });
  });

  it("writes an active overlay peer row with QR provenance", async () => {
    const { d, rows } = deps();
    await provisionOverlayPeer(d, input);
    expect(rows[0]).toMatchObject({
      publicKey: WG_KEY,
      assignedIp: "10.66.0.7",
      kind: "overlay",
      status: "active",
      mode: "away",
      userId: "overlay",
      linkTokenId: "tok-1",
      linkTokenEnrolledBy: "owner-1",
      linkTokenLabel: "Phone",
    });
  });

  // Re-approving a device whose row survives (a revoked one, say) must reuse
  // its address rather than burn another out of a /24 — 253 usable hosts is
  // not many for a household that re-links devices.
  it("reuses an existing row's address and reactivates it", async () => {
    const { d, rows } = deps();
    rows.push({
      id: "vp-old",
      publicKey: WG_KEY,
      assignedIp: "10.66.0.3",
      status: "revoked",
    });
    const out = await provisionOverlayPeer(d, input);
    expect(out.assignedIp).toBe("10.66.0.3");
    expect(d.allocateIp).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("active");
    expect(rows[0].revokedAt).toBeNull();
    expect(d.router.installPeer).toHaveBeenCalledWith(
      expect.objectContaining({ allowedIps: ["10.66.0.3/32"] }),
    );
  });
});

describe("buildOverlayProfile", () => {
  const base = {
    assignedIp: "10.66.0.7",
    serverPublicKey: "SRVPUB=",
    lanCidr: "192.168.20.0/24",
    vpnSubnet: "10.66.0.0/24",
    dns: "192.168.20.1",
    keepaliveSeconds: 25,
    endpointCandidates: [] as OverlayEndpointCandidate[],
  };

  it("addresses the client with a /32 inside the box's allowed range", () => {
    const p = buildOverlayProfile(base);
    expect(p.address).toBe("10.66.0.7/32");
    expect(p.allowed_ips).toEqual(["192.168.20.0/24", "10.66.0.0/24"]);
  });

  // Split-tunnel is the invariant: the Android client refuses a full-tunnel
  // conf outright, so issuing a default route would produce a tunnel that
  // silently never comes up.
  it("never issues a default route", () => {
    const p = buildOverlayProfile(base);
    expect(p.allowed_ips).not.toContain("0.0.0.0/0");
    expect(p.allowed_ips).not.toContain("::/0");
  });

  it("splits a multi-value DNS string into a list", () => {
    const p = buildOverlayProfile({ ...base, dns: "192.168.20.1, 192.168.20.2" });
    expect(p.dns).toEqual(["192.168.20.1", "192.168.20.2"]);
  });

  it("drops empty DNS entries rather than emitting blanks", () => {
    const p = buildOverlayProfile({ ...base, dns: "192.168.20.1,, " });
    expect(p.dns).toEqual(["192.168.20.1"]);
  });

  // The ordering IS the contract: clients try candidates top-down and keep the
  // first that completes a handshake.
  it("orders candidates by descending priority regardless of input order", () => {
    const p = buildOverlayProfile({
      ...base,
      endpointCandidates: [
        { kind: "srflx", host: "203.0.113.9", port: 41234, priority: 40 },
        { kind: "lan", host: "192.168.20.1", port: 51820, priority: 120 },
        { kind: "direct", host: "box.example", port: 51820, priority: 100 },
      ],
    });
    expect(p.endpoint_candidates.map((c) => c.kind)).toEqual([
      "lan",
      "direct",
      "srflx",
    ]);
  });

  it("does not mutate the caller's candidate array", () => {
    const candidates: OverlayEndpointCandidate[] = [
      { kind: "srflx", host: "a", port: 1, priority: 1 },
      { kind: "lan", host: "b", port: 2, priority: 9 },
    ];
    buildOverlayProfile({ ...base, endpointCandidates: candidates });
    expect(candidates[0].kind).toBe("srflx");
  });

  it("tolerates an empty candidate list (box has no address yet)", () => {
    expect(buildOverlayProfile(base).endpoint_candidates).toEqual([]);
  });
});
