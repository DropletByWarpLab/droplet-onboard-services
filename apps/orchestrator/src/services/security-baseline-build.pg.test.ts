/**
 * WARP-2980 (ADR-059 P5 §6.5, §12 pg lane) — the build against REAL Postgres.
 *
 *   the twin     — the one INSERT … SELECT and `referenceCells` (TypeScript,
 *                  area membership by P2b's own `zonesForEvent`) over
 *                  generated detections, links (whole camera and parts,
 *                  overlapping areas, an archived area, a removed link) and
 *                  coverage (gaps, partial slots, the 120-minute fall-back
 *                  hour, an unobserved camera) must give IDENTICAL rows — for
 *                  a full build and for an area rebuild. This pins the SQL
 *                  matcher to P2b's (R6);
 *   only detections — detection_low, a camera's offline row, a threat, a mode
 *                  change, a non-Frigate "detection" and (WARP-2978 PR-D) a
 *                  person's "still in view" row in the fixture change
 *                  nothing — the person is counted once, by their `end` row;
 *   CHECKs       — each refuses its bad row;
 *   indexes      — a second ready build, a second building one;
 *   the swap     — a reader in a REPEATABLE READ snapshot sees only the old
 *                  build's cells, never a mix;
 *   the timeout  — a build past its statement timeout fails, the previous one
 *                  stays ready;
 *   single flight — a live claim → skip; a stale claim → failed 'interrupted'.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, like every *.pg.test.ts.
 * Review #2352 hardening: spans are ms-precision (never whole minutes), a
 * second process's OVERLAPPING spans are in the fixture (incl. the 120-minute
 * fall-back slot covered twice — a sum would count it as 240 minutes and break
 * the observedMinutes CHECK), a second window straddles the 2033 spring-forward
 * (a date with no 02:00), and one case runs under `SET LOCAL TIME ZONE
 * 'Pacific/Kiritimati'` to prove the slot bounds are bound as UTC text.
 *
 * FIXTURE SCOPING — cameras `warp2980b_*`, areas named `warp2980b …`, events
 * `warp2980b:*`, and dates in November 2031 and February–March 2033 (the
 * coverage pg file uses 2032, so this file's prune of old spans can never
 * touch its fixtures). Builds have no tag; only this file writes them, and it
 * clears the ones it made (windows 2031-… and 2033-…).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

import { buildCells, rebuildAreas, runFullBuild } from "./security-baseline-build.js";
import { loadActiveLinks } from "./security-zones.service.js";
import { windowBounds, windowFor, windowSlots } from "../lib/security-baseline-slots.js";
import { referenceCells, type RefCell, type RefEvent } from "../__tests__/helpers/baseline-reference.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const TAG = "warp2980b";
const TZ = "America/New_York";
/** Today 2031-11-10 in New York; the window 2031-10-13 … 2031-11-09 holds the 2031-11-02 fall-back. */
const NOW = new Date("2031-11-10T17:00:00Z");
const WINDOW = windowFor(NOW, TZ);
const BOUNDS = windowBounds(WINDOW, TZ);
const SLOTS = windowSlots(WINDOW.from, WINDOW.to, TZ);
/** Today 2033-03-20 in New York; the window 2033-02-20 … 2033-03-19 holds the 2033-03-13 spring-forward. */
const NOW_SPRING = new Date("2033-03-20T17:00:00Z");
const WINDOW_SPRING = windowFor(NOW_SPRING, TZ);
const BOUNDS_SPRING = windowBounds(WINDOW_SPRING, TZ);
const SLOTS_SPRING = windowSlots(WINDOW_SPRING.from, WINDOW_SPRING.to, TZ);
const DAY = 86_400_000;
const CAMS = [`${TAG}_c1`, `${TAG}_c2`, `${TAG}_c3`, `${TAG}_c4`];
/** Has events and links, never coverage: it must never make a slot observed. */
const BLIND = `${TAG}_c5`;
const PARTS = ["porch", "drive", "yard", "till"];
const LABELS = ["person", "person", "person", "person", "car", "car", "dog", "cat", "bicycle", "truck", "bird", "horse", "sheep", "cow", "boat"];
const MIN = 60_000;

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
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const cellOrder = (a: RefCell, b: RefCell) =>
  a.zoneKey.localeCompare(b.zoneKey) || a.label.localeCompare(b.label) || a.dayType.localeCompare(b.dayType) || a.hour - b.hour;

describe.skipIf(!RUN)("The baseline build against real Postgres (WARP-2980)", () => {
  let prisma: PrismaClient;
  let events: RefEvent[] = [];
  const zoneIds: string[] = [];

  async function sweepBuilds(): Promise<void> {
    await prisma.securityBaselineBuild.deleteMany({
      where: { OR: [{ windowFrom: { startsWith: "2031-" } }, { windowFrom: { startsWith: "2033-" } }] },
    });
  }
  async function sweep(): Promise<void> {
    await sweepBuilds();
    const zones = await prisma.securityZone.findMany({ where: { name: { startsWith: `${TAG} ` } }, select: { id: true } });
    await prisma.securityZoneLink.deleteMany({ where: { zoneId: { in: zones.map((z) => z.id) } } });
    await prisma.securityZone.deleteMany({ where: { id: { in: zones.map((z) => z.id) } } });
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: `${TAG}:` } } });
    await prisma.securityEvent.deleteMany({ where: { dedupeKey: { startsWith: `frigate-ongoing:${TAG}-` } } });
    await prisma.securityCoverageSpan.deleteMany({ where: { camera: { startsWith: `${TAG}_` } } });
  }

  async function area(n: number, links: Array<[string, string]>, opts: { state?: "active" | "archived"; version?: number; removed?: string[] } = {}) {
    const name = `${TAG} Area ${n}`;
    const zone = await prisma.securityZone.create({
      data: { name, nameKey: name.toLowerCase(), kind: "interior", state: opts.state ?? "active", version: opts.version ?? n },
    });
    zoneIds.push(zone.id);
    for (const [kind, ref] of links) {
      await prisma.securityZoneLink.create({
        data: {
          zoneId: zone.id,
          sourceKind: kind as "camera" | "camera_zone",
          sourceRef: ref,
          sourceLabel: ref,
          state: opts.removed?.includes(ref) ? "removed" : "active",
        },
      });
    }
    return zone.id;
  }

  /** The active links of active areas, with each area's version — the reference's input. */
  async function liveLinks() {
    const links = await loadActiveLinks(prisma);
    const versions = new Map(
      (await prisma.securityZone.findMany({ where: { id: { in: [...new Set(links.map((l) => l.zoneId))] } }, select: { id: true, version: true } })).map(
        (z) => [z.id, z.version],
      ),
    );
    return links.map((l) => ({ zoneId: l.zoneId, sourceKind: l.sourceKind, sourceRef: l.sourceRef, zoneVersion: versions.get(l.zoneId)! }));
  }

  async function spans() {
    return prisma.securityCoverageSpan.findMany({ select: { camera: true, startedAt: true, coveredUntil: true } });
  }

  async function cellsOf(buildId: string): Promise<RefCell[]> {
    const rows = await prisma.securityBaselineCell.findMany({ where: { buildId } });
    return rows
      .map((r) => ({
        zoneKey: r.zoneKey,
        keyKind: r.keyKind,
        zoneId: r.zoneId,
        camera: r.camera,
        zoneVersion: r.zoneVersion,
        cameras: r.cameras,
        label: r.label,
        dayType: r.dayType,
        hour: r.hour,
        daysObserved: r.daysObserved,
        daysWithEvent: r.daysWithEvent,
        eventCount: r.eventCount,
        observedMinutes: r.observedMinutes,
        dwellSamples: r.dwellSamples,
        durationP99Sec: r.durationP99Sec,
      }))
      .sort(cellOrder);
  }

  async function claim(state: "building" | "ready" = "building", startedAt = NOW, window = WINDOW) {
    return prisma.securityBaselineBuild.create({
      data: {
        state,
        trigger: "first",
        timezone: TZ,
        windowFrom: window.from,
        windowTo: window.to,
        rulesetVersion: 1,
        startedAt,
        finishedAt: state === "building" ? null : NOW,
      },
    });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
    await sweep();

    // Areas: overlapping, whole cameras and parts, one camera twice in one area
    // (a whole link AND a part: DISTINCT must count its events once), an area
    // needing a blind camera, an archived area, a removed link.
    await area(1, [["camera", CAMS[0]!], ["camera_zone", `${CAMS[0]}/porch`]]);
    await area(2, [["camera", CAMS[0]!], ["camera", CAMS[1]!]]);
    await area(3, [["camera_zone", `${CAMS[1]}/drive`], ["camera_zone", `${CAMS[2]}/yard`], ["camera_zone", `${CAMS[2]}/till`]]);
    await area(4, [["camera_zone", `${CAMS[3]}/porch`], ["camera", BLIND]]);
    await area(5, [["camera", CAMS[2]!], ["camera_zone", `${CAMS[3]}/till`]], { removed: [`${CAMS[3]}/till`] });
    await area(6, [["camera", CAMS[1]!]], { state: "archived" });
    await area(7, [["camera_zone", `${CAMS[3]}/drive`]]);

    const r = rng(2980);
    const closedSpan = (camera: string, start: number, end: number): Prisma.SecurityCoverageSpanCreateManyInput => ({
      camera,
      state: "closed",
      startedAt: new Date(start),
      coveredUntil: new Date(end),
      processId: randomUUID(),
      closedAt: new Date(end),
    });
    // Coverage: ms-precision spans per camera, with gaps, from before each window to after it.
    const spanRows: Prisma.SecurityCoverageSpanCreateManyInput[] = [];
    for (const bounds of [BOUNDS, BOUNDS_SPRING]) {
      for (const camera of CAMS) {
        let t = bounds.start.getTime() - 2 * DAY + Math.floor(r() * MIN);
        while (t < bounds.end.getTime() + DAY) {
          const len = (60 + Math.floor(r() * 3 * 1440)) * MIN + Math.floor(r() * MIN);
          spanRows.push(closedSpan(camera, t, t + len));
          t = t + len + Math.floor(r() * 180 * MIN);
        }
      }
    }
    // What a second process could leave behind: spans that OVERLAP this camera's
    // own — exact duplicates and shifted copies. Overlap must never count twice.
    const own = spanRows.filter((s) => s.camera === CAMS[0]);
    for (let i = 0; i < 12; i += 1) {
      const s = own[Math.floor(r() * own.length)]!;
      const shift = i % 3 === 0 ? 0 : Math.floor(r() * 90 * MIN);
      spanRows.push(closedSpan(CAMS[0]!, (s.startedAt as Date).getTime() + shift, (s.coveredUntil as Date).getTime() + shift));
    }
    // The 120-minute fall-back slot (2031-11-02 01:00–03:00 EDT/EST = 05:00–07:00Z), covered twice over.
    spanRows.push(closedSpan(CAMS[1]!, Date.parse("2031-11-02T04:30:00.250Z"), Date.parse("2031-11-02T07:30:00.750Z")));
    spanRows.push(closedSpan(CAMS[1]!, Date.parse("2031-11-02T04:45:00.000Z"), Date.parse("2031-11-02T07:15:00.000Z")));
    await prisma.securityCoverageSpan.createMany({ data: spanRows });

    // 300 detections per window, some outside it; plus rows that must never count.
    const evRows: Prisma.SecurityEventCreateManyInput[] = [];
    for (const [w, bounds] of [["f", BOUNDS], ["s", BOUNDS_SPRING]] as const) {
      const span = bounds.end.getTime() - bounds.start.getTime() + 2 * DAY;
      for (let i = 0; i < 300; i += 1) {
        const startedAt = new Date(bounds.start.getTime() - DAY + Math.floor(r() * span));
        const camera = pick(r, [...CAMS, ...CAMS, BLIND]);
        const zones = PARTS.filter(() => r() < 0.4);
        evRows.push({
          source: "frigate",
          kind: "detection",
          severity: "info",
          camera,
          sourceRef: `${camera}/${TAG}-${w}${i}`,
          dedupeKey: `${TAG}:${w}${i}`,
          labels: [i % 97 === 0 ? "traffic light" : pick(r, LABELS)],
          cameraZones: zones,
          score: 0.9,
          startedAt,
          endedAt: new Date(startedAt.getTime() + 2_000 + Math.floor(r() * 400_000)),
          summary: "detection",
        });
      }
    }
    // Noise in observed slots — none of it may count.
    for (let i = 0; i < 40; i += 1) {
      const startedAt = new Date(BOUNDS.start.getTime() + Math.floor(r() * (BOUNDS.end.getTime() - BOUNDS.start.getTime())));
      const camera = pick(r, CAMS);
      const k = i % 4;
      evRows.push({
        source: k === 3 ? "frigate_status" : k === 2 ? "activity_mirror" : "frigate",
        kind: k === 0 ? "detection_low" : k === 1 ? "camera_offline" : k === 2 ? "threat" : "detection",
        severity: "info",
        camera: k === 2 ? null : camera,
        sourceRef: `${camera}/noise-${i}`,
        dedupeKey: `${TAG}:noise-${i}`,
        labels: ["person"],
        cameraZones: ["porch"],
        score: 0.5,
        startedAt,
        endedAt: new Date(startedAt.getTime() + 30_000),
        summary: "noise",
      });
    }
    // WARP-2978 PR-D — people still in view 30 s in: confident, zoned, in observed
    // slots. Baselines count detections only (their `end` rows), so none may count.
    for (let i = 0; i < 12; i += 1) {
      const startedAt = new Date(BOUNDS.start.getTime() + Math.floor(r() * (BOUNDS.end.getTime() - BOUNDS.start.getTime())));
      const camera = pick(r, CAMS);
      evRows.push({
        source: "frigate",
        kind: "detection_ongoing",
        severity: "info",
        camera,
        sourceRef: `${camera}/ongoing-${i}`,
        dedupeKey: `frigate-ongoing:${TAG}-ongoing-${i}`,
        labels: ["person"],
        cameraZones: ["porch"],
        score: 0.95,
        startedAt,
        endedAt: null,
        summary: "Person still in view after 30 s",
      });
    }
    evRows.push({
      source: "site_mode",
      kind: "mode_changed",
      severity: "info",
      camera: null,
      sourceRef: "site_mode",
      dedupeKey: `${TAG}:mode`,
      labels: ["closed", "schedule", "open"],
      cameraZones: [],
      score: null,
      startedAt: new Date(BOUNDS.start.getTime() + 86_400_000),
      endedAt: null,
      summary: "Closed",
    });
    await prisma.securityEvent.createMany({ data: evRows });
    events = (
      await prisma.securityEvent.findMany({
        where: { OR: [{ dedupeKey: { startsWith: `${TAG}:` } }, { dedupeKey: { startsWith: `frigate-ongoing:${TAG}-` } }] },
      })
    ).map((e) => ({
      id: e.id,
      source: e.source,
      kind: e.kind,
      camera: e.camera,
      labels: e.labels,
      cameraZones: e.cameraZones,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
    }));
  }, 120_000);

  afterAll(async () => {
    await sweep();
    await prisma.$disconnect();
  });

  it("a full build's rows equal the TypeScript reference, row for row", async () => {
    await sweepBuilds();
    const b = await claim();
    const inserted = await prisma.$transaction((tx) =>
      buildCells(tx, { buildId: b.id, slots: SLOTS, windowStart: BOUNDS.start, windowEnd: BOUNDS.end, onlyZoneIds: null, includeCameraKeys: true }),
    );
    const got = await cellsOf(b.id);
    const want = referenceCells({
      slots: SLOTS,
      windowStart: BOUNDS.start,
      windowEnd: BOUNDS.end,
      events,
      links: await liveLinks(),
      spans: await spans(),
      onlyZoneIds: null,
      includeCameraKeys: true,
    }).sort(cellOrder);
    expect(inserted).toBe(got.length);
    expect(got).toEqual(want);

    // The fixture exercises what it claims to.
    const keys = new Set(got.map((c) => c.zoneKey));
    expect([...keys].filter((k) => k.startsWith("area:")).length).toBeGreaterThanOrEqual(3);
    expect([...keys].filter((k) => k.startsWith("camera:")).sort()).toEqual(CAMS.map((c) => `camera:${c}`).sort());
    expect(keys.has(`camera:${BLIND}`)).toBe(false);
    expect(got.every((c) => new Set(got.filter((x) => x.zoneKey === c.zoneKey).map((x) => x.label)).size <= 8)).toBe(true);
    expect(got.some((c) => c.label === "traffic light")).toBe(false);
    expect(got.some((c) => c.observedMinutes > c.daysObserved * 60)).toBe(true); // the 120-minute fall-back hour
    expect(got.some((c) => c.eventCount > 0)).toBe(true);
    expect(got.some((c) => c.dwellSamples >= 2)).toBe(true);
    // The twice-covered fall-back slot counts its 120 minutes once (a sum would say 240).
    expect(got.every((c) => c.observedMinutes <= c.daysObserved * 120)).toBe(true);
    // Every key keeps the four tracked labels: the readers take one row per key
    // from (person, weekday, hour 0) instead of an in-memory `distinct` (review #2352).
    for (const k of keys) {
      const labels = new Set(got.filter((c) => c.zoneKey === k).map((c) => c.label));
      for (const tracked of ["person", "car", "dog", "cat"]) expect(labels.has(tracked), `${k} ${tracked}`).toBe(true);
    }
    // Every kept (key, label) has all 48 (dayType, hour) rows.
    for (const k of keys) {
      for (const label of new Set(got.filter((c) => c.zoneKey === k).map((c) => c.label))) {
        expect(got.filter((c) => c.zoneKey === k && c.label === label)).toHaveLength(48);
      }
    }
  }, 120_000);

  it("the slot bounds are bound as UTC text: identical rows under SET LOCAL TIME ZONE 'Pacific/Kiritimati' (review #2352)", async () => {
    await sweepBuilds();
    const b = await claim();
    // The named zone when the server has tzdata (CI's pg16 image does); else the
    // same +14:00 as a SQL-standard offset (a Postgres build without tzdata).
    const named = await prisma
      .$queryRawUnsafe<Array<{ n: bigint }>>("SELECT count(*) AS n FROM pg_timezone_names WHERE name = 'Pacific/Kiritimati'")
      .then((rows) => Number(rows[0]!.n) === 1, () => false);
    const setZone = named ? "SET LOCAL TIME ZONE 'Pacific/Kiritimati'" : "SET LOCAL TIME ZONE INTERVAL '+14:00' HOUR TO MINUTE";
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(setZone);
      const shown = await tx.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone');
      expect(shown[0]!.TimeZone).toMatch(/Kiritimati|\+14|-14/);
      return buildCells(tx, { buildId: b.id, slots: SLOTS, windowStart: BOUNDS.start, windowEnd: BOUNDS.end, onlyZoneIds: null, includeCameraKeys: true });
    });
    const want = referenceCells({
      slots: SLOTS,
      windowStart: BOUNDS.start,
      windowEnd: BOUNDS.end,
      events,
      links: await liveLinks(),
      spans: await spans(),
      onlyZoneIds: null,
      includeCameraKeys: true,
    }).sort(cellOrder);
    expect(await cellsOf(b.id)).toEqual(want);
  }, 120_000);

  it("a window with a spring-forward date (no 02:00 on 2033-03-13) equals the reference too", async () => {
    await sweepBuilds();
    expect(SLOTS_SPRING.some((s) => s.ymd === "2033-03-13" && s.hour === 2)).toBe(false);
    const b = await claim("building", NOW_SPRING, WINDOW_SPRING);
    await prisma.$transaction((tx) =>
      buildCells(tx, {
        buildId: b.id,
        slots: SLOTS_SPRING,
        windowStart: BOUNDS_SPRING.start,
        windowEnd: BOUNDS_SPRING.end,
        onlyZoneIds: null,
        includeCameraKeys: true,
      }),
    );
    const got = await cellsOf(b.id);
    const want = referenceCells({
      slots: SLOTS_SPRING,
      windowStart: BOUNDS_SPRING.start,
      windowEnd: BOUNDS_SPRING.end,
      events,
      links: await liveLinks(),
      spans: await spans(),
      onlyZoneIds: null,
      includeCameraKeys: true,
    }).sort(cellOrder);
    expect(got.length).toBeGreaterThan(0);
    expect(got).toEqual(want);
  }, 120_000);

  it("an area rebuild's rows equal the reference for just those areas, with no camera keys", async () => {
    await sweepBuilds();
    const b = await claim();
    const only = [zoneIds[0]!, zoneIds[2]!];
    await prisma.$transaction((tx) =>
      buildCells(tx, { buildId: b.id, slots: SLOTS, windowStart: BOUNDS.start, windowEnd: BOUNDS.end, onlyZoneIds: only, includeCameraKeys: false }),
    );
    const got = await cellsOf(b.id);
    const want = referenceCells({
      slots: SLOTS,
      windowStart: BOUNDS.start,
      windowEnd: BOUNDS.end,
      events,
      links: await liveLinks(),
      spans: await spans(),
      onlyZoneIds: only,
      includeCameraKeys: false,
    }).sort(cellOrder);
    expect(got).toEqual(want);
    expect(new Set(got.map((c) => c.zoneKey))).toEqual(new Set(only.map((id) => `area:${id}`)));
  }, 120_000);

  it("rows that are not frigate detections change nothing", async () => {
    await sweepBuilds();
    const b = await claim();
    await prisma.$transaction((tx) =>
      buildCells(tx, { buildId: b.id, slots: SLOTS, windowStart: BOUNDS.start, windowEnd: BOUNDS.end, onlyZoneIds: null, includeCameraKeys: true }),
    );
    const withNoise = await cellsOf(b.id);
    const clean = referenceCells({
      slots: SLOTS,
      windowStart: BOUNDS.start,
      windowEnd: BOUNDS.end,
      events: events.filter((e) => e.source === "frigate" && e.kind === "detection"),
      links: await liveLinks(),
      spans: await spans(),
      onlyZoneIds: null,
      includeCameraKeys: true,
    }).sort(cellOrder);
    expect(withNoise).toEqual(clean);
    expect(events.filter((e) => !(e.source === "frigate" && e.kind === "detection")).length).toBeGreaterThanOrEqual(40);
    expect(events.filter((e) => e.kind === "detection_ongoing")).toHaveLength(12);
  }, 120_000);

  describe("CHECKs and partial unique indexes", () => {
    async function cellRow(buildId: string, over: Record<string, unknown>) {
      return prisma.securityBaselineCell.create({
        data: {
          buildId,
          zoneKey: `camera:${CAMS[0]}`,
          keyKind: "camera",
          zoneId: null,
          camera: CAMS[0]!,
          zoneVersion: null,
          cameras: [CAMS[0]!],
          label: "person",
          dayType: "weekday",
          hour: 3,
          daysObserved: 20,
          daysWithEvent: 1,
          eventCount: 1,
          observedMinutes: 1200,
          dwellSamples: 0,
          durationP99Sec: null,
          ...over,
        } as never,
      });
    }

    it("a valid camera cell and a valid area cell are accepted (the fixtures below are one change from valid)", async () => {
      await sweepBuilds();
      const b = await claim();
      await cellRow(b.id, {});
      await cellRow(b.id, { zoneKey: `area:${zoneIds[0]}`, keyKind: "area", zoneId: zoneIds[0], camera: null, zoneVersion: 1, cameras: [CAMS[0]] });
    });

    it.each([
      ["an area cell without zoneVersion", { zoneKey: "area:11111111-1111-4111-8111-111111111111", keyKind: "area", zoneId: "11111111-1111-4111-8111-111111111111", camera: null, zoneVersion: null }],
      ["an area cell with no cameras", { zoneKey: "area:11111111-1111-4111-8111-111111111111", keyKind: "area", zoneId: "11111111-1111-4111-8111-111111111111", camera: null, zoneVersion: 1, cameras: [] }],
      ["a camera cell whose cameras is not [camera]", { cameras: [CAMS[1]] }],
      ["d > n", { daysObserved: 2, daysWithEvent: 3, eventCount: 3, observedMinutes: 120 }],
      ["events without a day", { daysWithEvent: 0, eventCount: 2 }],
      ["a p99 with 0 samples", { dwellSamples: 0, durationP99Sec: 12 }],
      ["samples with no p99", { dwellSamples: 3, durationP99Sec: null }],
      ["an observed day with no minutes", { observedMinutes: 0 }],
      ["more than 120 minutes an observed day", { daysObserved: 1, daysWithEvent: 1, observedMinutes: 121 }],
      ["hour 24", { hour: 24 }],
      ["a label Frigate never sends", { label: "traffic light" }],
    ] as const)("the cell CHECKs refuse %s", async (_l, over) => {
      await sweepBuilds();
      const b = await claim();
      await expect(cellRow(b.id, over)).rejects.toThrow(/check constraint|SecurityBaselineCell_/i);
    });

    it.each([
      ["an active source with 12 days", { state: "active", daysObserved: 12 }],
      ["a learning source with 14 days", { state: "learning", daysObserved: 14 }],
      ["a source key that is not camera:<camera>", { sourceKey: `camera:${TAG}_other` }],
      ["lastSeenAt before firstSeenAt", { lastSeenAt: new Date(NOW.getTime() - 2 * 86_400_000) }],
    ] as const)("the source CHECK refuses %s", async (_l, over) => {
      await expect(
        prisma.securityBaselineSource.create({
          data: {
            sourceKey: `camera:${TAG}_src`,
            camera: `${TAG}_src`,
            state: "learning",
            daysObserved: 3,
            firstSeenAt: new Date(NOW.getTime() - 86_400_000),
            lastSeenAt: NOW,
            stateChangedAt: NOW,
            ...over,
          } as never,
        }),
      ).rejects.toThrow(/check constraint|SecurityBaselineSource_shape/i);
    });

    it.each([
      ["a ready build without finishedAt", { state: "ready", finishedAt: null }],
      ["a building build with a finishedAt", { state: "building", finishedAt: NOW }],
      ["a failed build without an error", { state: "failed", finishedAt: NOW, error: null }],
      ["a window that ends before it starts", { state: "superseded", finishedAt: NOW, windowFrom: "2031-11-09", windowTo: "2031-10-13" }],
    ] as const)("the build CHECK refuses %s", async (_l, over) => {
      await sweepBuilds();
      await expect(
        prisma.securityBaselineBuild.create({
          data: { trigger: "first", timezone: TZ, windowFrom: WINDOW.from, windowTo: WINDOW.to, rulesetVersion: 1, ...over } as never,
        }),
      ).rejects.toThrow(/check constraint|SecurityBaselineBuild_shape/i);
    });

    it("a second READY build is refused, and a second BUILDING one", async () => {
      await sweepBuilds();
      await claim("ready");
      await expect(claim("ready")).rejects.toMatchObject({ code: "P2002" });
      await claim("building");
      await expect(claim("building")).rejects.toMatchObject({ code: "P2002" });
    });

    it("the job-state row is a singleton", async () => {
      await expect(prisma.securityBaselineJobState.create({ data: { id: `${TAG}-not-singleton`, hourlyThrough: NOW } })).rejects.toThrow(
        /check constraint|SecurityBaselineJobState_singleton/i,
      );
    });
  });

  describe("runFullBuild end to end", () => {
    it("builds, and a reader in a REPEATABLE READ snapshot sees only the old build's cells while the swap commits", async () => {
      await sweepBuilds();
      const first = await runFullBuild(prisma, "first", TZ, NOW);
      expect(first.status).toBe("built");
      const firstId = (first as { buildId: string }).buildId;
      const firstCount = await prisma.securityBaselineCell.count({ where: { buildId: firstId } });
      expect(firstCount).toBeGreaterThan(0);

      const seen = await prisma.$transaction(
        async (tx) => {
          const before = await tx.securityBaselineBuild.findFirstOrThrow({ where: { state: "ready" } });
          const beforeCells = await tx.securityBaselineCell.count({ where: { buildId: before.id } });
          // The swap commits on another connection while this snapshot is open.
          const second = await runFullBuild(prisma, "nightly", TZ, new Date(NOW.getTime() + 60_000));
          const after = await tx.securityBaselineBuild.findFirstOrThrow({ where: { state: "ready" } });
          const afterCells = await tx.securityBaselineCell.count({ where: { buildId: after.id } });
          return { before: before.id, beforeCells, after: after.id, afterCells, second };
        },
        { isolationLevel: "RepeatableRead", timeout: 120_000 },
      );
      expect(seen.second.status).toBe("built");
      expect(seen.after).toBe(seen.before);
      expect(seen.afterCells).toBe(seen.beforeCells);
      // Outside the snapshot: exactly one ready build, the new one; the old one superseded.
      const ready = await prisma.securityBaselineBuild.findMany({ where: { state: "ready", windowFrom: { startsWith: "2031-" } } });
      expect(ready.map((b) => b.id)).toEqual([(seen.second as { buildId: string }).buildId]);
      expect((await prisma.securityBaselineBuild.findUniqueOrThrow({ where: { id: firstId } })).state).toBe("superseded");
    }, 180_000);

    it("a build past its statement timeout is failed; the previous ready build keeps serving", async () => {
      await sweepBuilds();
      const good = await runFullBuild(prisma, "first", TZ, NOW);
      expect(good.status).toBe("built");
      const r = await runFullBuild(prisma, "nightly", TZ, new Date(NOW.getTime() + 60_000), { statementTimeout: "1ms" });
      expect(r.status).toBe("failed");
      const failed = await prisma.securityBaselineBuild.findUniqueOrThrow({ where: { id: (r as { buildId: string }).buildId } });
      expect(failed.state).toBe("failed");
      expect(failed.error).toMatch(/statement timeout/);
      expect(await prisma.securityBaselineCell.count({ where: { buildId: failed.id } })).toBe(0);
      const ready = await prisma.securityBaselineBuild.findFirstOrThrow({ where: { state: "ready" } });
      expect(ready.id).toBe((good as { buildId: string }).buildId);
    }, 180_000);

    it("a live claim elsewhere → skip; a claim older than 10 minutes → failed 'interrupted', then this build runs", async () => {
      await sweepBuilds();
      const live = await claim("building", new Date(NOW.getTime() - 60_000));
      expect(await runFullBuild(prisma, "first", TZ, NOW)).toEqual({ status: "claimed_elsewhere" });
      expect(await prisma.securityBaselineBuild.count({ where: { state: "building" } })).toBe(1);
      await prisma.securityBaselineBuild.update({ where: { id: live.id }, data: { startedAt: new Date(NOW.getTime() - 11 * 60_000) } });
      const r = await runFullBuild(prisma, "first", TZ, NOW);
      expect(r.status).toBe("built");
      expect(await prisma.securityBaselineBuild.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ state: "failed", error: "interrupted" });
    }, 180_000);

    it("two rebuilds of one area at once both succeed and leave one consistent set of cells (the cells lock; review #2352)", async () => {
      await sweepBuilds();
      const b = await runFullBuild(prisma, "first", TZ, NOW);
      const buildId = (b as { buildId: string }).buildId;
      const key = `area:${zoneIds[0]}`;
      const before = await prisma.securityBaselineCell.count({ where: { buildId, zoneKey: key } });
      expect(before).toBeGreaterThan(0);
      // Hold one of the area's cells, so both rebuilds are inside their transactions at the same time.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let isLocked!: () => void;
      const locked = new Promise<void>((r) => (isLocked = r));
      const blocker = prisma.$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe(
            'SELECT id FROM "SecurityBaselineCell" WHERE "buildId" = $1 AND "zoneKey" = $2 ORDER BY id LIMIT 1 FOR UPDATE',
            buildId,
            key,
          );
          isLocked();
          await held;
        },
        { timeout: 60_000 },
      );
      await locked;
      const both = Promise.allSettled([rebuildAreas(prisma, [zoneIds[0]!]), rebuildAreas(prisma, [zoneIds[0]!])]);
      await new Promise((r) => setTimeout(r, 700));
      release();
      await blocker;
      const results = await both;
      expect(results.map((r) => (r.status === "rejected" ? String(r.reason).slice(0, 120) : r.status))).toEqual(["fulfilled", "fulfilled"]);
      const after = await prisma.securityBaselineCell.findMany({ where: { buildId, zoneKey: key } });
      expect(after).toHaveLength(before);
      expect(new Set(after.map((c) => `${c.label}:${c.dayType}:${c.hour}`)).size).toBe(after.length);
      expect((await prisma.securityBaselineBuild.findUniqueOrThrow({ where: { id: buildId } })).cellsVersion).toBe(3);
    }, 180_000);

    it("rebuildAreas moves an area to its new version and bumps cellsVersion; an archived area's cells are dropped", async () => {
      await sweepBuilds();
      const b = await runFullBuild(prisma, "first", TZ, NOW);
      const buildId = (b as { buildId: string }).buildId;
      const z = zoneIds[1]!;
      const before = await prisma.securityBaselineCell.findFirst({ where: { buildId, zoneKey: `area:${z}` } });
      expect(before).not.toBeNull();
      const bumped = await prisma.securityZone.update({ where: { id: z }, data: { version: { increment: 1 } } });
      expect(await rebuildAreas(prisma, [z])).toMatchObject({ status: "rebuilt", buildId });
      const after = await prisma.securityBaselineCell.findMany({ where: { buildId, zoneKey: `area:${z}` }, distinct: ["zoneVersion"] });
      expect(after.map((c) => c.zoneVersion)).toEqual([bumped.version]);
      expect((await prisma.securityBaselineBuild.findUniqueOrThrow({ where: { id: buildId } })).cellsVersion).toBe(2);

      await prisma.securityZone.update({ where: { id: z }, data: { state: "archived", version: { increment: 1 } } });
      await rebuildAreas(prisma, [z]);
      expect(await prisma.securityBaselineCell.count({ where: { buildId, zoneKey: `area:${z}` } })).toBe(0);
      await prisma.securityZone.update({ where: { id: z }, data: { state: "active" } });
    }, 180_000);
  });
});
