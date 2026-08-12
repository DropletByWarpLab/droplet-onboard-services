import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

// ── Mocks ──
//
// Mock config BEFORE importing the route so the env-validated `config` object
// is the test fixture, not the production zod-validated one.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    NEXTCLOUD_URL: "http://nextcloud.test",
    ROUTING_SERVICE_URL: "http://routing.test",
    ROUTING_SERVICE_TOKEN: "test-token",
    ROUTING_MODE: "real",
    WIREGUARD_ENDPOINT_HOST: "vpn.example.com",
    DROPLET_PUBLIC_FQDN: "",
    REMOTE_ACCESS_MODE: "fqdn",
    WIREGUARD_VPN_SUBNET: "10.13.13.0/24",
    WIREGUARD_LISTEN_PORT: 51820,
    WIREGUARD_LAN_CIDR: "192.168.50.0/24",
    WIREGUARD_DNS: "192.168.50.1",
    // Hybrid home-mode config (P1).
    WIREGUARD_HOME_DNS: "192.168.20.1",
    WIREGUARD_HOME_ALLOWED_IPS: "192.168.20.0/24",
    WIREGUARD_HOME_ENDPOINT_HOST: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/openwrt.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/openwrt.client.js")>(
    "../services/openwrt.client.js",
  );
  return {
    ...actual,
    vpnSetup: vi.fn(),
    vpnStatus: vi.fn(),
    listVpnPeers: vi.fn(),
    createVpnPeer: vi.fn(),
    deleteVpnPeer: vi.fn(),
    // Home-mode LAN-IP discovery reads the network summary. Default: no WAN IP
    // (single-box shape), so home mode leans on the config fallback. Tests that
    // exercise multi-box discovery override this per-case.
    fetchNetworkSummary: vi.fn(async () => ({
      wan: { present: false, "ipv4-address": [] },
    })),
  };
});

import { createVpnRouter, _resetEndpointCacheForTests } from "../routes/vpn.js";
import { config } from "../config.js";
import * as openwrt from "../services/openwrt.client.js";

// In-memory Prisma stand-in for the VpnPeer table.
function createPrismaMock() {
  const rows: any[] = [];
  let counter = 0;
  const mock: any = {
    rows,
    // WARP-565: allocateMintAndPersistPeer wraps the create in a
    // $transaction. Run the callback against this same mock so `tx` shares
    // the in-memory store (mirrors claim-code.service.test.ts's pattern).
    $transaction: vi.fn(async (fn: any) => fn(mock)),
    vpnPeer: {
      findMany: vi.fn(async ({ where, orderBy, select }: any = {}) => {
        let result = [...rows];
        if (where?.status) result = result.filter((r) => r.status === where.status);
        if (where?.userId) result = result.filter((r) => r.userId === where.userId);
        if (where?.assignedIp?.startsWith) {
          result = result.filter((r) => r.assignedIp.startsWith(where.assignedIp.startsWith));
        }
        if (orderBy?.createdAt === "desc") {
          result.sort((a, b) => +b.createdAt - +a.createdAt);
        }
        if (select) {
          return result.map((r) => {
            const out: any = {};
            for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
            return out;
          });
        }
        return result;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        return rows.find((r) => r.id === where.id) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        // publicKey is unique across ALL rows (active + revoked); tag the
        // P2002 with meta.target so isActiveIpViolation() routes it to the
        // non-retryable path the rollback test depends on.
        if (rows.find((r) => r.publicKey === data.publicKey)) {
          const e: any = new Error("Unique constraint failed on publicKey");
          e.code = "P2002";
          e.meta = { target: ["publicKey"] };
          throw e;
        }
        // WARP-565: model the partial unique index — assignedIp is unique
        // among ACTIVE rows only (revoked rows' IPs are reusable).
        if (
          data.status !== "revoked" &&
          rows.find((r) => r.status === "active" && r.assignedIp === data.assignedIp)
        ) {
          const e: any = new Error("Unique constraint failed on assignedIp");
          e.code = "P2002";
          e.meta = { target: ["assignedIp"] };
          throw e;
        }
        const row = {
          id: `vp-${++counter}`,
          status: "active",
          createdAt: new Date(),
          revokedAt: null,
          ...data,
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = rows.findIndex((r) => r.id === where.id);
        if (idx < 0) {
          const e: any = new Error("not found");
          e.code = "P2025";
          throw e;
        }
        rows[idx] = { ...rows[idx], ...data };
        return rows[idx];
      }),
    },
  };
  return mock;
}

// WARP-171: default test user is `owner` so all the VPN tests (which
// historically didn't think about role) keep passing. The matrix
// in `rbac.test.ts` is the canonical source for who-can-do-what;
// these tests focus on the route's business logic, not the guard.
// Tests that need a non-privileged caller pass `role: "family"`
// explicitly.
function buildApp(prismaMock: any, user = { username: "alice", role: "owner" }) {
  const app = express();
  app.use(express.json());
  // Inject a synthetic auth user so getUser() in the route picks it up.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: user.username, ...user, displayName: user.username };
    next();
  });
  app.use("/api", createVpnRouter(prismaMock));
  // Generic error handler so unhandled errors surface as 500 with the message.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "internal" });
  });
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // resolveEndpointHost() now reads WIREGUARD_ENDPOINT_HOST directly with
  // no cache; this reset is a no-op kept for a stable import.
  _resetEndpointCacheForTests();
});

describe("GET /api/vpn/status", () => {
  it("reports configured=false when the router has no wg interface", async () => {
    (openwrt.vpnStatus as any).mockResolvedValue(null);
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/vpn/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: false,
      endpointConfigured: true,
    });
  });

  // WARP-974: the named FQDN alone must make endpointConfigured true — the box
  // learns DROPLET_PUBLIC_FQDN automatically from HQ, so remote access "turns on
  // automatically" (as the wizard/help copy promises) with NO operator env set.
  it("reports endpointConfigured=true from DROPLET_PUBLIC_FQDN alone (no WIREGUARD_ENDPOINT_HOST)", async () => {
    (openwrt.vpnStatus as any).mockResolvedValue(null);
    const origEnv = config.WIREGUARD_ENDPOINT_HOST;
    const origFqdn = (config as any).DROPLET_PUBLIC_FQDN;
    (config as any).WIREGUARD_ENDPOINT_HOST = "";
    (config as any).DROPLET_PUBLIC_FQDN = "home.droplet-us.com";
    try {
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/vpn/status");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        endpointConfigured: true,
        publicFqdn: "home.droplet-us.com",
      });
    } finally {
      (config as any).WIREGUARD_ENDPOINT_HOST = origEnv;
      (config as any).DROPLET_PUBLIC_FQDN = origFqdn;
    }
  });

  // WARP-993: honest off-LAN reachability. The FQDN is split-horizon only
  // (ADR-023 §3 — no public A record), so FQDN-only must report
  // offLanReachable=false even though endpointConfigured=true; the dashboard
  // gates every "from anywhere" promise on this boolean.
  describe("offLanReachable (WARP-993)", () => {
    it("reports true when the operator override is a publicly-routable host", async () => {
      (openwrt.vpnStatus as any).mockResolvedValue(null);
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/vpn/status");
      expect(res.status).toBe(200);
      // Fixture default: WIREGUARD_ENDPOINT_HOST=vpn.example.com, no FQDN.
      expect(res.body.offLanReachable).toBe(true);
    });

    it("reports false when only the split-horizon FQDN is configured", async () => {
      (openwrt.vpnStatus as any).mockResolvedValue(null);
      const origEnv = config.WIREGUARD_ENDPOINT_HOST;
      const origFqdn = (config as any).DROPLET_PUBLIC_FQDN;
      (config as any).WIREGUARD_ENDPOINT_HOST = "";
      (config as any).DROPLET_PUBLIC_FQDN = "home.droplet-us.com";
      try {
        const app = buildApp(createPrismaMock());
        const res = await request(app).get("/api/vpn/status");
        expect(res.status).toBe(200);
        // endpointConfigured is true (a conf CAN be minted, it works on-LAN)
        // but the endpoint is not routable from outside the home network.
        expect(res.body).toMatchObject({
          endpointConfigured: true,
          offLanReachable: false,
        });
      } finally {
        (config as any).WIREGUARD_ENDPOINT_HOST = origEnv;
        (config as any).DROPLET_PUBLIC_FQDN = origFqdn;
      }
    });

    it("reports true in relay mode even when only the FQDN is configured (ADR-025)", async () => {
      (openwrt.vpnStatus as any).mockResolvedValue(null);
      const origEnv = config.WIREGUARD_ENDPOINT_HOST;
      const origFqdn = (config as any).DROPLET_PUBLIC_FQDN;
      const origMode = (config as any).REMOTE_ACCESS_MODE;
      (config as any).WIREGUARD_ENDPOINT_HOST = "";
      (config as any).DROPLET_PUBLIC_FQDN = "home.droplet-us.com";
      (config as any).REMOTE_ACCESS_MODE = "relay";
      try {
        const app = buildApp(createPrismaMock());
        const res = await request(app).get("/api/vpn/status");
        expect(res.status).toBe(200);
        expect(res.body.offLanReachable).toBe(true);
      } finally {
        (config as any).WIREGUARD_ENDPOINT_HOST = origEnv;
        (config as any).DROPLET_PUBLIC_FQDN = origFqdn;
        (config as any).REMOTE_ACCESS_MODE = origMode;
      }
    });

    it("is present on the configured-status response shape too", async () => {
      (openwrt.vpnStatus as any).mockResolvedValue({
        interface: "wg0",
        public_key: "PUBKEY=",
        listen_port: 51820,
        addresses: ["10.13.13.1/24"],
        peer_count: 2,
      });
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/vpn/status");
      expect(res.status).toBe(200);
      expect(res.body.offLanReachable).toBe(true);
    });
  });

  it("returns server info when configured", async () => {
    (openwrt.vpnStatus as any).mockResolvedValue({
      interface: "wg0",
      public_key: "PUBKEY=",
      listen_port: 51820,
      addresses: ["10.13.13.1/24"],
      peer_count: 2,
    });
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/vpn/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      serverPublicKey: "PUBKEY=",
      listenPort: 51820,
      peerCount: 2,
    });
    // Never expose private key shape via this endpoint.
    expect(JSON.stringify(res.body)).not.toMatch(/private/i);
  });

  // Hybrid P1: the box's home-facing LAN IP (what a HOME-mode peer dials
  // directly) is surfaced dynamically from the network summary — never
  // hardcoded, and null when it can't be discovered.
  describe("homeEndpointHost (hybrid P1)", () => {
    it("surfaces the discovered WAN IPv4 address", async () => {
      (openwrt.vpnStatus as any).mockResolvedValue(null);
      (openwrt.fetchNetworkSummary as any).mockResolvedValue({
        wan: { present: true, "ipv4-address": [{ address: "192.168.1.87", mask: 24 }] },
      });
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/vpn/status");
      expect(res.status).toBe(200);
      expect(res.body.homeEndpointHost).toBe("192.168.1.87");
    });

    it("is null when the box IP can't be discovered and no fallback is set", async () => {
      (openwrt.vpnStatus as any).mockResolvedValue(null);
      (openwrt.fetchNetworkSummary as any).mockResolvedValue({
        wan: { present: false, "ipv4-address": [] },
      });
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/vpn/status");
      expect(res.status).toBe(200);
      expect(res.body.homeEndpointHost).toBeNull();
    });

    it("falls back to WIREGUARD_HOME_ENDPOINT_HOST when the summary has no WAN IP", async () => {
      (openwrt.vpnStatus as any).mockResolvedValue(null);
      (openwrt.fetchNetworkSummary as any).mockResolvedValue({
        wan: { present: false, "ipv4-address": [] },
      });
      const orig = (config as any).WIREGUARD_HOME_ENDPOINT_HOST;
      (config as any).WIREGUARD_HOME_ENDPOINT_HOST = "192.168.1.50";
      try {
        const app = buildApp(createPrismaMock());
        const res = await request(app).get("/api/vpn/status");
        expect(res.body.homeEndpointHost).toBe("192.168.1.50");
      } finally {
        (config as any).WIREGUARD_HOME_ENDPOINT_HOST = orig;
      }
    });

    it("stays null (never crashes) when the routing summary lookup fails", async () => {
      (openwrt.vpnStatus as any).mockResolvedValue(null);
      (openwrt.fetchNetworkSummary as any).mockRejectedValue(new Error("routing down"));
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/vpn/status");
      expect(res.status).toBe(200);
      expect(res.body.homeEndpointHost).toBeNull();
    });
  });
});

describe("GET /api/vpn/status — routing service unavailable (WARP-1283)", () => {
  // Every other input to the status handler already degrades gracefully, but
  // vpnStatus() throws a typed RouterError when the routing sidecar can't be
  // reached. The wizard's Remote Access precheck needs to tell that soft,
  // recoverable condition ("the box's network service is still coming up —
  // try again in a minute") apart from a genuine orchestrator fault, so the
  // route answers 503 + a stable code with customer-safe copy instead of
  // falling through to next(err). UNREACHABLE / TIMEOUT / DISABLED are the
  // WARP-807 unavailability codes (mirrors the dashboard's
  // ROUTER_UNREACHABLE_CODES).
  it.each([
    ["UNREACHABLE", openwrt.RouterError.unreachable("VPN status: fetch failed")],
    ["TIMEOUT", openwrt.RouterError.timeout("VPN status: timed out")],
    ["DISABLED", openwrt.RouterError.disabled("VPN status")],
  ])(
    "returns 503 + code ROUTING_UNAVAILABLE when vpnStatus throws %s",
    async (_code, thrown) => {
      (openwrt.vpnStatus as any).mockRejectedValue(thrown);
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/vpn/status");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("ROUTING_UNAVAILABLE");
      // Customer-safe copy (ADR-002): calm, no transport internals.
      expect(res.body.error).toMatch(/isn't responding right now/i);
      expect(res.body.error).not.toMatch(/fetch failed|timed out|RouterError/i);
    },
  );

  it("still forwards a genuinely unexpected error to next(err) (500 path unchanged)", async () => {
    (openwrt.vpnStatus as any).mockRejectedValue(new Error("kaboom"));
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/vpn/status");
    expect(res.status).toBe(500);
    expect(res.body.code).toBeUndefined();
    expect(res.body.error).toBe("kaboom");
  });

  it("does not swallow a non-availability RouterError (AUTH) into ROUTING_UNAVAILABLE", async () => {
    (openwrt.vpnStatus as any).mockRejectedValue(
      openwrt.RouterError.auth("VPN status: 401 Unauthorized", { status: 401 }),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/vpn/status");
    // buildApp's error handler echoes err.status — the route must have passed
    // the AUTH error through to next(err) untouched.
    expect(res.status).toBe(401);
    expect(res.body.code).not.toBe("ROUTING_UNAVAILABLE");
  });
});

describe("GET /api/vpn/peers", () => {
  it("scopes to the calling user's peers by default", async () => {
    // WARP-171: explicit family-tier caller — the per-user scoping
    // (`!isAdmin(req) ? { userId: user.username } : {}`) still
    // applies for GETs; only write routes were tightened to
    // owner+admin. Default test user changed to owner in WARP-171
    // so non-WARP-171 tests don't hit the guard.
    const prisma = createPrismaMock();
    prisma.rows.push(
      { id: "p1", userId: "alice", deviceLabel: "phone", publicKey: "A=", assignedIp: "10.13.13.5", status: "active", createdAt: new Date(1) },
      { id: "p2", userId: "bob", deviceLabel: "laptop", publicKey: "B=", assignedIp: "10.13.13.6", status: "active", createdAt: new Date(2) },
    );
    const app = buildApp(prisma, { username: "alice", role: "family" });
    const res = await request(app).get("/api/vpn/peers");
    expect(res.status).toBe(200);
    expect(res.body.peers.map((p: any) => p.id)).toEqual(["p1"]);
  });

  it("returns all peers for an admin", async () => {
    const prisma = createPrismaMock();
    prisma.rows.push(
      { id: "p1", userId: "alice", deviceLabel: "phone", publicKey: "A=", assignedIp: "10.13.13.5", status: "active", createdAt: new Date(1) },
      { id: "p2", userId: "bob", deviceLabel: "laptop", publicKey: "B=", assignedIp: "10.13.13.6", status: "active", createdAt: new Date(2) },
    );
    const app = buildApp(prisma, { username: "admin", role: "owner" });
    const res = await request(app).get("/api/vpn/peers");
    expect(res.body.peers.map((p: any) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  // WARP-1763 — the DTO an owner needs to MANAGE a QR-linked device.
  //
  // Route-level on purpose. `vpn-live-peers.test.ts` pins the never-vs-unknown
  // logic in isolation, but the failure this feature actually had was one of
  // WIRING: the columns existed on the row and were simply not selected into
  // the response, so the dashboard had nothing to render. A unit test of the
  // helper would have passed the whole time.
  describe("overlay provenance + live state (WARP-1763)", () => {
    const OVERLAY_ROW = {
      id: "p-overlay",
      userId: "overlay",
      deviceLabel: "Alice's iPhone",
      publicKey: "OVERLAY_KEY=",
      assignedIp: "10.13.13.9",
      status: "active",
      mode: "overlay",
      kind: "overlay",
      createdAt: new Date(3),
      revokedAt: null,
      linkTokenLabel: "Alice's iPhone",
      linkTokenEnrolledBy: "admin",
      enrolledAt: new Date(3),
      lastSessionAt: new Date(3),
    };

    it("carries kind + link-token provenance so a QR device is identifiable", async () => {
      const prisma = createPrismaMock();
      prisma.rows.push({ ...OVERLAY_ROW });
      vi.mocked(openwrt.listVpnPeers).mockResolvedValue([
        { public_key: "OVERLAY_KEY=", latest_handshake: 1_754_000_000 } as any,
      ]);

      const app = buildApp(prisma, { username: "admin", role: "owner" });
      const res = await request(app).get("/api/vpn/peers");

      expect(res.status).toBe(200);
      const peer = res.body.peers[0];
      expect(peer.kind).toBe("overlay");
      expect(peer.linkTokenEnrolledBy).toBe("admin");
      expect(peer.linkTokenLabel).toBe("Alice's iPhone");
      expect(peer.enrolledAt).toBeTruthy();
      expect(res.body.liveStateAvailable).toBe(true);
      expect(peer.provisioned).toBe(true);
      expect(peer.lastHandshakeAt).toBe(new Date(1_754_000_000_000).toISOString());
    });

    it("never leaks lastSessionAt as if it were a handshake", async () => {
      // It is stamped at APPROVAL time (the idle-expiry clock). Shipping it
      // would let a client render a just-approved device as connected, which
      // is the exact defect this ticket removes.
      const prisma = createPrismaMock();
      prisma.rows.push({ ...OVERLAY_ROW });
      vi.mocked(openwrt.listVpnPeers).mockResolvedValue([]);

      const app = buildApp(prisma, { username: "admin", role: "owner" });
      const res = await request(app).get("/api/vpn/peers");

      expect(res.body.peers[0]).not.toHaveProperty("lastSessionAt");
    });

    it("reports a DB-active peer the interface does not carry as unprovisioned", async () => {
      const prisma = createPrismaMock();
      prisma.rows.push({ ...OVERLAY_ROW });
      vi.mocked(openwrt.listVpnPeers).mockResolvedValue([]);

      const app = buildApp(prisma, { username: "admin", role: "owner" });
      const res = await request(app).get("/api/vpn/peers");

      expect(res.body.liveStateAvailable).toBe(true);
      expect(res.body.peers[0].provisioned).toBe(false);
      expect(res.body.peers[0]).not.toHaveProperty("lastHandshakeAt");
    });

    it("still lists devices — with live state withheld — when routing is down", async () => {
      // The list IS the revoke surface. A sidecar restart must not take away
      // the owner's ability to cut a device off, and must not report every
      // device as never-connected on the way.
      const prisma = createPrismaMock();
      prisma.rows.push({ ...OVERLAY_ROW });
      vi.mocked(openwrt.listVpnPeers).mockRejectedValue(new Error("routing down"));

      const app = buildApp(prisma, { username: "admin", role: "owner" });
      const res = await request(app).get("/api/vpn/peers");

      expect(res.status).toBe(200);
      expect(res.body.peers).toHaveLength(1);
      expect(res.body.liveStateAvailable).toBe(false);
      expect(res.body.peers[0]).not.toHaveProperty("provisioned");
      expect(res.body.peers[0]).not.toHaveProperty("lastHandshakeAt");
    });
  });
});

describe("POST /api/vpn/peers", () => {
  function setupHappyPath() {
    (openwrt.vpnSetup as any).mockResolvedValue({
      status: "ok",
      created: false,
      interface: "wg0",
      public_key: "SERVERPUB=",
      listen_port: 51820,
      addresses: ["10.13.13.1/24"],
    });
    (openwrt.createVpnPeer as any).mockResolvedValue({
      status: "ok",
      interface: "wg0",
      public_key: "PEERPUB=",
      private_key: "PEERPRIV=",
      allowed_ips: ["10.13.13.5/32"],
      description: "iPhone",
      persistent_keepalive: 25,
    });
  }

  it("rejects missing deviceLabel", async () => {
    setupHappyPath();
    const app = buildApp(createPrismaMock());
    const res = await request(app).post("/api/vpn/peers").send({});
    expect(res.status).toBe(400);
  });

  it("mints a peer end-to-end and returns a renderable .conf", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/vpn/peers")
      .send({ deviceLabel: "iPhone" });
    expect(res.status).toBe(201);
    expect(res.body.peer).toMatchObject({
      userId: "alice",
      deviceLabel: "iPhone",
      publicKey: "PEERPUB=",
      assignedIp: "10.13.13.2", // first free in /24 (server takes .1)
      status: "active",
    });
    // .conf must contain the priv key + server pubkey + endpoint host.
    expect(res.body.conf).toContain("PrivateKey = PEERPRIV=");
    expect(res.body.conf).toContain("PublicKey = SERVERPUB=");
    expect(res.body.conf).toContain("Endpoint = vpn.example.com:51820");
    expect(res.body.conf).toContain("Address = 10.13.13.2/32");
    expect(res.body.conf).toContain("AllowedIPs = 192.168.50.0/24, 10.13.13.0/24");
    expect(prisma.rows).toHaveLength(1);
  });

  it("includes offLanReachable on the created-peer response (WARP-993)", async () => {
    setupHappyPath();
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/vpn/peers")
      .send({ deviceLabel: "iPhone" });
    expect(res.status).toBe(201);
    // Fixture default: public operator override, no FQDN → reachable off-LAN.
    expect(res.body.offLanReachable).toBe(true);
  });

  it("allocates the next free IP, skipping reserved + active peers", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    prisma.rows.push(
      // .2 and .3 are taken; allocator should hand out .4
      { id: "p1", userId: "alice", deviceLabel: "phone", publicKey: "A=", assignedIp: "10.13.13.2", status: "active", createdAt: new Date(1) },
      { id: "p2", userId: "alice", deviceLabel: "laptop", publicKey: "B=", assignedIp: "10.13.13.3", status: "active", createdAt: new Date(2) },
      // Revoked peer's IP is free for re-use
      { id: "p3", userId: "alice", deviceLabel: "old", publicKey: "C=", assignedIp: "10.13.13.4", status: "revoked", createdAt: new Date(3) },
    );
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/vpn/peers")
      .send({ deviceLabel: "new" });
    expect(res.status).toBe(201);
    // .4 is revoked → reusable, so allocator picks it.
    expect(res.body.peer.assignedIp).toBe("10.13.13.4");
  });

  it("returns 503 if WIREGUARD_ENDPOINT_HOST is empty", async () => {
    setupHappyPath();
    // Override config inside this test only.
    const { config } = await import("../config.js");
    const origHost = config.WIREGUARD_ENDPOINT_HOST;
    (config as any).WIREGUARD_ENDPOINT_HOST = "";
    try {
      const app = buildApp(createPrismaMock());
      const res = await request(app)
        .post("/api/vpn/peers")
        .send({ deviceLabel: "iPhone" });
      expect(res.status).toBe(503);
      // Error message points the operator at WIREGUARD_ENDPOINT_HOST.
      expect(res.body.error).toMatch(/WIREGUARD_ENDPOINT_HOST/);
      // Routing service must NOT be called when endpoint is unset; we don't
      // want to leak a peer on the router that nobody can dial.
      expect(openwrt.createVpnPeer).not.toHaveBeenCalled();
    } finally {
      (config as any).WIREGUARD_ENDPOINT_HOST = origHost;
    }
  });

  it("rolls back the routing-side peer when DB persist fails", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    // Force a P2002 by pre-inserting a row with the same publicKey.
    prisma.rows.push({
      id: "preexisting",
      userId: "someoneelse",
      deviceLabel: "x",
      publicKey: "PEERPUB=",
      assignedIp: "10.13.13.99",
      status: "active",
      createdAt: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/vpn/peers")
      .send({ deviceLabel: "iPhone" });
    expect(res.status).toBe(500);
    // Ensure the rollback delete was attempted with the orphan pubkey.
    expect(openwrt.deleteVpnPeer).toHaveBeenCalledWith({ publicKey: "PEERPUB=" });
  });

  // Away mode is the default: an omitted `mode` must persist "away" so existing
  // clients and existing rows are unchanged.
  it("defaults mode to 'away' and persists it", async () => {
    setupHappyPath();
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/vpn/peers")
      .send({ deviceLabel: "iPhone" });
    expect(res.status).toBe(201);
    expect(res.body.peer.mode).toBe("away");
    expect(prisma.rows[0].mode).toBe("away");
    // Away-mode conf shape is unchanged (regression).
    expect(res.body.conf).toContain("Endpoint = vpn.example.com:51820");
    expect(res.body.conf).toContain("AllowedIPs = 192.168.50.0/24, 10.13.13.0/24");
  });

  it("rejects an unknown mode value", async () => {
    setupHappyPath();
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/vpn/peers")
      .send({ deviceLabel: "iPhone", mode: "sideways" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/vpn/peers — home mode (hybrid P1)", () => {
  function setupHappyPath() {
    (openwrt.vpnSetup as any).mockResolvedValue({
      status: "ok",
      created: false,
      interface: "wg0",
      public_key: "SERVERPUB=",
      listen_port: 51820,
      addresses: ["10.13.13.1/24"],
    });
    (openwrt.createVpnPeer as any).mockResolvedValue({
      status: "ok",
      interface: "wg0",
      public_key: "PEERPUB=",
      private_key: "PEERPRIV=",
      allowed_ips: ["10.13.13.5/32"],
      description: "iPhone",
      persistent_keepalive: 25,
    });
  }

  it("mints a home-mode peer that dials the discovered LAN IP with split-tunnel + split-horizon DNS", async () => {
    setupHappyPath();
    (openwrt.fetchNetworkSummary as any).mockResolvedValue({
      wan: { present: true, "ipv4-address": [{ address: "192.168.1.87", mask: 24 }] },
    });
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/vpn/peers")
      .send({ deviceLabel: "iPhone", mode: "home" });
    expect(res.status).toBe(201);
    // Endpoint = box home-facing LAN IP (discovered), NOT the public FQDN host.
    expect(res.body.conf).toContain("Endpoint = 192.168.1.87:51820");
    // DNS = split-horizon resolver so the FQDN resolves over the tunnel.
    expect(res.body.conf).toContain("DNS = 192.168.20.1");
    // Split-tunnel to the box subnet + the VPN subnet — never 0.0.0.0/0, never
    // the away-mode LAN CIDR.
    expect(res.body.conf).toContain("AllowedIPs = 192.168.20.0/24, 10.13.13.0/24");
    expect(res.body.conf).not.toContain("0.0.0.0/0");
    expect(res.body.conf).not.toContain("192.168.50.0/24");
    // Mode persisted.
    expect(res.body.peer.mode).toBe("home");
    expect(prisma.rows[0].mode).toBe("home");
  });

  it("falls back to WIREGUARD_HOME_ENDPOINT_HOST when the box IP isn't discovered", async () => {
    setupHappyPath();
    (openwrt.fetchNetworkSummary as any).mockResolvedValue({
      wan: { present: false, "ipv4-address": [] },
    });
    const orig = (config as any).WIREGUARD_HOME_ENDPOINT_HOST;
    (config as any).WIREGUARD_HOME_ENDPOINT_HOST = "192.168.1.99";
    try {
      const app = buildApp(createPrismaMock());
      const res = await request(app)
        .post("/api/vpn/peers")
        .send({ deviceLabel: "iPhone", mode: "home" });
      expect(res.status).toBe(201);
      expect(res.body.conf).toContain("Endpoint = 192.168.1.99:51820");
    } finally {
      (config as any).WIREGUARD_HOME_ENDPOINT_HOST = orig;
    }
  });

  it("returns 503 with a clear error (and mints NOTHING) when the box IP can't be discovered", async () => {
    setupHappyPath();
    (openwrt.fetchNetworkSummary as any).mockResolvedValue({
      wan: { present: false, "ipv4-address": [] },
    });
    // No config fallback → honest failure rather than a wrong guess.
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/vpn/peers")
      .send({ deviceLabel: "iPhone", mode: "home" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/home[- ]?facing|LAN IP|WIREGUARD_HOME_ENDPOINT_HOST/i);
    // Must not leak a router-side peer nobody can dial.
    expect(openwrt.createVpnPeer).not.toHaveBeenCalled();
  });

  it("does NOT require the away-mode public endpoint to be configured", async () => {
    setupHappyPath();
    (openwrt.fetchNetworkSummary as any).mockResolvedValue({
      wan: { present: true, "ipv4-address": [{ address: "192.168.1.87", mask: 24 }] },
    });
    // Home mode reaches the box on-LAN, so an empty public endpoint host must
    // NOT block it (unlike away mode, which 503s without one).
    const origHost = config.WIREGUARD_ENDPOINT_HOST;
    const origFqdn = (config as any).DROPLET_PUBLIC_FQDN;
    (config as any).WIREGUARD_ENDPOINT_HOST = "";
    (config as any).DROPLET_PUBLIC_FQDN = "";
    try {
      const app = buildApp(createPrismaMock());
      const res = await request(app)
        .post("/api/vpn/peers")
        .send({ deviceLabel: "iPhone", mode: "home" });
      expect(res.status).toBe(201);
      expect(res.body.conf).toContain("Endpoint = 192.168.1.87:51820");
    } finally {
      (config as any).WIREGUARD_ENDPOINT_HOST = origHost;
      (config as any).DROPLET_PUBLIC_FQDN = origFqdn;
    }
  });
});

describe("DELETE /api/vpn/peers/:id", () => {
  it("404s on unknown id", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app).delete("/api/vpn/peers/nope");
    expect(res.status).toBe(404);
  });

  it("403s a family-tier caller (WARP-171 — VPN write is owner+admin only)", async () => {
    // Pre-WARP-171 this test exercised the per-resource ownership
    // guard ("you can delete YOUR peer but not bob's"). After WARP-171
    // the route-level guard rejects every family-tier caller at the
    // door — they don't even reach the ownership check. The 403 still
    // happens, just from `requireRole("owner", "admin")` instead.
    const prisma = createPrismaMock();
    prisma.rows.push({
      id: "p1", userId: "bob", deviceLabel: "phone", publicKey: "A=", assignedIp: "10.13.13.5", status: "active", createdAt: new Date(),
    });
    const app = buildApp(prisma, { username: "alice", role: "family" });
    const res = await request(app).delete("/api/vpn/peers/p1");
    expect(res.status).toBe(403);
  });

  it("revokes own peer and deletes from router", async () => {
    (openwrt.deleteVpnPeer as any).mockResolvedValue({
      status: "ok",
      interface: "wg0",
      removed: 1,
    });
    const prisma = createPrismaMock();
    prisma.rows.push({
      id: "p1", userId: "alice", deviceLabel: "phone", publicKey: "A=", assignedIp: "10.13.13.5", status: "active", createdAt: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app).delete("/api/vpn/peers/p1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "revoked", id: "p1" });
    expect(openwrt.deleteVpnPeer).toHaveBeenCalledWith({ publicKey: "A=" });
    expect(prisma.rows[0].status).toBe("revoked");
    expect(prisma.rows[0].revokedAt).toBeInstanceOf(Date);
  });

  it("is idempotent on already-revoked peers", async () => {
    const prisma = createPrismaMock();
    prisma.rows.push({
      id: "p1", userId: "alice", deviceLabel: "phone", publicKey: "A=", assignedIp: "10.13.13.5", status: "revoked", createdAt: new Date(), revokedAt: new Date(),
    });
    const app = buildApp(prisma);
    const res = await request(app).delete("/api/vpn/peers/p1");
    expect(res.status).toBe(200);
    expect(openwrt.deleteVpnPeer).not.toHaveBeenCalled();
  });
});
