/**
 * ADR-055 (P4a) — the doors schema and service against REAL Postgres.
 *
 * WHY THESE CASES RUN HERE AND NOT IN THE MOCKED LANE
 *
 *   append-only   — "no in-place AccessEvent UPDATE or DELETE" is a database
 *                   fact. A mocked client proves nobody CALLED update; only a
 *                   real BEFORE UPDATE OR DELETE trigger proves a raw
 *                   statement, a no-op `SET kind = kind` and a cascade are
 *                   refused too — and that the retention purge, the one
 *                   sanctioned deleter, still works and leaves the gate shut
 *                   behind it.
 *   derived rows  — §9.7's "a door with no position source has no forced-door
 *                   claim" and §11.3's "derived alarms reference their
 *                   door_open row" are enforced by a BEFORE INSERT trigger and
 *                   CHECKs; a mocked insert cannot violate either.
 *   retention     — counts from createdAt (the box's clock), never occurredAt
 *                   (the device's), and never orphans a door_open row a
 *                   younger alarm still cites. Both are SQL predicates.
 *   paging        — rows sharing an occurredAt must neither repeat nor vanish
 *                   across a page boundary.
 *   position      — DISTINCT ON over the (accessPointId, occurredAt) index, by
 *                   occurredAt not id.
 *   wiring        — the §11.2 boot assertion's catalog query and its "trigger
 *                   missing" failure, against the real catalog.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * Local: scripts/test-orchestrator-pg.sh.
 *
 * FIXTURE SCOPING — the DB is shared by the pg suites. Every row this file
 * mints is namespaced `adr055` (door names, dedupe keys) and every cleanup is
 * scoped to it. Cleanup of AccessEvent goes through the retention gate — the
 * same door the production purge uses — because nothing else may delete one.
 * The one unscoped statement is the code under test, `purgeExpiredAccessEvents`,
 * which only reaches rows older than the horizon; no other suite writes them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import {
  DoorWriteError,
  createDoor,
  listDoorEvents,
  listDoors,
  parseEventCursor,
  purgeExpiredAccessEvents,
  registerDoorsJobs,
  retireDoor,
  updateDoor,
  _resetDoorsJobsForTests,
} from "./doors.service.js";
import { mountModuleGates } from "../modules/module-mounts.js";
import { createModuleGate } from "../middleware/module-gate.js";
import { createDoorsRouter } from "../routes/doors.js";
import { assertDoorsWired, DoorsWiringError } from "./doors-wiring.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "adr055";
const NOW = new Date("2026-09-29T03:55:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const REQ = { user: { id: "u-owner", role: "owner", username: "owner" } } as never;

describe.skipIf(!RUN)("doors — real Postgres (ADR-055 P4a)", () => {
  let prisma: PrismaClient;
  let seq = 0;
  const key = (label: string) => `${TAG}:${label}:${++seq}`;

  /** Delete through the ONE sanctioned door — the retention gate — because nothing else may. */
  async function cleanup() {
    if (!prisma) return;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('droplet.access_event_retention', 'on', true)`;
      await tx.$executeRaw`DELETE FROM "AccessEvent" WHERE "dedupeKey" LIKE ${TAG + ":%"}`;
    });
    await prisma.accessPoint.deleteMany({ where: { name: { startsWith: TAG } } });
    await prisma.moduleSetting.deleteMany({ where: { moduleId: "doors" } });
  }

  async function door(over: { name?: string; source?: "lock" | "dp1" | "none"; status?: "active" | "retired" } = {}) {
    const status = over.status ?? "active";
    return prisma.accessPoint.create({
      data: {
        name: over.name ?? `${TAG} door ${++seq}`,
        doorPositionSource: over.source ?? "lock",
        status,
        retiredAt: status === "retired" ? NOW : null,
      },
    });
  }

  async function event(
    doorId: string,
    kind: string,
    over: Partial<{
      occurredAt: Date;
      createdAt: Date;
      derivedFromId: bigint | null;
      forcedClaim: "latch_witnessed" | "unwitnessed_open" | null;
      troubleCode: "position_unknown" | null;
      dedupeKey: string;
    }> = {},
  ) {
    return prisma.accessEvent.create({
      data: {
        accessPointId: doorId,
        kind: kind as never,
        occurredAt: over.occurredAt ?? NOW,
        createdAt: over.createdAt ?? NOW,
        dedupeKey: over.dedupeKey ?? key(kind),
        derivedFromId: over.derivedFromId ?? null,
        forcedClaim: over.forcedClaim ?? null,
        troubleCode: over.troubleCode ?? null,
      },
    });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await cleanup();
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
  });

  describe("AccessEvent is append-only — refused by the database, not by convention", () => {
    it("refuses an UPDATE — every column, and even a no-op — through Prisma and through raw SQL", async () => {
      const d = await door();
      const e = await event(d.id, "door_open");

      await expect(prisma.accessEvent.update({ where: { id: e.id }, data: { correlationKey: "clip-1" } })).rejects.toThrow(/append-only/);
      await expect(prisma.accessEvent.updateMany({ data: { kind: "door_closed" }, where: { id: e.id } })).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRaw`UPDATE "AccessEvent" SET "kind" = "kind" WHERE "id" = ${e.id}`).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRawUnsafe(`UPDATE "AccessEvent" SET "occurredAt" = now()`)).rejects.toThrow(/append-only/);

      const after = await prisma.accessEvent.findUniqueOrThrow({ where: { id: e.id } });
      expect(after.kind).toBe("door_open");
      expect(after.correlationKey).toBeNull();
    });

    it("refuses a DELETE outside the retention job — Prisma, raw, and a whole-table sweep", async () => {
      const d = await door();
      const e = await event(d.id, "door_open");

      await expect(prisma.accessEvent.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
      await expect(prisma.accessEvent.deleteMany({ where: { id: e.id } })).rejects.toThrow(/append-only/);
      await expect(prisma.$executeRaw`DELETE FROM "AccessEvent" WHERE "id" = ${e.id}`).rejects.toThrow(/append-only/);
      expect(await prisma.accessEvent.count({ where: { id: e.id } })).toBe(1);
    });

    it("refuses the delete a foreign-key cascade would otherwise do: an AccessPoint with events cannot be removed", async () => {
      const d = await door();
      await event(d.id, "door_open");
      await expect(prisma.accessPoint.delete({ where: { id: d.id } })).rejects.toThrow();
      expect(await prisma.accessEvent.count({ where: { accessPointId: d.id } })).toBe(1);
    });

    it("the retention gate is transaction-local: after the purge, and on the very next statement, DELETE is refused again", async () => {
      const d = await door();
      await event(d.id, "door_open", { createdAt: daysAgo(400), occurredAt: daysAgo(400) });
      await purgeExpiredAccessEvents(prisma, 365, NOW);

      // Run several statements so they land on different pooled connections:
      // none may find the gate left open.
      for (let i = 0; i < 6; i++) {
        const fresh = await event(d.id, "door_closed", { dedupeKey: key("fresh") });
        await expect(prisma.accessEvent.delete({ where: { id: fresh.id } })).rejects.toThrow(/append-only/);
      }
    });

    it("a SET LOCAL outside a transaction opens nothing (it is a no-op, and the trigger still refuses)", async () => {
      const d = await door();
      const e = await event(d.id, "door_open");
      await prisma.$executeRawUnsafe(`SET LOCAL droplet.access_event_retention = 'on'`).catch(() => undefined);
      await expect(prisma.accessEvent.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
    });
  });

  describe("retention — purgeExpiredAccessEvents", () => {
    it("deletes what the BOX received more than N days ago and keeps the rest", async () => {
      const d = await door();
      const old = await event(d.id, "door_open", { createdAt: daysAgo(366), occurredAt: daysAgo(366) });
      const edge = await event(d.id, "door_closed", { createdAt: daysAgo(364), occurredAt: daysAgo(364) });
      const fresh = await event(d.id, "latch_extended");

      const out = await purgeExpiredAccessEvents(prisma, 365, NOW);
      expect(out.deleted).toBeGreaterThanOrEqual(1);
      expect(out.before).toEqual(daysAgo(365));

      const left = await prisma.accessEvent.findMany({ where: { accessPointId: d.id }, select: { id: true } });
      expect(left.map((r) => r.id).sort()).toEqual([edge.id, fresh.id].sort());
      expect(left.map((r) => r.id)).not.toContain(old.id);
    });

    it("counts from createdAt, not the device's occurredAt: an ancient device clock cannot expire a row at once, nor a future one keep it forever", async () => {
      const d = await door();
      const badClockPast = await event(d.id, "door_open", { occurredAt: daysAgo(900), createdAt: NOW });
      const badClockFuture = await event(d.id, "door_closed", { occurredAt: new Date(NOW.getTime() + 900 * DAY), createdAt: daysAgo(400) });

      await purgeExpiredAccessEvents(prisma, 365, NOW);

      const ids = (await prisma.accessEvent.findMany({ where: { accessPointId: d.id }, select: { id: true } })).map((r) => r.id);
      expect(ids).toContain(badClockPast.id);
      expect(ids).not.toContain(badClockFuture.id);
    });

    it("keeps a door_open row while a younger alarm still cites it, and takes both together once the alarm ages out", async () => {
      const d = await door({ source: "lock" });
      const open = await event(d.id, "door_open", { createdAt: daysAgo(366), occurredAt: daysAgo(366) });
      const alarm = await event(d.id, "forced_door", {
        createdAt: daysAgo(10),
        occurredAt: daysAgo(10),
        derivedFromId: open.id,
        forcedClaim: "latch_witnessed",
      });

      await purgeExpiredAccessEvents(prisma, 365, NOW);
      expect((await prisma.accessEvent.findMany({ where: { accessPointId: d.id } })).map((r) => r.id).sort()).toEqual([open.id, alarm.id].sort());

      // A later run, once the alarm is itself past the horizon: both go, in one pass, with no foreign-key error.
      await purgeExpiredAccessEvents(prisma, 365, new Date(NOW.getTime() + 400 * DAY));
      expect(await prisma.accessEvent.count({ where: { accessPointId: d.id } })).toBe(0);
    });

    it("a door_open and its alarm that are BOTH past the horizon go in one statement", async () => {
      const d = await door({ source: "dp1" });
      const open = await event(d.id, "door_open", { createdAt: daysAgo(500), occurredAt: daysAgo(500) });
      await event(d.id, "forced_door", {
        createdAt: daysAgo(499),
        occurredAt: daysAgo(499),
        derivedFromId: open.id,
        forcedClaim: "unwitnessed_open",
      });
      const out = await purgeExpiredAccessEvents(prisma, 365, NOW);
      expect(out.deleted).toBeGreaterThanOrEqual(2);
      expect(await prisma.accessEvent.count({ where: { accessPointId: d.id } })).toBe(0);
    });

    it("the cron leg registered by registerDoorsJobs runs the same purge", async () => {
      _resetDoorsJobsForTests();
      const d = await door();
      await event(d.id, "door_open", { createdAt: daysAgo(500), occurredAt: daysAgo(500) });
      let handler: (() => Promise<void>) | undefined;
      registerDoorsJobs({ scheduleCron: (_spec: string, fn: () => Promise<void>) => void (handler = fn) } as never, prisma, 365);
      await handler!();
      expect(await prisma.accessEvent.count({ where: { accessPointId: d.id } })).toBe(0);
    });
  });

  describe("derived alarms — the BEFORE INSERT trigger and the CHECKs (§9.7, §11.3)", () => {
    it("a door with doorPositionSource `none` can have NO forced-door and NO held-open row, however it is inserted", async () => {
      const none = await door({ source: "none" });
      const open = await event(none.id, "door_open");
      await expect(
        event(none.id, "forced_door", { derivedFromId: open.id, forcedClaim: "latch_witnessed" }),
      ).rejects.toThrow(/no forced_door claim|doorPositionSource none/);
      await expect(
        event(none.id, "forced_door", { derivedFromId: open.id, forcedClaim: "unwitnessed_open" }),
      ).rejects.toThrow(/doorPositionSource none/);
      await expect(event(none.id, "held_open", { derivedFromId: open.id })).rejects.toThrow(/doorPositionSource none/);
      await expect(
        prisma.$executeRaw`INSERT INTO "AccessEvent" ("accessPointId","kind","occurredAt","dedupeKey","derivedFromId","forcedClaim")
          VALUES (${none.id}, 'forced_door', now(), ${key("raw")}, ${open.id}, 'latch_witnessed')`,
      ).rejects.toThrow(/doorPositionSource none/);
      expect(await prisma.accessEvent.count({ where: { accessPointId: none.id, kind: { in: ["forced_door", "held_open"] } } })).toBe(0);
    });

    it("a lock door: forced_door(latch_witnessed) and held_open, each referencing a door_open row of that door", async () => {
      const lock = await door({ source: "lock" });
      const open = await event(lock.id, "door_open");
      await expect(event(lock.id, "forced_door", { derivedFromId: open.id, forcedClaim: "latch_witnessed" })).resolves.toBeDefined();
      await expect(event(lock.id, "held_open", { derivedFromId: open.id })).resolves.toBeDefined();
    });

    it("the two forced-door claims are not interchangeable: only a lock is its own witness", async () => {
      const lock = await door({ source: "lock" });
      const dp1 = await door({ source: "dp1" });
      const lockOpen = await event(lock.id, "door_open");
      const dp1Open = await event(dp1.id, "door_open");
      await expect(event(lock.id, "forced_door", { derivedFromId: lockOpen.id, forcedClaim: "unwitnessed_open" })).rejects.toThrow(/does not match doorPositionSource/);
      await expect(event(dp1.id, "forced_door", { derivedFromId: dp1Open.id, forcedClaim: "latch_witnessed" })).rejects.toThrow(/does not match doorPositionSource/);
      await expect(event(dp1.id, "forced_door", { derivedFromId: dp1Open.id, forcedClaim: "unwitnessed_open" })).resolves.toBeDefined();
    });

    it("an alarm must cite a door_open row — not another kind, not another door, not nothing", async () => {
      const a = await door({ source: "lock" });
      const b = await door({ source: "lock" });
      const closed = await event(a.id, "door_closed");
      const otherDoorOpen = await event(b.id, "door_open");
      const open = await event(a.id, "door_open");
      await expect(event(a.id, "held_open", { derivedFromId: closed.id })).rejects.toThrow(/must reference a door_open row of the same door/);
      await expect(event(a.id, "held_open", { derivedFromId: otherDoorOpen.id })).rejects.toThrow(/must reference a door_open row of the same door/);
      await expect(event(a.id, "held_open", { derivedFromId: null })).rejects.toThrow();
      await expect(event(a.id, "held_open", { derivedFromId: open.id })).resolves.toBeDefined();
    });

    it("the CHECKs tie columns to kinds: a claim only on forced_door, a trouble code only on trouble, a reference only on alarms", async () => {
      const d = await door({ source: "lock" });
      const open = await event(d.id, "door_open");
      await expect(event(d.id, "forced_door", { derivedFromId: open.id, forcedClaim: null })).rejects.toThrow(/AccessEvent_kind_shape/);
      await expect(event(d.id, "door_open", { forcedClaim: "latch_witnessed" })).rejects.toThrow(/AccessEvent_kind_shape/);
      await expect(event(d.id, "door_closed", { derivedFromId: open.id })).rejects.toThrow(/AccessEvent_kind_shape/);
      await expect(event(d.id, "trouble", { troubleCode: null })).rejects.toThrow(/AccessEvent_kind_shape/);
      await expect(event(d.id, "door_open", { troubleCode: "position_unknown" })).rejects.toThrow(/AccessEvent_kind_shape/);
      await expect(event(d.id, "trouble", { troubleCode: "position_unknown" })).resolves.toBeDefined();
    });

    it("a redelivered event lands on the dedupe key and adds nothing", async () => {
      const d = await door();
      const dedupeKey = key("replay");
      await event(d.id, "door_open", { dedupeKey });
      await expect(event(d.id, "door_open", { dedupeKey })).rejects.toThrow();
      const r = await prisma.accessEvent.createMany({
        data: [{ accessPointId: d.id, kind: "door_open", occurredAt: NOW, dedupeKey }],
        skipDuplicates: true,
      });
      expect(r.count).toBe(0);
      expect(await prisma.accessEvent.count({ where: { dedupeKey } })).toBe(1);
    });
  });

  describe("AccessPoint CHECKs", () => {
    it("refuses a blank name, a held-open time outside 5 s – 1 h, and a retired/retiredAt disagreement", async () => {
      const base = { doorPositionSource: "lock" as const };
      await expect(prisma.accessPoint.create({ data: { ...base, name: "   " } })).rejects.toThrow(/AccessPoint_shape/);
      await expect(prisma.accessPoint.create({ data: { ...base, name: `${TAG} a`, heldOpenSeconds: 4 } })).rejects.toThrow(/AccessPoint_shape/);
      await expect(prisma.accessPoint.create({ data: { ...base, name: `${TAG} b`, heldOpenSeconds: 3601 } })).rejects.toThrow(/AccessPoint_shape/);
      await expect(prisma.accessPoint.create({ data: { ...base, name: `${TAG} c`, status: "retired" } })).rejects.toThrow(/AccessPoint_shape/);
      await expect(prisma.accessPoint.create({ data: { ...base, name: `${TAG} d`, status: "active", retiredAt: NOW } })).rejects.toThrow(/AccessPoint_shape/);
      await expect(prisma.accessPoint.create({ data: { ...base, name: `${TAG} e`, status: "retired", retiredAt: NOW } })).resolves.toBeDefined();
    });
  });

  describe("the service on real rows", () => {
    it("reports position from the newest position event BY occurredAt, not by insertion order; `none` is not_monitored; a fresh door is unknown", async () => {
      const fresh = await door({ name: `${TAG} fresh`, source: "lock" });
      const closedThenOpen = await door({ name: `${TAG} cto`, source: "lock" });
      const lateArrival = await door({ name: `${TAG} late`, source: "dp1" });
      const gone = await door({ name: `${TAG} gone`, source: "lock" });
      const none = await door({ name: `${TAG} none`, source: "none" });

      await event(closedThenOpen.id, "door_closed", { occurredAt: daysAgo(1) });
      await event(closedThenOpen.id, "door_open", { occurredAt: new Date(NOW.getTime() - 1000) });
      await event(closedThenOpen.id, "latch_extended", { occurredAt: NOW }); // newest, but not a position event
      // Inserted SECOND (higher id) but happened EARLIER: the door is still open.
      await event(lateArrival.id, "door_open", { occurredAt: new Date(NOW.getTime() - 1000) });
      await event(lateArrival.id, "door_closed", { occurredAt: daysAgo(3) });
      // Closed, then the cartridge lost it.
      await event(gone.id, "door_closed", { occurredAt: daysAgo(1) });
      await event(gone.id, "trouble", { occurredAt: new Date(NOW.getTime() - 500), troubleCode: "position_unknown" });
      await event(none.id, "door_open");

      const doors = await listDoors(prisma, { includeRetired: false });
      const byName = new Map(doors.map((x) => [x.name, x]));
      expect(byName.get(`${TAG} fresh`)).toMatchObject({ position: "unknown", positionSince: null });
      expect(byName.get(`${TAG} cto`)!.position).toBe("open");
      expect(byName.get(`${TAG} late`)!.position).toBe("open");
      expect(byName.get(`${TAG} gone`)!.position).toBe("unknown");
      expect(byName.get(`${TAG} none`)).toMatchObject({ position: "not_monitored", positionSince: null, claims: { forcedDoor: null, heldOpen: false } });
      // Silence about the unused ids the fixtures made.
      expect(fresh.id).toBeTruthy();
    });

    it("pages events without a repeat or a gap when many rows share one instant", async () => {
      const d = await door();
      const at = new Date(NOW.getTime() - 5000);
      for (let i = 0; i < 5; i++) await event(d.id, "door_open", { occurredAt: at, dedupeKey: key("same-instant") });
      await event(d.id, "door_closed", { occurredAt: new Date(NOW.getTime() - 1000) });
      await event(d.id, "door_open", { occurredAt: new Date(NOW.getTime() - 9000) });

      const seen: string[] = [];
      let cursor: ReturnType<typeof parseEventCursor> | undefined;
      let pages = 0;
      for (;;) {
        const page = await listDoorEvents(prisma, { limit: 2, doorId: d.id, ...(cursor ? { cursor } : {}) });
        seen.push(...page.events.map((e) => e.id));
        pages++;
        if (!page.nextCursor) break;
        cursor = parseEventCursor(page.nextCursor)!;
        expect(cursor).not.toBeNull();
      }
      expect(pages).toBe(4);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      // Newest first by device time, ties by id descending.
      const all = await prisma.accessEvent.findMany({ where: { accessPointId: d.id }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }] });
      expect(seen).toEqual(all.map((e) => e.id.toString()));
    });

    it("create / update / retire, and a retired door can no longer be changed", async () => {
      const created = await createDoor(prisma, { name: `${TAG} front`, doorPositionSource: "lock" }, { req: REQ, now: NOW });
      expect(created).toMatchObject({ heldOpenSeconds: 30, status: "active", position: "unknown" });

      const renamed = await updateDoor(prisma, created.id, { name: `${TAG} main`, heldOpenSeconds: 45 }, { req: REQ, now: NOW });
      expect(renamed).toMatchObject({ name: `${TAG} main`, heldOpenSeconds: 45 });

      const none = await updateDoor(prisma, created.id, { doorPositionSource: "none" }, { req: REQ, now: NOW });
      expect(none).toMatchObject({ position: "not_monitored", claims: { forcedDoor: null, heldOpen: false } });

      const retired = await retireDoor(prisma, created.id, { req: REQ, now: NOW });
      expect(retired.status).toBe("retired");
      expect((await retireDoor(prisma, created.id, { req: REQ, now: NOW })).status).toBe("retired");
      await expect(updateDoor(prisma, created.id, { name: `${TAG} x` }, { req: REQ, now: NOW })).rejects.toBeInstanceOf(DoorWriteError);

      expect((await listDoors(prisma, { includeRetired: false })).map((x) => x.id)).not.toContain(created.id);
      expect((await listDoors(prisma, { includeRetired: true })).map((x) => x.id)).toContain(created.id);
    });

    it("the `doors` ModuleId exists in the database (its own migration ran before the tables)", async () => {
      await expect(prisma.moduleSetting.create({ data: { moduleId: "doors", enabled: true } })).resolves.toBeDefined();
    });
  });

  describe("the §11.2 boot assertion, against the real catalog", () => {
    const ON = { DOORS_ENABLED: true } as AvailabilityConfig;

    function wiredApp() {
      const app = express();
      app.use((_req, _res, next) => next());
      mountModuleGates(
        app,
        createModuleGate({ moduleSetting: { findMany: async () => [] } } as never, ON, 0),
        (async () => null) as never,
      );
      app.use("/api", createDoorsRouter(prisma));
      return app;
    }

    it("passes against a database with both triggers and both tables", async () => {
      _resetDoorsJobsForTests();
      registerDoorsJobs({ scheduleCron: () => undefined } as never, prisma, 365);
      await expect(assertDoorsWired({ app: wiredApp(), config: ON, prisma })).resolves.toEqual({ state: "wired" });
    });

    it("fails, by name, when the append-only trigger is gone (rolled back, so nothing is left behind)", async () => {
      _resetDoorsJobsForTests();
      registerDoorsJobs({ scheduleCron: () => undefined } as never, prisma, 365);
      const rollback = new Error("rollback");
      let caught: unknown;
      await prisma
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`DROP TRIGGER "AccessEvent_append_only" ON "AccessEvent"`);
          try {
            await assertDoorsWired({ app: wiredApp(), config: ON, prisma: tx as never });
          } catch (e) {
            caught = e;
          }
          throw rollback;
        })
        .catch((e) => {
          if (e !== rollback) throw e;
        });
      expect(caught).toBeInstanceOf(DoorsWiringError);
      expect((caught as DoorsWiringError).problems.join("\n")).toMatch(/AccessEvent_append_only/);

      // …and it really was rolled back: the trigger still refuses.
      const d = await door();
      const e = await event(d.id, "door_open");
      await expect(prisma.accessEvent.delete({ where: { id: e.id } })).rejects.toThrow(/append-only/);
    });
  });
});
