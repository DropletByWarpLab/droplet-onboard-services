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
      // WARP-1337: pool-create seeds the customer's displayName via upsert.
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = pools.get(where.device);
        const row = existing
          ? { ...existing, ...update }
          : { device: where.device, status: "none", notes: null, ...create };
        pools.set(where.device, row);
        return row;
      }),
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

  // WARP-662 — drive_adopt goes through the SAME gated flow as the pool ops.
  // WARP-857 item 3 — pool_create members are tightened to WHOLE disks and must
  // be distinct physical disks (defense in depth). A partition member, an
  // md/injection token, or a repeated disk is rejected at the edge before it can
  // reach the destructive host script.
  it("rejects a partition / md / injection member (whole-disk only)", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    for (const bad of [
      ["/dev/sda1", "/dev/sdb"],
      ["/dev/md0", "/dev/sdb"],
      ["/dev/sda; rm -rf /", "/dev/sdb"],
      ["/dev/mapper/vg-root", "/dev/sdb"],
    ]) {
      const res = await request(app)
        .post("/api/storage/pools")
        .send({ device: "md0", level: "raid1", members: bad, confirmPhrase: "ERASE go" });
      expect(res.status).toBe(400);
    }
    const hit = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(hit).toBe(false);
  });

  it("rejects two members on the same physical disk (unique parent disks)", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const res = await request(app)
      .post("/api/storage/pools")
      .send({
        device: "md0",
        level: "raid1",
        members: ["/dev/sda", "/dev/sda"],
        confirmPhrase: "ERASE sda sda",
      });
    expect(res.status).toBe(400);
    const hit = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(hit).toBe(false);
  });

  it("drive adopt returns 202 + a confirm token, and does NOT touch the bridge yet", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const res = await request(app)
      .post("/api/storage/drives/adopt")
      .send({ device: "sdb", fstype: "ext4", wipeMethod: "quick", confirmPhrase: "ERASE sdb" });
    expect(res.status).toBe(202);
    expect(res.body.confirmationToken).toBeTruthy();
    expect(res.body.service).toBe("drive_adopt");
    const hit = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(hit).toBe(false);
  });

  it("drive adopt confirm with a matching token reaches the bridge and executes", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const create = await request(app)
      .post("/api/storage/drives/adopt")
      .send({ device: "sdb", wipeMethod: "secure", confirmPhrase: "ERASE sdb" });
    const token = create.body.confirmationToken;
    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({ confirmationToken: token, service: "drive_adopt", resourceId: "sdb" });
    expect(confirm.status).toBe(200);
    const hit = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(hit).toBe(true);
  });

  it("drive adopt rejects a partition / md / injection device (whole-disk only)", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    for (const bad of ["sdb1", "md0", "/dev/sdb", "sdb; rm -rf /"]) {
      const res = await request(app)
        .post("/api/storage/drives/adopt")
        .send({ device: bad, confirmPhrase: `ERASE ${bad}` });
      expect(res.status).toBe(400);
    }
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

  // WARP-828 — the Settings "Danger Zone" reformat-a-drive flow reuses this
  // same drive_adopt → confirm path. The owner gate has to hold on the SERVER,
  // never on the client: a family/guest session must be refused at BOTH the
  // mint (adopt) and the execute (confirm) step, and the bridge must never be
  // touched. Mirrors the eject/rescan "forbids non-admins" tests, generalised
  // to the two-step destructive flow these routes carry.
  it("drive adopt is refused for a non-owner/non-admin (family) and never reaches the bridge", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    // Real requireRole gate: inject a family-role session, not the owner stub.
    vi.stubGlobal("fetch", bridge);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: "fam-1", role: "family" };
      next();
    });
    app.use("/api", createStorageRouter(prisma));

    const res = await request(app)
      .post("/api/storage/drives/adopt")
      .send({ device: "sdb", wipeMethod: "quick", confirmPhrase: "ERASE sdb" });
    expect(res.status).toBe(403);
    const hit = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(hit).toBe(false);
  });

  it("storage command confirm is refused for a non-owner/non-admin (family)", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    vi.stubGlobal("fetch", bridge);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: "guest-1", role: "guest" };
      next();
    });
    app.use("/api", createStorageRouter(prisma));

    // Even with a plausible-looking token the role gate must reject before the
    // token is ever evaluated, and the bridge must stay untouched.
    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({ confirmationToken: "a".repeat(64), service: "drive_adopt", resourceId: "sdb" });
    expect(confirm.status).toBe(403);
    const hit = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(hit).toBe(false);
  });

  // WARP-828 — an EXPIRED token must be refused (the Danger Zone holds the
  // owner on screen for the type-to-confirm friction, which can outlive the
  // 60s token). The safety service stamps expiresAt; we force the clock past it
  // and assert the confirm is rejected and the bridge is never touched.
  it("drive adopt confirm with an EXPIRED token is refused and never reaches the bridge", async () => {
    vi.useFakeTimers();
    try {
      const prisma = createPrismaMock();
      const bridge = bridgePoolsResponse([]);
      const app = makeApp(prisma, bridge);
      const create = await request(app)
        .post("/api/storage/drives/adopt")
        .send({ device: "sdb", wipeMethod: "quick", confirmPhrase: "ERASE sdb" });
      expect(create.status).toBe(202);
      const token = create.body.confirmationToken;

      // STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS is 60s; jump well past it.
      vi.advanceTimersByTime(120_000);

      const confirm = await request(app)
        .post("/api/storage/command/confirm")
        .send({ confirmationToken: token, service: "drive_adopt", resourceId: "sdb" });
      expect(confirm.status).toBe(400);
      expect(confirm.body.code).toBe("TOKEN_EXPIRED");
      const hit = (bridge as any).mock.calls.some((c: any[]) =>
        String(c[0]).endsWith("/pools/command"),
      );
      expect(hit).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// WARP-1338 review — pool_format's fstype must be pinned to the SAME
// allow-list adopt/reclaim already use (ext4/xfs/btrfs — every mkfs there
// accepts `-L`). The old shape-only regex (/^[a-z0-9]{1,12}$/) admitted
// fstypes whose mkfs doesn't take -L (vfat uses -n), and pool_format now
// unconditionally runs `mkfs.$FSTYPE -L pool` — so a loose fstype that used
// to format would now fail the op on the host. Reject at the edge instead.
describe("POST /api/storage/pools/:device/format — pinned fstype allow-list", () => {
  it("accepts the pinned fstypes (and an omitted fstype, defaulting downstream)", async () => {
    for (const good of [undefined, "ext4", "xfs", "btrfs"]) {
      const prisma = createPrismaMock();
      const app = makeApp(prisma, bridgePoolsResponse([]));
      const res = await request(app)
        .post("/api/storage/pools/md0/format")
        .send({ ...(good ? { fstype: good } : {}), confirmPhrase: "ERASE md0" });
      expect(res.status, `fstype=${good}`).toBe(202);
      expect(res.body.confirmationToken).toBeTruthy();
    }
  });

  it("rejects a shape-valid fstype whose mkfs cannot -L (vfat et al) and never mints a token", async () => {
    for (const bad of ["vfat", "exfat", "f2fs", "ntfs", "EXT4", "ext4; rm -rf /"]) {
      const prisma = createPrismaMock();
      const bridge = bridgePoolsResponse([]);
      const app = makeApp(prisma, bridge);
      const res = await request(app)
        .post("/api/storage/pools/md0/format")
        .send({ fstype: bad, confirmPhrase: "ERASE md0" });
      expect(res.status, `fstype=${bad}`).toBe(400);
      expect(res.body.confirmationToken).toBeUndefined();
      const hit = (bridge as any).mock.calls.some((c: any[]) =>
        String(c[0]).endsWith("/pools/command"),
      );
      expect(hit).toBe(false);
    }
  });
});

// WARP-2097 — pool_format must carry the owner's chosen fs label. Same
// validator and same conditional-forward shape adopt/reclaim already use. The
// label is what reaches the FILESYSTEM (and therefore the mount tail, the
// Nextcloud folder and every /files?path= deep link); the StoragePool PATCH
// rename is DB-only and can reach none of those. Assertions are on the PARAMS
// the bridge actually receives — a status-code-only test stays green if the
// route silently drops the field.
describe("POST /api/storage/pools/:device/format — optional fs label (WARP-2097)", () => {
  /** The params object the route forwarded to the bridge's /pools/command. */
  function bridgeParams(bridge: any): any {
    const call = bridge.mock.calls.find((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    if (!call) return null;
    return JSON.parse(String(call[1]?.body ?? "{}")).params ?? null;
  }

  it("forwards a valid label through the confirm token into the bridge params", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const res = await request(app)
      .post("/api/storage/pools/md0/format")
      .send({ fstype: "ext4", label: "Family_Photos", confirmPhrase: "ERASE md0" });
    expect(res.status).toBe(202);
    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({
        confirmationToken: res.body.confirmationToken,
        service: "pool_format",
        resourceId: "md0",
      });
    expect(confirm.status).toBe(200);
    expect(bridgeParams(bridge)).toMatchObject({ label: "Family_Photos" });
  });

  it("omits the label key entirely when the caller sends none", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const res = await request(app)
      .post("/api/storage/pools/md0/format")
      .send({ fstype: "ext4", confirmPhrase: "ERASE md0" });
    expect(res.status).toBe(202);
    await request(app)
      .post("/api/storage/command/confirm")
      .send({
        confirmationToken: res.body.confirmationToken,
        service: "pool_format",
        resourceId: "md0",
      });
    // Absent, not empty-string: the host script falls back to "pool" only when
    // LABEL is unset/empty, and an empty label would mount at "drive-<uuid>".
    expect(bridgeParams(bridge)).not.toHaveProperty("label");
  });

  it("rejects an out-of-contract label with 400 and never mints a token", async () => {
    for (const bad of [
      "way-too-long-a-label-here", // >16 chars
      "has spaces",
      "slash/es",
      "semi;colon",
      "", // empty string is not a name
    ]) {
      const prisma = createPrismaMock();
      const bridge = bridgePoolsResponse([]);
      const app = makeApp(prisma, bridge);
      const res = await request(app)
        .post("/api/storage/pools/md0/format")
        .send({ fstype: "ext4", label: bad, confirmPhrase: "ERASE md0" });
      expect(res.status, `label=${JSON.stringify(bad)}`).toBe(400);
      expect(res.body.confirmationToken).toBeUndefined();
      const hit = (bridge as any).mock.calls.some((c: any[]) =>
        String(c[0]).endsWith("/pools/command"),
      );
      expect(hit).toBe(false);
    }
  });
});
// WARP-1337 — POST /api/storage/pools accepts an optional customer-facing
// displayName. Zod-validated BEFORE any prisma call (pre-DB gate); carried in
// the confirm-token params (never forwarded to the bridge — the host script
// has no such parameter) and, on a successful CONFIRM/execute, seeds the
// StoragePool row keyed by the md device so the new pool is born named
// instead of waiting for a later PATCH rename.
describe("POST /api/storage/pools — optional displayName seeding (WARP-1337)", () => {
  it("create-with-name seeds the StoragePool row on confirm and GET returns it", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([
      { device: "md0", level: "raid1", status: "active", members: ["sda", "sdb"] },
    ]);
    const app = makeApp(prisma, bridge);
    const create = await request(app)
      .post("/api/storage/pools")
      .send({
        device: "md0",
        level: "raid1",
        members: ["/dev/sda", "/dev/sdb"],
        confirmPhrase: "ERASE sda sdb",
        displayName: "Family Vault",
      });
    expect(create.status).toBe(202);

    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({
        confirmationToken: create.body.confirmationToken,
        service: "pool_create",
        resourceId: "md0",
      });
    expect(confirm.status).toBe(200);

    // The row exists, keyed by mdDevice, with the customer's name + the
    // validated level (an explicit enum column — never a host default).
    expect(prisma.pools.get("md0")).toMatchObject({
      device: "md0",
      displayName: "Family Vault",
      level: "raid1",
    });

    // And the read path joins it, exactly like a PATCH-renamed pool.
    const list = await request(app).get("/api/storage/pools");
    expect(list.status).toBe(200);
    expect(list.body.pools[0].displayName).toBe("Family Vault");
  });

  // Code review (WARP-1337): pool_delete leaves the StoragePool row behind, so
  // a RECREATE of the same md device at a different RAID level hits the
  // upsert's update branch — which must refresh `level` too, not just
  // displayName, or the row keeps the deleted pool's stale level forever
  // (GET reads level from the live bridge, but the DB column must not lie).
  it("refreshes a stale level when the pool is recreated at a different RAID level", async () => {
    const prisma = createPrismaMock();
    // Stale row from a pool that was deleted on the host: raid5, old name.
    prisma.pools.set("md0", {
      device: "md0",
      displayName: "Old Vault",
      level: "raid5",
      status: "none",
      notes: null,
    });
    const app = makeApp(prisma, bridgePoolsResponse([]));
    const create = await request(app)
      .post("/api/storage/pools")
      .send({
        device: "md0",
        level: "raid1",
        members: ["/dev/sda", "/dev/sdb"],
        confirmPhrase: "ERASE sda sdb",
        displayName: "Family Vault",
      });
    expect(create.status).toBe(202);
    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({
        confirmationToken: create.body.confirmationToken,
        service: "pool_create",
        resourceId: "md0",
      });
    expect(confirm.status).toBe(200);
    expect(prisma.pools.get("md0")).toMatchObject({
      device: "md0",
      displayName: "Family Vault",
      level: "raid1",
    });
  });

  it("never forwards displayName to the bridge (host script has no such param)", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const create = await request(app)
      .post("/api/storage/pools")
      .send({
        device: "md0",
        level: "raid1",
        members: ["/dev/sda", "/dev/sdb"],
        confirmPhrase: "ERASE sda sdb",
        displayName: "Family Vault",
      });
    await request(app)
      .post("/api/storage/command/confirm")
      .send({
        confirmationToken: create.body.confirmationToken,
        service: "pool_create",
        resourceId: "md0",
      });
    const cmdCall = (bridge as any).mock.calls.find((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(cmdCall).toBeTruthy();
    const sent = JSON.parse(cmdCall[1].body);
    expect(sent.params.displayName).toBeUndefined();
    expect(sent.params.level).toBe("raid1");
    expect(sent.params.members).toEqual(["/dev/sda", "/dev/sdb"]);
  });

  it("rejects an invalid displayName with 400 BEFORE minting a token (pre-DB zod gate)", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    for (const bad of [42, "x".repeat(65), ""]) {
      const res = await request(app)
        .post("/api/storage/pools")
        .send({
          device: "md0",
          level: "raid1",
          members: ["/dev/sda", "/dev/sdb"],
          confirmPhrase: "ERASE sda sdb",
          displayName: bad,
        });
      expect(res.status).toBe(400);
      expect(res.body.confirmationToken).toBeUndefined();
    }
    expect(prisma.storagePool.upsert).not.toHaveBeenCalled();
  });

  it("create WITHOUT a displayName seeds no phantom StoragePool row", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const create = await request(app)
      .post("/api/storage/pools")
      .send({
        device: "md0",
        level: "raid1",
        members: ["/dev/sda", "/dev/sdb"],
        confirmPhrase: "ERASE sda sdb",
      });
    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({
        confirmationToken: create.body.confirmationToken,
        service: "pool_create",
        resourceId: "md0",
      });
    expect(confirm.status).toBe(200);
    expect(prisma.storagePool.upsert).not.toHaveBeenCalled();
    expect(prisma.pools.size).toBe(0);
  });
});

// WARP-1048 — reclaim a pool-member drive. Same two-step gated flow as
// drive_adopt; the request additionally carries the owning md array so the
// host script can detach the disk before wiping. Whole-disk device only; md
// must look like md<N>.
describe("POST /api/storage/drives/reclaim (WARP-1048)", () => {
  it("returns 202 + a confirm token bound to drive_reclaim, and does NOT touch the bridge yet", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const res = await request(app)
      .post("/api/storage/drives/reclaim")
      .send({ device: "sda", md: "md127", confirmPhrase: "ERASE sda" });
    expect(res.status).toBe(202);
    expect(res.body.confirmationToken).toBeTruthy();
    expect(res.body.service).toBe("drive_reclaim");
    expect(res.body.resourceId).toBe("sda");
    const hit = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(hit).toBe(false);
  });

  it("confirm with a matching token reaches the bridge and forwards the md param", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    const app = makeApp(prisma, bridge);
    const mint = await request(app)
      .post("/api/storage/drives/reclaim")
      .send({ device: "sda", md: "md127", wipeMethod: "quick", confirmPhrase: "ERASE sda" });
    const token = mint.body.confirmationToken;
    const confirm = await request(app)
      .post("/api/storage/command/confirm")
      .send({ confirmationToken: token, service: "drive_reclaim", resourceId: "sda" });
    expect(confirm.status).toBe(200);
    const cmdCall = (bridge as any).mock.calls.find((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(cmdCall).toBeTruthy();
    const sent = JSON.parse(cmdCall[1].body);
    expect(sent.operation).toBe("drive_reclaim");
    expect(sent.params.md).toBe("md127");
    expect(sent.params.device).toBe("sda");
  });

  it("rejects a bad device (partition / md / injection) — whole-disk only", async () => {
    const prisma = createPrismaMock();
    const app = makeApp(prisma, bridgePoolsResponse([]));
    for (const bad of ["sda1", "md127", "/dev/sda", "sda; rm -rf /"]) {
      const res = await request(app)
        .post("/api/storage/drives/reclaim")
        .send({ device: bad, md: "md127", confirmPhrase: `ERASE ${bad}` });
      expect(res.status).toBe(400);
    }
  });

  it("rejects a bad or missing md array name", async () => {
    const prisma = createPrismaMock();
    const app = makeApp(prisma, bridgePoolsResponse([]));
    for (const badMd of [undefined, "", "sdb", "md127; rm -rf /", "/dev/md127"]) {
      const res = await request(app)
        .post("/api/storage/drives/reclaim")
        .send({ device: "sda", md: badMd, confirmPhrase: "ERASE sda" });
      expect(res.status).toBe(400);
    }
  });

  it("is refused for a non-owner/non-admin (family) and never reaches the bridge", async () => {
    const prisma = createPrismaMock();
    const bridge = bridgePoolsResponse([]);
    vi.stubGlobal("fetch", bridge);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: "fam-1", role: "family" };
      next();
    });
    app.use("/api", createStorageRouter(prisma));
    const res = await request(app)
      .post("/api/storage/drives/reclaim")
      .send({ device: "sda", md: "md127", confirmPhrase: "ERASE sda" });
    expect(res.status).toBe(403);
    const hit = (bridge as any).mock.calls.some((c: any[]) =>
      String(c[0]).endsWith("/pools/command"),
    );
    expect(hit).toBe(false);
  });
});

// WARP-1048 — rename a storage pool. Owner/admin-only, mirrors
// PATCH /storage/drives/:uuid. Upserts the StoragePool row's displayName/notes;
// `level` is required on create, so the route resolves it from the live bridge
// inventory when the row doesn't exist yet.
describe("PATCH /api/storage/pools/:device (WARP-1048 rename)", () => {
  function prismaWithPoolUpsert() {
    const prisma = createPrismaMock();
    prisma.storagePool.upsert = vi.fn(async ({ where, create, update }: any) => {
      const existing = prisma.pools.get(where.device);
      const row = existing
        ? { ...existing, ...update }
        : { device: where.device, status: "none", notes: null, ...create };
      prisma.pools.set(where.device, row);
      return row;
    });
    return prisma;
  }

  it("upserts the owner's displayName and returns the row", async () => {
    const prisma = prismaWithPoolUpsert();
    const app = makeApp(
      prisma,
      bridgePoolsResponse([
        { device: "md127", level: "raid1", status: "resyncing", members: ["sda", "sdb"] },
      ]),
    );
    const res = await request(app)
      .patch("/api/storage/pools/md127")
      .send({ displayName: "Family Vault" });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("Family Vault");
    expect(prisma.storagePool.upsert).toHaveBeenCalledTimes(1);
    // On first create the level is resolved from the live bridge pool (md127
    // is raid1), never a host-specific default.
    const call = (prisma.storagePool.upsert as any).mock.calls[0][0];
    expect(call.create.level).toBe("raid1");
  });

  it("rejects an invalid pool device name", async () => {
    const prisma = prismaWithPoolUpsert();
    const app = makeApp(prisma, bridgePoolsResponse([]));
    const res = await request(app)
      .patch("/api/storage/pools/not-an-md")
      .send({ displayName: "Nope" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty displayName", async () => {
    const prisma = prismaWithPoolUpsert();
    const app = makeApp(
      prisma,
      bridgePoolsResponse([
        { device: "md127", level: "raid1", status: "none", members: ["sda"] },
      ]),
    );
    const res = await request(app)
      .patch("/api/storage/pools/md127")
      .send({ displayName: "   " });
    expect(res.status).toBe(400);
  });

  it("is refused for a non-owner/non-admin (family)", async () => {
    const prisma = prismaWithPoolUpsert();
    vi.stubGlobal("fetch", bridgePoolsResponse([]));
    const app = express();
    app.use(express.json());
    app.use((req: any, _res, next) => {
      req.user = { id: "fam-1", role: "family" };
      next();
    });
    app.use("/api", createStorageRouter(prisma));
    const res = await request(app)
      .patch("/api/storage/pools/md127")
      .send({ displayName: "Family Vault" });
    expect(res.status).toBe(403);
  });
});
