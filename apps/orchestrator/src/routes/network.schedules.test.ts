/**
 * WARP-94: supertest coverage for the schedule / override / schedule-event
 * / manualBlock REST surface.
 *
 * Extends the in-memory-Prisma pattern from network.device.test.ts to add
 * `schedule`, `scheduleWindow`, `scheduleOverride`, `scheduleEvent`, and
 * `networkDevice.update` stores + a `$transaction` callback proxy, so the
 * service layer's validation + P2025 translation is exercised end-to-end
 * against a Prisma-shaped stub without a live Postgres.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// --- Config / unrelated service mocks (mirrors network.device.test.ts) ---

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
    // camera-settings.service.ts derefs this at module scope;
    // the real config defaults it, so the mock must carry it too.
    FRIGATE_URL: "http://frigate:5000",
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// WARP-181: spy on the signed activity emitter so the override
// create/delete audit rows (AC4) can be asserted without a recorder.
const recordActivityMock = vi.fn().mockResolvedValue(null);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => recordActivityMock(...a),
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

vi.mock("../services/openwrt.client.js", async () => {
  const actual =
    await vi.importActual<any>("../services/openwrt.client.js");
  return {
    ...actual,
    fetchDhcpLeases: vi.fn().mockResolvedValue([]),
    fetchWirelessClients: vi.fn().mockResolvedValue([]),
  };
});

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

type ScheduleRow = {
  id: string;
  name: string;
  enabled: boolean;
  subjectType: string;
  deviceMac: string | null;
  groupId: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type WindowRow = {
  id: string;
  scheduleId: string;
  daysOfWeek: number;
  startMin: number;
  endMin: number;
};
type OverrideRow = {
  id: string;
  subjectType: string;
  deviceMac: string | null;
  groupId: string | null;
  action: string;
  startAt: Date;
  endAt: Date;
  note: string | null;
  createdAt: Date;
};
type EventRow = {
  id: string;
  scheduleId: string | null;
  overrideId: string | null;
  subjectType: string;
  deviceMac: string | null;
  groupId: string | null;
  transition: string;
  reason: string;
  occurredAt: Date;
};
type NetDeviceRow = {
  mac: string;
  manualBlock: boolean;
};

const scheduleStore = new Map<string, ScheduleRow>();
const windowStore = new Map<string, WindowRow>();
const overrideStore = new Map<string, OverrideRow>();
const eventStore = new Map<string, EventRow>();
const netDeviceStore = new Map<string, NetDeviceRow>();
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function hydrateSchedule(row: ScheduleRow, include?: any): any {
  const out: any = { ...row };
  if (include?.windows) {
    out.windows = Array.from(windowStore.values()).filter(
      (w) => w.scheduleId === row.id,
    );
  }
  return out;
}

vi.mock("@prisma/client", () => {
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

  // --- Schedule model ---
  const schedule = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(scheduleStore.values());
      if (args.orderBy) {
        const clauses = Array.isArray(args.orderBy)
          ? args.orderBy
          : [args.orderBy];
        rows = rows.slice().sort((a: any, b: any) => {
          for (const clause of clauses) {
            for (const key of Object.keys(clause)) {
              const dir = clause[key] === "desc" ? -1 : 1;
              const av = a[key];
              const bv = b[key];
              if (av === bv) continue;
              if (typeof av === "boolean") {
                return (av ? 1 : 0) < (bv ? 1 : 0) ? -dir : dir;
              }
              return av < bv ? -dir : dir;
            }
          }
          return 0;
        });
      }
      return rows.map((r) => hydrateSchedule(r, args.include));
    }),
    findUnique: vi.fn(async ({ where, include }: any) => {
      const row = scheduleStore.get(where.id);
      return row ? hydrateSchedule(row, include) : null;
    }),
    create: vi.fn(async ({ data, include }: any) => {
      const id = nextId("sch");
      const row: ScheduleRow = {
        id,
        name: data.name,
        enabled: data.enabled ?? true,
        subjectType: data.subjectType,
        deviceMac: data.deviceMac ?? null,
        groupId: data.groupId ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      scheduleStore.set(id, row);
      if (data.windows?.create) {
        for (const w of data.windows.create) {
          const wid = nextId("win");
          windowStore.set(wid, { id: wid, scheduleId: id, ...w });
        }
      }
      return hydrateSchedule(row, include);
    }),
    update: vi.fn(async ({ where, data, include }: any) => {
      const row = scheduleStore.get(where.id);
      if (!row) {
        throw new PrismaClientKnownRequestError("not found", {
          code: "P2025",
          clientVersion: "test",
        });
      }
      if (data.name !== undefined) row.name = data.name;
      if (data.enabled !== undefined) row.enabled = data.enabled;
      row.updatedAt = new Date();
      if (data.windows?.create) {
        for (const w of data.windows.create) {
          const wid = nextId("win");
          windowStore.set(wid, { id: wid, scheduleId: row.id, ...w });
        }
      }
      return hydrateSchedule(row, include);
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = scheduleStore.get(where.id);
      if (!row) {
        throw new PrismaClientKnownRequestError("not found", {
          code: "P2025",
          clientVersion: "test",
        });
      }
      scheduleStore.delete(where.id);
      for (const [wid, w] of windowStore) {
        if (w.scheduleId === where.id) windowStore.delete(wid);
      }
      return row;
    }),
  };

  const scheduleWindow = {
    deleteMany: vi.fn(async ({ where }: any) => {
      let count = 0;
      for (const [wid, w] of windowStore) {
        if (w.scheduleId === where.scheduleId) {
          windowStore.delete(wid);
          count++;
        }
      }
      return { count };
    }),
  };

  const scheduleOverride = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(overrideStore.values());
      const w = args.where ?? {};
      if (w.deviceMac) rows = rows.filter((r) => r.deviceMac === w.deviceMac);
      if (w.groupId) rows = rows.filter((r) => r.groupId === w.groupId);
      if (w.AND) {
        for (const clause of w.AND) {
          if (clause.startAt?.lte) {
            const ts = (clause.startAt.lte as Date).getTime();
            rows = rows.filter((r) => r.startAt.getTime() <= ts);
          }
          if (clause.endAt?.gt) {
            const ts = (clause.endAt.gt as Date).getTime();
            rows = rows.filter((r) => r.endAt.getTime() > ts);
          }
        }
      }
      if (args.orderBy?.startAt === "desc") {
        rows = rows
          .slice()
          .sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
      }
      return rows;
    }),
    create: vi.fn(async ({ data }: any) => {
      const id = nextId("ovr");
      const row: OverrideRow = {
        id,
        subjectType: data.subjectType,
        deviceMac: data.deviceMac ?? null,
        groupId: data.groupId ?? null,
        action: data.action,
        startAt: data.startAt,
        endAt: data.endAt,
        note: data.note ?? null,
        createdAt: new Date(),
      };
      overrideStore.set(id, row);
      return row;
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = overrideStore.get(where.id);
      if (!row) {
        throw new PrismaClientKnownRequestError("not found", {
          code: "P2025",
          clientVersion: "test",
        });
      }
      overrideStore.delete(where.id);
      return row;
    }),
  };

  const scheduleEvent = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(eventStore.values());
      if (args.where?.occurredAt?.gte) {
        const gte = (args.where.occurredAt.gte as Date).getTime();
        rows = rows.filter((r) => r.occurredAt.getTime() >= gte);
      }
      if (args.orderBy?.occurredAt === "desc") {
        rows = rows
          .slice()
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
      }
      if (args.take) rows = rows.slice(0, args.take);
      return rows;
    }),
  };

  // --- NetworkDevice — only the bits WARP-94 touches (manualBlock) plus
  // the bits WARP-82's service path calls so mounting the full router
  // doesn't blow up. The deviceGroup store is unused for schedule tests
  // but must exist because createNetworkDeviceService reads from it.
  const networkDevice = {
    findMany: vi.fn(async () => [] as any[]),
    findUnique: vi.fn(async ({ where }: any) => {
      const row = netDeviceStore.get(where.mac);
      return row ? { ...row } : null;
    }),
    update: vi.fn(async ({ where, data, select }: any) => {
      const row = netDeviceStore.get(where.mac);
      if (!row) {
        throw new PrismaClientKnownRequestError("not found", {
          code: "P2025",
          clientVersion: "test",
        });
      }
      if (data.manualBlock !== undefined) row.manualBlock = data.manualBlock;
      if (select?.mac && select?.manualBlock) {
        return { mac: row.mac, manualBlock: row.manualBlock };
      }
      return row;
    }),
    delete: vi.fn(async () => ({})),
  };

  const deviceGroup = {
    findMany: vi.fn(async () => []),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };

  // Return type annotated: the callback now receives `mockPrisma`, which
  // carries this function, so inference would be circular (TS7022/TS7024).
  const $transaction = vi.fn(async (fn: (tx: any) => Promise<any>): Promise<unknown> => {
    // WARP-1583: hand the callback the WHOLE client, not a four-model
    // subset. Prisma's `tx` exposes every model, and the §3 effective-access
    // resolver (mounted in front of /api/network by requireFeatureAccess)
    // reads `user` through it — a narrow tx made that `undefined.findUnique`,
    // so the gate failed closed and every route here 404'd.
    return fn(mockPrisma);
  });

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
    $transaction,
    device: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    schedule,
    scheduleWindow,
    scheduleOverride,
    scheduleEvent,
    networkDevice,
    deviceGroup,
  };
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";

describe("Schedule / override / event / manualBlock API (WARP-94)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    app = createApp(prisma);
  });

  beforeEach(() => {
    scheduleStore.clear();
    windowStore.clear();
    overrideStore.clear();
    eventStore.clear();
    netDeviceStore.clear();
    seq = 0;
    recordActivityMock.mockClear();
  });

  // ---------- POST /network/schedules ----------

  describe("POST /api/network/schedules", () => {
    it("creates a schedule with windows", async () => {
      const res = await request(app)
        .post("/api/network/schedules")
        .send({
          name: "Bedtime",
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          windows: [{ daysOfWeek: 31, startMin: 1260, endMin: 420 }],
        });
      expect(res.status).toBe(201);
      expect(res.body.schedule.name).toBe("Bedtime");
      expect(res.body.schedule.windows).toHaveLength(1);
    });

    it("400s with SCHEDULE_SUBJECT_MISMATCH when both refs are set", async () => {
      const res = await request(app)
        .post("/api/network/schedules")
        .send({
          name: "Bad",
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          groupId: "grp-1",
          windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("SCHEDULE_SUBJECT_MISMATCH");
    });
  });

  // ---------- GET /network/schedules ----------

  describe("GET /api/network/schedules", () => {
    it("returns schedules ordered enabled-first, name-ascending", async () => {
      await request(app).post("/api/network/schedules").send({
        name: "Zeta",
        enabled: true,
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      await request(app).post("/api/network/schedules").send({
        name: "Alpha",
        enabled: false,
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:02",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      const res = await request(app).get("/api/network/schedules");
      expect(res.status).toBe(200);
      expect(res.body.schedules.map((s: any) => s.name)).toEqual([
        "Zeta",
        "Alpha",
      ]);
    });

    // WARP-111: SWR-friendly caching header on the schedules-list read.
    it("sets Cache-Control: private, max-age=5, stale-while-revalidate=10", async () => {
      const res = await request(app).get("/api/network/schedules");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe(
        "private, max-age=5, stale-while-revalidate=10",
      );
    });
  });

  // ---------- GET /network/schedules/:id ----------

  describe("GET /api/network/schedules/:id", () => {
    it("returns a schedule by id", async () => {
      const create = await request(app).post("/api/network/schedules").send({
        name: "S",
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      const id = create.body.schedule.id;
      const res = await request(app).get(`/api/network/schedules/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.schedule.id).toBe(id);
    });

    it("404s when the schedule is unknown", async () => {
      const res = await request(app).get("/api/network/schedules/missing");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("SCHEDULE_NOT_FOUND");
    });
  });

  // ---------- PATCH /network/schedules/:id ----------

  describe("PATCH /api/network/schedules/:id", () => {
    it("updates name + enabled", async () => {
      const create = await request(app).post("/api/network/schedules").send({
        name: "S",
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      const id = create.body.schedule.id;
      const res = await request(app)
        .patch(`/api/network/schedules/${id}`)
        .send({ enabled: false, name: "Renamed" });
      expect(res.status).toBe(200);
      expect(res.body.schedule.enabled).toBe(false);
      expect(res.body.schedule.name).toBe("Renamed");
    });

    it("400s when the body tries to change subjectType", async () => {
      const create = await request(app).post("/api/network/schedules").send({
        name: "S",
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      const id = create.body.schedule.id;
      const res = await request(app)
        .patch(`/api/network/schedules/${id}`)
        .send({ subjectType: "group" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("SCHEDULE_SUBJECT_MISMATCH");
    });

    // WARP-110: re-sending the SAME subject fields (the full shape the
    // dashboard PATCHes back) is idempotent and must succeed.
    it("200s when the body re-sends matching subject fields", async () => {
      const create = await request(app).post("/api/network/schedules").send({
        name: "S",
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      const id = create.body.schedule.id;
      const res = await request(app)
        .patch(`/api/network/schedules/${id}`)
        .send({
          name: "Renamed",
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          groupId: null,
        });
      expect(res.status).toBe(200);
      expect(res.body.schedule.name).toBe("Renamed");
      expect(res.body.schedule.subjectType).toBe("device");
      expect(res.body.schedule.deviceMac).toBe("AA:BB:CC:DD:EE:01");
    });
  });

  // ---------- DELETE /network/schedules/:id ----------

  describe("DELETE /api/network/schedules/:id", () => {
    it("deletes a schedule", async () => {
      const create = await request(app).post("/api/network/schedules").send({
        name: "S",
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      const id = create.body.schedule.id;
      const res = await request(app).delete(`/api/network/schedules/${id}`);
      expect(res.status).toBe(204);
      expect(scheduleStore.has(id)).toBe(false);
    });

    it("404s for an unknown id", async () => {
      const res = await request(app).delete("/api/network/schedules/nope");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("SCHEDULE_NOT_FOUND");
    });
  });

  // ---------- POST /network/overrides ----------

  describe("POST /api/network/overrides", () => {
    it("creates an override with ISO-string dates", async () => {
      const res = await request(app)
        .post("/api/network/overrides")
        .send({
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          action: "allow",
          // Within the 90-day ScheduleOverride cap (WARP-114, #729). A stale
          // far-future literal ("2099-…") now exceeds the cap and 400s.
          endAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
        });
      expect(res.status).toBe(201);
      expect(res.body.override.action).toBe("allow");
    });

    it("400s with OVERRIDE_INVALID_RANGE when endAt <= startAt", async () => {
      const res = await request(app)
        .post("/api/network/overrides")
        .send({
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          action: "allow",
          startAt: "2026-04-17T10:00:00Z",
          endAt: "2026-04-17T10:00:00Z",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("OVERRIDE_INVALID_RANGE");
    });

    it("400s with INVALID_DATE when endAt is not a valid ISO date", async () => {
      const res = await request(app)
        .post("/api/network/overrides")
        .send({
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:FF",
          action: "allow",
          endAt: "garbage",
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_DATE");
    });

    it("400s with INVALID_DATE when startAt is not a valid ISO date", async () => {
      const res = await request(app)
        .post("/api/network/overrides")
        .send({
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:FF",
          action: "allow",
          startAt: "nope",
          endAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_DATE");
    });
  });

  // ---------- WARP-181 (AC4): override create/delete audit rows ----------

  describe("override create/delete emit signed activity rows (WARP-181)", () => {
    it("POST /api/network/overrides records a network row with actor + refs", async () => {
      const endAt = new Date(Date.now() + 30 * 86400_000).toISOString();
      const res = await request(app).post("/api/network/overrides").send({
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        action: "block",
        endAt,
      });
      expect(res.status).toBe(201);
      expect(recordActivityMock).toHaveBeenCalledTimes(1);
      const row = recordActivityMock.mock.calls[0][0];
      expect(row.kind).toBe("network");
      expect(row.severity).toBe("ok");
      expect(row.what).toContain("override");
      // Dev-bypass auth: req.user = { id: "dev", role: "owner" }.
      expect(row.actor).toEqual({ type: "user", id: "dev" });
      expect(row.refs.deviceId).toBe("AA:BB:CC:DD:EE:01");
      expect(row.refs.overrideId).toBe(res.body.override.id);
      expect(typeof row.refs.startAt).toBe("string");
      expect(row.refs.endAt).toBe(endAt);
    });

    it("a failed create (validation 400) emits no activity row", async () => {
      await request(app).post("/api/network/overrides").send({
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        action: "allow",
        endAt: "garbage",
      });
      expect(recordActivityMock).not.toHaveBeenCalled();
    });

    it("DELETE /api/network/overrides/:id records a network row with actor + refs", async () => {
      const create = await request(app).post("/api/network/overrides").send({
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:02",
        action: "allow",
        endAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      });
      recordActivityMock.mockClear();
      const id = create.body.override.id;
      const res = await request(app).delete(`/api/network/overrides/${id}`);
      expect(res.status).toBe(204);
      expect(recordActivityMock).toHaveBeenCalledTimes(1);
      const row = recordActivityMock.mock.calls[0][0];
      expect(row.kind).toBe("network");
      expect(row.severity).toBe("ok");
      expect(row.actor).toEqual({ type: "user", id: "dev" });
      expect(row.refs.overrideId).toBe(id);
      expect(row.refs.deviceId).toBe("AA:BB:CC:DD:EE:02");
    });

    it("a 404 delete emits no activity row", async () => {
      await request(app).delete("/api/network/overrides/nope");
      expect(recordActivityMock).not.toHaveBeenCalled();
    });
  });

  // ---------- GET /network/overrides ----------

  describe("GET /api/network/overrides", () => {
    it("filters by deviceMac", async () => {
      await request(app).post("/api/network/overrides").send({
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        action: "allow",
        endAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      });
      await request(app).post("/api/network/overrides").send({
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:02",
        action: "block",
        endAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      });
      const res = await request(app).get(
        "/api/network/overrides?deviceMac=AA:BB:CC:DD:EE:01",
      );
      expect(res.status).toBe(200);
      expect(res.body.overrides).toHaveLength(1);
      expect(res.body.overrides[0].deviceMac).toBe("AA:BB:CC:DD:EE:01");
    });
  });

  // ---------- DELETE /network/overrides/:id ----------

  describe("DELETE /api/network/overrides/:id", () => {
    it("cancels an override", async () => {
      const create = await request(app).post("/api/network/overrides").send({
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        action: "allow",
        endAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      });
      const id = create.body.override.id;
      const res = await request(app).delete(`/api/network/overrides/${id}`);
      expect(res.status).toBe(204);
      expect(overrideStore.has(id)).toBe(false);
    });

    it("404s for an unknown id", async () => {
      const res = await request(app).delete("/api/network/overrides/nope");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("OVERRIDE_NOT_FOUND");
    });
  });

  // ---------- GET /network/schedule-events ----------

  describe("GET /api/network/schedule-events", () => {
    it("returns schedule events with a default limit", async () => {
      eventStore.set("e-1", {
        id: "e-1",
        scheduleId: "sch-1",
        overrideId: null,
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        groupId: null,
        transition: "blocked",
        reason: "schedule_window_start",
        occurredAt: new Date("2026-04-15T00:00:00Z"),
      });
      const res = await request(app).get("/api/network/schedule-events");
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
    });

    // WARP-111: schedule-events gets a plain max-age (no SWR window) — the
    // event log is append-only and tolerates a slightly longer cache.
    it("sets Cache-Control: private, max-age=15", async () => {
      const res = await request(app).get("/api/network/schedule-events");
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("private, max-age=15");
    });

    it("respects ?since= and ?limit=", async () => {
      eventStore.set("e-old", {
        id: "e-old",
        scheduleId: null,
        overrideId: null,
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        groupId: null,
        transition: "blocked",
        reason: "schedule_window_start",
        occurredAt: new Date("2026-03-01T00:00:00Z"),
      });
      eventStore.set("e-new", {
        id: "e-new",
        scheduleId: null,
        overrideId: null,
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        groupId: null,
        transition: "unblocked",
        reason: "schedule_window_end",
        occurredAt: new Date("2026-04-15T00:00:00Z"),
      });
      const res = await request(app).get(
        "/api/network/schedule-events?since=2026-04-01T00:00:00Z&limit=5",
      );
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].id).toBe("e-new");
    });

    it("400s with INVALID_DATE when ?since= is not a valid ISO date", async () => {
      const res = await request(app).get(
        "/api/network/schedule-events?since=garbage",
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("INVALID_DATE");
    });
  });

  // ---------- POST /network/devices/:mac/manualBlock ----------

  describe("POST /api/network/devices/:mac/manualBlock", () => {
    it("toggles manualBlock on", async () => {
      netDeviceStore.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        manualBlock: false,
      });
      const res = await request(app)
        .post("/api/network/devices/AA:BB:CC:DD:EE:01/manualBlock")
        .send({ blocked: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        mac: "AA:BB:CC:DD:EE:01",
        manualBlock: true,
      });
      expect(netDeviceStore.get("AA:BB:CC:DD:EE:01")!.manualBlock).toBe(true);
    });

    it("400s when the body is missing `blocked`", async () => {
      const res = await request(app)
        .post("/api/network/devices/AA:BB:CC:DD:EE:01/manualBlock")
        .send({});
      expect(res.status).toBe(400);
    });

    it("404s when the device is unknown (P2025)", async () => {
      const res = await request(app)
        .post("/api/network/devices/AA:BB:CC:DD:EE:99/manualBlock")
        .send({ blocked: true });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });
  });
});
