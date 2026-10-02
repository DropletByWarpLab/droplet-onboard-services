/**
 * WARP-2980 (ADR-059 P5 §6.13, §6.17) — the read side: the overview (route
 * 29), one key's cells (route 30) and the explanation (route 31, and the
 * PR-E chat tool's function).
 *
 * DS-005 is most of it. An area's numbers ("seen on 3 of 20 weekdays") are
 * presence data from EVERY camera behind the area, so an area key exists for
 * a viewer only when they can see the area AND every camera its cells were
 * built from; otherwise it is absent — and absent answers exactly like
 * missing, byte for byte. The numbers come from lib/security-baseline-math.ts,
 * the same functions the rules use, so an explanation can never disagree
 * with a flag.
 */
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { explainSecurityPattern, readPatternCells, readPatternsOverview, verdictPrecision } from "./security-patterns-read.js";
import { cellsFor, newPatternsWorld, patternsPrisma, type FakeCell, type PatternsWorld } from "../__tests__/security-patterns.fake.js";
import { hourlyRate, isReady, rarityP, smoothCounts, slotRate, volumeThreshold } from "../lib/security-baseline-math.js";
import type { SecurityViewerScope } from "./security-access.js";

const TZ = "America/New_York";
const NOW = new Date("2026-09-23T06:14:00Z"); // Wed 2:14 AM in New York
const B = "b-ready";
const A = "front"; // granted to the family viewer
const C = "back"; // not granted
const AREA_X = "3f1c2a9e-0b7d-4c55-9a51-1c2d3e4f5a61"; // links A and C
const AREA_Y = "7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c82"; // links A only
const GONE = "0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6";
/** Areas with NO cells yet (day 1: nothing observed; D3 needs every linked camera). */
const AREA_Z = "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f"; // links A and C
const AREA_W = "6d7e8f9a-0b1c-4d2e-9f3a-4b5c6d7e8f9a"; // links A only

const ALL: SecurityViewerScope = { visibleCameras: "all", mayReadThreats: true, mayReadLocks: true };
const FAMILY: SecurityViewerScope = { visibleCameras: new Set([A]), mayReadThreats: false, mayReadLocks: false };

function world(over: Partial<PatternsWorld> = {}): PatternsWorld {
  let id = 1n;
  const next = () => (id += 100n);
  const cells: FakeCell[] = [
    // camera:front — person: a busy 14:00, a never-seen 02:00; car too.
    ...cellsFor(B, { zoneKey: `camera:${A}`, keyKind: "camera", camera: A, cameras: [A] }, "person", (dt, h) =>
      dt === "weekday" && h === 14 ? { daysWithEvent: 18, eventCount: 160, dwellSamples: 40, durationP99Sec: 95 } : {},
      next(),
    ),
    ...cellsFor(B, { zoneKey: `camera:${A}`, keyKind: "camera", camera: A, cameras: [A] }, "car", () => ({}), next()),
    ...cellsFor(B, { zoneKey: `camera:${C}`, keyKind: "camera", camera: C, cameras: [C] }, "person", () => ({}), next()),
    ...cellsFor(B, { zoneKey: `area:${AREA_X}`, keyKind: "area", zoneId: AREA_X, zoneVersion: 2, cameras: [C, A].sort() }, "person", () => ({}), next()),
    ...cellsFor(B, { zoneKey: `area:${AREA_Y}`, keyKind: "area", zoneId: AREA_Y, zoneVersion: 1, cameras: [A] }, "person", (dt, h) =>
      dt === "weekday" && h === 1 ? { daysWithEvent: 20, eventCount: 20 } : {},
      next(),
    ),
  ];
  return newPatternsWorld({
    hours: { state: "set", timezone: TZ },
    cameras: [
      { name: A, displayName: "Front camera" },
      { name: C, displayName: "Back camera" },
      { name: "porch", displayName: "Porch" },
    ],
    grants: { "u-family": [A] },
    zones: [
      { id: AREA_X, name: "Shop floor", kind: "interior", state: "active", version: 2 },
      { id: AREA_Y, name: "Car park", kind: "parking", state: "active", version: 1 },
      { id: AREA_Z, name: "Stock room", kind: "restricted", state: "active", version: 1 },
      { id: AREA_W, name: "Porch", kind: "entry", state: "active", version: 1 },
    ],
    links: [
      { id: "l1", zoneId: AREA_X, sourceKind: "camera", sourceRef: A, state: "active" },
      { id: "l2", zoneId: AREA_X, sourceKind: "camera", sourceRef: C, state: "active" },
      { id: "l3", zoneId: AREA_Y, sourceKind: "camera_zone", sourceRef: `${A}/drive`, state: "active" },
      { id: "l4", zoneId: AREA_Z, sourceKind: "camera", sourceRef: A, state: "active" },
      { id: "l5", zoneId: AREA_Z, sourceKind: "camera_zone", sourceRef: `${C}/shelf`, state: "active" },
      { id: "l6", zoneId: AREA_W, sourceKind: "camera", sourceRef: A, state: "active" },
    ],
    sources: [
      { sourceKey: `camera:${A}`, camera: A, state: "active", daysObserved: 20, firstSeenAt: new Date("2026-08-01T00:00:00Z"), lastSeenAt: NOW, stateChangedAt: NOW },
      { sourceKey: `camera:${C}`, camera: C, state: "learning", daysObserved: 9, firstSeenAt: new Date("2026-09-10T00:00:00Z"), lastSeenAt: NOW, stateChangedAt: NOW },
    ],
    builds: [
      { id: B, state: "ready", timezone: TZ, windowFrom: "2026-08-26", windowTo: "2026-09-22", finishedAt: new Date("2026-09-23T04:11:00Z"), startedAt: new Date("2026-09-23T04:10:00Z") },
    ],
    cells,
    ...over,
  });
}

const db = (w: PatternsWorld) => patternsPrisma(w) as unknown as PrismaClient;

describe("readPatternsOverview (route 29)", () => {
  it("owner: areas first by name, then cameras; labels in the tracked order; learning flags; release all trial", async () => {
    const o = await readPatternsOverview(db(world()), ALL);
    expect(o.state).toBe("ready");
    expect(o.reason).toBeNull();
    expect(o.timezone).toBe(TZ);
    expect(o.window).toEqual({ from: "2026-08-26", to: "2026-09-22", builtAt: "2026-09-23T04:11:00.000Z" });
    expect(o.release).toEqual({ out_of_place: "trial", unusual_volume: "trial", long_dwell: "trial" });
    expect(o.waitingProposals).toBe(0);
    expect(o.keys.map((k) => [k.zoneKey, k.name, k.labels, k.learning])).toEqual([
      [`area:${AREA_Y}`, "Car park", ["person"], false],
      [`area:${AREA_X}`, "Shop floor", ["person"], true],
      [`camera:${C}`, "Back camera", ["person"], true],
      [`camera:${A}`, "Front camera", ["person", "car"], false],
    ]);
    expect(o.keys[1]).toMatchObject({ kind: "area", zoneId: AREA_X, cameras: [C, A].sort() });
  });

  it("family granted one camera: the area it cannot fully see and the hidden camera are ABSENT; sources only its own", async () => {
    const o = await readPatternsOverview(db(world()), FAMILY);
    expect(o.keys.map((k) => k.zoneKey)).toEqual([`area:${AREA_Y}`, `camera:${A}`]);
    expect(o.sources.map((s) => s.camera)).toEqual([A]);
    expect(JSON.stringify(o)).not.toContain(C);
    expect(JSON.stringify(o)).not.toContain("Shop floor");
  });

  it("sources carry the household's name, the 14-day goal, and detections a day over observed time", async () => {
    const o = await readPatternsOverview(db(world()), ALL);
    const front = o.sources.find((s) => s.camera === A)!;
    expect(front).toMatchObject({ label: "Front camera", state: "active", daysObserved: 20, daysNeeded: 14, lastSeenAt: NOW.toISOString() });
    // person + car cells: 160 detections over (20 × 24 + 8 × 24) observed hours = 28 days.
    expect(front.detectionsPerDay).toBeCloseTo(160 / 28, 6);
    expect(o.sources.find((s) => s.camera === C)!.detectionsPerDay).toBe(0);
  });

  it("no site zone and no valid Workspace.tz → not_configured / no_timezone", async () => {
    const o = await readPatternsOverview(db(world({ hours: null, workspaceTz: null })), ALL);
    expect(o).toMatchObject({ state: "not_configured", reason: "no_timezone", timezone: null });
  });

  it("a zone but no camera Droplet has heard from → not_configured / no_cameras", async () => {
    const o = await readPatternsOverview(db(world({ sources: [] })), ALL);
    expect(o).toMatchObject({ state: "not_configured", reason: "no_cameras" });
  });

  it("sources but no ready build yet → not_built, no window, no keys", async () => {
    const o = await readPatternsOverview(db(world({ builds: [] })), ALL);
    expect(o).toMatchObject({ state: "not_built", reason: null, window: null, keys: [] });
    expect(o.sources).toHaveLength(2);
  });

  it("a read failure throws (the route answers 503, never an empty 200)", async () => {
    await expect(readPatternsOverview(db(world({ failReads: true })), ALL)).rejects.toThrow("db down");
  });
});

describe("readPatternCells (route 30)", () => {
  it("a visible camera key: 48 cells, weekdays 0–23 then weekends; the numbers are the math library's", async () => {
    const r = await readPatternCells(db(world()), ALL, `camera:${A}`, "person");
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.view.window).toEqual({ from: "2026-08-26", to: "2026-09-22", builtAt: "2026-09-23T04:11:00.000Z" });
    expect(r.view.cells).toHaveLength(48);
    expect(r.view.cells.slice(0, 2).map((c) => [c.dayType, c.hour])).toEqual([
      ["weekday", 0],
      ["weekday", 1],
    ]);
    expect(r.view.cells[24]).toMatchObject({ dayType: "weekend", hour: 0 });
    const busy = r.view.cells.find((c) => c.dayType === "weekday" && c.hour === 14)!;
    const s = smoothCounts(
      { daysObserved: 20, daysWithEvent: 0, eventCount: 0, observedMinutes: 1200 },
      { daysObserved: 20, daysWithEvent: 18, eventCount: 160, observedMinutes: 1200 },
      { daysObserved: 20, daysWithEvent: 0, eventCount: 0, observedMinutes: 1200 },
    );
    expect(busy).toEqual({
      dayType: "weekday",
      hour: 14,
      daysObserved: 20,
      daysWithEvent: 18,
      ready: true,
      rare: false,
      typicalPerHour: hourlyRate(s),
      longestUsualVisitSec: 95,
    });
    const quiet = r.view.cells.find((c) => c.dayType === "weekday" && c.hour === 2)!;
    expect(quiet).toMatchObject({ ready: true, rare: true, longestUsualVisitSec: null });
  });

  it("a cell that is not ready is never 'rare' and has no rate", async () => {
    const w = world();
    w.cells = cellsFor(B, { zoneKey: `camera:${A}`, keyKind: "camera", camera: A, cameras: [A] }, "person", () => ({ daysObserved: 5, observedMinutes: 300 }));
    const r = await readPatternCells(db(w), ALL, `camera:${A}`, "person");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.view.cells.every((c) => !c.ready && !c.rare && c.typicalPerHour === null)).toBe(true);
    expect(isReady(smoothCounts({ daysObserved: 5, daysWithEvent: 0, eventCount: 0, observedMinutes: 300 }, { daysObserved: 5, daysWithEvent: 0, eventCount: 0, observedMinutes: 300 }, { daysObserved: 5, daysWithEvent: 0, eventCount: 0, observedMinutes: 300 }).n)).toBe(false);
  });

  it("DS-005: an area with a camera outside the grant answers EXACTLY like a random id; so does a hidden camera", async () => {
    const hidden = await readPatternCells(db(world()), FAMILY, `area:${AREA_X}`, "person");
    const missing = await readPatternCells(db(world()), FAMILY, `area:${GONE}`, "person");
    expect(hidden).toEqual({ status: "not_found" });
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
    expect(await readPatternCells(db(world()), FAMILY, `camera:${C}`, "person")).toEqual({ status: "not_found" });
    // The area the viewer fully sees is there.
    expect((await readPatternCells(db(world()), FAMILY, `area:${AREA_Y}`, "person")).status).toBe("ok");
  });

  it("an area that is no longer active (archived, cells not yet dropped) is not shown", async () => {
    const w = world();
    w.zones = w.zones.map((z) => (z.id === AREA_Y ? { ...z, state: "archived" } : z));
    expect(await readPatternCells(db(w), ALL, `area:${AREA_Y}`, "person")).toEqual({ status: "not_found" });
  });

  it("a label the key does not keep, or no ready build → not found", async () => {
    expect(await readPatternCells(db(world()), ALL, `camera:${A}`, "dog")).toEqual({ status: "not_found" });
    expect(await readPatternCells(db(world({ builds: [] })), ALL, `camera:${A}`, "person")).toEqual({ status: "not_found" });
  });
});

describe("DS-005 for an area with NO cells yet (review #2352, finding 1)", () => {
  it("family granted A only, area linking A and C: not_found, byte-identical to a random id — never C's source row", async () => {
    const hidden = await explainSecurityPattern(db(world()), FAMILY, { zoneId: AREA_Z }, NOW);
    const missing = await explainSecurityPattern(db(world()), FAMILY, { zoneId: GONE }, NOW);
    expect(hidden).toEqual({ status: "not_found" });
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
  });

  it("the owner gets it: the area's link cameras, and their sources", async () => {
    const r = await explainSecurityPattern(db(world()), ALL, { zoneId: AREA_Z }, NOW);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.key).toMatchObject({ kind: "area", zoneId: AREA_Z, cameras: [C, A].sort() });
    expect(r.view.cell).toBeNull();
    expect(r.view.sources.map((s) => s.camera).sort()).toEqual([C, A].sort());
  });

  it("an area the viewer fully sees, with no cells: ok, and only visible cameras' sources", async () => {
    const r = await explainSecurityPattern(db(world()), FAMILY, { zoneId: AREA_W }, NOW);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.key.cameras).toEqual([A]);
    expect(r.view.sources.map((s) => s.camera)).toEqual([A]);
    expect(JSON.stringify(r)).not.toContain(C);
  });

  it("route 30 for the no-cells area answers like a missing key for everyone", async () => {
    expect(await readPatternCells(db(world()), FAMILY, `area:${AREA_Z}`, "person")).toEqual({ status: "not_found" });
    expect(await readPatternCells(db(world()), ALL, `area:${AREA_Z}`, "person")).toEqual({ status: "not_found" });
  });

  it("route 29 never lists an area without cells", async () => {
    const o = await readPatternsOverview(db(world()), ALL);
    expect(o.keys.map((k) => k.zoneKey)).not.toContain(`area:${AREA_Z}`);
    expect(o.keys.map((k) => k.zoneKey)).not.toContain(`area:${AREA_W}`);
  });
});

describe("DS-019: an area judged on the links the viewer can see, lock links included (WARP-2977 P2b-2)", () => {
  // Car park's camera link was replaced by a door lock after the ready build:
  // its cells (camera A) stand until the area rebuild. A lock link is visible
  // only with Devices view, so for a viewer without it every active link of
  // the area is hidden — the area is absent, as on the Areas page.
  const LOCK_ONLY = () => {
    const w = world();
    w.links = w.links.map((l) =>
      l.zoneId === AREA_Y ? { ...l, sourceKind: "lock" as const, sourceRef: "matter:4660/1" } : l,
    );
    return w;
  };
  const FAMILY_WITH_DEVICES: SecurityViewerScope = { ...FAMILY, mayReadLocks: true };

  it("without Devices view: absent from the overview, and route 30 / 31 answer exactly like a random id", async () => {
    const o = await readPatternsOverview(db(LOCK_ONLY()), FAMILY);
    expect(o.keys.map((k) => k.zoneKey)).toEqual([`camera:${A}`]);
    const hidden = await readPatternCells(db(LOCK_ONLY()), FAMILY, `area:${AREA_Y}`, "person");
    const missing = await readPatternCells(db(LOCK_ONLY()), FAMILY, `area:${GONE}`, "person");
    expect(hidden).toEqual({ status: "not_found" });
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
    expect(await explainSecurityPattern(db(LOCK_ONLY()), FAMILY, { zoneId: AREA_Y }, NOW)).toEqual({ status: "not_found" });
  });

  it("with Devices view and every camera behind the cells: shown", async () => {
    const o = await readPatternsOverview(db(LOCK_ONLY()), FAMILY_WITH_DEVICES);
    expect(o.keys.map((k) => k.zoneKey)).toEqual([`area:${AREA_Y}`, `camera:${A}`]);
    expect((await readPatternCells(db(LOCK_ONLY()), FAMILY_WITH_DEVICES, `area:${AREA_Y}`, "person")).status).toBe("ok");
  });

  it("a lock link is never one of an area's baseline cameras", async () => {
    const w = world();
    w.links.push({ id: "l7", zoneId: AREA_W, sourceKind: "lock", sourceRef: "matter:4660/1", state: "active" });
    const r = await explainSecurityPattern(db(w), FAMILY_WITH_DEVICES, { zoneId: AREA_W }, NOW);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.key.cameras).toEqual([A]);
  });
});

describe("explainSecurityPattern (route 31, the PR-E tool's function)", () => {
  it("DS-005: a hidden area → not_found, byte-identical to a missing one", async () => {
    const hidden = await explainSecurityPattern(db(world()), FAMILY, { zoneId: AREA_X }, NOW);
    const missing = await explainSecurityPattern(db(world()), FAMILY, { zoneId: GONE }, NOW);
    expect(hidden).toEqual({ status: "not_found" });
    expect(JSON.stringify(hidden)).toBe(JSON.stringify(missing));
    expect(await explainSecurityPattern(db(world()), FAMILY, { camera: C }, NOW)).toEqual({ status: "not_found" });
    expect(await explainSecurityPattern(db(world()), FAMILY, { camera: "nosuch" }, NOW)).toEqual({ status: "not_found" });
  });

  it("a camera the viewer sees, at 2:14 AM on a weekday: the three cells and the same numbers the rules use", async () => {
    const r = await explainSecurityPattern(db(world()), FAMILY, { camera: A }, NOW);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const v = r.view;
    expect(v.key).toEqual({ zoneKey: `camera:${A}`, kind: "camera", zoneId: null, name: "Front camera", cameras: [A] });
    expect(v.at).toEqual({ instant: NOW.toISOString(), local: "Wed 2:14 AM", dayType: "weekday", hour: 2, timezone: TZ });
    expect(v.window).toEqual({ from: "2026-08-26", to: "2026-09-22", builtAt: "2026-09-23T04:11:00.000Z" });
    expect(v.sources).toEqual([{ camera: A, state: "active", daysObserved: 20, daysNeeded: 14, lastSeenAt: NOW.toISOString() }]);
    const empty = { daysObserved: 20, daysWithEvent: 0, eventCount: 0, observedMinutes: 1200 };
    const s = smoothCounts(empty, empty, empty);
    const lambda = hourlyRate(s)!;
    expect(v.cell).toEqual({
      ready: true,
      daysObserved: 20,
      daysWithEvent: 0,
      smoothed: { daysObserved: 30, daysWithEvent: 0 },
      rarity: { p: rarityP(s), flagsBelow: 0.05, wouldFlag: true },
      volume: { typicalPerHour: lambda, flagsFrom: volumeThreshold(slotRate(lambda, 60)) },
      dwell: { longestUsualVisitSec: null, samples: 0, wouldFlagAboveSec: null },
      neighbours: [
        { hour: 1, daysObserved: 20, daysWithEvent: 0 },
        { hour: 2, daysObserved: 20, daysWithEvent: 0 },
        { hour: 3, daysObserved: 20, daysWithEvent: 0 },
      ],
    });
    expect(v.cell!.rarity.p).toBeCloseTo(0.5 / 31, 12);
    expect(v.paused).toBeNull();
    expect(v.expected).toEqual([]);
    expect(v.release).toEqual({ out_of_place: "trial", unusual_volume: "trial", long_dwell: "trial" });
  });

  it("the area the viewer fully sees, with its learning source; an explicit `at` and label", async () => {
    const at = new Date("2026-09-22T19:30:00Z"); // Tue 3:30 PM
    const r = await explainSecurityPattern(db(world()), ALL, { zoneId: AREA_X, label: "person", at }, NOW);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.key).toMatchObject({ kind: "area", zoneId: AREA_X, name: "Shop floor", cameras: [C, A].sort() });
    expect(r.view.at).toMatchObject({ local: "Tue 3:30 PM", hour: 15, dayType: "weekday" });
    expect(r.view.sources.map((s) => [s.camera, s.state])).toEqual([
      [C, "learning"],
      [A, "active"],
    ]);
  });

  it("a label the key does not keep → ok with no cell", async () => {
    const r = await explainSecurityPattern(db(world()), ALL, { camera: A, label: "dog" }, NOW);
    expect(r.status === "ok" && r.view.cell).toBeNull();
  });

  it("dwell: with ≥ 30 samples the longest usual visit and the threshold are the math library's", async () => {
    const at = new Date("2026-09-22T18:10:00Z"); // Tue 2:10 PM
    const r = await explainSecurityPattern(db(world()), ALL, { camera: A, at }, NOW);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.cell!.dwell).toEqual({ longestUsualVisitSec: 95, samples: 40, wouldFlagAboveSec: 120 });
  });

  it("no ready build → not_built; no zone → no_timezone; neither or both of zone/camera → not_found", async () => {
    expect(await explainSecurityPattern(db(world({ builds: [] })), ALL, { camera: A }, NOW)).toEqual({ status: "not_built" });
    expect(await explainSecurityPattern(db(world({ hours: null })), ALL, { camera: A }, NOW)).toEqual({ status: "no_timezone" });
    expect(await explainSecurityPattern(db(world()), ALL, {}, NOW)).toEqual({ status: "not_found" });
    expect(await explainSecurityPattern(db(world()), ALL, { camera: A, zoneId: AREA_Y }, NOW)).toEqual({ status: "not_found" });
  });
});

// ── WARP-2980 PR-B: route 31's `expected` and `paused` ───────────────────

describe("route 31 `expected` — the active expected activity covering the slot, by the engine's own match (review item 10)", () => {
  // NOW is Wed 2:14 AM in New York: slot weekday 02.
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    targetKind: "camera",
    zoneId: null,
    camera: A,
    label: "person",
    days: "weekdays",
    hourFrom: 22,
    hourCount: 6,
    codes: ["out_of_place", "unusual_volume"],
    state: "active",
    reason: "Night deliveries",
    createdAt: new Date("2026-09-20T12:00:00Z"),
    expiresAt: new Date("2026-10-20T12:00:00Z"),
    ...over,
  });

  it("lists the one that covers the slot, with its codes; not another label, hour, day type or key; not one past its expiresAt", async () => {
    const w = world({
      suppressions: [
        row("s-match"),
        row("s-label", { label: "car" }),
        row("s-hour", { hourFrom: 9, hourCount: 8 }),
        // Opens on Tuesday night 22:00 → Wednesday 02:00 is its tail; a WEEKENDS one does not cover it.
        row("s-days", { days: "weekends" }),
        row("s-key", { camera: C }),
        row("s-expired", { expiresAt: NOW }),
        row("s-removed", { state: "removed" }),
      ],
    });
    const r = await explainSecurityPattern(db(w), FAMILY, { camera: A }, NOW);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.expected).toEqual([{ id: "s-match", text: "Night deliveries", until: "2026-10-20T12:00:00.000Z", codes: ["out_of_place", "unusual_volume"] }]);
  });
});

describe("route 31 `paused` — the engine's own gates, so an explanation never says a flag the engine would not raise (review item 11)", () => {
  it("a camera still learning: paused camera_not_active, and every 'would flag' is off; the numbers stay", async () => {
    const r = await explainSecurityPattern(db(world()), ALL, { camera: C }, NOW);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.paused).toBe("camera_not_active");
    expect(r.view.cell).toMatchObject({ ready: true, rarity: { wouldFlag: false }, volume: { flagsFrom: null }, dwell: { wouldFlagAboveSec: null } });
    expect(r.view.cell!.rarity.p).toBeCloseTo(0.5 / 31, 12);
  });

  it("an out-of-date build: stale_build; one cut in another zone: zone_changed", async () => {
    const stale = world();
    stale.builds[0]!.windowTo = "2026-09-20";
    const r1 = await explainSecurityPattern(db(stale), ALL, { camera: A }, NOW);
    expect(r1.status === "ok" && r1.view.paused).toBe("stale_build");
    expect(r1.status === "ok" && r1.view.cell!.rarity.wouldFlag).toBe(false);
    const moved = world({ hours: { state: "set", timezone: "America/Chicago" } });
    const r2 = await explainSecurityPattern(db(moved), ALL, { camera: A }, NOW);
    expect(r2.status === "ok" && r2.view.paused).toBe("zone_changed");
  });

  it("an area whose links changed since its cells: area_changed", async () => {
    const w = world();
    w.zones.find((z) => z.id === AREA_Y)!.version = 2;
    const r = await explainSecurityPattern(db(w), FAMILY, { zoneId: AREA_Y }, NOW);
    expect(r.status === "ok" && r.view.paused).toBe("area_changed");
  });

  it("nothing pauses a fresh build of an active camera; no cell → null", async () => {
    const r = await explainSecurityPattern(db(world()), ALL, { camera: A }, NOW);
    expect(r.status === "ok" && r.view.paused).toBeNull();
    const none = await explainSecurityPattern(db(world()), ALL, { camera: A, label: "dog" }, NOW);
    expect(none.status === "ok" && none.view.paused).toBeNull();
  });
});

// ── WARP-2980 PR-B: route 29's `precision` (spec D17, review item 14) ────

describe("route 29 `precision` — how often each pattern code was right, owner/admin only", () => {
  const DAY = 86_400_000;
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const marked = (first: Date) => [
    { id: "i1", verdict: "not_expected", verdictCodes: ["after_hours_presence", "out_of_place"], verdictFirstAt: first },
    { id: "i2", verdict: "expected", verdictCodes: ["out_of_place"], verdictFirstAt: ago(10 * DAY) },
    { id: "i3", verdict: "not_expected", verdictCodes: ["out_of_place", "long_dwell"], verdictFirstAt: ago(2 * DAY) },
    // A P3 code only: "Expected" says the event was fine, not that a rule was wrong — never counted.
    { id: "i4", verdict: "not_expected", verdictCodes: ["after_hours_presence"], verdictFirstAt: ago(40 * DAY) },
    { id: "i5", verdict: "expected", verdictCodes: ["long_dwell"], verdictFirstAt: ago(DAY) },
  ];

  it("family (camera-limited, no threats) → null; the incidents are never read", async () => {
    const w = world({ incidents: marked(ago(30 * DAY)) });
    const prisma = patternsPrisma(w);
    const r = await readPatternsOverview(prisma as unknown as PrismaClient, FAMILY, NOW);
    expect(r.precision).toBeNull();
    expect(prisma.securityIncident.findMany).not.toHaveBeenCalled();
  });

  it("owner: per pattern code in order, Not expected counted right, Expected wrong; a percentage from the first mark's 30th day", async () => {
    const r = await readPatternsOverview(db(world({ incidents: marked(ago(30 * DAY)) })), ALL, NOW);
    expect(r.precision).toEqual({
      showAfterDays: 30,
      codes: [
        { code: "out_of_place", marked: 3, notExpected: 2, firstMarkedAt: ago(30 * DAY).toISOString(), percentRight: 67 },
        { code: "long_dwell", marked: 2, notExpected: 1, firstMarkedAt: ago(2 * DAY).toISOString(), percentRight: null },
      ],
    });
  });

  it("at 29 days 23 hours: the counts, no percentage yet", async () => {
    const r = await readPatternsOverview(db(world({ incidents: marked(ago(30 * DAY - 3_600_000)) })), ALL, NOW);
    expect(r.precision!.codes[0]).toMatchObject({ code: "out_of_place", marked: 3, notExpected: 2, percentRight: null });
  });

  it("verdictPrecision is pure: a code absent from verdictCodes is never credited; P3 codes are never listed", () => {
    const p = verdictPrecision(
      [
        { verdict: "not_expected", verdictCodes: ["camera_offline"], verdictFirstAt: ago(60 * DAY) },
        { verdict: "not_expected", verdictCodes: ["unusual_volume"], verdictFirstAt: ago(60 * DAY) },
      ],
      NOW,
    );
    expect(p.codes).toEqual([{ code: "unusual_volume", marked: 1, notExpected: 1, firstMarkedAt: ago(60 * DAY).toISOString(), percentRight: 100 }]);
    expect(verdictPrecision([], NOW)).toEqual({ showAfterDays: 30, codes: [] });
  });
});
