/**
 * WARP-94: unit tests for createScheduleApiService.
 *
 * Uses an in-memory Prisma mock (Maps per model + a $transaction that
 * proxies back to the mocked models) so we exercise the real service
 * logic — subject/window validation, P2025 → DeviceRegistryError
 * translation, transactional window replacement on update — without a
 * live Postgres. Same pattern WARP-82 + device-clients tests use.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The real `@prisma/client` import path includes runtime class plumbing
// we don't need; for the service under test we only need a
// PrismaClientKnownRequestError we can instanceof-check.
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
  return {
    PrismaClient: vi.fn(() => ({})),
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { Prisma } from "@prisma/client";
import { createScheduleApiService } from "./schedule-api.service.js";
import { DeviceRegistryError } from "../types/device-registry-error.js";

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
type DeviceRow = { mac: string; manualBlock: boolean };

function makeMockPrisma() {
  const schedules = new Map<string, ScheduleRow>();
  const windows = new Map<string, WindowRow>();
  const overrides = new Map<string, OverrideRow>();
  const events = new Map<string, EventRow>();
  const devices = new Map<string, DeviceRow>();
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  function hydrateSchedule(s: ScheduleRow, include?: any) {
    if (include?.windows) {
      return {
        ...s,
        windows: Array.from(windows.values()).filter(
          (w) => w.scheduleId === s.id,
        ),
      };
    }
    return { ...s };
  }

  const schedule = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(schedules.values());
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
      const row = schedules.get(where.id);
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
      schedules.set(id, row);
      if (data.windows?.create) {
        for (const w of data.windows.create) {
          const wid = nextId("win");
          windows.set(wid, { id: wid, scheduleId: id, ...w });
        }
      }
      return hydrateSchedule(row, include);
    }),
    update: vi.fn(async ({ where, data, include }: any) => {
      const row = schedules.get(where.id);
      if (!row) {
        throw new Prisma.PrismaClientKnownRequestError("not found", {
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
          windows.set(wid, { id: wid, scheduleId: row.id, ...w });
        }
      }
      return hydrateSchedule(row, include);
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = schedules.get(where.id);
      if (!row) {
        throw new Prisma.PrismaClientKnownRequestError("not found", {
          code: "P2025",
          clientVersion: "test",
        });
      }
      schedules.delete(where.id);
      for (const [wid, w] of windows) {
        if (w.scheduleId === where.id) windows.delete(wid);
      }
      return row;
    }),
  };

  const scheduleWindow = {
    deleteMany: vi.fn(async ({ where }: any) => {
      let count = 0;
      for (const [wid, w] of windows) {
        if (w.scheduleId === where.scheduleId) {
          windows.delete(wid);
          count++;
        }
      }
      return { count };
    }),
  };

  const scheduleOverride = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(overrides.values());
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
      overrides.set(id, row);
      return row;
    }),
    delete: vi.fn(async ({ where }: any) => {
      const row = overrides.get(where.id);
      if (!row) {
        throw new Prisma.PrismaClientKnownRequestError("not found", {
          code: "P2025",
          clientVersion: "test",
        });
      }
      overrides.delete(where.id);
      return row;
    }),
  };

  const scheduleEvent = {
    findMany: vi.fn(async (args: any = {}) => {
      let rows = Array.from(events.values());
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

  const networkDevice = {
    update: vi.fn(async ({ where, data, select }: any) => {
      const row = devices.get(where.mac);
      if (!row) {
        throw new Prisma.PrismaClientKnownRequestError("not found", {
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
  };

  // `$transaction(fn)` with a callback flavor: hand the callback back
  // the same top-level mocks wrapped as `tx` so `tx.scheduleWindow` /
  // `tx.schedule` delegate to our in-memory stores.
  const $transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => {
    return fn({ schedule, scheduleWindow, scheduleOverride, scheduleEvent });
  });

  return {
    prisma: {
      schedule,
      scheduleWindow,
      scheduleOverride,
      scheduleEvent,
      networkDevice,
      $transaction,
    } as any,
    stores: { schedules, windows, overrides, events, devices },
  };
}

describe("createScheduleApiService (WARP-94)", () => {
  let mock: ReturnType<typeof makeMockPrisma>;
  let svc: ReturnType<typeof createScheduleApiService>;

  beforeEach(() => {
    mock = makeMockPrisma();
    svc = createScheduleApiService(mock.prisma);
  });

  describe("createSchedule", () => {
    it("creates a schedule with windows when subject is valid", async () => {
      const s = await svc.createSchedule({
        name: "Bedtime",
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 31, startMin: 1260, endMin: 420 }],
      });
      expect(s.id).toMatch(/^sch-/);
      expect(s.name).toBe("Bedtime");
      expect(s.enabled).toBe(true);
      expect(s.windows).toHaveLength(1);
      expect(s.windows[0].daysOfWeek).toBe(31);
    });

    it("rejects when both deviceMac and groupId are set", async () => {
      await expect(
        svc.createSchedule({
          name: "Bad",
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          groupId: "grp-1",
          windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
        }),
      ).rejects.toMatchObject({
        code: "SCHEDULE_SUBJECT_MISMATCH",
      });
    });

    it("rejects when neither deviceMac nor groupId is set", async () => {
      await expect(
        svc.createSchedule({
          name: "Bad",
          subjectType: "device",
          windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
        }),
      ).rejects.toBeInstanceOf(DeviceRegistryError);
    });

    it("rejects a zero-length window", async () => {
      await expect(
        svc.createSchedule({
          name: "Bad",
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          windows: [{ daysOfWeek: 1, startMin: 60, endMin: 60 }],
        }),
      ).rejects.toMatchObject({ code: "SCHEDULE_INVALID_WINDOW" });
    });

    it("rejects more than 7 windows", async () => {
      const manyWindows = Array.from({ length: 8 }, (_, i) => ({
        daysOfWeek: 1,
        startMin: i * 10,
        endMin: i * 10 + 5,
      }));
      await expect(
        svc.createSchedule({
          name: "Too many",
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          windows: manyWindows,
        }),
      ).rejects.toMatchObject({ code: "SCHEDULE_INVALID_WINDOW" });
    });

    it("rejects daysOfWeek=0", async () => {
      await expect(
        svc.createSchedule({
          name: "Bad",
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          windows: [{ daysOfWeek: 0, startMin: 0, endMin: 60 }],
        }),
      ).rejects.toMatchObject({ code: "SCHEDULE_INVALID_WINDOW" });
    });
  });

  describe("updateSchedule", () => {
    it("rejects any attempt to change subjectType/deviceMac/groupId", async () => {
      const s = await svc.createSchedule({
        name: "S",
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      await expect(
        svc.updateSchedule(s.id, { subjectType: "group" } as any),
      ).rejects.toMatchObject({ code: "SCHEDULE_SUBJECT_MISMATCH" });
      await expect(
        svc.updateSchedule(s.id, { deviceMac: "AA:BB:CC:DD:EE:02" } as any),
      ).rejects.toMatchObject({ code: "SCHEDULE_SUBJECT_MISMATCH" });
      await expect(
        svc.updateSchedule(s.id, { groupId: "grp-1" } as any),
      ).rejects.toMatchObject({ code: "SCHEDULE_SUBJECT_MISMATCH" });
    });

    it("replaces windows atomically (deletes old, inserts new)", async () => {
      const s = await svc.createSchedule({
        name: "S",
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      expect(mock.stores.windows.size).toBe(1);

      const updated = await svc.updateSchedule(s.id, {
        windows: [
          { daysOfWeek: 127, startMin: 100, endMin: 200 },
          { daysOfWeek: 64, startMin: 300, endMin: 400 },
        ],
      });
      expect(mock.stores.windows.size).toBe(2);
      expect(updated.windows).toHaveLength(2);
      expect(mock.prisma.$transaction).toHaveBeenCalled();
      expect(mock.prisma.scheduleWindow.deleteMany).toHaveBeenCalled();
    });
  });

  describe("deleteSchedule", () => {
    it("throws SCHEDULE_NOT_FOUND when Prisma raises P2025", async () => {
      await expect(svc.deleteSchedule("does-not-exist")).rejects.toMatchObject(
        { code: "SCHEDULE_NOT_FOUND" },
      );
    });
  });

  describe("listSchedules", () => {
    it("orders enabled-first, then name ascending", async () => {
      await svc.createSchedule({
        name: "Zeta",
        enabled: true,
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      await svc.createSchedule({
        name: "Alpha",
        enabled: false,
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:02",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      await svc.createSchedule({
        name: "Beta",
        enabled: true,
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:03",
        windows: [{ daysOfWeek: 1, startMin: 0, endMin: 60 }],
      });
      const rows = await svc.listSchedules();
      expect(rows.map((r: any) => r.name)).toEqual(["Beta", "Zeta", "Alpha"]);
    });
  });

  describe("createOverride", () => {
    it("creates an override for a device", async () => {
      const ovr = await svc.createOverride({
        subjectType: "device",
        deviceMac: "AA:BB:CC:DD:EE:01",
        action: "allow",
        endAt: new Date(Date.now() + 60_000),
      });
      expect(ovr.id).toMatch(/^ovr-/);
      expect(ovr.action).toBe("allow");
    });

    it("rejects endAt <= startAt", async () => {
      const start = new Date("2026-04-17T10:00:00Z");
      await expect(
        svc.createOverride({
          subjectType: "device",
          deviceMac: "AA:BB:CC:DD:EE:01",
          action: "allow",
          startAt: start,
          endAt: start,
        }),
      ).rejects.toMatchObject({ code: "OVERRIDE_INVALID_RANGE" });
    });
  });

  describe("cancelOverride", () => {
    it("throws OVERRIDE_NOT_FOUND when Prisma raises P2025", async () => {
      await expect(svc.cancelOverride("nope")).rejects.toMatchObject({
        code: "OVERRIDE_NOT_FOUND",
      });
    });
  });

  describe("setManualBlock", () => {
    it("calls Prisma update with {manualBlock: true}", async () => {
      mock.stores.devices.set("AA:BB:CC:DD:EE:01", {
        mac: "AA:BB:CC:DD:EE:01",
        manualBlock: false,
      });
      const res = await svc.setManualBlock("AA:BB:CC:DD:EE:01", true);
      expect(res).toEqual({ mac: "AA:BB:CC:DD:EE:01", manualBlock: true });
      expect(mock.prisma.networkDevice.update).toHaveBeenCalledWith({
        where: { mac: "AA:BB:CC:DD:EE:01" },
        data: { manualBlock: true },
        select: { mac: true, manualBlock: true },
      });
    });

    it("throws NOT_FOUND when the device is unknown (P2025)", async () => {
      await expect(
        svc.setManualBlock("AA:BB:CC:DD:EE:99", true),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("listScheduleEvents", () => {
    it("passes since + limit to Prisma correctly", async () => {
      const since = new Date("2026-04-10T00:00:00Z");
      await svc.listScheduleEvents({ since, limit: 10 });
      expect(mock.prisma.scheduleEvent.findMany).toHaveBeenCalledWith({
        where: { occurredAt: { gte: since } },
        orderBy: { occurredAt: "desc" },
        take: 10,
      });
    });

    it("defaults limit to 50 and caps at 200", async () => {
      await svc.listScheduleEvents({});
      expect(mock.prisma.scheduleEvent.findMany).toHaveBeenLastCalledWith({
        where: undefined,
        orderBy: { occurredAt: "desc" },
        take: 50,
      });
      await svc.listScheduleEvents({ limit: 10_000 });
      expect(mock.prisma.scheduleEvent.findMany).toHaveBeenLastCalledWith({
        where: undefined,
        orderBy: { occurredAt: "desc" },
        take: 200,
      });
    });
  });
});
