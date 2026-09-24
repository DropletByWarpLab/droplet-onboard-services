/**
 * WARP-2978 review R1 (rjouffret) — route 16 for a viewer who cannot see
 * every camera, against REAL Postgres and the real engine:
 *
 *   his test      — a two-camera incident, and a family viewer who sees one
 *                   of the cameras: her summary AND detail equal those of an
 *                   incident built from the visible camera's events alone,
 *                   and her list's order and paging do not move when the
 *                   hidden camera fires;
 *   parity        — `projectedIncidentPage` (the SQL) orders and pages
 *                   exactly like the reference (Prisma's `incidentListWhere`
 *                   + `projectedLastActivity` in JS), for generated incidents
 *                   × viewers × every filter.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL. Every camera, area, event and
 * incident here is tagged `warp2978l`; the engine / mode / hours singletons
 * are saved before the file and restored after it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";

vi.unmock("@prisma/client");

import { tickSecurityIncidents, _resetIncidentHealthForTests, type SecurityIncidentDeps } from "./security-incidents.service.js";
import {
  listIncidents,
  loadIncidentDetail,
  type IncidentListFilters,
  type IncidentStateFilter,
  type IncidentViewer,
} from "./security-incident-view.js";
import { projectedIncidentPage, type CameraLimitedViewer } from "./security-incident-page.js";
import { referenceProjectedIncidentPage } from "../__tests__/security-incidents.fake.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2978l";
const FRONT = `${TAG}_front`;
const BACK = `${TAG}_back`;
const SIDE = `${TAG}_side`;
const CAMS = [FRONT, BACK, SIDE];
/** The parity cases' rows carry this rulesetVersion (a site-scoped one may name no camera to sweep it by). */
const SEEDED = 97;
/** 22:14 in London on a Wednesday: closed by the hours below. */
const T0 = new Date("2026-09-23T21:14:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

/** Maria: family, sees FRONT and SIDE — never BACK. */
const MARIA: IncidentViewer = { userId: randomUUID(), visibleCameras: new Set([FRONT, SIDE]), mayReadThreats: false, ownerOrAdmin: false };
const OWNER: IncidentViewer = { userId: randomUUID(), visibleCameras: "all", mayReadThreats: true, ownerOrAdmin: true };

describe.skipIf(!RUN)("route 16 for a viewer who cannot see every camera — real Postgres (WARP-2978 review R1)", () => {
  let prisma: PrismaClient;
  let savedEngine: unknown = null;
  let savedMode: unknown = null;
  let savedHours: unknown = null;
  let savedDays: unknown[] = [];
  let stockRoom = "";
  let office = "";
  let n = 0;

  const deps = (now: Date): SecurityIncidentDeps => ({ isSecurityModuleOn: async () => false, resolveAccess: async () => null, now: () => now });

  async function sweepIncidents(): Promise<void> {
    const incidents = await prisma.securityIncident.findMany({
      where: {
        OR: [{ zoneName: { startsWith: TAG } }, { scopeCamera: { startsWith: TAG } }, { cameras: { hasSome: CAMS } }, { rulesetVersion: SEEDED }],
      },
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

  const tick = (at: Date) => tickSecurityIncidents(prisma, deps(at));
  const ids = (page: { incidents: Array<{ id: string }> }) => page.incidents.map((i) => i.id);

  beforeAll(async () => {
    const { PrismaClient: Real } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new Real();
    await prisma.$connect();
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
    const a = await prisma.securityZone.create({ data: { name: `${TAG} Stock room`, nameKey: `${TAG} stock room`, kind: "interior" } });
    const b = await prisma.securityZone.create({ data: { name: `${TAG} Office`, nameKey: `${TAG} office`, kind: "interior" } });
    stockRoom = a.id;
    office = b.id;
    await prisma.securityZoneLink.createMany({
      data: [
        { zoneId: stockRoom, sourceKind: "camera", sourceRef: FRONT, sourceLabel: "Front", state: "active" },
        { zoneId: stockRoom, sourceKind: "camera", sourceRef: BACK, sourceLabel: "Back", state: "active" },
        { zoneId: office, sourceKind: "camera", sourceRef: SIDE, sourceLabel: "Side", state: "active" },
      ],
    });
  });

  afterAll(async () => {
    await sweep();
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
  });

  // ── his test ──────────────────────────────────────────────────────────────

  it("her summary and detail of a front+back incident equal those of the same incident built from front's events alone", async () => {
    // Front quiet for quiet + settle by NOW; back, later, is not — so the stored incident is still collecting.
    const NOW = plus(T0, 600_000);
    const view = async () => {
      const list = await listIncidents(prisma, MARIA, { state: "all" }, 30, NOW);
      expect(list.incidents).toHaveLength(1);
      const summary = list.incidents[0]!;
      const detail = await loadIncidentDetail(prisma, summary.id, MARIA, "act", NOW);
      return { summary, detail: detail! };
    };
    /** Ids differ between the two worlds (new rows); everything else must not. */
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
    const alone = await view();
    expect(alone.summary.grouping).toBe("closed"); // the engine sealed it
    await sweepIncidents();

    // World A: the same front event, and a person on hidden BACK four minutes later (it joins).
    await engineAtHead();
    const a1 = await person(FRONT, T0, "front-1");
    await tick(plus(T0, 30_000));
    await person(BACK, plus(T0, 240_000), "back-1");
    await tick(plus(T0, 280_000));
    await tick(NOW);
    const stored = await prisma.securityIncident.findUniqueOrThrow({ where: { id: (await view()).summary.id } });
    expect(stored).toMatchObject({ cameras: [BACK, FRONT], grouping: "collecting", eventCount: 2 });
    const both = await view();

    expect(normalized(both, [both.summary.id, a1])).toEqual(normalized(alone, [alone.summary.id, b1]));
  });

  it("her order and paging do not move when the hidden camera fires; the owner's follow the stored activity", async () => {
    await engineAtHead();
    await person(FRONT, T0); // X: Stock room (front, later back)
    await person(SIDE, plus(T0, 60_000)); // Y: Office (side)
    await tick(plus(T0, 100_000));
    const now1 = plus(T0, 100_000);
    const all1 = await listIncidents(prisma, MARIA, { state: "all" }, 30, now1);
    expect(all1.incidents).toHaveLength(2);
    const [y, x] = ids(all1);
    expect(all1.incidents.map((i) => i.zone?.id)).toEqual([office, stockRoom]);
    const page1 = await listIncidents(prisma, MARIA, { state: "all" }, 1, now1);
    expect(ids(page1)).toEqual([y]);
    expect(page1.nextCursor).not.toBeNull();

    // BACK fires: it joins X and moves X's STORED last activity past Y's.
    await person(BACK, plus(T0, 120_000));
    await tick(plus(T0, 160_000));
    const now2 = plus(T0, 160_000);
    const xRow = await prisma.securityIncident.findUniqueOrThrow({ where: { id: x! } });
    expect(xRow.lastActivityAt).toEqual(plus(T0, 140_000));

    // Her first page is unchanged, and the cursor she already holds still leads to X.
    const again = await listIncidents(prisma, MARIA, { state: "all" }, 1, now2);
    expect(ids(again)).toEqual([y]);
    expect(again.nextCursor).toBe(page1.nextCursor);
    const page2 = await listIncidents(prisma, MARIA, { state: "all", cursor: cursorOf(page1.nextCursor!) }, 1, now2);
    expect(ids(page2)).toEqual([x]);
    expect(page2.incidents[0]!.lastActivityAt).toBe(plus(T0, 20_000).toISOString());
    expect(page2.nextCursor).toBeNull();

    // The owner sees every camera: X moved up for them.
    const owner = await listIncidents(prisma, OWNER, { state: "all", zoneId: undefined }, 30, now2);
    const mine = ids(owner).filter((id) => id === x || id === y);
    expect(mine).toEqual([x, y]);
  });

  // ── parity: the SQL against the reference ─────────────────────────────────

  describe("projectedIncidentPage (SQL) orders and filters exactly like the reference", () => {
    const CAMS3 = [FRONT, BACK, SIDE];
    const SCOPES = ["area", "camera", "site_camera_system", "site_threat"] as const;

    /** Deterministic PRNG (mulberry32). */
    function rng(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /** Legal incidents (every CHECK holds) with random scopes, cameras, spans, states and reasons. */
    async function seed(count: number, seedNo: number): Promise<string[]> {
      const r = rng(seedNo);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const out: string[] = [];
      for (let k = 0; k < count; k++) {
        const scope = pick(SCOPES);
        const site = scope === "site_camera_system" || scope === "site_threat";
        const cams = scope === "camera" ? [pick(CAMS3)] : CAMS3.filter(() => r() < 0.6);
        if (!site && cams.length === 0) cams.push(pick(CAMS3));
        const keys = [...cams, ...(site && r() < 0.5 ? [""] : [])];
        if (keys.length === 0) keys.push("");
        const spans: Record<string, { first: string; last: string }> = {};
        let first = Infinity;
        let last = -Infinity;
        for (const key of keys) {
          const s = T0.getTime() + Math.floor(r() * 6) * 60_000; // coarse: ties happen, so the id breaks them
          const e = s + Math.floor(r() * 4) * 60_000;
          spans[key] = { first: new Date(s).toISOString(), last: new Date(e).toISOString() };
          first = Math.min(first, s);
          last = Math.max(last, e);
        }
        const codes: Array<{ code: "after_hours_presence" | "camera_offline" | "threat_signal"; severity: "alert" | "notice"; camera: string | null }> = [];
        if (scope === "site_threat") {
          if (r() < 0.6) codes.push({ code: "threat_signal", severity: "notice", camera: null });
        } else {
          for (const cam of cams) {
            if (r() < 0.5) codes.push({ code: "after_hours_presence", severity: "alert", camera: cam });
            if (r() < 0.3) codes.push({ code: "camera_offline", severity: "notice", camera: cam });
          }
        }
        const severity = codes.some((c) => c.severity === "alert") ? "alert" : codes.length ? "notice" : "info";
        const state = severity === "info" ? "no_action" : pick(["open", "acknowledged", "resolved"] as const);
        const resolved = state === "resolved";
        const ORDER = ["after_hours_presence", "camera_offline", "threat_signal"];
        const reasonCodes = [...new Set(codes.map((c) => c.code))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
        const closed = resolved || r() < 0.5;
        const id = randomUUID();
        await prisma.securityIncident.create({
          data: {
            id,
            scope,
            zoneId: scope === "area" ? (r() < 0.5 ? stockRoom : office) : null,
            zoneName: scope === "area" ? `${TAG} Area` : null,
            zoneKind: scope === "area" ? "interior" : null,
            zoneLinkIds: scope === "area" ? ["l0"] : [],
            scopeCamera: scope === "camera" ? cams[0]! : null,
            openedInMode: "closed",
            grouping: closed ? "closed" : "collecting",
            closedAt: closed ? new Date(last + 600_000) : null,
            state,
            severity,
            reasonCodes,
            notifyState: severity === "alert" ? "module_off" : "not_needed",
            alertedAt: severity === "alert" ? new Date(last) : null,
            rulesetVersion: SEEDED,
            firstActivityAt: new Date(first),
            lastActivityAt: new Date(last),
            lastArrivalAt: new Date(last + 1000),
            eventCount: keys.length,
            countsByCamera: Object.fromEntries(keys.map((key) => [key, { person: 1 }])),
            cameras: cams,
            spanByCamera: spans,
            ...(resolved ? { resolvedAt: T0, resolvedById: OWNER.userId, stateChangedById: OWNER.userId } : {}),
          } as Prisma.SecurityIncidentUncheckedCreateInput,
        });
        for (const [j, c] of codes.entries()) {
          await prisma.securityIncidentReason.create({
            data: {
              incidentId: id,
              code: c.code,
              severity: c.severity,
              rulesetVersion: 1,
              evidenceEventId: BigInt(1_000_000 + k * 10 + j),
              evidenceCamera: c.camera,
              evidenceSource: c.code === "threat_signal" ? "activity_mirror" : "frigate",
              evidenceKind: c.code === "camera_offline" ? "camera_offline" : c.code === "threat_signal" ? "threat" : "detection",
              evidenceLabel: c.code === "after_hours_presence" ? "person" : null,
              evidenceAt: T0,
              evidenceSummary: "x",
              detail: {},
            },
          });
        }
        out.push(id);
      }
      return out;
    }

    const VIEWERS: IncidentViewer[] = [
      { ...MARIA, visibleCameras: new Set([FRONT]) },
      { ...MARIA, visibleCameras: new Set([FRONT, SIDE]) },
      { ...MARIA, visibleCameras: new Set([BACK]), mayReadThreats: true },
      { ...MARIA, visibleCameras: new Set<string>() },
      { ...MARIA, visibleCameras: new Set([FRONT, BACK, SIDE]) },
    ];
    const STATES: IncidentStateFilter[] = ["all", "attention", "open", "acknowledged", "resolved", "activity"];

    it("every viewer × state × severity × area: the same ids, in the same order, with the same keys", async () => {
      const mine = new Set(await seed(60, 2978));
      let compared = 0;
      for (const v of VIEWERS) {
        for (const state of STATES) {
          for (const severity of [undefined, "alert", "notice"] as const) {
            for (const zoneId of [undefined, stockRoom]) {
              const f: IncidentListFilters = { state, severity, zoneId };
              const sql = (await projectedIncidentPage(prisma, v as CameraLimitedViewer, f, 1000)).filter((k) => mine.has(k.id));
              const ref = (await referenceProjectedIncidentPage(prisma as never, v, f, 1000)).filter((k) => mine.has(k.id));
              expect(sql.map((k) => [k.id, k.projectedLast.toISOString()]), JSON.stringify({ v: [...(v.visibleCameras as ReadonlySet<string>)], f })).toEqual(
                ref.map((k) => [k.id, k.projectedLast.toISOString()]),
              );
              compared += ref.length;
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(300); // not vacuous
    });

    it("paging by the cursor (limit 3) visits exactly the reference order, for every viewer", async () => {
      const mine = new Set(await seed(40, 1570));
      for (const v of VIEWERS) {
        const ref = (await referenceProjectedIncidentPage(prisma as never, v, { state: "all" }, 1000)).map((k) => k.id);
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 100; guard++) {
          const page: Awaited<ReturnType<typeof listIncidents>> = await listIncidents(
            prisma,
            v,
            { state: "all", ...(cursor ? { cursor: cursorOf(cursor) } : {}) },
            3,
            plus(T0, 3_600_000),
          );
          seen.push(...ids(page));
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        expect(seen.filter((id) => mine.has(id)), JSON.stringify([...(v.visibleCameras as ReadonlySet<string>)])).toEqual(ref.filter((id) => mine.has(id)));
        expect(new Set(seen).size).toBe(seen.length); // no incident twice
      }
    });
  });
});

function cursorOf(raw: string): { at: Date; id: string } {
  const dot = raw.indexOf(".");
  return { at: new Date(Number(raw.slice(0, dot))), id: raw.slice(dot + 1) };
}
