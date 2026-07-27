/**
 * WARP-107: ScheduleWindows rollback safety in the updateSchedule
 * transaction (Option A — keep the deleteMany + create pattern, prove it
 * is rollback-safe).
 *
 * `updateSchedule` replaces a schedule's windows inside a single
 * `$transaction`: `tx.scheduleWindow.deleteMany(...)` then
 * `tx.schedule.update({ data: { windows: { create } } })`. If step 2
 * fails, real Prisma rolls the whole transaction back and the original
 * `ScheduleWindow` rows survive.
 *
 * The shared schedule-route mock (`network.schedules.test.ts`) runs the
 * `$transaction` callback straight against the live in-memory stores with
 * NO rollback — so it cannot demonstrate this invariant. This file builds
 * a focused Prisma stand-in whose `$transaction`:
 *   - snapshots every model store before invoking the callback, and
 *   - restores those snapshots if the callback throws,
 * faithfully reproducing interactive-transaction rollback. A
 * `failNextWindowRecreate` switch injects a mid-transaction constraint
 * failure on the windows re-create step so we can assert:
 *   1. the harness can inject a mid-transaction failure,
 *   2. the original windows remain intact after the rollback,
 *   3. the error surfaced to the client is a clean 400 with
 *      SCHEDULE_INVALID_WINDOW (the pre-transaction validation gate, which
 *      rejects before any deletion happens).
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

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

vi.mock("../services/openwrt.client.js", async () => {
  const actual = await vi.importActual<any>("../services/openwrt.client.js");
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

// --- In-memory Prisma stand-in with real transaction rollback ---

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

const scheduleStore = new Map<string, ScheduleRow>();
const windowStore = new Map<string, WindowRow>();
let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

// Test-controlled fault injection. When set, the NEXT `schedule.update`
// that re-creates windows (i.e. carries `data.windows.create`) throws a
// Prisma constraint error mid-transaction, exactly as a DB-level
// constraint violation would on the re-create step. It is one-shot: it
// clears itself when it fires.
let failNextWindowRecreate = false;

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
    constructor(message: string, opts: { code: string; clientVersion: string }) {
      super(message);
      this.name = "PrismaClientKnownRequestError";
      this.code = opts.code;
      this.clientVersion = opts.clientVersion;
    }
  }

  const schedule = {
    findMany: vi.fn(async () =>
      Array.from(scheduleStore.values()).map((r) =>
        hydrateSchedule(r, { windows: true }),
      ),
    ),
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
      // Inject a mid-transaction constraint failure on the windows
      // re-create step — this runs AFTER deleteMany has already emptied
      // the store inside the same transaction, so a non-rolling-back
      // implementation would leave the windows lost.
      if (data.windows?.create && failNextWindowRecreate) {
        failNextWindowRecreate = false;
        throw new PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`scheduleId`,`daysOfWeek`,`startMin`,`endMin`)",
          { code: "P2002", clientVersion: "test" },
        );
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

  // Faithful interactive-transaction semantics: snapshot the mutable
  // stores, run the callback, and restore the snapshots if it throws —
  // so a failure anywhere inside the callback rolls back ALL writes, the
  // way Prisma's `$transaction(fn)` does against Postgres.
  // The return type is annotated because the callback now receives
  // `mockPrisma`, which carries this very function — without it TS cannot
  // break the inference cycle (TS7022/TS7024).
  const $transaction = vi.fn(async (fn: (tx: any) => Promise<any>): Promise<unknown> => {
    const scheduleSnapshot = new Map(
      Array.from(scheduleStore.entries()).map(([k, v]) => [k, { ...v }]),
    );
    const windowSnapshot = new Map(
      Array.from(windowStore.entries()).map(([k, v]) => [k, { ...v }]),
    );
    try {
      // WARP-1583: hand the callback the WHOLE client, not a two-model
      // subset. Prisma's `tx` exposes every model, and the §3
      // effective-access resolver (which app.ts mounts in front of
      // /api/network via requireFeatureAccess) reads `user` through it — a
      // narrow tx made that `undefined.findUnique`, so the gate failed
      // closed and every route here 404'd. The rollback semantics this
      // suite exists to prove are unchanged.
      return await fn(mockPrisma);
    } catch (err) {
      scheduleStore.clear();
      for (const [k, v] of scheduleSnapshot) scheduleStore.set(k, v);
      windowStore.clear();
      for (const [k, v] of windowSnapshot) windowStore.set(k, v);
      throw err;
    }
  });

  const mockPrisma = {
    // Module gate reads moduleSetting.findMany() on every gated request
    // (/api/network here); [] = no overrides => registry defaults, gate passes.
    moduleSetting: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
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
    scheduleOverride: {
      findMany: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(),
    },
    scheduleEvent: { findMany: vi.fn(async () => []) },
    networkDevice: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      update: vi.fn(),
      delete: vi.fn(),
    },
    deviceGroup: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { PrismaClient } from "@prisma/client";
import { createApp } from "../app.js";

async function seedSchedule(app: ReturnType<typeof createApp>) {
  const create = await request(app)
    .post("/api/network/schedules")
    .send({
      name: "Bedtime",
      subjectType: "device",
      deviceMac: "AA:BB:CC:DD:EE:01",
      windows: [
        { daysOfWeek: 31, startMin: 1260, endMin: 420 },
        { daysOfWeek: 96, startMin: 600, endMin: 720 },
      ],
    });
  expect(create.status).toBe(201);
  return create.body.schedule;
}

describe("updateSchedule window rollback safety (WARP-107)", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    app = createApp(prisma);
  });

  beforeEach(() => {
    scheduleStore.clear();
    windowStore.clear();
    seq = 0;
    failNextWindowRecreate = false;
  });

  it("rolls back to the original windows when the re-create step fails mid-transaction", async () => {
    const original = await seedSchedule(app);
    expect(windowStore.size).toBe(2);
    const originalWindows = Array.from(windowStore.values()).map((w) => ({
      daysOfWeek: w.daysOfWeek,
      startMin: w.startMin,
      endMin: w.endMin,
    }));

    // Arm the injected constraint failure on the windows re-create step.
    failNextWindowRecreate = true;

    const res = await request(app)
      .patch(`/api/network/schedules/${original.id}`)
      .send({
        windows: [
          { daysOfWeek: 127, startMin: 100, endMin: 200 },
          { daysOfWeek: 64, startMin: 300, endMin: 400 },
        ],
      });

    // The transaction threw, so the request failed (not a clean 400 —
    // a DB-level P2002 isn't mapped, it bubbles as a 5xx; this test is
    // about persistence, not status — the clean-400 path is covered by
    // the validation test below).
    expect(res.status).toBeGreaterThanOrEqual(400);

    // Rollback invariant: the original windows survive untouched, and
    // none of the attempted replacement windows leaked in.
    expect(windowStore.size).toBe(2);
    const afterWindows = Array.from(windowStore.values()).map((w) => ({
      daysOfWeek: w.daysOfWeek,
      startMin: w.startMin,
      endMin: w.endMin,
    }));
    expect(afterWindows).toEqual(originalWindows);

    // And the schedule, fetched fresh, still reports the original windows.
    const after = await request(app).get(
      `/api/network/schedules/${original.id}`,
    );
    expect(after.status).toBe(200);
    expect(after.body.schedule.windows).toHaveLength(2);
    const fetched = after.body.schedule.windows.map((w: any) => ({
      daysOfWeek: w.daysOfWeek,
      startMin: w.startMin,
      endMin: w.endMin,
    }));
    expect(fetched).toEqual(originalWindows);

    // The injected failure was actually consumed.
    expect(failNextWindowRecreate).toBe(false);
  });

  it("rejects an invalid window payload with a clean 400 SCHEDULE_INVALID_WINDOW and never touches the stored windows", async () => {
    const original = await seedSchedule(app);
    expect(windowStore.size).toBe(2);

    const deleteManySpy = (
      new PrismaClient() as any
    ).scheduleWindow.deleteMany;
    const callsBefore = deleteManySpy.mock.calls.length;

    const res = await request(app)
      .patch(`/api/network/schedules/${original.id}`)
      .send({
        // Zero-length window — rejected by validateWindows BEFORE the
        // transaction opens, so deleteMany never runs.
        windows: [{ daysOfWeek: 1, startMin: 60, endMin: 60 }],
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SCHEDULE_INVALID_WINDOW");

    // The validation gate runs before deleteMany, so the original windows
    // are untouched and no destructive transaction was even attempted.
    expect(windowStore.size).toBe(2);
    expect(deleteManySpy.mock.calls.length).toBe(callsBefore);
  });
});
