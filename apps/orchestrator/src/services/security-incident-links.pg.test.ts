/**
 * WARP-3195 (ADR-059 P4 §6.7.1, §8) — route 18's `dropletLinks` against REAL
 * Postgres, the real engine and route 24's real write:
 *
 *   · Stock room is covered by FRONT (a person linked it) and BACK (Droplet
 *     linked it on its own). A person on BACK after hours groups into Stock
 *     room and raises nothing: Droplet's links never alert.
 *   · The owner at manage reads BACK's link on that incident — the line and
 *     Keep — and nothing on the same incident built from FRONT alone.
 *   · 🔴 R1: Maria (family, FRONT only) reads `dropletLinks: null`, and her
 *     WHOLE detail equals the one for the incident built from FRONT's events
 *     alone — `actionable` included, since a Droplet-only camera raises no
 *     alert she could be missing. (The pin itself,
 *     security-incident-list.pg.test.ts, is untouched and still passes.)
 *   · Keep (`decideDropletLink` accept — route 24's service): the line is gone,
 *     and BACK's next person after hours is an alert.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL. Every camera, area and event
 * here is tagged `warp3195k`; the engine / mode / hours singletons are saved
 * before the file and restored after it; the audit rows route 24 appends are
 * this file's chain segment (`chainFloor`) and are deleted after it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";

vi.unmock("@prisma/client");

import { tickSecurityIncidents, _resetIncidentHealthForTests, type SecurityIncidentDeps } from "./security-incidents.service.js";
import { listIncidents, loadIncidentDetail, type IncidentViewer } from "./security-incident-view.js";
import { decideDropletLink, type ZoneWriteContext } from "./security-zones.service.js";
import { createActivityRecorder } from "./activity.service.js";
import { _setActivityRecorderForTests } from "./activity.singleton.js";
import { createHmacSigner } from "./audit-signing.service.js";
import { chainFloor, deleteAfterFloor, type ChainFloor } from "../__tests__/helpers/activity-chain-floor.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp3195k";
const FRONT = `${TAG}_front`;
const BACK = `${TAG}_back`;
const CAMS = [FRONT, BACK];
/** 22:14 in London on a Wednesday: closed by the hours below. */
const T0 = new Date("2026-09-23T21:14:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** Maria: family, sees FRONT only. */
const MARIA: IncidentViewer = { userId: randomUUID(), visibleCameras: new Set([FRONT]), mayReadThreats: false, ownerOrAdmin: false };
const OWNER: IncidentViewer = { userId: randomUUID(), visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: true };

describe.skipIf(!RUN)("route 18 `dropletLinks` — real Postgres, the real engine, route 24's write (WARP-3195)", () => {
  let prisma: PrismaClient;
  let floor: ChainFloor | null = null;
  let savedEngine: unknown = null;
  let savedMode: unknown = null;
  let savedHours: unknown = null;
  let savedDays: unknown[] = [];
  let stockRoom = "";
  let backLink = "";
  let n = 0;
  const signer = createHmacSigner(Buffer.alloc(32, 7));

  const deps = (now: Date): SecurityIncidentDeps => ({ isSecurityModuleOn: async () => false, resolveAccess: async () => null, now: () => now });
  const tick = (at: Date) => tickSecurityIncidents(prisma, deps(at));

  async function sweepIncidents(): Promise<void> {
    const incidents = await prisma.securityIncident.findMany({
      where: { OR: [{ zoneName: { startsWith: TAG } }, { scopeCamera: { startsWith: TAG } }, { cameras: { hasSome: CAMS } }] },
      select: { id: true },
    });
    const ids = incidents.map((i) => i.id);
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: `${TAG}:` } } });
    await prisma.securityEventTriage.deleteMany({ where: { incidentId: { in: ids } } });
    await prisma.securityIncident.deleteMany({ where: { id: { in: ids } } });
  }

  async function sweep(): Promise<void> {
    await sweepIncidents();
    const zones = await prisma.securityZone.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
    await prisma.securityZoneLink.deleteMany({ where: { zoneId: { in: zones.map((z) => z.id) } } });
    await prisma.securityZone.deleteMany({ where: { id: { in: zones.map((z) => z.id) } } });
  }

  async function engineAtHead(): Promise<void> {
    const { _max } = await prisma.securityEvent.aggregate({ _max: { id: true } });
    const head = _max.id ?? 0n;
    await prisma.securityIncidentEngineState.deleteMany({});
    await prisma.securityIncidentEngineState.create({
      data: { id: "singleton", startedAtId: head, triageFloor: head, floorCandidate: head, floorCandidateAt: plus(T0, -600_000) },
    });
  }

  /** A person on `camera` from `at` for 20 s, arriving 1 s after it ended. `key` makes the row the same in both worlds. */
  async function person(camera: string, at: Date, key = `${camera}-${++n}`): Promise<string> {
    const e = await prisma.securityEvent.create({
      data: {
        source: "frigate",
        kind: "detection",
        severity: "info",
        camera,
        sourceRef: `${camera}/${key}.5-a`,
        dedupeKey: `${TAG}:${key}`,
        labels: ["person"],
        cameraZones: [],
        score: 0.9,
        startedAt: at,
        endedAt: plus(at, 20_000),
        createdAt: plus(at, 21_000),
        summary: `Person seen by ${camera}`,
      },
    });
    return e.id.toString();
  }

  /** Back's link as Droplet set it: CHECK SecurityZoneLink_origin_shape wants its evidence columns. */
  async function linkBackByDroplet(): Promise<void> {
    await prisma.securityZoneLink.deleteMany({ where: { zoneId: stockRoom, sourceRef: BACK } });
    const row = await prisma.securityZoneLink.create({
      data: {
        zoneId: stockRoom,
        sourceKind: "camera",
        sourceRef: BACK,
        sourceLabel: "Back",
        state: "active",
        origin: "droplet",
        stateSetBy: "droplet",
        evidence: { v: 1 },
        confidence: 0.66,
        rulesVersion: 1,
        evidenceAt: T0,
      },
    });
    backLink = row.id;
  }

  const onlyIncident = async (now: Date) => {
    const list = await listIncidents(prisma, OWNER, { state: "all" }, 30, now);
    const mine = list.incidents.filter((i) => i.zone?.id === stockRoom);
    expect(mine).toHaveLength(1);
    return mine[0]!.id;
  };

  beforeAll(async () => {
    const { PrismaClient: Real } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new Real();
    await prisma.$connect();
    _setActivityRecorderForTests(createActivityRecorder({ prisma, signer }), signer);
    floor = await chainFloor(prisma);
    savedEngine = await prisma.securityIncidentEngineState.findUnique({ where: { id: "singleton" } });
    savedMode = await prisma.securityModeState.findUnique({ where: { id: "singleton" } });
    savedHours = await prisma.securitySiteHours.findUnique({ where: { id: "singleton" } });
    savedDays = await prisma.securitySchedule.findMany();
    await sweep();
    await prisma.securitySchedule.deleteMany({});
    await prisma.securitySiteHours.deleteMany({});
    await prisma.securityModeState.deleteMany({});
    await prisma.securitySiteHours.create({ data: { id: "singleton", state: "set", timezone: "Europe/London", version: 1 } });
    await prisma.securitySchedule.createMany({
      data: [1, 2, 3, 4, 5, 6, 7].map((weekday) =>
        weekday <= 5 ? { weekday, kind: "hours" as const, opensMin: 540, closesMin: 1020 } : { weekday, kind: "closed" as const },
      ),
    });
    await prisma.securityModeState.create({ data: { id: "singleton", mode: "closed", modeSource: "schedule", setAt: T0 } });
    const zone = await prisma.securityZone.create({ data: { name: `${TAG} Stock room`, nameKey: `${TAG} stock room`, kind: "interior" } });
    stockRoom = zone.id;
    await prisma.securityZoneLink.create({
      data: { zoneId: stockRoom, sourceKind: "camera", sourceRef: FRONT, sourceLabel: "Front", state: "active", origin: "person", stateSetBy: "person" },
    });
  });

  afterAll(async () => {
    await sweep();
    await deleteAfterFloor(prisma, floor);
    _setActivityRecorderForTests(null, null);
    await prisma.securityIncidentEngineState.deleteMany({});
    if (savedEngine) await prisma.securityIncidentEngineState.create({ data: savedEngine as Prisma.SecurityIncidentEngineStateCreateInput });
    await prisma.securitySchedule.deleteMany({});
    if (savedDays.length) await prisma.securitySchedule.createMany({ data: savedDays as Prisma.SecurityScheduleCreateManyInput[] });
    await prisma.securitySiteHours.deleteMany({});
    if (savedHours) await prisma.securitySiteHours.create({ data: savedHours as Prisma.SecuritySiteHoursCreateInput });
    await prisma.securityModeState.deleteMany({});
    if (savedMode) await prisma.securityModeState.create({ data: savedMode as Prisma.SecurityModeStateCreateInput });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    _resetIncidentHealthForTests();
    await sweepIncidents();
    await linkBackByDroplet();
  });

  it("🔴 the owner reads back's link, Maria reads null — and her whole detail equals front's-alone world, `actionable` included", async () => {
    const NOW = plus(T0, 600_000);
    /** Ids differ between the two worlds (new rows); nothing else may. */
    const normalized = (x: unknown, idsInOrder: string[]) => {
      let s = JSON.stringify(x);
      idsInOrder.forEach((id, k) => (s = s.split(`"${id}"`).join(`"#${k}"`)));
      return JSON.parse(s) as unknown;
    };

    // World B: front's events alone.
    await engineAtHead();
    const b1 = await person(FRONT, T0, "front-1");
    await tick(plus(T0, 30_000));
    await tick(NOW);
    const bId = await onlyIncident(NOW);
    const aloneMaria = await loadIncidentDetail(prisma, bId, MARIA, "act", NOW);
    const aloneOwner = await loadIncidentDetail(prisma, bId, OWNER, "manage", NOW);
    expect(aloneOwner!.dropletLinks).toEqual([]);
    await sweepIncidents();

    // World A: the same front event, and a person on BACK (Droplet's link only) four minutes later.
    await engineAtHead();
    const a1 = await person(FRONT, T0, "front-1");
    await tick(plus(T0, 30_000));
    await person(BACK, plus(T0, 240_000), "back-1");
    await tick(plus(T0, 280_000));
    await tick(NOW);
    const aId = await onlyIncident(NOW);
    const stored = await prisma.securityIncident.findUniqueOrThrow({ where: { id: aId }, include: { reasons: true } });
    // It grouped into Stock room through Droplet's link — and raised nothing on BACK (§6.7.1).
    expect(stored.cameras).toEqual([BACK, FRONT]);
    expect(stored.reasons.map((r) => [r.code, r.evidenceCamera])).toEqual([["after_hours_presence", FRONT]]);

    const owner = await loadIncidentDetail(prisma, aId, OWNER, "manage", NOW);
    expect(owner!.dropletLinks).toEqual([
      { linkId: backLink, zone: { id: stockRoom, name: `${TAG} Stock room`, kind: "interior" }, sourceKind: "camera", sourceRef: BACK, camera: BACK, label: "Back" },
    ]);
    // Below manage, the owner's own view has no list either (route 24 is manage).
    expect((await loadIncidentDetail(prisma, aId, OWNER, "act", NOW))!.dropletLinks).toBeNull();

    const both = await loadIncidentDetail(prisma, aId, MARIA, "act", NOW);
    expect(both!.dropletLinks).toBeNull();
    expect(aloneMaria!.dropletLinks).toBeNull();
    expect(normalized(both, [aId, a1])).toEqual(normalized(aloneMaria, [bId, b1]));
  });

  it("Keep (route 24's write): the line goes, and BACK's next person after hours is an alert", async () => {
    await engineAtHead();
    await person(FRONT, T0, "front-k");
    await tick(plus(T0, 30_000));
    await person(BACK, plus(T0, 240_000), "back-k1");
    await tick(plus(T0, 280_000));
    const id = await onlyIncident(plus(T0, 280_000));
    expect((await loadIncidentDetail(prisma, id, OWNER, "manage", plus(T0, 280_000)))!.dropletLinks!.map((l) => l.linkId)).toEqual([backLink]);

    const ctx: ZoneWriteContext = { req: { user: { id: OWNER.userId, role: "owner" } }, now: plus(T0, 300_000) };
    const kept = await decideDropletLink(prisma, ctx, backLink, "accept", { scope: { visibleCameras: "all" }, cameraLabels: new Map() });
    expect(kept.changed).toBe(true);
    expect(await prisma.securityZoneLink.findUniqueOrThrow({ where: { id: backLink } })).toMatchObject({ state: "active", origin: "droplet", stateSetBy: "person" });
    expect((await loadIncidentDetail(prisma, id, OWNER, "manage", plus(T0, 300_000)))!.dropletLinks).toEqual([]);

    // The next person on BACK after hours: a person-kept link now, so the rule fires on BACK.
    await person(BACK, plus(T0, 320_000), "back-k2");
    await tick(plus(T0, 360_000));
    const reasons = await prisma.securityIncidentReason.findMany({ where: { incident: { zoneId: stockRoom } }, select: { code: true, evidenceCamera: true } });
    expect(reasons).toEqual(expect.arrayContaining([{ code: "after_hours_presence", evidenceCamera: BACK }]));
  });
});
