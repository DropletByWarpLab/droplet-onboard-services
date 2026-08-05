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
import {
  expireIdleOverlayPeers,
  type OverlayConnectDeps,
} from "./overlay-connect.service.js";

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

  // schema.prisma states the invariant in words: kind='overlay' IMPLIES
  // lastSessionAt is non-NULL, precisely so the idle-expiry sweep's
  // `kind='overlay' AND lastSessionAt < cutoff` filter never has to derive
  // state from an absence (repo rule 10). A NULL here is not "unset" — in
  // Postgres `NULL < cutoff` is NULL, so the row NEVER matches the sweep and
  // the peer becomes permanent, removable only by hand.
  //
  // Asserted EXPLICITLY and not folded into the toMatchObject above: that
  // matcher ignores every field it does not name, which is exactly how a
  // missing lastSessionAt survives review.
  it("stamps lastSessionAt on a NEW row (kind='overlay' ⇒ non-NULL)", async () => {
    const { d, rows } = deps();
    await provisionOverlayPeer(d, input);
    expect(rows[0].lastSessionAt).toBeInstanceOf(Date);
    expect(rows[0].lastSessionAt).toEqual(new Date("2026-08-05T00:00:00Z"));
  });

  it("stamps lastSessionAt when REVIVING an existing row", async () => {
    const { d, rows } = deps();
    rows.push({
      id: "vp-old",
      publicKey: WG_KEY,
      assignedIp: "10.66.0.3",
      status: "revoked",
      lastSessionAt: null,
    });
    await provisionOverlayPeer(d, input);
    expect(rows[0].lastSessionAt).toBeInstanceOf(Date);
    expect(rows[0].lastSessionAt).toEqual(new Date("2026-08-05T00:00:00Z"));
  });
});

// The unit assertions above pin the field; this pins the CONSEQUENCE. The row
// this flow writes must be reachable by the very sweep that owns overlay-peer
// lifecycle — otherwise every device approved through the QR flow gets a
// permanent wg0 peer with no expiry path, and the defect is invisible until
// someone flips OVERLAY_CONNECT_ENABLED.
describe("provisioned peers are visible to the idle-expiry sweep", () => {
  /** findMany with Postgres three-valued logic for `lt`: a NULL column never
   *  satisfies a comparison, so a NULL lastSessionAt is silently un-sweepable.
   *  Modelling that faithfully is the whole point of this test. */
  function sweepPrisma(rows: any[]) {
    return {
      vpnPeer: {
        findUnique: vi.fn(async ({ where }: any) =>
          rows.find((r) => r.publicKey === where.publicKey) ?? null,
        ),
        create: vi.fn(async ({ data }: any) => {
          const row = { id: `vp-${rows.length + 1}`, ...data };
          rows.push(row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = rows.find((r) => r.publicKey === where.publicKey);
          Object.assign(row, data);
          return row;
        }),
        findMany: vi.fn(async ({ where }: any) =>
          rows.filter((r) => {
            if (where.kind !== undefined && r.kind !== where.kind) return false;
            if (where.status !== undefined && r.status !== where.status)
              return false;
            const lt = where.lastSessionAt?.lt;
            if (lt !== undefined) {
              // SQL: NULL < x → NULL → row excluded.
              if (r.lastSessionAt === null || r.lastSessionAt === undefined)
                return false;
              if (!(r.lastSessionAt < lt)) return false;
            }
            return true;
          }),
        ),
      },
    };
  }

  it("expires a QR-approved peer once it idles past the cutoff", async () => {
    const rows: any[] = [];
    const prisma = sweepPrisma(rows);
    const approvedAt = new Date("2026-08-05T00:00:00Z");

    await provisionOverlayPeer(
      { ...deps({ prisma } as any).d, prisma, now: () => approvedAt } as any,
      input,
    );
    expect(rows).toHaveLength(1);

    const remove = vi.fn(async () => {});
    const sweepDeps = {
      config: {
        hqBaseUrl: "",
        deviceId: "d",
        bridgeUrl: "",
        bridgeToken: "",
        vpnInterface: "wg0",
        keepaliveSeconds: 25,
        idleExpiryHours: 12,
      },
      identity: {} as never,
      prisma: prisma as never,
      peers: { install: vi.fn(), remove } as never,
      allocateIp: vi.fn(),
      // 13 h after approval — one hour past the 12 h idle window, with no
      // session ever recorded.
      now: () => new Date(approvedAt.getTime() + 13 * 3_600_000),
    } as unknown as OverlayConnectDeps;

    const expired = await expireIdleOverlayPeers(sweepDeps);
    expect(expired).toBe(1);
    expect(remove).toHaveBeenCalledWith({
      interface: "wg0",
      publicKey: WG_KEY,
    });
    expect(rows[0].status).toBe("revoked");
  });

  it("does NOT expire the same peer while it is still inside the idle window", async () => {
    const rows: any[] = [];
    const prisma = sweepPrisma(rows);
    const approvedAt = new Date("2026-08-05T00:00:00Z");
    await provisionOverlayPeer(
      { ...deps({ prisma } as any).d, prisma, now: () => approvedAt } as any,
      input,
    );
    const sweepDeps = {
      config: {
        hqBaseUrl: "",
        deviceId: "d",
        bridgeUrl: "",
        bridgeToken: "",
        vpnInterface: "wg0",
        keepaliveSeconds: 25,
        idleExpiryHours: 12,
      },
      identity: {} as never,
      prisma: prisma as never,
      peers: { install: vi.fn(), remove: vi.fn() } as never,
      allocateIp: vi.fn(),
      now: () => new Date(approvedAt.getTime() + 11 * 3_600_000),
    } as unknown as OverlayConnectDeps;
    expect(await expireIdleOverlayPeers(sweepDeps)).toBe(0);
    expect(rows[0].status).toBe("active");
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
