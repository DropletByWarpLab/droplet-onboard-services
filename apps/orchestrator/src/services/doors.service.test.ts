/**
 * ADR-055 (P4a) — the doors service, against a stubbed Prisma. Real-database
 * proof (the append-only trigger, the derived-alarm trigger, retention,
 * cursor paging) is in `doors.pg.test.ts`; what belongs here is the calls the
 * service makes and the decisions it takes on what comes back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";

const recordActivity = vi.fn(async (..._args: unknown[]) => null);
vi.mock("./activity.singleton.js", () => ({
  recordActivity: (...args: unknown[]) => recordActivity(...args),
  recordActivityInTx: vi.fn(),
  getActivityRecorder: () => null,
}));

import {
  DOORS_RETENTION_CRON,
  DOORS_RETENTION_LOCK_KEY,
  DOOR_EVENTS_MAX_LIMIT,
  DoorWriteError,
  createDoor,
  formatEventCursor,
  listDoorEvents,
  listDoors,
  normaliseDoorName,
  parseEventCursor,
  purgeExpiredAccessEvents,
  registerDoorsJobs,
  retireDoor,
  updateDoor,
} from "./doors.service.js";

const NOW = new Date("2026-09-29T03:55:00.000Z");
/** `NOW` minus `seconds`. */
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const REQ = { user: { id: "owner-1", role: "owner", username: "owner" } } as never;

function doorRow(over: Record<string, unknown> = {}) {
  return {
    id: "door-1",
    name: "Front door",
    doorPositionSource: "lock",
    heldOpenSeconds: 30,
    status: "active",
    retiredAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...over,
  };
}

function makePrisma() {
  const prisma = {
    accessPoint: {
      findMany: vi.fn(async (_args?: Record<string, unknown>) => [] as unknown[]),
      findUnique: vi.fn(async (_args?: unknown) => null as unknown),
      create: vi.fn(async (args: { data: Record<string, unknown> }) =>
        doorRow({ ...args.data, id: "door-new" }),
      ),
      updateMany: vi.fn(async (_args?: unknown) => ({ count: 1 })),
    },
    accessEvent: { findMany: vi.fn(async (_args?: Record<string, unknown>) => [] as unknown[]) },
    $queryRaw: vi.fn(async () => [] as unknown[]),
    $executeRaw: vi.fn(async () => 0),
    $transaction: undefined as unknown,
  };
  prisma.$transaction = createTransactionSeam({ client: () => prisma }).$transaction;
  return prisma;
}
const asPrisma = (p: ReturnType<typeof makePrisma>) => p as unknown as PrismaClient;

beforeEach(() => {
  recordActivity.mockClear();
});

describe("normaliseDoorName", () => {
  it("trims, collapses spaces, and keeps ordinary names", () => {
    expect(normaliseDoorName("  Front   door ")).toBe("Front door");
    expect(normaliseDoorName("Cabinet de l'étage ☂")).toBe("Cabinet de l'étage ☂");
  });

  it("refuses empty, over-long, control, bidi-override and NUL text", () => {
    expect(normaliseDoorName("")).toBeNull();
    expect(normaliseDoorName("   ")).toBeNull();
    expect(normaliseDoorName("x".repeat(81))).toBeNull();
    expect(normaliseDoorName("x".repeat(80))).not.toBeNull();
    expect(normaliseDoorName("Front\u0007door")).toBeNull();
    expect(normaliseDoorName("Front‮door")).toBeNull();
    expect(normaliseDoorName("Front\u0000door")).toBeNull();
    expect(normaliseDoorName("Front\ndoor")).toBeNull();
  });
});

describe("event cursor", () => {
  it("round-trips (occurredAt, id)", () => {
    const at = new Date("2026-09-29T02:00:00.123Z");
    expect(parseEventCursor(formatEventCursor(at, 4123n))).toEqual({ occurredAt: at, id: 4123n });
  });

  it("refuses anything that is not <ms>_<id> — including a 19-digit id that would overflow BIGINT", () => {
    for (const bad of ["", "abc", "1_", "_1", "1-2", "1_2_3", "12345678901234567890_1", "1_9999999999999999999", " 1_2"]) {
      expect(parseEventCursor(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("listDoors", () => {
  it("lists active doors by default and includes retired ones only when asked", async () => {
    const p = makePrisma();
    await listDoors(asPrisma(p), { includeRetired: false });
    expect(p.accessPoint.findMany.mock.calls[0]![0]).toMatchObject({ where: { status: "active" } });
    await listDoors(asPrisma(p), { includeRetired: true });
    expect((p.accessPoint.findMany.mock.calls[1]![0] as { where?: unknown }).where).toBeUndefined();
  });

  it("reports position from the newest position event; a door never heard from is unknown, never closed", async () => {
    const p = makePrisma();
    p.accessPoint.findMany.mockResolvedValue([
      doorRow({ id: "a", name: "A" }),
      doorRow({ id: "b", name: "B" }),
      doorRow({ id: "c", name: "C", doorPositionSource: "dp1" }),
    ]);
    p.$queryRaw.mockResolvedValue([
      { accessPointId: "a", kind: "door_open", troubleCode: null, occurredAt: ago(10) },
      { accessPointId: "c", kind: "trouble", troubleCode: "position_unknown", occurredAt: ago(5) },
    ]);
    const doors = await listDoors(asPrisma(p), { includeRetired: false });
    expect(doors.map((d) => [d.id, d.position])).toEqual([
      ["a", "open"],
      ["b", "unknown"],
      ["c", "unknown"],
    ]);
    expect(doors[0]!.positionSince).toEqual(ago(10));
    expect(doors[1]!.positionSince).toBeNull();
  });

  // §9.7's "never left at closed" is link supervision lapsing, and P4a has no
  // supervision data. A cutoff on the age of the newest position event would be
  // the wrong signal: a lock or DP-1 that reports only on change would read
  // unknown 90 or 180 s after every close. So the position is the newest report
  // as it stands, and `positionSince` says when that was.
  describe("the position is the newest report as it stands, however old", () => {
    const listOne = async (source: string, kind: string, secondsOld: number) => {
      const p = makePrisma();
      p.accessPoint.findMany.mockResolvedValue([doorRow({ doorPositionSource: source })]);
      p.$queryRaw.mockResolvedValue([{ accessPointId: "door-1", kind, troubleCode: null, occurredAt: ago(secondsOld) }]);
      return (await listDoors(asPrisma(p), { includeRetired: false }))[0]!;
    };

    it.each([["lock"], ["dp1"]])("a %s door closed a day ago is still closed, with its positionSince — never unknown by age", async (source) => {
      expect(await listOne(source, "door_closed", 86_400)).toMatchObject({ position: "closed", positionSince: ago(86_400) });
      expect(await listOne(source, "door_open", 86_400)).toMatchObject({ position: "open", positionSince: ago(86_400) });
    });

    it("the read that follows a write says the same (create / update / retire return a view)", async () => {
      const p = makePrisma();
      p.accessPoint.findUnique.mockResolvedValue(doorRow());
      p.$queryRaw.mockResolvedValue([{ accessPointId: "door-1", kind: "door_closed", troubleCode: null, occurredAt: ago(3600) }]);
      const retired = await retireDoor(asPrisma(p), "door-1", { req: REQ, now: NOW });
      expect(retired).toMatchObject({ position: "closed", positionSince: ago(3600) });
    });
  });

  it("a door with no position source is not_monitored and claims neither alarm — without asking the event log", async () => {
    const p = makePrisma();
    p.accessPoint.findMany.mockResolvedValue([doorRow({ id: "n", doorPositionSource: "none" })]);
    const [door] = await listDoors(asPrisma(p), { includeRetired: false });
    expect(door).toMatchObject({
      position: "not_monitored",
      positionSince: null,
      claims: { forcedDoor: null, heldOpen: false },
    });
    // No monitored door → nothing to look up.
    expect(p.$queryRaw).not.toHaveBeenCalled();
  });

  it("says which forced-door claim each source makes", async () => {
    const p = makePrisma();
    p.accessPoint.findMany.mockResolvedValue([
      doorRow({ id: "l", doorPositionSource: "lock" }),
      doorRow({ id: "s", doorPositionSource: "dp1" }),
    ]);
    const doors = await listDoors(asPrisma(p), { includeRetired: false });
    expect(doors.map((d) => d.claims.forcedDoor)).toEqual(["latch_witnessed", "unwitnessed_open"]);
  });
});

describe("listDoorEvents", () => {
  const evRow = (id: number, at: string, over: Record<string, unknown> = {}) => ({
    id: BigInt(id),
    accessPointId: "door-1",
    accessPoint: { name: "Front door" },
    kind: "door_open",
    occurredAt: new Date(at),
    forcedClaim: null,
    troubleCode: null,
    derivedFromId: null,
    correlationKey: null,
    ...over,
  });

  it("orders newest first, asks for one extra row, and returns a cursor only when there is more", async () => {
    const p = makePrisma();
    p.accessEvent.findMany.mockResolvedValue([
      evRow(3, "2026-09-29T02:00:03Z"),
      evRow(2, "2026-09-29T02:00:02Z"),
      evRow(1, "2026-09-29T02:00:01Z"),
    ]);
    const page = await listDoorEvents(asPrisma(p), { limit: 2 });
    const args = p.accessEvent.findMany.mock.calls[0]![0] as Record<string, unknown>;
    expect(args.take).toBe(3);
    expect(args.orderBy).toEqual([{ occurredAt: "desc" }, { id: "desc" }]);
    expect(page.events.map((e) => e.id)).toEqual(["3", "2"]);
    expect(page.nextCursor).toBe(formatEventCursor(new Date("2026-09-29T02:00:02Z"), 2n));

    p.accessEvent.findMany.mockResolvedValue([evRow(3, "2026-09-29T02:00:03Z")]);
    expect((await listDoorEvents(asPrisma(p), { limit: 2 })).nextCursor).toBeNull();
  });

  it("resumes strictly after the cursor: an earlier time, or the same time and a smaller id", async () => {
    const p = makePrisma();
    const at = new Date("2026-09-29T02:00:02Z");
    await listDoorEvents(asPrisma(p), { limit: 10, cursor: { occurredAt: at, id: 2n }, doorId: "door-1" });
    const where = (p.accessEvent.findMany.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toEqual({
      AND: [
        { accessPointId: "door-1" },
        { OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: 2n } }] },
      ],
    });
  });

  it("clamps the limit, and never returns an unbounded page", async () => {
    const p = makePrisma();
    await listDoorEvents(asPrisma(p), { limit: 10_000 });
    expect((p.accessEvent.findMany.mock.calls[0]![0] as { take: number }).take).toBe(DOOR_EVENTS_MAX_LIMIT + 1);
  });

  it("carries the derived-alarm claim, the trouble code and the reference — ids as strings", async () => {
    const p = makePrisma();
    p.accessEvent.findMany.mockResolvedValue([
      evRow(9, "2026-09-29T02:00:09Z", { kind: "forced_door", forcedClaim: "latch_witnessed", derivedFromId: 7n }),
      evRow(8, "2026-09-29T02:00:08Z", { kind: "trouble", troubleCode: "position_unknown" }),
    ]);
    const { events } = await listDoorEvents(asPrisma(p), { limit: 10 });
    expect(events[0]).toMatchObject({ id: "9", doorId: "door-1", doorName: "Front door", forcedClaim: "latch_witnessed", derivedFromId: "7" });
    expect(events[1]).toMatchObject({ troubleCode: "position_unknown", derivedFromId: null });
  });
});

describe("createDoor", () => {
  it("writes a lock door with the 30 s default held-open time, and audits it", async () => {
    const p = makePrisma();
    const door = await createDoor(asPrisma(p), { name: " Front  door ", doorPositionSource: "lock" }, { req: REQ, now: NOW });
    expect(p.accessPoint.create).toHaveBeenCalledWith({
      data: { name: "Front door", doorPositionSource: "lock", heldOpenSeconds: 30 },
    });
    expect(door).toMatchObject({ id: "door-new", name: "Front door", position: "unknown" });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({
      kind: "system",
      severity: "info",
      what: "Door added",
      sub: "Front door",
      refs: { surface: "doors", action: "door.create", doorId: "door-new", doorPositionSource: "lock" },
    });
  });

  it("a `none` door is created as not_monitored, and the audit says so", async () => {
    const p = makePrisma();
    const door = await createDoor(asPrisma(p), { name: "Back", doorPositionSource: "none", heldOpenSeconds: 60 }, { req: REQ, now: NOW });
    expect(door.position).toBe("not_monitored");
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({ refs: { doorPositionSource: "none" } });
  });

  it("refuses a name it cannot store, before touching the database", async () => {
    const p = makePrisma();
    await expect(
      createDoor(asPrisma(p), { name: "Front‮door", doorPositionSource: "lock" }, { req: REQ, now: NOW }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_NAME" });
    expect(p.accessPoint.create).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

describe("updateDoor", () => {
  it("404s a door that does not exist and 409s a retired one — nothing is written either way", async () => {
    const p = makePrisma();
    await expect(updateDoor(asPrisma(p), "nope", { name: "X" }, { req: REQ, now: NOW })).rejects.toMatchObject({ status: 404, code: "DOOR_NOT_FOUND" });
    p.accessPoint.findUnique.mockResolvedValue(doorRow({ status: "retired", retiredAt: NOW }));
    await expect(updateDoor(asPrisma(p), "door-1", { name: "X" }, { req: REQ, now: NOW })).rejects.toMatchObject({ status: 409, code: "DOOR_RETIRED" });
    expect(p.accessPoint.updateMany).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("updates only active doors (the write itself carries the status guard) and audits what changed, with the source before and after", async () => {
    const p = makePrisma();
    p.accessPoint.findUnique
      .mockResolvedValueOnce(doorRow())
      .mockResolvedValueOnce(doorRow({ doorPositionSource: "none" }));
    await updateDoor(asPrisma(p), "door-1", { doorPositionSource: "none" }, { req: REQ, now: NOW });
    expect(p.accessPoint.updateMany).toHaveBeenCalledWith({
      where: { id: "door-1", status: "active" },
      data: { doorPositionSource: "none" },
    });
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({
      what: "Door changed",
      refs: {
        surface: "doors",
        action: "door.update",
        doorId: "door-1",
        changed: ["doorPositionSource"],
        doorPositionSource: { from: "lock", to: "none" },
      },
    });
  });

  it("a patch that changes nothing writes and audits nothing", async () => {
    const p = makePrisma();
    p.accessPoint.findUnique.mockResolvedValue(doorRow());
    await updateDoor(asPrisma(p), "door-1", { name: "Front door", heldOpenSeconds: 30 }, { req: REQ, now: NOW });
    expect(p.accessPoint.updateMany).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("a door retired between the read and the write is a 409, not a silent overwrite", async () => {
    const p = makePrisma();
    p.accessPoint.findUnique.mockResolvedValue(doorRow());
    p.accessPoint.updateMany.mockResolvedValue({ count: 0 });
    await expect(updateDoor(asPrisma(p), "door-1", { name: "New" }, { req: REQ, now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

describe("retireDoor", () => {
  it("retires an active door once, stamps the time, and audits", async () => {
    const p = makePrisma();
    p.accessPoint.findUnique
      .mockResolvedValueOnce(doorRow())
      .mockResolvedValueOnce(doorRow({ status: "retired", retiredAt: NOW }));
    const door = await retireDoor(asPrisma(p), "door-1", { req: REQ, now: NOW });
    expect(p.accessPoint.updateMany).toHaveBeenCalledWith({
      where: { id: "door-1", status: "active" },
      data: { status: "retired", retiredAt: NOW },
    });
    expect(door.status).toBe("retired");
    expect(recordActivity.mock.calls[0]![0]).toMatchObject({ what: "Door retired", refs: { action: "door.retire", doorId: "door-1" } });
  });

  it("is idempotent: retiring a retired door returns it and writes and audits nothing", async () => {
    const p = makePrisma();
    p.accessPoint.findUnique.mockResolvedValue(doorRow({ status: "retired", retiredAt: NOW }));
    await retireDoor(asPrisma(p), "door-1", { req: REQ, now: NOW });
    expect(p.accessPoint.updateMany).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("404s a door that does not exist", async () => {
    const p = makePrisma();
    await expect(retireDoor(asPrisma(p), "nope", { req: REQ, now: NOW })).rejects.toBeInstanceOf(DoorWriteError);
  });
});

describe("purgeExpiredAccessEvents — the retention path", () => {
  it("calls the database purge function with the cutoff, counts from `now`, and reports what it deleted — naming no gate itself", async () => {
    const p = makePrisma();
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    p.$queryRaw.mockImplementation((async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ sql: strings.join("?").replace(/\s+/g, " ").trim(), values });
      return [{ deleted: 3n }];
    }) as never);

    const out = await purgeExpiredAccessEvents(asPrisma(p), 365, NOW);

    expect(out).toEqual({ deleted: 3, before: new Date("2025-09-29T03:55:00.000Z") });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/^SELECT "access_event_purge"\(\?::timestamptz\)/);
    expect(calls[0]!.values).toEqual([new Date("2025-09-29T03:55:00.000Z")]);
    // The function owns the gate: this file neither opens a transaction nor runs a DELETE of its own.
    expect(p.$transaction).not.toHaveBeenCalled();
    expect(p.$executeRaw).not.toHaveBeenCalled();
    expect(calls[0]!.sql).not.toMatch(/DELETE FROM|set_config/i);
  });

  it("refuses a retention that is not a whole number of days ≥ 1 — a typo is never 'delete everything'", async () => {
    const p = makePrisma();
    for (const bad of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(purgeExpiredAccessEvents(asPrisma(p), bad, NOW), String(bad)).rejects.toThrow(/retention/i);
    }
    expect(p.$queryRaw).not.toHaveBeenCalled();
  });

  it("a function that returns no row is an error, not zero", async () => {
    const p = makePrisma();
    p.$queryRaw.mockResolvedValue([]);
    await expect(purgeExpiredAccessEvents(asPrisma(p), 30, NOW)).rejects.toThrow(/no row/);
  });
});

describe("registerDoorsJobs", () => {
  it("registers ONE daily cron on the shared runtime, single-flighted on its own lock — no interval, no loop", () => {
    const scheduleCron = vi.fn();
    const scheduleInterval = vi.fn();
    registerDoorsJobs({ scheduleCron, scheduleInterval } as never, makePrisma() as never, 365);
    expect(scheduleInterval).not.toHaveBeenCalled();
    expect(scheduleCron).toHaveBeenCalledTimes(1);
    const [spec, handler, opts] = scheduleCron.mock.calls[0]!;
    expect(spec).toBe(DOORS_RETENTION_CRON);
    expect(spec).toBe("55 3 * * *");
    expect(typeof handler).toBe("function");
    expect(opts).toEqual({ lockKey: DOORS_RETENTION_LOCK_KEY });
  });

  it("the handler purges with the configured retention", async () => {
    const scheduleCron = vi.fn();
    const p = makePrisma();
    registerDoorsJobs({ scheduleCron, scheduleInterval: vi.fn() } as never, asPrisma(p) as never, 90);
    p.$queryRaw.mockResolvedValue([{ deleted: 0n }]);
    await (scheduleCron.mock.calls[0]![1] as () => Promise<void>)();
    const cutoff = (p.$queryRaw.mock.calls[0] as unknown[])[1] as Date;
    // 90 days before "now" (the handler's own clock), to the day.
    expect(Math.round((Date.now() - cutoff.getTime()) / 86_400_000)).toBe(90);
  });
});
