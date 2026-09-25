/**
 * WARP-2980 (ADR-059 P5 PR-B, p5b spec §11.1 B) — the pattern context and
 * `flagPatterns` over the incidents fake, with a seeded ready build, cells
 * and learning states:
 *
 *   · each gate on its own writes no flag, and is COUNTED per site date
 *     (SecurityPatternDay) — "nothing judged" never reads as "nothing
 *     flagged" (review item 12); no fall-back to the camera key (D5);
 *   · `k` (D8): Frigate `detection` rows of the label, in the slot, with
 *     id ≤ the event's — including the two rows where that differs from
 *     `startedAt ≤` (review item 6); an area keeps only what its links match;
 *     the 5000 cap, counted after those filters, and the scan ceiling past
 *     which k is null (review #2369);
 *   · never throws (D4): a write failure is 0 flags, plain words on the
 *     health state, and a `failed` count; the next success clears it;
 *   · one cell query per judged event, none without a build (D21).
 *
 * The engine end to end (P3 unchanged, suppression, cap, retention) is
 * security-incidents.patterns.test.ts; the real CHECKs and the plan are the
 * pg lane's (security-pattern-flags.pg.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  PatternTally,
  _resetPatternRulesForTests,
  countSlotDetections,
  flagPatterns,
  loadPatternContext,
  loadPatternContextSafe,
  patternRuleHealth,
  type GroupedInto,
} from "./security-pattern-rules.js";
import { loadActiveLinks } from "./security-zones.service.js";
import { slotOf } from "../lib/security-baseline-slots.js";
import {
  areaRows,
  baselineRows,
  createFakeSecurityPrisma,
  eventRow,
  officeHours,
  type BaselineKeyFixture,
  type FakeSecurityPrisma,
} from "../__tests__/security-incidents.fake.js";

const TZ = "Europe/London";
/** Wednesday 2026-09-23, 22:14 in London (BST): slot = weekday 22:00–23:00 = 21:00–22:00 UTC. */
const T0 = new Date("2026-09-23T21:14:00Z");
const STOCK = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61";
const INC = "00000000-0000-4000-8000-0000000029c1";
const at = (iso: string) => new Date(iso);

interface WorldOpts {
  links?: string[];
  zoneVersion?: number;
  keys?: BaselineKeyFixture[];
  sources?: Array<{ camera: string; state: "learning" | "active" | "stale" }>;
  build?: { tz?: string; windowTo?: string } | null;
  hours?: boolean;
}

function world(o: WorldOpts = {}): FakeSecurityPrisma {
  const hours = officeHours(TZ);
  const stock = areaRows(STOCK, "Stock room", "interior", o.links ?? ["back"]);
  const b = baselineRows({
    tz: o.build?.tz,
    windowTo: o.build?.windowTo,
    keys: o.keys ?? [{ zoneKey: `area:${STOCK}`, cameras: ["back"] }],
    sources: o.sources ?? [{ camera: "back", state: "active" }],
  });
  return createFakeSecurityPrisma(
    {
      securityZone: [{ ...stock.zone, version: o.zoneVersion ?? 0 }],
      securityZoneLink: stock.links,
      ...(o.hours === false ? {} : { securitySiteHours: [hours.header], securitySchedule: hours.days }),
      ...(o.build === null ? {} : { securityBaselineBuild: [b.build], securityBaselineCell: b.cells }),
      securityBaselineSource: b.sources,
    },
    T0,
  );
}

const db = (f: FakeSecurityPrisma) => f.client as unknown as PrismaClient;
const areaGrouped = (over: Partial<GroupedInto> = {}): GroupedInto => ({
  incidentId: INC,
  key: { scope: "area", zoneId: STOCK, scopeCamera: null },
  zoneKind: "interior",
  mode: "closed",
  ...over,
});

/** Judge one event: the context (gates a–d), then flagPatterns. */
async function judge(f: FakeSecurityPrisma, event = eventRow({ id: 500n, startedAt: T0 }), grouped = areaGrouped()) {
  f.world.securityEvent.push(event);
  const tally = new PatternTally();
  const ctx = await loadPatternContext(db(f), T0);
  const n = await flagPatterns(db(f), event as never, grouped, ctx, await loadActiveLinks(db(f)), T0, tally);
  return { n, ctx, tally: tally.entries(), flags: f.world.securityPatternFlag };
}

beforeEach(() => {
  _resetPatternRulesForTests();
});

describe("a judged event (every gate passes)", () => {
  it("a person never seen at this hour gets one trial out_of_place flag, snapshot and numbers included, and is counted `judged`", async () => {
    const { n, tally, flags } = await judge(world());
    expect(n).toBe(1);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      incidentId: INC,
      code: "out_of_place",
      effect: "trial",
      severity: "alert",
      suppressionId: null,
      rulesetVersion: 3,
      zoneKey: `area:${STOCK}`,
      keyCameras: ["back"],
      evidenceEventId: 500n,
      evidenceCamera: "back",
      evidenceLabel: "person",
      evidenceAt: T0,
      detail: {
        dayType: "weekday",
        hour: 22,
        windowFrom: "2026-08-26",
        windowTo: "2026-09-22",
        mode: "closed",
        zoneKind: "interior",
        rulesetVersion: 3,
        daysObserved: 20,
        daysWithEvent: 0,
        smoothedDaysObserved: "30",
        smoothedDaysWithEvent: "0",
        p: "0.0161",
        flagsBelow: "0.05",
      },
    });
    expect(tally).toEqual([{ date: "2026-09-23", outcome: "judged", n: 1 }]);
    expect(patternRuleHealth()).toEqual({ lastOkAt: T0, lastError: null });
  });

  it("an hour that is usual gets nothing, and is still counted `judged`", async () => {
    const usual = world({ keys: [{ zoneKey: `area:${STOCK}`, cameras: ["back"], at: () => ({ daysWithEvent: 18, eventCount: 60 }) }] });
    const { n, tally } = await judge(usual);
    expect(n).toBe(0);
    expect(tally).toEqual([{ date: "2026-09-23", outcome: "judged", n: 1 }]);
  });
});

describe("each gate on its own: no flag, and the gate is counted under the site date (D6, review item 12)", () => {
  it.each([
    ["no ready build", { build: null }, "no_build"],
    ["a build cut in another zone", { build: { tz: "America/New_York" } }, "zone_changed"],
    ["a build whose window ends today − 3", { build: { windowTo: "2026-09-20" } }, "stale_build"],
    ["no cell for this label", { keys: [{ zoneKey: `area:${STOCK}`, cameras: ["back"], labels: ["car"] }] }, "no_cell"],
    ["cells older than the area's links", { zoneVersion: 1 }, "area_changed"],
    ["the event's camera still learning", { sources: [{ camera: "back", state: "learning" as const }] }, "camera_not_active"],
    [
      "a second camera behind the area stale while the event's is active",
      {
        links: ["back", "side"],
        keys: [{ zoneKey: `area:${STOCK}`, cameras: ["back", "side"] }],
        sources: [
          { camera: "back", state: "active" as const },
          { camera: "side", state: "stale" as const },
        ],
      },
      "camera_not_active",
    ],
    ["a cell not ready (n′ < 10)", { keys: [{ zoneKey: `area:${STOCK}`, cameras: ["back"], at: () => ({ daysObserved: 3 }) }] }, "not_ready"],
    // Review item 21 — the camera key HAS cells; the area key has none. No fall-back to the camera's numbers.
    ["an area with no cells while its camera has some (no fall-back, D5)", { keys: [{ zoneKey: "camera:back", cameras: ["back"] }] }, "no_cell"],
  ] as Array<[string, WorldOpts, string]>)("%s → nothing, counted %s", async (_what, opts, outcome) => {
    const { n, flags, tally } = await judge(world(opts));
    expect(n).toBe(0);
    expect(flags).toEqual([]);
    expect(tally).toEqual([{ date: "2026-09-23", outcome, n: 1 }]);
  });

  it("a window ending today − 2 still passes (the health row's own out-of-date test)", async () => {
    expect((await judge(world({ build: { windowTo: "2026-09-21" } }))).n).toBe(1);
  });

  it("no site zone: nothing, and nothing counted — there is no site date (the patterns row says so)", async () => {
    const { n, ctx, tally } = await judge(world({ hours: false }));
    expect(ctx).toEqual({ ok: false, gate: "no_zone", zone: null });
    expect(n).toBe(0);
    expect(tally).toEqual([]);
  });

  it("an event D5 does not judge is not counted at all: a lock row, a detection_low, a site incident", async () => {
    const f = world();
    const tally = new PatternTally();
    const ctx = await loadPatternContext(db(f), T0);
    const links = await loadActiveLinks(db(f));
    for (const [e, g] of [
      [eventRow({ id: 501n, kind: "detection_ongoing", endedAt: null }), areaGrouped()],
      [eventRow({ id: 502n, kind: "detection_low" }), areaGrouped()],
      [eventRow({ id: 503n, labels: ["a person"] }), areaGrouped()],
      [eventRow({ id: 504n }), areaGrouped({ key: { scope: "site_camera_system", zoneId: null, scopeCamera: null } })],
      // WARP-2977 P2b-2: a real door-lock row (the engine never groups one, D21; judged as if it had been).
      [
        eventRow({ id: 505n, source: "matter_lock", kind: "lock_state", camera: null, labels: ["unlocked"], cameraZones: [], sourceRef: "matter:4660/1", endedAt: null }),
        areaGrouped(),
      ],
    ] as const) {
      expect(await flagPatterns(db(f), e as never, g, ctx, links, T0, tally)).toBe(0);
    }
    expect(tally.entries()).toEqual([]);
  });
});

describe("k — what `unusual_volume` counts (D8)", () => {
  // The slot of T0: weekday 22:00–23:00 London = 21:00–22:00 UTC.
  const slot = slotOf(T0, TZ);
  const E = 500n;

  function kWorld(rows: Array<Record<string, unknown>>, links = ["back"]): FakeSecurityPrisma {
    const f = world({ links });
    f.world.securityEvent.push(...rows.map((r) => eventRow(r)));
    return f;
  }
  const k = async (f: FakeSecurityPrisma, zoneId: string | null = null) =>
    countSlotDetections(db(f), { keyCameras: ["back"], zoneId, label: "person", slot, eventId: E, links: await loadActiveLinks(db(f)) });

  it("counts Frigate `detection` rows of the label in the slot with id ≤ the event's — and nothing else", async () => {
    const f = kWorld([
      { id: E, startedAt: T0 }, // the event itself
      { id: 100n, startedAt: at("2026-09-23T21:05:00Z") },
      { id: 90n, startedAt: at("2026-09-23T21:01:00Z") }, // earlier start, lower id
      // Review item 6 — where id ≤ and `startedAt ≤ event.startedAt` disagree:
      { id: 110n, startedAt: at("2026-09-23T21:30:00Z") }, // started LATER, LOWER id (a short visit that ended first): counted
      { id: 700n, startedAt: at("2026-09-23T21:02:00Z") }, // started EARLIER, HIGHER id (ended after): not counted
      { id: 101n, kind: "detection_ongoing", endedAt: null, startedAt: at("2026-09-23T21:06:00Z"), dedupeKey: "frigate-ongoing:101" },
      { id: 102n, kind: "detection_low", startedAt: at("2026-09-23T21:07:00Z") },
      { id: 103n, labels: ["car"], startedAt: at("2026-09-23T21:08:00Z") },
      { id: 104n, labels: ["car", "person"], startedAt: at("2026-09-23T21:09:00Z") }, // the label is labels[0]
      { id: 105n, source: "matter_lock", startedAt: at("2026-09-23T21:10:00Z") },
      { id: 106n, camera: "front", startedAt: at("2026-09-23T21:11:00Z") },
      { id: 95n, startedAt: at("2026-09-23T20:59:59Z") }, // the previous slot
      { id: 96n, startedAt: slot.end }, // the next one (end is exclusive)
      { id: 600n, startedAt: at("2026-09-23T21:20:00Z") }, // a higher id
    ]);
    expect(await k(f)).toBe(4); // 500, 100, 90, 110
  });

  it("an area key keeps only what its links match: a detection outside the linked part of the view is not the area's", async () => {
    const f = kWorld(
      [
        { id: E, startedAt: T0, cameraZones: ["aisle"] },
        { id: 100n, startedAt: at("2026-09-23T21:05:00Z"), cameraZones: ["aisle"] },
        { id: 101n, startedAt: at("2026-09-23T21:06:00Z"), cameraZones: ["door"] },
        { id: 102n, startedAt: at("2026-09-23T21:07:00Z"), cameraZones: [] },
      ],
      ["back/aisle"],
    );
    expect(await k(f, STOCK)).toBe(2);
    expect(await k(f, null)).toBe(4); // the camera key counts the whole view
  });

  it("reads at most 5000 rows: at the cap k = 5000", async () => {
    const rows = Array.from({ length: 5003 }, (_, i) => ({ id: BigInt(i + 1), startedAt: at("2026-09-23T21:20:00Z"), dedupeKey: `frigate:k${i}` }));
    const f = kWorld(rows);
    expect(await countSlotDetections(db(f), { keyCameras: ["back"], zoneId: null, label: "person", slot, eventId: 9_999n, links: [] })).toBe(5000);
  });

  describe("the cap counts matches, not rows read (review #2369)", () => {
    const row = (id: number, zone: string) => ({ id: BigInt(id), startedAt: at("2026-09-23T21:20:00Z"), cameraZones: [zone], dedupeKey: `frigate:c${id}` });
    const kArea = async (f: FakeSecurityPrisma) =>
      countSlotDetections(db(f), { keyCameras: ["back"], zoneId: STOCK, label: "person", slot, eventId: 99_999n, links: await loadActiveLinks(db(f)) });

    it("5000 rows outside the linked part never use it up — and pages go in id order, whatever order the rows come back in", async () => {
      // Stored newest first, so a page that is not in id order loses the lowest ids: the three in the area.
      const outside = Array.from({ length: 5000 }, (_, i) => row(5003 - i, "door"));
      const f = kWorld([...outside, row(3, "aisle"), row(2, "aisle"), row(1, "aisle")], ["back/aisle"]);
      expect(await kArea(f)).toBe(3);
    });

    it("5003 in the area among 2000 outside: k = 5000", async () => {
      const f = kWorld(
        Array.from({ length: 7003 }, (_, i) => row(i + 1, i < 2000 ? "door" : "aisle")),
        ["back/aisle"],
      );
      expect(await kArea(f)).toBe(5000);
    });

    // n rows, only the last in the area: whether the scan reads row n is the difference between k = 1 and null.
    const ceilingWorld = (n: number) => kWorld([...Array.from({ length: n - 1 }, (_, i) => row(i + 1, "door")), row(n, "aisle")], ["back/aisle"]);

    it("rows that run out exactly at the scan ceiling (20000 rows) are a known k", async () => {
      expect(await kArea(ceilingWorld(20_000))).toBe(1);
    });

    it("past the scan ceiling (20001 rows) k is not known: null, and volume is not judged", async () => {
      expect(await kArea(ceilingWorld(20_001))).toBeNull();
    });
  });

  it("a busy hour flags unusual_volume for the event that takes k past k*", async () => {
    const f = world();
    for (let i = 0; i < 4; i += 1) f.world.securityEvent.push(eventRow({ id: BigInt(400 + i), startedAt: at(`2026-09-23T21:0${i}:00Z`) }));
    const { flags } = await judge(f);
    expect(flags.map((x) => x.code)).toEqual(["out_of_place", "unusual_volume"]);
    expect(flags[1]).toMatchObject({ severity: "notice", detail: { k: 5, slotMinutes: 60 } });
  });
});

describe("never throws (D4)", () => {
  it("a failing write returns 0, says so in plain words, counts `failed`; the next success clears it", async () => {
    const f = world();
    f.failOn("securityPatternFlag", "createMany", undefined, { error: Object.assign(new Error('relation "SecurityPatternFlag" …'), { code: "P2010", name: "PrismaClientKnownRequestError" }) });
    const first = await judge(f);
    expect(first.n).toBe(0);
    expect(first.tally).toEqual([
      { date: "2026-09-23", outcome: "judged", n: 1 },
      { date: "2026-09-23", outcome: "failed", n: 1 },
    ]);
    expect(patternRuleHealth().lastError).toEqual({ at: T0, message: "the database couldn't be read" });
    const second = await judge(f, eventRow({ id: 501n, startedAt: T0 }));
    expect(second.n).toBe(1);
    expect(patternRuleHealth()).toEqual({ lastOkAt: T0, lastError: null });
  });

  it("a context that cannot be read is `failed` for the tick, never a throw", async () => {
    const f = world();
    f.failOn("securityBaselineBuild", "findFirst");
    const ctx = await loadPatternContextSafe(db(f), T0);
    expect(ctx).toEqual({ ok: false, gate: "failed", zone: TZ });
    expect(patternRuleHealth().lastError).toEqual({ at: T0, message: "something went wrong" });
    const tally = new PatternTally();
    expect(await flagPatterns(db(f), eventRow({ id: 500n }) as never, areaGrouped(), ctx, [], T0, tally)).toBe(0);
    expect(tally.entries()).toEqual([{ date: "2026-09-23", outcome: "failed", n: 1 }]);
  });
});

describe("the cells are read once per judged event, and never without a build (D21)", () => {
  it("one findMany of the three hours per judged event", async () => {
    const f = world();
    const cells = (f.client as unknown as { securityBaselineCell: { findMany: (a: unknown) => Promise<unknown> } }).securityBaselineCell;
    const spy = vi.spyOn(cells, "findMany");
    await judge(f);
    await judge(f, eventRow({ id: 501n, startedAt: T0 }));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]![0]).toMatchObject({ where: { zoneKey: `area:${STOCK}`, label: "person", dayType: "weekday", hour: { in: [21, 22, 23] } } });
  });

  it("no build: no cell query at all", async () => {
    const f = world({ build: null });
    const cells = (f.client as unknown as { securityBaselineCell: { findMany: (a: unknown) => Promise<unknown> } }).securityBaselineCell;
    const spy = vi.spyOn(cells, "findMany");
    await judge(f);
    expect(spy).not.toHaveBeenCalled();
  });
});
