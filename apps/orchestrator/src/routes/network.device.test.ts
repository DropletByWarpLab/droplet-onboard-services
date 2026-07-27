/**
 * WARP-82: supertest coverage for /network/devices + /network/groups.
 *
 * Mocks @prisma/client with an in-memory store (same pattern as
 * device-clients.test.ts) so the routes exercise their real logic —
 * normalizeMac, icon validation, duplicate-name guards, group
 * membership — against a Prisma-shaped stub without a live Postgres.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";
import request from "supertest";

// --- Mocks ---

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    // Makes the `network` module available so the module gate lets /api/network
    // through (network.available = isSet(ROUTING_SERVICE_URL)).
    ROUTING_SERVICE_URL: "http://routing.test",
    AUTH_ENABLED: false,
    // departments.ts (registered by createApp) derefs this at module scope to
    // build RESERVED_NAMES; the real config zod-defaults it, so the mock must
    // carry it too or module load throws on undefined.toLowerCase(). (WARP-1292)
    DROPLET_SHARED_FOLDER_NAME: "Household",
    // camera-retention-purge.service.ts derefs this at module scope;
    // the real config defaults it, so the mock must carry it too.
    FRIGATE_URL: "http://frigate:5000",
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

// Stub the raw OpenWrt client so listDevices' live-snapshot wiring
// resolves to an empty snapshot without trying to reach a real router
// (the client otherwise does its full retry-with-backoff dance).
vi.mock("../services/openwrt.client.js", async () => {
  const actual = await vi.importActual<any>("../services/openwrt.client.js");
  return {
    ...actual,
    fetchDhcpLeases: vi.fn().mockResolvedValue([]),
    fetchWirelessClients: vi.fn().mockResolvedValue([]),
  };
});

// Stub out the live routing-service calls so listDevices doesn't try to
// reach a real OpenWrt. Tests that need a signal overlay wire it
// explicitly via the test helper.
vi.mock("../services/network.service.js", async () => {
  const actual = await vi.importActual<any>("../services/network.service.js");
  return {
    ...actual,
    getConnectedDevices: vi.fn().mockResolvedValue([]),
    getDhcpLeases: vi.fn().mockResolvedValue([]),
    getFirewallConfig: vi.fn().mockResolvedValue({}),
    getNetworkOverview: vi.fn(),
    getWifiSettings: vi.fn(),
    scanWifiNetworks: vi.fn(),
    getSystemInfo: vi.fn(),
    setWifiSsid: vi.fn(),
    setWifiPassword: vi.fn(),
    setWifiChannel: vi.fn(),
    addStaticDhcpLease: vi.fn(),
    blockDevice: vi.fn(),
    unblockDevice: vi.fn(),
    addPortForward: vi.fn(),
    rebootRouter: vi.fn(),
    getRouterOperation: vi.fn(),
    isNetworkInitialized: vi.fn().mockReturnValue(false),
  };
});

// --- In-memory Prisma stand-in ---

type DeviceRow = {
  mac: string;
  displayName: string | null;
  icon: string | null;
  notes: string | null;
  vendor: string | null;
  hostname: string | null;
  lastIp: string | null;
  firstSeen: Date;
  lastSeen: Date;
  // WARP-106: no stored `isBlocked`. The two authored block fields; the
  // service computes `isBlocked = lastAppliedBlocked ?? manualBlock`.
  manualBlock: boolean;
  lastAppliedBlocked: boolean | null;
  groupIds: string[];
};

type GroupRow = {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
};

const deviceStore = new Map<string, DeviceRow>();
const groupStore = new Map<string, GroupRow>();
const presenceStore: Array<{ mac: string; date: Date; seenMinutes: number }> = [];
let groupIdSeq = 0;

function hydrateDevice(row: DeviceRow, include?: any): any {
  const out: any = { ...row };
  if (include?.groups) {
    out.groups = row.groupIds
      .map((id) => groupStore.get(id))
      .filter((g): g is GroupRow => g !== undefined);
  }
  if (include?.presenceDays) {
    const opts = include.presenceDays;
    let rows = presenceStore.filter((p) => p.mac === row.mac);
    if (opts.orderBy?.date === "desc") {
      rows = rows.slice().sort((a, b) => b.date.getTime() - a.date.getTime());
    }
    if (opts.take) rows = rows.slice(0, opts.take);
    out.presenceDays = rows;
  }
  return out;
}

vi.mock("@prisma/client", () => {
  // Defined inside the factory so vitest's top-level hoisting of
  // `vi.mock` doesn't race the class declaration. Mirrors the real
  // `Prisma.PrismaClientKnownRequestError` well enough for the service
  // layer's `instanceof` + `code === "P2025"` check.
  class PrismaClientKnownRequestError extends Error {
    code: string;
    clientVersion: string;
    constructor(
      message: string,
      opts: { code: string; clientVersion: string },
    ) {
      super(message);
      this.name = "PrismaClientKnownRequestError";
      this.code = opts.code;
      this.clientVersion = opts.clientVersion;
    }
  }

  const networkDevice = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(deviceStore.values());
      if (args.where?.groups?.some?.id) {
        const id = args.where.groups.some.id;
        rows = rows.filter((r) => r.groupIds.includes(id));
      }
      return rows.map((r) => hydrateDevice(r, args.include));
    }),
    findUnique: vi.fn(async ({ where, include }: any) => {
      const row = deviceStore.get(where.mac);
      if (!row) return null;
      return hydrateDevice(row, include);
    }),
    update: vi.fn(async ({ where, data, include }: any) => {
      const row = deviceStore.get(where.mac);
      if (!row) throw new Error("not found");
      if (data.displayName !== undefined) row.displayName = data.displayName;
      if (data.icon !== undefined) row.icon = data.icon;
      if (data.notes !== undefined) row.notes = data.notes;
      if (data.groups?.set) {
        row.groupIds = data.groups.set.map((g: { id: string }) => g.id);
      }
      return hydrateDevice(row, include);
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = deviceStore.get(where.mac);
      if (!row) throw new Error("not found");
      deviceStore.delete(where.mac);
      return row;
    }),
  };

  const deviceGroup = {
    findMany: vi.fn(async (args: any = {}) => {
      return Array.from(groupStore.values()).map((g) => {
        const base: any = { ...g };
        if (args.include?._count?.select?.devices) {
          base._count = {
            devices: Array.from(deviceStore.values()).filter((d) =>
              d.groupIds.includes(g.id),
            ).length,
          };
        }
        return base;
      });
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      if (where.name !== undefined) {
        for (const g of groupStore.values()) {
          if (g.name === where.name) return g;
        }
        return null;
      }
      if (where.id !== undefined) return groupStore.get(where.id) ?? null;
      return null;
    }),
    findFirst: vi.fn(async ({ where }: any) => {
      for (const g of groupStore.values()) {
        if (where?.name !== undefined && g.name !== where.name) continue;
        if (where?.NOT?.id !== undefined && g.id === where.NOT.id) continue;
        return g;
      }
      return null;
    }),
    create: vi.fn(async ({ data }: any) => {
      const id = `grp-${++groupIdSeq}`;
      const row: GroupRow = {
        id,
        name: data.name,
        color: data.color ?? null,
        icon: data.icon ?? null,
      };
      groupStore.set(id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = groupStore.get(where.id);
      if (!row) throw new Error("not found");
      if (data.name !== undefined) row.name = data.name;
      if (data.color !== undefined) row.color = data.color;
      if (data.icon !== undefined) row.icon = data.icon;
      return row;
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = groupStore.get(where.id);
      if (!row) throw new Error("not found");
      groupStore.delete(where.id);
      for (const d of deviceStore.values()) {
        d.groupIds = d.groupIds.filter((id) => id !== where.id);
      }
      return row;
    }),
  };

  const mockPrisma = {
    // Module gate reads moduleSetting.findMany() on every gated request
    // (/api/network here); [] = no overrides => registry defaults, gate passes.
    moduleSetting: { findMany: vi.fn().mockResolvedValue([]) },
    // BUG-11: requirePasswordChangeGate reads prisma.user.findUnique on
    // every request; null = no directory row = fail-open.
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    device: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    networkDevice,
    deviceGroup,
  };
  // WARP-1583: the T3 effective-access resolver composes its reads inside ONE
  // RepeatableRead transaction, and app.ts mounts requireFeatureAccess on this
  // module's prefix — so a stub without `$transaction` makes the gate fail
  // closed and every route here 404s. Shared seam (WARP-1570) rather than
  // `(fn) => fn(self)`, which would drop the isolation option and hide a
  // regression that removed it.
  (mockPrisma as { $transaction?: unknown }).$transaction = createTransactionSeam({
    client: () => mockPrisma,
  }).$transaction;

  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { PrismaClient, Prisma } from "@prisma/client";
import { createApp } from "../app.js";

describe("Network devices + groups API (WARP-82)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    app = createApp(prisma);
  });

  beforeEach(() => {
    deviceStore.clear();
    groupStore.clear();
    presenceStore.length = 0;
    groupIdSeq = 0;
  });

  // ---------- GET /network/devices ----------

  describe("GET /api/network/devices", () => {
    it("returns the enriched registry (empty by default)", async () => {
      const res = await request(app).get("/api/network/devices");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("devices");
      expect(Array.isArray(res.body.devices)).toBe(true);
      expect(res.body.devices).toHaveLength(0);
    });

    // WARP-111: SWR-friendly caching header on the device-list read.
    it("sets Cache-Control: private, max-age=5, stale-while-revalidate=10", async () => {
      const res = await request(app).get("/api/network/devices");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe(
        "private, max-age=5, stale-while-revalidate=10",
      );
    });

    it("returns the legacy DHCP lease shape when ?legacy=1", async () => {
      const res = await request(app).get("/api/network/devices?legacy=1");
      expect(res.status).toBe(200);
      // legacy handler returns { devices: <ConnectedDevice[]> } — the
      // mocked getConnectedDevices resolves to [].
      expect(res.body).toHaveProperty("devices");
      expect(res.body.devices).toEqual([]);
    });

    it("returns only devices in the requested group with ?groupId=", async () => {
      groupStore.set("grp-1", { id: "grp-1", name: "Living", color: null, icon: null });
      deviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        displayName: null,
        icon: null,
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: ["grp-1"],
      });
      deviceStore.set("AA:BB:CC:DD:EE:02", {
        mac: "AA:BB:CC:DD:EE:02",
        displayName: null,
        icon: null,
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: [],
      });

      const res = await request(app).get("/api/network/devices?groupId=grp-1");
      expect(res.status).toBe(200);
      expect(res.body.devices).toHaveLength(1);
      expect(res.body.devices[0].mac).toBe("AA:BB:CC:DD:EE:01");
    });
  });

  // ---------- GET /network/devices/:mac ----------

  describe("GET /api/network/devices/:mac", () => {
    it("returns 200 with device + presence when present", async () => {
      deviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        displayName: "TV",
        icon: "Tv",
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: [],
      });

      const res = await request(app).get("/api/network/devices/aa:bb:cc:dd:ee:01");
      expect(res.status).toBe(200);
      expect(res.body.device.mac).toBe("AA:BB:CC:DD:EE:01");
      expect(res.body.device.displayName).toBe("TV");
      // WARP-106: API boundary exposes the computed display flag.
      expect(res.body.device.isBlocked).toBe(false);
      expect(res.body.presence).toEqual([]);
    });

    it("404s when the device is unknown", async () => {
      const res = await request(app).get("/api/network/devices/AA:BB:CC:DD:EE:99");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("400s when the MAC is malformed", async () => {
      const res = await request(app).get("/api/network/devices/not-a-mac");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_MAC");
    });
  });

  // ---------- PATCH /network/devices/:mac ----------

  describe("PATCH /api/network/devices/:mac", () => {
    it("updates displayName + icon when icon is in the allowlist", async () => {
      deviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        displayName: null,
        icon: null,
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: [],
      });

      const res = await request(app)
        .patch("/api/network/devices/AA:BB:CC:DD:EE:01")
        .send({ displayName: "Living TV", icon: "Tv" });
      expect(res.status).toBe(200);
      expect(res.body.device.displayName).toBe("Living TV");
      expect(res.body.device.icon).toBe("Tv");
    });

    it("400s with INVALID_ICON when the icon is not in the allowlist", async () => {
      deviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        displayName: null,
        icon: null,
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: [],
      });

      const res = await request(app)
        .patch("/api/network/devices/AA:BB:CC:DD:EE:01")
        .send({ icon: "BogusIcon" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_ICON");
    });
  });

  // ---------- POST /network/devices/:mac/groups ----------

  describe("POST /api/network/devices/:mac/groups", () => {
    it("replaces the group set", async () => {
      groupStore.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      groupStore.set("grp-b", { id: "grp-b", name: "B", color: null, icon: null });
      deviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        displayName: null,
        icon: null,
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: ["grp-a"],
      });

      const res = await request(app)
        .post("/api/network/devices/AA:BB:CC:DD:EE:01/groups")
        .send({ groupIds: ["grp-b"] });
      expect(res.status).toBe(200);
      expect(deviceStore.get("AA:BB:CC:DD:EE:01")!.groupIds).toEqual(["grp-b"]);
    });

    it("400s when body.groupIds is not an array", async () => {
      const res = await request(app)
        .post("/api/network/devices/AA:BB:CC:DD:EE:01/groups")
        .send({ groupIds: "grp-b" });
      expect(res.status).toBe(400);
    });
  });

  // ---------- DELETE /network/devices/:mac ----------

  describe("DELETE /api/network/devices/:mac", () => {
    it("forgets a device", async () => {
      deviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        displayName: null,
        icon: null,
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: [],
      });

      const res = await request(app).delete("/api/network/devices/AA:BB:CC:DD:EE:01");
      expect(res.status).toBe(204);
      expect(deviceStore.has("AA:BB:CC:DD:EE:01")).toBe(false);
    });

    // Proves the Prisma P2025 → DeviceRegistryError.notFound translation
    // in the service layer surfaces as a clean 404 to HTTP clients instead
    // of an opaque 500 from the generic error middleware.
    it("404s when prisma throws P2025 for a stale MAC", async () => {
      const client = new PrismaClient() as any;
      const original = client.networkDevice.delete;
      client.networkDevice.delete = vi.fn().mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Not found", {
          code: "P2025",
          clientVersion: "test",
        }),
      );
      try {
        const res = await request(app).delete(
          "/api/network/devices/AA:BB:CC:DD:EE:99",
        );
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
      } finally {
        client.networkDevice.delete = original;
      }
    });
  });

  // ---------- GET /network/groups ----------

  describe("GET /api/network/groups", () => {
    it("returns groups with device counts", async () => {
      groupStore.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      deviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        displayName: null,
        icon: null,
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: ["grp-a"],
      });
      const res = await request(app).get("/api/network/groups");
      expect(res.status).toBe(200);
      expect(res.body.groups).toHaveLength(1);
      expect(res.body.groups[0]._count.devices).toBe(1);
    });

    // WARP-111: SWR-friendly caching header on the group-list read.
    it("sets Cache-Control: private, max-age=5, stale-while-revalidate=10", async () => {
      const res = await request(app).get("/api/network/groups");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe(
        "private, max-age=5, stale-while-revalidate=10",
      );
    });
  });

  // ---------- POST /network/groups ----------

  describe("POST /api/network/groups", () => {
    it("creates a new group", async () => {
      const res = await request(app)
        .post("/api/network/groups")
        .send({ name: "Office", color: "#336699", icon: "Laptop" });
      expect(res.status).toBe(201);
      expect(res.body.group.name).toBe("Office");
    });

    it("409s when the group name is already taken", async () => {
      groupStore.set("grp-a", { id: "grp-a", name: "Living Room", color: null, icon: null });
      const res = await request(app)
        .post("/api/network/groups")
        .send({ name: "Living Room" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DUPLICATE_GROUP_NAME");
    });

    it("400s when name is missing", async () => {
      const res = await request(app).post("/api/network/groups").send({});
      expect(res.status).toBe(400);
    });
  });

  // ---------- PATCH /network/groups/:id ----------

  describe("PATCH /api/network/groups/:id", () => {
    it("renames a group", async () => {
      groupStore.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      const res = await request(app)
        .patch("/api/network/groups/grp-a")
        .send({ name: "Living Room" });
      expect(res.status).toBe(200);
      expect(res.body.group.name).toBe("Living Room");
    });

    it("409s when the new name collides with another group", async () => {
      groupStore.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      groupStore.set("grp-b", { id: "grp-b", name: "B", color: null, icon: null });
      const res = await request(app)
        .patch("/api/network/groups/grp-b")
        .send({ name: "A" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DUPLICATE_GROUP_NAME");
    });
  });

  // ---------- DELETE /network/groups/:id ----------

  describe("DELETE /api/network/groups/:id", () => {
    it("deletes a group; devices remain", async () => {
      groupStore.set("grp-a", { id: "grp-a", name: "A", color: null, icon: null });
      deviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        displayName: null,
        icon: null,
        notes: null,
        vendor: null,
        hostname: null,
        lastIp: null,
        firstSeen: new Date(),
        lastSeen: new Date(),
        manualBlock: false,
        lastAppliedBlocked: null,
        groupIds: ["grp-a"],
      });
      const res = await request(app).delete("/api/network/groups/grp-a");
      expect(res.status).toBe(204);
      expect(groupStore.has("grp-a")).toBe(false);
      expect(deviceStore.has("AA:BB:CC:DD:EE:01")).toBe(true);
      expect(deviceStore.get("AA:BB:CC:DD:EE:01")!.groupIds).toEqual([]);
    });
  });
});
