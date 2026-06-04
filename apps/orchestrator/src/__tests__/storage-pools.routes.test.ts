/**
 * BUG-3 / ADR-019 — storage pool routes.
 *
 * Covers:
 *   - GET /api/storage/pools left-joins the StoragePool table onto the
 *     device-bridge GET /pools inventory, and returns an honest empty list
 *     (NOT a fabricated sum) when the bridge reports no array.
 *   - The destructive routes (pool create/destroy/format/...) are owner-gated
 *     and refuse to EXECUTE without a valid confirm token: the create route
 *     returns 202 + token, and only /storage/command/confirm with a matching
 *     token reaches the bridge.
 *   - A confirm with a mismatched {service, resourceId} never reaches the
 *     bridge.
 *
 * Mocks the device-bridge fetch + builds an in-memory Prisma stand-in, exactly
 * like storage.test.ts. No real bridge, no real mdadm.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(async () => null),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetUserQuota: vi.fn(),
}));

import { createStorageRouter } from "../routes/storage.js";

// ── Prisma stand-in: Drive (existing) + StoragePool + PoolMember ──
function createPrismaMock() {
  const pools = new Map<string, any>();
  const members: any[] = [];
  return {
    pools,
    members,
    drive: {
      findMany: vi.fn(async () => []),
    },
    storagePool: {
      findMany: vi.fn(async () => [...pools.values()]),
      findUnique: vi.fn(async ({ where }: any) => pools.get(where.device) ?? null),
    },
    poolMember: {
      findMany: vi.fn(async ({ where }: any = {}) =>
        members.filter((m) => !where?.poolDevice || m.poolDevice === where.poolDevice),
      ),
    },
  } as any;
}

// Owner-session middleware stub: every request is an authenticated owner so we
// exercise the safety-tier gate, not the auth gate (auth is covered elsewhere).
function ownerAuth(req: any, _res: any, next: any) {
  req.user = { id: "owner-1", role: "owner" };
  next();
}

function makeApp(prisma: any, bridgeFetch: typeof fetch) {
  vi.stubGlobal("fetch", bridgeFetch);
  const app = express();
  app.use(express.json());
  app.use(ownerAuth);
  app.use("/api", createStorageRouter(prisma));
  return app;
}

function bridgePoolsResponse(pools: any[]) {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith("/pools")) {
      return {
        ok: true,
        json: async () => ({ pools, count: pools.length, snapshot_at: "2026-06-04T00:00:00Z" }),
      } as any;
    }
    // Destructive POST to the bridge.
    return { ok: true, json: async () => ({ ok: true, device: "md0" }) } as any;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  process.env.BRIDGE_AUTH_TOKEN = "test-bridge-token";
});

describe("GET /api/storage/pools (read-only, honest empty)", () => {
  it("returns the bridge's arrays joined with owner labels", async () => {
    const prisma = createPrismaMock();
    prisma.pools.set("md0", { device: "md0", displayName: "Vault", level: "raid1", status: "active", notes: null });
    const app = makeApp(
      prisma,
      bridgePoolsResponse([
        { device: "md0", level: "raid1", status: "active", members: ["sda", "sdb"] },
      ]),
    );
    const res = await request(app).get("/api/storage/pools");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.pools[0].device).toBe("md0");
    expect(res.body.pools[0].displayName).toBe("Vault");
  });

  it("returns an honest empty list when the bridge reports no array (no fake sum)", async () => {
    const prisma = createPrismaMock();
    const app = makeApp(prisma, bridgePoolsResponse([]));
    const res = await request(app).get("/api/storage/pools");
    expect(res.status).toBe(200);
    expect(res.body.pools).toEqual([]);
    expect(res.body.count).toBe(0);
  });

  it("degrades to an empty list (not a 500) when the bridge is unreachable", async () => {
    const prisma = createPrismaMock();
    const econn = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const app = makeApp(
      prisma,
      vi.fn(async () => {
        throw econn;
      }) as unknown as typeof fetch,
    );
    const res = await request(app).get("/api/storage/pools");
    expect(res.status).toBe(200);
    expect(res.body.pools).toEqual([]);
    expect(res.body.reason).toBe("bridge_unavailable");
  });
});

describe("destructive pool routes — no execution without a valid confirm token", () => {
  it("pool create returns 202 + a confirm token, and does NOT touch the bridge yet", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const res = await request(app)
      .post("/api/storage/pools")
      .send({ device: "md0", level: "raid1", members: ["/dev/sda", "/dev/sdb"], confirmPhrase: "ERASE sda sdb" });
    expect(res.status).toBe(202);
    expect(res.body.confirmationToken).toBeTruthy();
    // The bridge POST /pools/command must NOT have been called during evaluate.
    const calledBridgeCommand = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(calledBridgeCommand).toBe(false);
  });

  it("confirm with a matching token reaches the bridge and executes", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const create = await request(app)
      .post("/api/storage/pools")
      .send({ device: "md0", level: "raid1", members: ["/dev/sda", "/dev/sdb"], confirmPhrase: "ERASE sda sdb" });
    const token = create.body.confirmationToken;

    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({ confirmationToken: token, service: "pool_create", resourceId: "md0" });
    expect(confirm.status).toBe(200);
    const calledBridgeCommand = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(calledBridgeCommand).toBe(true);
  });

  it("confirm with a MISMATCHED resourceId is refused and never reaches the bridge", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const create = await request(app)
      .post("/api/storage/pools")
      .send({ device: "md0", level: "raid1", members: ["/dev/sda", "/dev/sdb"], confirmPhrase: "ERASE sda sdb" });
    const token = create.body.confirmationToken;

    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({ confirmationToken: token, service: "pool_create", resourceId: "md1" });
    expect(confirm.status).toBeGreaterThanOrEqual(400);
    const calledBridgeCommand = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(calledBridgeCommand).toBe(false);
  });

  it("confirm with no/invalid token is refused", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({ confirmationToken: "garbage", service: "pool_create", resourceId: "md0" });
    expect(confirm.status).toBeGreaterThanOrEqual(400);
  });
});
