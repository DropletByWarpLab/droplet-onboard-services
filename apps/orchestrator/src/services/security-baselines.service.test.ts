/**
 * WARP-2980 (ADR-059 P5 §6.7, §6.14) — the baseline job's tick and the
 * `patterns` health row, mocked lane.
 *
 * The tick is level-triggered on DATABASE watermarks (the job-state row's
 * `hourlyThrough`, the ready build's `windowTo` / `timezone`, each area's
 * `zoneVersion`), so every case below is "given these rows, at this site
 * time, the tick does exactly this". The build and coverage writes are their
 * own modules' tests; here they are mocks and only their CALLS are pinned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  recordCoverage: vi.fn(),
  refreshBaselineSources: vi.fn(),
  runFullBuild: vi.fn(),
  rebuildAreas: vi.fn(),
}));

vi.mock("./security-coverage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./security-coverage.js")>();
  return { ...actual, recordCoverage: h.recordCoverage, refreshBaselineSources: h.refreshBaselineSources };
});
vi.mock("./security-baseline-build.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./security-baseline-build.js")>();
  return { ...actual, runFullBuild: h.runFullBuild, rebuildAreas: h.rebuildAreas };
});
vi.mock("./camera.service.js", () => ({ securityStatusSnapshot: () => new Map() }));

import { BASELINE_BUILD_TX_TIMEOUT_MS } from "./security-baseline-build.js";
import {
  BASELINE_BUILD_RETRY_AFTER_MS,
  SECURITY_BASELINE_BUILD_START_BUDGET_MS,
  SECURITY_BASELINE_GRACE_MS,
  SECURITY_BASELINE_INTERVAL_MS,
  SECURITY_BASELINE_LOCK_KEY,
  _resetBaselineHealthForTests,
  _resetBaselineJobForTests,
  baselineHealthState,
  patternsHealthRow,
  registerSecurityBaselineJobs,
  securityPatternsHealth,
  tickSecurityBaselines,
  type BaselineHealthState,
  type PatternsHealthDb,
} from "./security-baselines.service.js";
import type { CoverageObservation } from "./security-coverage.js";

const TZ = "America/New_York";
const PID = "0b9f3c3e-7d0a-4b5e-9d64-1f2a3b4c5d6e";
/** What the tracker says: subscribed, and no status message yet (the orchestrator just restarted). */
const OBS: Omit<CoverageObservation, "stats"> = {
  ingest: { frigateSubscribed: true, frigateSubscribedAt: new Date(0), lastRecordedAt: null, lastWriteError: null },
  readings: new Map(),
};
/** Frigate's /api/stats body: one camera streaming. */
const STATS = { cameras: { front: { camera_fps: 5, detection_enabled: true } }, detectors: {} };
/** A New York wall clock on 2026-09-23 (EDT, UTC−4) as an instant. */
const ny = (hhmm: string, ymd = "2026-09-23") => new Date(`${ymd}T${hhmm}:00-04:00`);

interface World {
  jobState: { id: string; hourlyThrough: Date } | null;
  ready: { id: string; timezone: string; windowFrom: string; windowTo: string; finishedAt: Date } | null;
  newest: { state: string; startedAt: Date; error: string | null; timezone?: string } | null;
  areaCells: Array<{ zoneId: string; zoneVersion: number }>;
  liveAreas: Array<{ id: string; version: number }>;
}

function world(over: Partial<World> = {}): World {
  return {
    jobState: { id: "singleton", hourlyThrough: ny("15:00") },
    ready: { id: "b-1", timezone: TZ, windowFrom: "2026-08-26", windowTo: "2026-09-22", finishedAt: ny("00:11") },
    newest: null,
    areaCells: [],
    liveAreas: [],
    ...over,
  };
}

function fakePrisma(w: World) {
  const jobState = {
    findUnique: vi.fn(async () => (w.jobState ? { ...w.jobState } : null)),
    createMany: vi.fn(async (a: { data: Array<{ id: string; hourlyThrough: Date }> }) => {
      if (w.jobState) return { count: 0 };
      w.jobState = { ...a.data[0]! };
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => ({ ...w.jobState! })),
    updateMany: vi.fn(async (a: { where: { hourlyThrough: Date }; data: { hourlyThrough: Date } }) => {
      if (!w.jobState || w.jobState.hourlyThrough.getTime() !== a.where.hourlyThrough.getTime()) return { count: 0 };
      w.jobState.hourlyThrough = a.data.hourlyThrough;
      return { count: 1 };
    }),
  };
  const build = {
    findFirst: vi.fn(async (a: { where?: { state?: string }; orderBy?: unknown }) =>
      a.where?.state === "ready" ? (w.ready ? { ...w.ready } : null) : w.newest ? { ...w.newest } : null,
    ),
  };
  const cell = { findMany: vi.fn(async () => w.areaCells.map((c) => ({ ...c }))) };
  const zone = { findMany: vi.fn(async () => w.liveAreas.map((z) => ({ ...z }))) };
  return {
    prisma: {
      securityBaselineJobState: jobState,
      securityBaselineBuild: build,
      securityBaselineCell: cell,
      securityZone: zone,
    } as never,
    jobState,
    cell,
    zone,
  };
}

const deps = (zone: string | null, stats: () => Promise<unknown> = async () => STATS) => ({
  zone: async () => zone,
  observe: () => OBS,
  stats,
  processId: PID,
});

beforeEach(() => {
  _resetBaselineHealthForTests();
  _resetBaselineJobForTests();
  h.recordCoverage.mockReset().mockResolvedValue({ extended: 0, closed: 0, opened: 0 });
  h.refreshBaselineSources.mockReset().mockResolvedValue({ cameras: 1, created: 0, updated: 1, deleted: 0 });
  h.runFullBuild.mockReset().mockResolvedValue({ status: "built", buildId: "b-2", cellCount: 192, eventCount: 10 });
  h.rebuildAreas.mockReset().mockResolvedValue({ status: "rebuilt", buildId: "b-1", inserted: 0 });
});

describe("tickSecurityBaselines — coverage every tick, zone or not", () => {
  it("no zone → coverage only (the boot close on the process's first tick), then nothing else; the tick still counts as ok", async () => {
    const f = fakePrisma(world({ jobState: null }));
    const now = ny("12:30");
    await tickSecurityBaselines(f.prisma, now, deps(null));
    expect(h.recordCoverage).toHaveBeenCalledTimes(1);
    expect(h.recordCoverage.mock.calls[0]!.slice(2)).toEqual([PID, now, { bootClose: true }]);
    expect(f.jobState.findUnique).not.toHaveBeenCalled();
    expect(h.runFullBuild).not.toHaveBeenCalled();
    expect(h.refreshBaselineSources).not.toHaveBeenCalled();
    expect(baselineHealthState().lastOkAt).toEqual(now);
    // The boot close happens once per process.
    await tickSecurityBaselines(f.prisma, ny("12:31"), deps(null));
    expect(h.recordCoverage.mock.calls[1]![4]).toEqual({ bootClose: false });
  });

  it("first tick with a zone: the job-state row is created lazily at the current site hour (createMany + read, never upsert)", async () => {
    const f = fakePrisma(world({ jobState: null }));
    await tickSecurityBaselines(f.prisma, ny("12:30"), deps(TZ));
    expect(f.jobState.createMany).toHaveBeenCalledWith({ data: [{ id: "singleton", hourlyThrough: ny("12:00") }], skipDuplicates: true });
    expect(f.jobState.findUniqueOrThrow).toHaveBeenCalled();
    // The hour that just started is not a completed hour: no hourly step yet.
    expect(f.jobState.updateMany).not.toHaveBeenCalled();
  });
});

describe("tickSecurityBaselines — coverage reads Frigate's stats every tick (review #2352, finding 2)", () => {
  const observed = (call: number) => h.recordCoverage.mock.calls[call]![1] as CoverageObservation;

  it("a restart with Frigate up and no status message: Frigate and the streaming camera are seeded from stats", async () => {
    const now = ny("12:30");
    await tickSecurityBaselines(fakePrisma(world()).prisma, now, deps(TZ));
    const o = observed(0);
    expect(o.stats?.at).toEqual(now);
    expect([...(o.stats?.cameras.keys() ?? [])]).toEqual(["front"]);
    expect(o.readings.get(null)).toEqual({ health: "online", at: now, since: now });
    expect(o.readings.get("front")).toEqual({ health: "online", at: now, since: now });
  });

  it("the seed is kept across ticks (its `since` does not move)", async () => {
    const f = fakePrisma(world());
    await tickSecurityBaselines(f.prisma, ny("12:30"), deps(TZ));
    await tickSecurityBaselines(f.prisma, ny("12:31"), deps(TZ));
    expect(observed(1).readings.get("front")!.since).toEqual(ny("12:30"));
  });

  it("stats that fail or do not parse: `stats` null, nothing seeded, and the seeds are forgotten", async () => {
    const f = fakePrisma(world());
    await tickSecurityBaselines(f.prisma, ny("12:30"), deps(TZ));
    await tickSecurityBaselines(f.prisma, ny("12:31"), deps(TZ, async () => Promise.reject(new Error("ECONNREFUSED"))));
    expect(observed(1).stats).toBeNull();
    expect(observed(1).readings.has("front")).toBe(false);
    await tickSecurityBaselines(f.prisma, ny("12:32"), deps(TZ, async () => "not json"));
    expect(observed(2).stats).toBeNull();
    // Back: a fresh seed, from the new read — never from before the outage.
    await tickSecurityBaselines(f.prisma, ny("12:33"), deps(TZ));
    expect(observed(3).readings.get("front")!.since).toEqual(ny("12:33"));
  });
});

describe("tickSecurityBaselines — the hourly step (sources; no counts)", () => {
  it("runs ONCE after a five-hour gap, and moves hourlyThrough to the end of the last completed hour (CAS on the old value)", async () => {
    const w = world({ jobState: { id: "singleton", hourlyThrough: ny("07:00") } });
    const f = fakePrisma(w);
    await tickSecurityBaselines(f.prisma, ny("12:30"), deps(TZ));
    expect(h.refreshBaselineSources).toHaveBeenCalledTimes(1);
    expect(h.refreshBaselineSources.mock.calls[0]!.slice(1)).toEqual([TZ, ny("12:30")]);
    expect(f.jobState.updateMany).toHaveBeenCalledWith({
      where: { id: "singleton", hourlyThrough: ny("07:00") },
      data: { hourlyThrough: ny("12:00") },
    });
    await tickSecurityBaselines(f.prisma, ny("12:31"), deps(TZ));
    expect(h.refreshBaselineSources).toHaveBeenCalledTimes(1);
  });

  it("does not run inside the same hour", async () => {
    const f = fakePrisma(world({ jobState: { id: "singleton", hourlyThrough: ny("12:00") } }));
    await tickSecurityBaselines(f.prisma, ny("12:59"), deps(TZ));
    expect(h.refreshBaselineSources).not.toHaveBeenCalled();
  });
});

describe("tickSecurityBaselines — when a full build runs", () => {
  it("no ready build → `first`, in the current zone; after it, the sources are recomputed (the window moved) and area rebuilds wait", async () => {
    const f = fakePrisma(world({ ready: null, liveAreas: [{ id: "z-1", version: 1 }] }));
    const now = ny("15:00");
    await tickSecurityBaselines(f.prisma, now, deps(TZ));
    expect(h.runFullBuild).toHaveBeenCalledWith(f.prisma, "first", TZ, now);
    expect(h.refreshBaselineSources).toHaveBeenCalledTimes(1);
    expect(h.rebuildAreas).not.toHaveBeenCalled();
  });

  it("the ready build was cut in another zone → `timezone_changed`", async () => {
    const f = fakePrisma(world({ ready: { id: "b-1", timezone: "Europe/London", windowFrom: "2026-08-26", windowTo: "2026-09-22", finishedAt: ny("00:11") } }));
    await tickSecurityBaselines(f.prisma, ny("15:00"), deps(TZ));
    expect(h.runFullBuild.mock.calls[0]![1]).toBe("timezone_changed");
  });

  it("nightly at 00:10 site time, and not at 00:09", async () => {
    const stale = world({ ready: { id: "b-1", timezone: TZ, windowFrom: "2026-08-25", windowTo: "2026-09-21", finishedAt: ny("00:11", "2026-09-22") } });
    await tickSecurityBaselines(fakePrisma(stale).prisma, ny("00:09"), deps(TZ));
    expect(h.runFullBuild).not.toHaveBeenCalled();
    await tickSecurityBaselines(fakePrisma(stale).prisma, ny("00:10"), deps(TZ));
    expect(h.runFullBuild.mock.calls[0]![1]).toBe("nightly");
  });

  it("`catch_up` at any hour when two days behind (the box was off at 00:10)", async () => {
    const behind = world({ ready: { id: "b-1", timezone: TZ, windowFrom: "2026-08-24", windowTo: "2026-09-20", finishedAt: ny("00:11", "2026-09-21") } });
    await tickSecurityBaselines(fakePrisma(behind).prisma, ny("00:05"), deps(TZ));
    expect(h.runFullBuild.mock.calls[0]![1]).toBe("catch_up");
  });

  it("an up-to-date ready build → no full build", async () => {
    await tickSecurityBaselines(fakePrisma(world()).prisma, ny("15:00"), deps(TZ));
    expect(h.runFullBuild).not.toHaveBeenCalled();
  });

  it("a build that failed less than an hour ago is not retried every minute; after an hour it is", async () => {
    const failed = (ago: number) =>
      world({
        ready: null,
        newest: { state: "failed", startedAt: new Date(ny("15:00").getTime() - ago), error: "canceling statement due to statement timeout", timezone: TZ },
      });
    await tickSecurityBaselines(fakePrisma(failed(30 * 60_000)).prisma, ny("15:00"), deps(TZ));
    expect(h.runFullBuild).not.toHaveBeenCalled();
    await tickSecurityBaselines(fakePrisma(failed(BASELINE_BUILD_RETRY_AFTER_MS + 1)).prisma, ny("15:00"), deps(TZ));
    expect(h.runFullBuild).toHaveBeenCalledTimes(1);
  });

  it("a build that failed in ANOTHER zone never holds back the new zone's build (review #2352, finding 7)", async () => {
    const w = world({
      ready: { id: "b-1", timezone: "Europe/London", windowFrom: "2026-08-26", windowTo: "2026-09-22", finishedAt: ny("00:11") },
      newest: { state: "failed", startedAt: ny("14:50"), error: "canceling statement due to statement timeout", timezone: "Europe/London" },
    });
    await tickSecurityBaselines(fakePrisma(w).prisma, ny("15:00"), deps(TZ));
    expect(h.runFullBuild).toHaveBeenCalledTimes(1);
    expect(h.runFullBuild.mock.calls[0]![1]).toBe("timezone_changed");
  });

  it("a build that did not complete (claimed elsewhere) does not recompute the sources", async () => {
    h.runFullBuild.mockResolvedValueOnce({ status: "claimed_elsewhere" });
    await tickSecurityBaselines(fakePrisma(world({ ready: null })).prisma, ny("15:00"), deps(TZ));
    expect(h.refreshBaselineSources).not.toHaveBeenCalled();
  });
});

describe("a tick never starts a build it cannot finish inside its 60 s lock (review #2352, finding 5)", () => {
  it("the start budget plus a build's transaction stays under the lock, with time to spare", () => {
    expect(SECURITY_BASELINE_BUILD_START_BUDGET_MS + BASELINE_BUILD_TX_TIMEOUT_MS).toBeLessThanOrEqual(57_000);
  });

  it("when the earlier steps took longer than the budget, the full build waits for the next tick", async () => {
    let t = 1_000_000;
    const clock = () => {
      const v = t;
      t += SECURITY_BASELINE_BUILD_START_BUDGET_MS + 1;
      return v;
    };
    await tickSecurityBaselines(fakePrisma(world({ ready: null })).prisma, ny("15:00"), { ...deps(TZ), clock });
    expect(h.runFullBuild).not.toHaveBeenCalled();
    expect(baselineHealthState().lastOkAt).toEqual(ny("15:00"));
    // A tick that is on time builds.
    await tickSecurityBaselines(fakePrisma(world({ ready: null })).prisma, ny("15:01"), deps(TZ));
    expect(h.runFullBuild).toHaveBeenCalledTimes(1);
  });

  it("the same budget holds for area rebuilds", async () => {
    let t = 1_000_000;
    const clock = () => {
      const v = t;
      t += SECURITY_BASELINE_BUILD_START_BUDGET_MS + 1;
      return v;
    };
    await tickSecurityBaselines(fakePrisma(world({ liveAreas: [{ id: "z-1", version: 1 }] })).prisma, ny("15:00"), { ...deps(TZ), clock });
    expect(h.rebuildAreas).not.toHaveBeenCalled();
  });
});

describe("tickSecurityBaselines — area rebuilds when links change (D2)", () => {
  it("rebuilds, in ONE call, the areas whose version moved, the linked areas with no cells, and the cells of areas no longer linked", async () => {
    const f = fakePrisma(
      world({
        areaCells: [
          { zoneId: "z-moved", zoneVersion: 3 },
          { zoneId: "z-same", zoneVersion: 2 },
          { zoneId: "z-archived", zoneVersion: 5 },
        ],
        liveAreas: [
          { id: "z-moved", version: 4 },
          { id: "z-same", version: 2 },
          { id: "z-new", version: 1 },
        ],
      }),
    );
    await tickSecurityBaselines(f.prisma, ny("15:00"), deps(TZ));
    expect(h.rebuildAreas).toHaveBeenCalledTimes(1);
    const [, ids] = h.rebuildAreas.mock.calls[0] as unknown as [unknown, string[]];
    expect([...ids].sort()).toEqual(["z-archived", "z-moved", "z-new"]);
    // The live set is active areas with an active camera link.
    expect((f.zone.findMany.mock.calls[0] as unknown as [unknown])[0]).toMatchObject({
      where: { state: "active", links: { some: { state: "active", sourceKind: { in: ["camera", "camera_zone"] } } } },
    });
  });

  it("an area whose rebuild produced no cells (nothing observed yet) is not rebuilt again every minute — until its version moves", async () => {
    const w = world({ liveAreas: [{ id: "z-quiet", version: 1 }] });
    const f = fakePrisma(w);
    await tickSecurityBaselines(f.prisma, ny("15:00"), deps(TZ));
    await tickSecurityBaselines(f.prisma, ny("15:01"), deps(TZ));
    expect(h.rebuildAreas).toHaveBeenCalledTimes(1);
    w.liveAreas = [{ id: "z-quiet", version: 2 }];
    await tickSecurityBaselines(f.prisma, ny("15:02"), deps(TZ));
    expect(h.rebuildAreas).toHaveBeenCalledTimes(2);
  });

  it("only against a FRESH ready build (windowTo ≥ today − 2); an out-of-date one waits for its full build", async () => {
    const f = fakePrisma(
      world({
        ready: { id: "b-1", timezone: TZ, windowFrom: "2026-08-23", windowTo: "2026-09-19", finishedAt: ny("00:11", "2026-09-20") },
        // A catch-up build failed ten minutes ago IN THIS ZONE, so it is still backing off:
        // only the freshness rule can stop the area rebuild here.
        newest: { state: "failed", startedAt: ny("14:50"), error: "x", timezone: TZ },
        liveAreas: [{ id: "z-1", version: 1 }],
      }),
    );
    await tickSecurityBaselines(f.prisma, ny("15:00"), deps(TZ));
    expect(h.runFullBuild).not.toHaveBeenCalled();
    expect(h.rebuildAreas).not.toHaveBeenCalled();
  });

  it("reads one row per built area — never Prisma's in-memory `distinct` over every cell (review #2352, finding 4)", async () => {
    const f = fakePrisma(world({ areaCells: [{ zoneId: "z-1", zoneVersion: 2 }], liveAreas: [{ id: "z-1", version: 2 }] }));
    await tickSecurityBaselines(f.prisma, ny("15:00"), deps(TZ));
    const args = f.cell.findMany.mock.calls.map((c) => (c as unknown as [Record<string, unknown>])[0]);
    expect(args.length).toBeGreaterThan(0);
    for (const a of args) {
      expect(a).not.toHaveProperty("distinct");
      expect(a.where).toMatchObject({ keyKind: "area", label: "person", dayType: "weekday", hour: 0 });
    }
  });

  it("nothing changed → no rebuild", async () => {
    const f = fakePrisma(world({ areaCells: [{ zoneId: "z-1", zoneVersion: 2 }], liveAreas: [{ id: "z-1", version: 2 }] }));
    await tickSecurityBaselines(f.prisma, ny("15:00"), deps(TZ));
    expect(h.rebuildAreas).not.toHaveBeenCalled();
  });
});

describe("area rebuild failures back off and never fail the tick (review #2352, finding 3)", () => {
  it("a failing rebuild: the tick still completes (lastOkAt moves), the failure is noted, the same versions wait an hour", async () => {
    const w = world({ liveAreas: [{ id: "z-1", version: 1 }] });
    const f = fakePrisma(w);
    h.rebuildAreas.mockRejectedValueOnce(new Error("canceling statement due to statement timeout"));
    await expect(tickSecurityBaselines(f.prisma, ny("15:00"), deps(TZ))).resolves.toBeDefined();
    expect(baselineHealthState().lastOkAt).toEqual(ny("15:00"));
    expect(baselineHealthState().lastError).toBeNull();
    expect(baselineHealthState().areaRebuildFailedAt).toEqual(ny("15:00"));
    await tickSecurityBaselines(f.prisma, ny("15:01"), deps(TZ));
    await tickSecurityBaselines(f.prisma, ny("15:59"), deps(TZ));
    expect(h.rebuildAreas).toHaveBeenCalledTimes(1);
    // An hour on, it is tried again; a success clears the note.
    await tickSecurityBaselines(f.prisma, ny("16:01"), deps(TZ));
    expect(h.rebuildAreas).toHaveBeenCalledTimes(2);
    expect(baselineHealthState().areaRebuildFailedAt).toBeNull();
  });

  it("the area's version moving (someone fixed the link) retries at once", async () => {
    const w = world({ liveAreas: [{ id: "z-1", version: 1 }] });
    const f = fakePrisma(w);
    h.rebuildAreas.mockRejectedValueOnce(new Error("boom"));
    await tickSecurityBaselines(f.prisma, ny("15:00"), deps(TZ));
    w.liveAreas = [{ id: "z-1", version: 2 }];
    await tickSecurityBaselines(f.prisma, ny("15:01"), deps(TZ));
    expect(h.rebuildAreas).toHaveBeenCalledTimes(2);
  });
});

describe("tickSecurityBaselines — health bookkeeping", () => {
  it("a throw records lastError IN PLAIN WORDS and rethrows the raw error into safeRun's canary", async () => {
    h.recordCoverage.mockRejectedValueOnce(new Error("db down"));
    const now = ny("15:00");
    await expect(tickSecurityBaselines(fakePrisma(world()).prisma, now, deps(TZ))).rejects.toThrow("db down");
    expect(baselineHealthState()).toMatchObject({ lastOkAt: null, lastError: { at: now, message: "something went wrong" } });
  });

  it("a database error reads as one (review #2352, finding 8) — never its text", async () => {
    h.recordCoverage.mockRejectedValueOnce(
      Object.assign(new Error('Invalid `prisma.securityCoverageSpan.findMany()` invocation: relation "SecurityZone" does not exist'), {
        name: "PrismaClientKnownRequestError",
        code: "P2021",
      }),
    );
    await expect(tickSecurityBaselines(fakePrisma(world()).prisma, ny("15:00"), deps(TZ))).rejects.toThrow();
    expect(baselineHealthState().lastError?.message).toBe("the database couldn't be read");
  });
});

describe("registerSecurityBaselineJobs — one 60 s tick on its own advisory lock; registeredAt is the boot assertion", () => {
  it("schedules exactly one interval with the lock key, and stamps registeredAt", () => {
    const scheduleInterval = vi.fn();
    registerSecurityBaselineJobs({ scheduleInterval }, {} as never);
    expect(scheduleInterval).toHaveBeenCalledTimes(1);
    expect(scheduleInterval.mock.calls[0]![0]).toBe(SECURITY_BASELINE_INTERVAL_MS);
    expect(scheduleInterval.mock.calls[0]![2]).toEqual({ lockKey: SECURITY_BASELINE_LOCK_KEY });
    expect(baselineHealthState().registeredAt).toBeInstanceOf(Date);
  });
});

// ── the patterns health row ──────────────────────────────────────────────

const BANNED = /monitor|armed|\barm\b|alarm|\bsecure\b|protected|guard|\bspaces?\b|\bzones?\b|baseline|suppress/i;
const NOW = ny("14:14");
const running = (over: Partial<BaselineHealthState> = {}): BaselineHealthState => ({
  registeredAt: new Date(NOW.getTime() - 60 * 60_000),
  lastOkAt: new Date(NOW.getTime() - 30_000),
  lastError: null,
  ...over,
});
const db = (over: Partial<PatternsHealthDb> = {}): PatternsHealthDb => ({
  timezone: TZ,
  sources: [
    { camera: "front", state: "active", daysObserved: 20 },
    { camera: "back", state: "active", daysObserved: 18 },
    { camera: "yard", state: "active", daysObserved: 16 },
    { camera: "drive", state: "learning", daysObserved: 9 },
  ],
  ready: { finishedAt: ny("00:11"), windowTo: "2026-09-22" },
  newest: { state: "ready", error: null },
  cameras: ["front", "back", "yard", "drive"],
  openSpanCameras: ["front", "back", "yard", "drive"],
  ...over,
});
const ALL = { visibleCameras: "all" as const };

describe("patternsHealthRow — every state (§6.14)", () => {
  const cases: Array<[string, BaselineHealthState, PatternsHealthDb | null, { visibleCameras: "all" | Set<string> } | null, { state: string; detail: string }]> = [
    ["not registered (the boot assertion)", { registeredAt: null, lastOkAt: null, lastError: null }, db(), ALL, { state: "down", detail: "Not running" }],
    [
      "the last tick failed, after the last ok one (review #2352, finding 8)",
      running({ lastOkAt: new Date(NOW.getTime() - 90_000), lastError: { at: new Date(NOW.getTime() - 30_000), message: "the database couldn't be read" } }),
      db(),
      ALL,
      { state: "down", detail: "Couldn't check which cameras Droplet can hear: the database couldn't be read" },
    ],
    [
      "an older failure, followed by an ok tick, is history",
      running({ lastOkAt: new Date(NOW.getTime() - 30_000), lastError: { at: new Date(NOW.getTime() - 90_000), message: "something went wrong" } }),
      db(),
      ALL,
      { state: "ok", detail: "Knows what normal looks like for 3 cameras; 1 still learning · Trial: pattern flags aren't raised yet" },
    ],
    [
      "registered 4 minutes ago and never ok",
      running({ registeredAt: new Date(NOW.getTime() - 4 * 60_000), lastOkAt: null }),
      db(),
      ALL,
      { state: "down", detail: "Hasn't checked which cameras Droplet can hear since 2:10 PM" },
    ],
    [
      "last ok 5 minutes ago, no zone → minutes",
      running({ lastOkAt: new Date(NOW.getTime() - 5 * 60_000) }),
      db({ timezone: null }),
      ALL,
      { state: "down", detail: "Hasn't checked which cameras Droplet can hear for 5 minutes" },
    ],
    ["the rows couldn't be read", running(), null, ALL, { state: "down", detail: "Couldn't read what normal looks like" }],
    ["no zone", running(), db({ timezone: null }), ALL, { state: "not_configured", detail: "Needs the site's timezone. Set the opening hours to choose it." }],
    ["no visible camera is set up", running(), db(), { visibleCameras: new Set(["porch"]) }, { state: "not_configured", detail: "No cameras are set up yet" }],
    [
      "cameras exist, none confirmed (no source, no open span) — after a tick has run",
      running(),
      db({ sources: [], openSpanCameras: [] }),
      ALL,
      { state: "down", detail: "Can't confirm Droplet is hearing any camera yet" },
    ],
    [
      "cameras exist, none confirmed, and no tick has run yet (the start-up grace)",
      running({ registeredAt: new Date(NOW.getTime() - 60_000), lastOkAt: null }),
      db({ sources: [], openSpanCameras: [] }),
      ALL,
      { state: "quiet", detail: "Checking which cameras Droplet can hear" },
    ],
    [
      "no source row yet, but a camera is being heard (a span is open)",
      running(),
      db({ sources: [], openSpanCameras: ["front"] }),
      ALL,
      { state: "quiet", detail: "Learning what normal looks like — 0 of 14 days" },
    ],
    [
      "a hidden camera's open span is not the viewer's evidence (DS-005)",
      running(),
      db({ sources: [], openSpanCameras: ["back"] }),
      { visibleCameras: new Set(["front"]) },
      { state: "down", detail: "Can't confirm Droplet is hearing any camera yet" },
    ],
    [
      "the newest build failed and there is no ready one",
      running(),
      db({ ready: null, newest: { state: "failed", error: "canceling statement due to statement timeout" } }),
      ALL,
      { state: "down", detail: "Couldn't work out what normal looks like: it took too long" },
    ],
    [
      "the newest build was interrupted and the ready one is out of date",
      running(),
      db({ ready: { finishedAt: ny("00:11", "2026-09-19"), windowTo: "2026-09-18" }, newest: { state: "failed", error: "interrupted" } }),
      ALL,
      { state: "down", detail: "Couldn't work out what normal looks like: it was interrupted" },
    ],
    [
      "out of date with no failure",
      running(),
      db({ ready: { finishedAt: ny("00:11", "2026-09-19"), windowTo: "2026-09-18" } }),
      ALL,
      { state: "down", detail: "What normal looks like is out of date (last worked out Sat)" },
    ],
    [
      "nothing active yet",
      running(),
      db({ sources: [{ camera: "front", state: "learning", daysObserved: 9 }, { camera: "back", state: "learning", daysObserved: 4 }] }),
      ALL,
      { state: "quiet", detail: "Learning what normal looks like — 9 of 14 days" },
    ],
    [
      "every visible camera silent for two days",
      running(),
      db({ sources: [{ camera: "front", state: "stale", daysObserved: 20 }] }),
      ALL,
      { state: "quiet", detail: "No camera has reported for more than 2 days" },
    ],
    [
      "an area rebuild failed within the hour (the area's flags wait for it)",
      running({ areaRebuildFailedAt: new Date(NOW.getTime() - 20 * 60_000) }),
      db(),
      ALL,
      { state: "down", detail: "Couldn't update what's usual after an area's cameras changed; trying again within the hour" },
    ],
    [
      "ok, with the trial note",
      running(),
      db(),
      ALL,
      { state: "ok", detail: "Knows what normal looks like for 3 cameras; 1 still learning · Trial: pattern flags aren't raised yet" },
    ],
    [
      "ok for one visible camera (counts scoped to the viewer)",
      running(),
      db(),
      { visibleCameras: new Set(["front"]) },
      { state: "ok", detail: "Knows what normal looks like for 1 camera · Trial: pattern flags aren't raised yet" },
    ],
  ];

  it.each(cases)("%s", (_label, state, d, scope, want) => {
    const row = patternsHealthRow(state, d, scope, NOW);
    expect(row).toMatchObject({ id: "patterns", ...want });
  });

  it("inside the 3-minute start-up grace a never-ok job is not 'down'", () => {
    const row = patternsHealthRow(running({ registeredAt: new Date(NOW.getTime() - SECURITY_BASELINE_GRACE_MS + 1_000), lastOkAt: null }), db(), ALL, NOW);
    expect(row.state).toBe("ok");
  });

  it("the learning count never shows a hidden camera's days", () => {
    const row = patternsHealthRow(
      running(),
      db({ sources: [{ camera: "front", state: "learning", daysObserved: 3 }, { camera: "hidden", state: "learning", daysObserved: 12 }] }),
      { visibleCameras: new Set(["front"]) },
      NOW,
    );
    expect(row.detail).toBe("Learning what normal looks like — 3 of 14 days");
  });

  it("lastSeenAt is the ready build's finish", () => {
    expect(patternsHealthRow(running(), db(), ALL, NOW).lastSeenAt).toBe(ny("00:11").toISOString());
    expect(patternsHealthRow(running(), db({ ready: null }), ALL, NOW).lastSeenAt).toBeNull();
  });

  it("no detail the dashboard shows verbatim says monitor/arm/alarm/secure/protected/guard/space/zone, or 'baseline'/'suppression'", () => {
    const details = cases.map(([, s, d, scope]) => patternsHealthRow(s, d, scope, NOW).detail);
    for (const d of details) expect(d, d).not.toMatch(BANNED);
    // A raw database message never reaches the row.
    const raw = patternsHealthRow(running(), db({ ready: null, newest: { state: "failed", error: 'relation "SecurityZone" does not exist' } }), ALL, NOW);
    expect(raw.detail).toBe("Couldn't work out what normal looks like: something went wrong");
  });
});

describe("patternsHealthRow — the incident engine's pattern evaluation (WARP-2980 PR-B, spec D23)", () => {
  const failing = { lastOkAt: new Date(NOW.getTime() - 60_000), lastError: { at: NOW, message: "the database couldn't be read" } };
  const fine = { lastOkAt: NOW, lastError: null };

  it("the latest evaluation failed: down, in plain words, for a viewer who sees every camera", () => {
    const row = patternsHealthRow(running(), db(), ALL, NOW, failing);
    expect(row).toMatchObject({ state: "down", detail: "Couldn't compare new events with what's usual: the database couldn't be read" });
    expect(row.detail).not.toMatch(BANNED);
    expect(patternsHealthRow(running(), db(), ALL, NOW, { ...failing, lastError: { at: NOW, message: "something went wrong" } }).detail).toBe(
      "Couldn't compare new events with what's usual: something went wrong",
    );
  });

  it("cleared by the next evaluation that completes: the ok row keeps its trial note", () => {
    expect(patternsHealthRow(running(), db(), ALL, NOW, fine)).toMatchObject({
      state: "ok",
      detail: "Knows what normal looks like for 3 cameras; 1 still learning · Trial: pattern flags aren't raised yet",
    });
  });

  it("DS-005 (review item 15): a camera-limited viewer never sees it — its timing would reveal a detection on a hidden camera", () => {
    expect(patternsHealthRow(running(), db(), { visibleCameras: new Set(["front"]) }, NOW, failing)).toMatchObject({
      state: "ok",
      detail: "Knows what normal looks like for 1 camera · Trial: pattern flags aren't raised yet",
    });
  });

  it("comes after the area-rebuild check, and after the out-of-date build (which already pauses the rules)", () => {
    expect(patternsHealthRow(running({ areaRebuildFailedAt: new Date(NOW.getTime() - 60_000) }), db(), ALL, NOW, failing).detail).toBe(
      "Couldn't update what's usual after an area's cameras changed; trying again within the hour",
    );
    expect(
      patternsHealthRow(running(), db({ ready: { finishedAt: ny("00:11", "2026-09-19"), windowTo: "2026-09-18" } }), ALL, NOW, failing).detail,
    ).toBe("What normal looks like is out of date (last worked out Sat)");
  });
});

describe("securityPatternsHealth — reads, scopes, never throws", () => {
  it("a read failure is a down row, not a 503", async () => {
    const prisma = {
      securitySiteHours: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
      workspace: { findUnique: vi.fn() },
      securityBaselineSource: { findMany: vi.fn() },
      securityBaselineBuild: { findFirst: vi.fn() },
      // Every delegate the loader reads: a missing one throws while the reads are
      // being started, and the started ones then reject with nobody listening.
      camera: { findMany: vi.fn() },
      securityCoverageSpan: { findMany: vi.fn() },
    } as never;
    registerSecurityBaselineJobs({ scheduleInterval: vi.fn() }, {} as never);
    const row = await securityPatternsHealth(prisma, { visibleCameras: "all", mayReadThreats: true }, new Date());
    expect(row).toMatchObject({ id: "patterns", state: "down" });
  });

  it("no scope (the viewer's grants couldn't be read) → down, never counted as 'all'", async () => {
    registerSecurityBaselineJobs({ scheduleInterval: vi.fn() }, {} as never);
    const row = await securityPatternsHealth({} as never, null, new Date());
    expect(row).toMatchObject({ id: "patterns", state: "down", detail: "Couldn't read what normal looks like" });
  });
});
