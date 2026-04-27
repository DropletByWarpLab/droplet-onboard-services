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
    WIREGUARD_VPN_SUBNET: "10.13.13.0/24",
    WIREGUARD_LISTEN_PORT: 51820,
    WIREGUARD_LAN_CIDR: "192.168.50.0/24",
    WIREGUARD_DNS: "192.168.50.1",
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
  };
});

import { createVpnRouter } from "../routes/vpn.js";
import * as openwrt from "../services/openwrt.client.js";

// In-memory Prisma stand-in for the VpnPeer table.
function createPrismaMock() {
  const rows: any[] = [];
  let counter = 0;
  return {
    rows,
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
        const dup = rows.find(
          (r) => r.publicKey === data.publicKey,
        );
        if (dup) {
          const e: any = new Error("Unique constraint failed on publicKey");
          e.code = "P2002";
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
}

function buildApp(prismaMock: any, user = { username: "alice", role: "family" }) {
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
});

describe("GET /api/vpn/peers", () => {
  it("scopes to the calling user's peers by default", async () => {
    const prisma = createPrismaMock();
    prisma.rows.push(
      { id: "p1", userId: "alice", deviceLabel: "phone", publicKey: "A=", assignedIp: "10.13.13.5", status: "active", createdAt: new Date(1) },
      { id: "p2", userId: "bob", deviceLabel: "laptop", publicKey: "B=", assignedIp: "10.13.13.6", status: "active", createdAt: new Date(2) },
    );
    const app = buildApp(prisma);
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
});

describe("DELETE /api/vpn/peers/:id", () => {
  it("404s on unknown id", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app).delete("/api/vpn/peers/nope");
    expect(res.status).toBe(404);
  });

  it("403s when peer belongs to someone else (non-admin)", async () => {
    const prisma = createPrismaMock();
    prisma.rows.push({
      id: "p1", userId: "bob", deviceLabel: "phone", publicKey: "A=", assignedIp: "10.13.13.5", status: "active", createdAt: new Date(),
    });
    const app = buildApp(prisma); // alice
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
