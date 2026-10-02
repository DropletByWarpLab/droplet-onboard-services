/**
 * WARP-2978 PR-D (ADR-059 P3 spec §6.12, D35) — the `detection_ongoing` row in
 * the database: the kind exists, its CHECK refuses every other shape, the row
 * is as append-only as every SecurityEvent, and both migration folders re-run
 * as no-ops.
 *
 *   20260925030100_warp_2978_security_event_ongoing_value — the enum value,
 *     in its own folder (Postgres will not let one transaction USE a value it
 *     added, and the next folder's CHECK compares against it);
 *   20260925030200_warp_2978_security_event_ongoing_shape — the CHECK:
 *     an ongoing row is a Frigate row with a camera, no end yet, and a key in
 *     the `frigate-ongoing:` namespace.
 *
 * The CHECK is invisible to `prisma migrate diff`, so check-schema-drift
 * cannot see it dropped or loosened; this file is how that shows. Each refused
 * case asserts SQLSTATE 23514 AND the constraint that fired, so a row refused
 * by the WRONG rule (or by a NOT NULL, or a missing enum value) does not pass.
 *
 * Then the engine on real rows — the §6.12 box proof in miniature: a person
 * still in view after closing gets ONE ongoing row at 30 s and an alert
 * incident in the same tick, never a second row, the incident is held open
 * while they stay, and their `end` row joins it. The clock is the real one
 * (the row's `createdAt` is the database's `now()`), so "31 s ago" is
 * relative to it, and the site is closed by a manual mode that holds at any
 * hour.
 *
 * Every probe runs in a transaction that ALWAYS rolls back; fixtures are
 * tagged `warp2978d` and swept (scoped) before and after, belt and braces.
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { MIGRATIONS_DIR } from "../__tests__/helpers/test-paths.js";
import { tickSecurityIncidents, _resetIncidentHealthForTests, type SecurityIncidentDeps } from "./security-incidents.service.js";
import { createInflightTracker, presenceHolds } from "./security-inflight.js";

// The global unit setup mocks @prisma/client; this file needs the real one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2978d";
const VALUE_FOLDER = "20260925030100_warp_2978_security_event_ongoing_value";
const SHAPE_FOLDER = "20260925030200_warp_2978_security_event_ongoing_shape";

/** Thrown to roll a probe transaction back after a successful insert. */
class Rollback extends Error {}

type Outcome = "inserted" | { sqlstate: string; constraint: string | null };
const rejectedBy = (constraint: string): Outcome => ({ sqlstate: "23514", constraint });
const q = (v: string | null): string => (v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`);

/** A migration's statements, split at top-level `;` (a `DO $$ … $$` body keeps its own) — WARP-2804's splitter. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inDollar = false;
  for (const line of sql.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim().startsWith("--") && !inDollar) continue;
    cur += line + "\n";
    inDollar = (line.match(/\$\$/g)?.length ?? 0) % 2 === 1 ? !inDollar : inDollar;
    if (!inDollar && line.trimEnd().endsWith(";")) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

describe.skipIf(!RUN)("the detection_ongoing row in Postgres (WARP-2978 PR-D)", () => {
  let prisma: PrismaClient;

  async function sweep(): Promise<void> {
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { contains: TAG } } });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await sweep();
  });

  afterAll(async () => {
    await sweep();
    await prisma.$disconnect();
  });

  /** Run the statements in one transaction that always rolls back; report what the last one did. */
  async function run(...sql: string[]): Promise<Outcome> {
    try {
      await prisma.$transaction(async (tx) => {
        for (const s of sql) await tx.$executeRawUnsafe(s);
        throw new Rollback("probe");
      });
    } catch (e) {
      if (e instanceof Rollback) return "inserted";
      const err = e as { code?: string; meta?: { code?: string; message?: string } };
      if (err.code === "P2010" && typeof err.meta?.code === "string") {
        const m = /violates check constraint "([^"]+)"/.exec(err.meta.message ?? "");
        return { sqlstate: err.meta.code, constraint: m?.[1] ?? null };
      }
      throw e;
    }
    throw new Error("unreachable: the probe transaction always rolls back");
  }

  let n = 0;
  /** One SecurityEvent INSERT; `over` replaces columns (SQL literals). A legal ongoing row by default. */
  function event(over: Record<string, string> = {}): string {
    const k = ++n;
    const cols: Record<string, string> = {
      source: "'frigate'",
      kind: "'detection_ongoing'",
      severity: "'info'",
      camera: q(`${TAG}_back`),
      sourceRef: q(`${TAG}_back/1790000000.${k}-abc`),
      dedupeKey: q(`frigate-ongoing:${TAG}-1790000000.${k}-abc`),
      labels: "ARRAY['person']::text[]",
      cameraZones: "ARRAY[]::text[]",
      score: "0.86",
      startedAt: "now() - interval '40 seconds'",
      endedAt: "NULL",
      summary: q("Person still in view after 30 s"),
      ...over,
    };
    const names = Object.keys(cols);
    return `INSERT INTO "SecurityEvent" (${names.map((c) => `"${c}"`).join(",")}) VALUES (${names.map((c) => cols[c]).join(",")})`;
  }

  describe("SecurityEvent_ongoing_shape", () => {
    it("accepts a legal ongoing row, and leaves every other row shape alone", async () => {
      expect(await run(event())).toBe("inserted");
      expect(await run(event({ cameraZones: "ARRAY['porch']::text[]", score: "NULL" }))).toBe("inserted");
      // A finished detection with an end time, and the P2a status / threat rows (camera NULL, no key namespace).
      expect(
        await run(event({ kind: "'detection'", dedupeKey: q(`frigate:${TAG}-done`), endedAt: "now()", summary: q("Person in porch") })),
      ).toBe("inserted");
      expect(
        await run(event({ source: "'frigate_status'", kind: "'source_offline'", camera: "NULL", dedupeKey: q(`frigate_status:${TAG}:offline`), labels: "NULL" })),
      ).toBe("inserted");
      expect(await run(event({ source: "'activity_mirror'", kind: "'threat'", camera: "NULL", dedupeKey: q(`activity:${TAG}`), labels: "NULL" }))).toBe(
        "inserted",
      );
    });

    it.each([
      ["from another source", { source: "'frigate_status'" }],
      ["with no camera", { camera: "NULL" }],
      ["with an end time (it has not ended — the `end` row is its own)", { endedAt: "now()" }],
      ["keyed as a finished detection", { dedupeKey: q(`frigate:${TAG}-x`) }],
      ["keyed outside any namespace", { dedupeKey: q(`${TAG}-x`) }],
    ])("refuses an ongoing row %s", async (_name, over) => {
      expect(await run(event(over))).toEqual(rejectedBy("SecurityEvent_ongoing_shape"));
    });
  });

  it("an ongoing row is append-only like every SecurityEvent: UPDATE refused by the trigger, DELETE still works (D11)", async () => {
    const e = await prisma.securityEvent.create({
      data: {
        source: "frigate",
        kind: "detection_ongoing",
        severity: "info",
        camera: `${TAG}_back`,
        sourceRef: `${TAG}_back/append`,
        dedupeKey: `frigate-ongoing:${TAG}-append`,
        labels: ["person"],
        cameraZones: [],
        score: 0.9,
        startedAt: new Date("2026-09-23T21:14:00Z"),
        summary: "Person still in view after 30 s",
      },
    });
    // Its end is a NEW row, never an UPDATE of this one.
    await expect(prisma.$executeRawUnsafe(`UPDATE "SecurityEvent" SET "endedAt" = now() WHERE id = ${e.id}`)).rejects.toMatchObject({
      meta: { code: "23001" },
    });
    expect((await prisma.securityEvent.findUniqueOrThrow({ where: { id: e.id } })).endedAt).toBeNull();
    expect(await prisma.securityEvent.deleteMany({ where: { id: e.id } })).toEqual({ count: 1 });
  });

  it("both folders re-run as no-ops: one enum value, one CHECK with the same definition", async () => {
    const value = readFileSync(join(MIGRATIONS_DIR, VALUE_FOLDER, "migration.sql"), "utf8");
    const shape = readFileSync(join(MIGRATIONS_DIR, SHAPE_FOLDER, "migration.sql"), "utf8");
    const probe = async () => {
      const labels = await prisma.$queryRawUnsafe<Array<{ l: string }>>(
        `SELECT e.enumlabel AS l FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'SecurityEventKind' AND e.enumlabel = 'detection_ongoing'`,
      );
      const defs = await prisma.$queryRawUnsafe<Array<{ def: string }>>(
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conrelid = '"SecurityEvent"'::regclass AND c.conname = 'SecurityEvent_ongoing_shape'`,
      );
      return { labels: labels.map((r) => r.l), defs: defs.map((r) => r.def) };
    };
    const before = await probe();
    expect(before.labels).toEqual(["detection_ongoing"]);
    expect(before.defs).toHaveLength(1);
    // Each folder runs as its own transaction, as `migrate deploy` runs it.
    for (const sql of [value, shape]) {
      await prisma.$transaction(async (tx) => {
        for (const s of statements(sql)) await tx.$executeRawUnsafe(s);
      });
    }
    expect(await probe()).toEqual(before);
  });

  describe("the engine on real rows: a person still in view alerts at 30 s, and their end joins", () => {
    const CAM = `${TAG}_back`;
    let zoneId = "";
    let savedEngine: Prisma.SecurityIncidentEngineStateGetPayload<Record<string, never>> | null = null;
    let savedMode: unknown = null;
    let savedHours: unknown = null;
    let savedDays: unknown[] = [];
    const deps = (now: Date, ongoing: ReturnType<typeof createInflightTracker>): SecurityIncidentDeps => ({
      // The module is off: grouped all the same, never sent (D29) — no notifier I/O here.
      isSecurityModuleOn: async () => false,
      resolveAccess: async () => null,
      ongoing,
      now: () => now,
    });

    async function sweepEngine(): Promise<void> {
      const incidents = await prisma.securityIncident.findMany({ where: { cameras: { has: CAM } }, select: { id: true } });
      // Events first: their triage rows cascade, and then nothing holds the incidents (Restrict).
      await prisma.securityEvent.deleteMany({ where: { camera: CAM } });
      await prisma.securityEventTriage.deleteMany({ where: { incidentId: { in: incidents.map((i) => i.id) } } });
      await prisma.securityIncident.deleteMany({ where: { id: { in: incidents.map((i) => i.id) } } });
      const zones = await prisma.securityZone.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
      await prisma.securityZoneLink.deleteMany({ where: { zoneId: { in: zones.map((z) => z.id) } } });
      await prisma.securityZone.deleteMany({ where: { id: { in: zones.map((z) => z.id) } } });
    }

    beforeAll(async () => {
      savedEngine = await prisma.securityIncidentEngineState.findUnique({ where: { id: "singleton" } });
      savedMode = await prisma.securityModeState.findUnique({ where: { id: "singleton" } });
      savedHours = await prisma.securitySiteHours.findUnique({ where: { id: "singleton" } });
      savedDays = await prisma.securitySchedule.findMany();
      await sweepEngine();
      // Closed at any hour: a manual close with no hours set (until changed).
      await prisma.securitySchedule.deleteMany({});
      await prisma.securitySiteHours.deleteMany({});
      await prisma.securityModeState.deleteMany({});
      await prisma.securityModeState.create({
        data: { id: "singleton", mode: "closed", modeSource: "manual", manualEnd: "until_changed", setAt: new Date() },
      });
      const zone = await prisma.securityZone.create({ data: { name: `${TAG} Stock room`, nameKey: `${TAG} stock room`, kind: "interior" } });
      zoneId = zone.id;
      await prisma.securityZoneLink.create({
        data: { zoneId, sourceKind: "camera", sourceRef: CAM, sourceLabel: "Back", state: "active", origin: "person", stateSetBy: "person" },
      });
    });

    afterAll(async () => {
      await sweepEngine();
      await prisma.securityIncidentEngineState.deleteMany({});
      if (savedEngine) await prisma.securityIncidentEngineState.create({ data: savedEngine });
      await prisma.securitySchedule.deleteMany({});
      if (savedDays.length) await prisma.securitySchedule.createMany({ data: savedDays as Prisma.SecurityScheduleCreateManyInput[] });
      await prisma.securitySiteHours.deleteMany({});
      if (savedHours) await prisma.securitySiteHours.create({ data: savedHours as Prisma.SecuritySiteHoursCreateInput });
      await prisma.securityModeState.deleteMany({});
      if (savedMode) await prisma.securityModeState.create({ data: savedMode as Prisma.SecurityModeStateCreateInput });
    });

    it("one ongoing row at 30 s → an alert incident in the same tick; never a second row; held open; the end joins it", async () => {
      _resetIncidentHealthForTests();
      // The floor at the store's head: only this case's rows are triaged.
      const { _max } = await prisma.securityEvent.aggregate({ _max: { id: true } });
      const head = _max.id ?? 0n;
      await prisma.securityIncidentEngineState.deleteMany({});
      await prisma.securityIncidentEngineState.create({
        data: { id: "singleton", startedAtId: head, triageFloor: head, floorCandidate: head, floorCandidateAt: new Date(Date.now() - 600_000) },
      });

      const startSec = Math.floor(Date.now() / 1000) - 31;
      const fid = `${startSec}.5-${TAG}`;
      const startedAt = new Date(startSec * 1000);
      const track = (type: "new" | "update" | "end") => ({
        type,
        before: {},
        after: { id: fid, camera: CAM, label: "person", start_time: startSec, end_time: null, top_score: 0.88, false_positive: false, entered_zones: [] },
      });
      const map = createInflightTracker();
      map.observe(track("new"), new Date());

      // Tick 1, 31 s into the track: the row is written AND triaged.
      await tickSecurityIncidents(prisma, deps(new Date(), map));
      const rows = await prisma.securityEvent.findMany({ where: { camera: CAM, kind: "detection_ongoing" } });
      expect(rows).toEqual([
        expect.objectContaining({
          source: "frigate",
          dedupeKey: `frigate-ongoing:${fid}`,
          startedAt,
          endedAt: null,
          labels: ["person"],
          score: 0.88,
          summary: "Person still in view after 30 s",
        }),
      ]);
      const ongoing = rows[0]!;
      const t = await prisma.securityEventTriage.findUniqueOrThrow({
        where: { eventId: ongoing.id },
        include: { incident: { include: { reasons: true } } },
      });
      expect(t).toMatchObject({ outcome: "grouped" });
      expect(t.incident).toMatchObject({
        scope: "area",
        zoneId,
        severity: "alert",
        state: "open",
        reasonCodes: ["after_hours_presence"],
        notifyState: "module_off",
        firstActivityAt: startedAt,
        countsByCamera: { [CAM]: { _ongoing: 1 } },
      });
      expect(t.incident!.reasons).toEqual([
        expect.objectContaining({ code: "after_hours_presence", evidenceEventId: ongoing.id, evidenceKind: "detection_ongoing" }),
      ]);
      const incidentId = t.incidentId!;
      const alertedAt = t.incident!.alertedAt;

      // Ticks 2-3: Frigate keeps updating; no second row.
      map.observe(track("update"), new Date());
      await tickSecurityIncidents(prisma, deps(new Date(), map));
      await tickSecurityIncidents(prisma, deps(new Date(Date.now() + 10_000), map));
      expect(await prisma.securityEvent.count({ where: { camera: CAM, kind: "detection_ongoing" } })).toBe(1);

      // Eight minutes on, still in view: past quiet + settle, but held open.
      const eight = new Date(Date.now() + 8 * 60_000);
      await tickSecurityIncidents(prisma, deps(eight, map));
      expect(await prisma.securityIncident.findUniqueOrThrow({ where: { id: incidentId } })).toMatchObject({ grouping: "collecting" });
      // …by this camera's person: the answer a camera-limited viewer's "still happening" reads too.
      expect(await presenceHolds(prisma, [{ id: incidentId, firstActivityAt: startedAt }], map, eight)).toEqual(
        new Map([[incidentId, new Set([CAM])]]),
      );

      // Nine minutes on, Frigate ends the object: the ingest's own `end` row joins the SAME incident.
      const endAt = new Date(Date.now() + 9 * 60_000);
      map.observe(track("end"), endAt);
      const end = await prisma.securityEvent.create({
        data: {
          source: "frigate",
          kind: "detection",
          severity: "info",
          camera: CAM,
          sourceRef: `${CAM}/${fid}`,
          dedupeKey: `frigate:${fid}`,
          labels: ["person"],
          cameraZones: [],
          score: 0.88,
          startedAt,
          endedAt: endAt,
          summary: "Person",
        },
      });
      await tickSecurityIncidents(prisma, deps(new Date(endAt.getTime() + 5_000), map));
      expect(await prisma.securityEventTriage.findUniqueOrThrow({ where: { eventId: end.id } })).toMatchObject({ outcome: "grouped", incidentId });
      expect(await prisma.securityIncident.count({ where: { cameras: { has: CAM } } })).toBe(1);
      expect(await prisma.securityIncident.findUniqueOrThrow({ where: { id: incidentId } })).toMatchObject({
        eventCount: 2,
        countsByCamera: { [CAM]: { _ongoing: 1, person: 1 } },
        lastActivityAt: endAt,
        alertedAt,
      });
    });
  });
});
