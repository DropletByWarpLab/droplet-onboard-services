/**
 * WARP-2980 (ADR-059 P5 §6.3, §6.6) — coverage, mocked lane.
 *
 * Coverage is the one baseline input that cannot be rebuilt later: the MQTT
 * client uses a clean session, so a day with no rows can mean "nobody came"
 * or "Droplet wasn't listening". These pins are what keeps the two apart:
 *   · observingCameras — each of the four conditions alone stops a camera;
 *   · planCoverage — a span is extended only by the process that opened it
 *     and only while NOTHING changed since its last confirmation (a health
 *     change, a reconnect, a failed write); a new span never overlaps the
 *     camera's last one;
 *   · recordCoverage — the boot close comes first, closes before opens, and
 *     a lost race on the one-open-span index is not an error;
 *   · sourceStates — ≥ 1200 observed minutes make a day; stale after 48 h.
 * What only Postgres can prove (the partial unique index, the CHECKs, a real
 * restart) is in security-coverage.pg.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  observingCameras,
  parseFrigateStats,
  planCoverage,
  recordCoverage,
  refreshBaselineSources,
  sourceStates,
  withStatsSeeds,
  type CoverageObservation,
  type CoverageReading,
  type FrigateStatsView,
  type OpenCoverageSpan,
} from "./security-coverage.js";

const PID = "0b9f3c3e-7d0a-4b5e-9d64-1f2a3b4c5d6e";
const OTHER = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const NOW = new Date("2026-09-23T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const online = (since: Date, at: Date = ago(5_000)): CoverageReading => ({ health: "online", at, since });

function obs(over: {
  subscribed?: boolean;
  subscribedAt?: Date | null;
  lastRecordedAt?: Date | null;
  writeError?: Date | null;
  frigate?: CoverageReading | null;
  cameras?: Record<string, CoverageReading>;
  /** Frigate's /api/stats. Default: every camera above streaming; null = stats unavailable. */
  stats?: FrigateStatsView | null;
} = {}): CoverageObservation {
  const readings = new Map<string | null, CoverageReading>();
  const frigate = over.frigate === undefined ? online(ago(60 * MIN)) : over.frigate;
  if (frigate) readings.set(null, frigate);
  const cameras = over.cameras ?? { front: online(ago(60 * MIN)) };
  for (const [name, r] of Object.entries(cameras)) readings.set(name, r);
  return {
    ingest: {
      frigateSubscribed: over.subscribed ?? true,
      frigateSubscribedAt: over.subscribedAt === undefined ? ago(90 * MIN) : over.subscribedAt,
      lastRecordedAt: over.lastRecordedAt === undefined ? ago(2 * MIN) : over.lastRecordedAt,
      lastWriteError: over.writeError ? { at: over.writeError } : null,
    },
    readings,
    stats: over.stats === undefined ? statsOf(Object.keys(cameras)) : over.stats,
  };
}

/** Stats in which every named camera streams at 5 fps with detection on. */
function statsOf(live: string[], at: Date = ago(10_000), extra: Record<string, { fps: number; detectionEnabled: boolean | null }> = {}): FrigateStatsView {
  const cameras = new Map(live.map((n) => [n, { fps: 5, detectionEnabled: true as boolean | null }]));
  for (const [n, s] of Object.entries(extra)) cameras.set(n, s);
  return { at, cameras };
}

const span = (over: Partial<OpenCoverageSpan> = {}): OpenCoverageSpan => ({
  id: 1n,
  camera: "front",
  startedAt: ago(30 * MIN),
  coveredUntil: ago(MIN),
  processId: PID,
  ...over,
});

describe("observingCameras — all four conditions, each on its own", () => {
  it("everything fine → the camera is observed, from the latest of its own, Frigate's and the subscription's start", () => {
    const o = obs({ subscribedAt: ago(90 * MIN), frigate: online(ago(70 * MIN)), cameras: { front: online(ago(60 * MIN)) } });
    expect(observingCameras(o)).toEqual(new Map([["front", ago(60 * MIN)]]));
    const later = obs({ subscribedAt: ago(10 * MIN), frigate: online(ago(70 * MIN)), cameras: { front: online(ago(60 * MIN)) } });
    expect(observingCameras(later).get("front")).toEqual(ago(10 * MIN));
  });

  it.each([
    ["the ingest is not subscribed", obs({ subscribed: false })],
    ["the subscription has no time (never acknowledged)", obs({ subscribedAt: null })],
    ["Frigate itself has not reported", obs({ frigate: null })],
    ["Frigate itself is offline", obs({ frigate: { health: "offline", at: ago(MIN), since: ago(MIN) } })],
    ["the camera's detect stream is offline", obs({ cameras: { front: { health: "offline", at: ago(MIN), since: ago(10 * MIN) } } })],
    ["the camera's detection is disabled", obs({ cameras: { front: { health: "disabled", at: ago(MIN), since: ago(10 * MIN) } } })],
    ["the last write failed and nothing has been saved since", obs({ writeError: ago(MIN), lastRecordedAt: ago(5 * MIN) })],
    ["a write failed and nothing was ever saved", obs({ writeError: ago(MIN), lastRecordedAt: null })],
  ])("%s → nothing is observed", (_label, o) => {
    expect(observingCameras(o).size).toBe(0);
  });

  it("a write error OLDER than the last saved row does not stop observation (it did stop the span that saw it)", () => {
    const o = obs({ writeError: ago(20 * MIN), lastRecordedAt: ago(2 * MIN), cameras: { front: online(ago(60 * MIN)) } });
    // Observed again — but only from after the failure.
    expect(observingCameras(o).get("front")).toEqual(ago(20 * MIN));
  });

  it("a camera name the span CHECK would refuse is never observed", () => {
    const o = obs({ cameras: { "bad name": online(ago(60 * MIN)), front: online(ago(60 * MIN)) } });
    expect([...observingCameras(o).keys()]).toEqual(["front"]);
  });
});

describe("planCoverage — extend only what provably continued", () => {
  it("nothing changed since the last confirmation → extend (a repeated reading moves `at`, not `since`)", () => {
    const o = obs({ cameras: { front: online(ago(60 * MIN), ago(3_000)) } });
    expect(planCoverage([span()], o, PID, NOW)).toEqual({ extend: [1n], close: [], open: [] });
  });

  it("the camera's health changed since → close; and it is observing again → a new span from the change", () => {
    const o = obs({ cameras: { front: online(ago(30_000)) } });
    expect(planCoverage([span()], o, PID, NOW)).toEqual({ extend: [], close: [1n], open: [{ camera: "front", startedAt: ago(30_000) }] });
  });

  it("Frigate's own health changed since → close", () => {
    const o = obs({ frigate: online(ago(20_000)) });
    expect(planCoverage([span()], o, PID, NOW)).toMatchObject({ extend: [], close: [1n] });
  });

  it("a reconnect since (frigateSubscribedAt moved; the retained replay moved nothing else) → close, and reopen from the reconnect", () => {
    const o = obs({ subscribedAt: ago(10_000) });
    expect(planCoverage([span()], o, PID, NOW)).toEqual({ extend: [], close: [1n], open: [{ camera: "front", startedAt: ago(10_000) }] });
  });

  it("a write failed since — even though a later one succeeded — → close: an event may have been lost", () => {
    const o = obs({ writeError: ago(40_000), lastRecordedAt: ago(10_000) });
    expect(planCoverage([span()], o, PID, NOW)).toEqual({ extend: [], close: [1n], open: [{ camera: "front", startedAt: ago(40_000) }] });
  });

  it("another process's span → close, and open this process's own (the boot rule)", () => {
    const o = obs();
    const plan = planCoverage([span({ processId: OTHER })], o, PID, NOW);
    expect(plan.extend).toEqual([]);
    expect(plan.close).toEqual([1n]);
    // Never earlier than the old span's last confirmation: no minute counted twice.
    expect(plan.open).toEqual([{ camera: "front", startedAt: ago(MIN) }]);
  });

  it("disabled → close, and no new span", () => {
    const o = obs({ cameras: { front: { health: "disabled", at: ago(5_000), since: ago(5_000) } } });
    expect(planCoverage([span()], o, PID, NOW)).toEqual({ extend: [], close: [1n], open: [] });
  });

  it("a camera no longer reporting at all → close", () => {
    const o = obs({ cameras: { back: online(ago(60 * MIN)) } });
    const plan = planCoverage([span()], o, PID, NOW);
    expect(plan.close).toEqual([1n]);
    expect(plan.open).toEqual([{ camera: "back", startedAt: ago(60 * MIN) }]);
  });

  it("the lastClosed clamp: a new span never starts before the camera's last one ended", () => {
    const o = obs({ cameras: { front: online(ago(60 * MIN)) } });
    const last = new Map([["front", ago(5 * MIN)]]);
    expect(planCoverage([], o, PID, NOW, last).open).toEqual([{ camera: "front", startedAt: ago(5 * MIN) }]);
    // Without a later closed span, it starts at the proof.
    expect(planCoverage([], o, PID, NOW).open).toEqual([{ camera: "front", startedAt: ago(60 * MIN) }]);
  });

  it("never claims time after now", () => {
    const o = obs({ cameras: { front: online(ago(60 * MIN)) } });
    const last = new Map([["front", new Date(NOW.getTime() + MIN)]]);
    expect(planCoverage([], o, PID, NOW, last).open).toEqual([{ camera: "front", startedAt: NOW }]);
  });

  it("nothing observed at all (Frigate down) → every open span closes", () => {
    const o = obs({ frigate: { health: "offline", at: ago(MIN), since: ago(MIN) } });
    const plan = planCoverage([span(), span({ id: 2n, camera: "back" })], o, PID, NOW);
    expect(plan).toEqual({ extend: [], close: [1n, 2n], open: [] });
  });
});

describe("Frigate's /api/stats — coverage does not rest on an MQTT retain nobody verified (review #2352, finding 2)", () => {
  const T = ago(10_000);
  const tracker = (entries: Array<[string | null, CoverageReading]>) => new Map<string | null, CoverageReading>(entries);
  const ingest = { frigateSubscribed: true, frigateSubscribedAt: ago(90 * MIN), lastRecordedAt: ago(2 * MIN), lastWriteError: null };

  it("parseFrigateStats reads `cameras`: fps as a number, detection_enabled when present, names Frigate could send only", () => {
    const view = parseFrigateStats(
      {
        cameras: {
          front: { camera_fps: 5.1, detection_enabled: true },
          back: { camera_fps: "0", detection_enabled: false },
          yard: { camera_fps: 4 },
          "bad name": { camera_fps: 5 },
        },
        detectors: {},
      },
      T,
    );
    expect(view.at).toEqual(T);
    expect([...view.cameras]).toEqual([
      ["front", { fps: 5.1, detectionEnabled: true }],
      ["back", { fps: 0, detectionEnabled: false }],
      ["yard", { fps: 4, detectionEnabled: null }],
    ]);
    expect(parseFrigateStats({}, T).cameras.size).toBe(0);
    expect(() => parseFrigateStats(null, T)).toThrow();
  });

  it("an orchestrator restart with Frigate up and NO status message: Frigate and every streaming camera are seeded from stats", () => {
    const seeds = new Map<string | null, Date>();
    const r = withStatsSeeds(tracker([]), statsOf(["front", "back"], T), seeds);
    expect(r.readings.get(null)).toEqual({ health: "online", at: T, since: T });
    expect(r.readings.get("front")).toEqual({ health: "online", at: T, since: T });
    const o: CoverageObservation = { ingest, readings: r.readings, stats: statsOf(["front", "back"], T) };
    expect([...observingCameras(o).keys()].sort()).toEqual(["back", "front"]);
    // From the stats read: the latest proof (the subscription is older).
    expect(planCoverage([], o, PID, NOW).open).toEqual([
      { camera: "front", startedAt: T },
      { camera: "back", startedAt: T },
    ]);
  });

  it("a seed keeps its `since` across ticks, so the seeded span extends instead of restarting every minute", () => {
    const first = withStatsSeeds(tracker([]), statsOf(["front"], ago(2 * MIN)), new Map());
    const second = withStatsSeeds(tracker([]), statsOf(["front"], ago(MIN)), first.seeds);
    expect(second.readings.get("front")!.since).toEqual(ago(2 * MIN));
    const o: CoverageObservation = { ingest: { ...ingest, frigateSubscribedAt: ago(3 * MIN) }, readings: second.readings, stats: statsOf(["front"], ago(MIN)) };
    expect(planCoverage([span({ startedAt: ago(2 * MIN), coveredUntil: ago(MIN) })], o, PID, NOW)).toEqual({ extend: [1n], close: [], open: [] });
  });

  it("a real tracker reading wins over a seed (and replaces it)", () => {
    const seeded = withStatsSeeds(tracker([]), statsOf(["front"], ago(5 * MIN)), new Map());
    const offline: CoverageReading = { health: "offline", at: ago(MIN), since: ago(MIN) };
    const r = withStatsSeeds(tracker([["front", offline]]), statsOf(["front"], ago(MIN)), seeded.seeds);
    expect(r.readings.get("front")).toEqual(offline);
    expect(r.seeds.has("front")).toBe(false);
  });

  it("a ghost — the tracker still says online, but the camera is ABSENT from stats — is not observing, and its span closes", () => {
    const o = obs({ cameras: { front: online(ago(60 * MIN)), gone: online(ago(60 * MIN)) }, stats: statsOf(["front"]) });
    expect([...observingCameras(o).keys()]).toEqual(["front"]);
    expect(planCoverage([span({ camera: "gone" })], o, PID, NOW).close).toEqual([1n]);
  });

  it("a camera at 0 fps, or with detection turned off in Frigate, is not observing whatever the tracker says", () => {
    const o = obs({
      cameras: { front: online(ago(60 * MIN)), dark: online(ago(60 * MIN)), off: online(ago(60 * MIN)) },
      stats: statsOf(["front"], ago(10_000), { dark: { fps: 0, detectionEnabled: true }, off: { fps: 5, detectionEnabled: false } }),
    });
    expect([...observingCameras(o).keys()]).toEqual(["front"]);
    // …and neither is seeded.
    const r = withStatsSeeds(tracker([]), statsOf([], T, { dark: { fps: 0, detectionEnabled: true }, off: { fps: 5, detectionEnabled: false } }), new Map());
    expect(r.readings.has("dark")).toBe(false);
    expect(r.readings.has("off")).toBe(false);
  });

  it("a stats outage: nothing is seeded (seeds are forgotten), no NEW span opens, a span continues only while the tracker says online", () => {
    const seeds = new Map<string | null, Date>([[null, ago(30 * MIN)], ["seeded", ago(30 * MIN)]]);
    const r = withStatsSeeds(tracker([[null, online(ago(60 * MIN))], ["front", online(ago(60 * MIN))], ["fresh", online(ago(60 * MIN))]]), null, seeds);
    expect(r.seeds.size).toBe(0);
    expect(r.readings.has("seeded")).toBe(false);
    const o: CoverageObservation = { ingest, readings: r.readings, stats: null };
    const plan = planCoverage([span({ id: 1n, camera: "front" }), span({ id: 2n, camera: "seeded" })], o, PID, NOW);
    expect(plan.extend).toEqual([1n]);
    expect(plan.close).toEqual([2n]);
    // "fresh" is online in the tracker but has no span: without stats it may be a ghost — nothing opens.
    expect(plan.open).toEqual([]);
  });

  it("after an outage the seed restarts at the new stats read, so a span never claims the outage", () => {
    const outage = withStatsSeeds(tracker([]), null, new Map([["front", ago(60 * MIN)]]));
    const back = withStatsSeeds(tracker([]), statsOf(["front"], ago(MIN)), outage.seeds);
    expect(back.readings.get("front")!.since).toEqual(ago(MIN));
  });
});

describe("recordCoverage — the writes, in order", () => {
  function fakeSpans(open: OpenCoverageSpan[], lastClosed: Record<string, Date> = {}) {
    const log: string[] = [];
    const delegate = {
      updateMany: vi.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        log.push(`updateMany ${JSON.stringify(a.where, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))}`);
        return { count: 1 };
      }),
      findMany: vi.fn(async () => {
        log.push("findMany");
        return open;
      }),
      findFirst: vi.fn(async (a: { where: { camera: string } }) => {
        log.push(`findFirst ${a.where.camera}`);
        const at = lastClosed[a.where.camera];
        return at ? { coveredUntil: at } : null;
      }),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        log.push(`create ${String(a.data.camera)}`);
        return a.data;
      }),
    };
    return { prisma: { securityCoverageSpan: delegate } as never, delegate, log };
  }

  it("the first tick of a process closes every other process's open span BEFORE reading the open ones", async () => {
    const { prisma, delegate, log } = fakeSpans([]);
    await recordCoverage(prisma, obs(), PID, NOW, { bootClose: true });
    expect(log[0]).toBe(`updateMany {"state":"open","processId":{"not":"${PID}"}}`);
    expect(delegate.updateMany.mock.calls[0]![0].data).toEqual({ state: "closed", closedAt: NOW });
    expect(log[1]).toBe("findMany");
  });

  it("later ticks do not repeat the boot close", async () => {
    const { prisma, log } = fakeSpans([span()]);
    await recordCoverage(prisma, obs(), PID, NOW, { bootClose: false });
    expect(log[0]).toBe("findMany");
  });

  it("extends by id, still open, only for this process, and never backwards in time", async () => {
    const { prisma, delegate } = fakeSpans([span()]);
    const r = await recordCoverage(prisma, obs(), PID, NOW, { bootClose: false });
    expect(r).toEqual({ extended: 1, closed: 0, opened: 0 });
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: { id: 1n, state: "open", processId: PID, coveredUntil: { lt: NOW } },
      data: { coveredUntil: NOW },
    });
  });

  it("closes before it opens (one open span per camera), clamped to the camera's last closed span", async () => {
    const { prisma, delegate, log } = fakeSpans([span({ processId: OTHER })], { front: ago(2 * MIN) });
    const r = await recordCoverage(prisma, obs(), PID, NOW, { bootClose: false });
    expect(r).toEqual({ extended: 0, closed: 1, opened: 1 });
    const closeAt = log.findIndex((l) => l.startsWith('updateMany {"id":"1n","state":"open"}'));
    const openAt = log.indexOf("create front");
    expect(closeAt).toBeGreaterThan(-1);
    expect(openAt).toBeGreaterThan(closeAt);
    expect(delegate.create).toHaveBeenCalledWith({
      data: { camera: "front", state: "open", startedAt: ago(MIN), coveredUntil: NOW, processId: PID },
    });
  });

  it("a lost race on the one-open-span index (P2002) is not an error: another process holds the camera", async () => {
    const { prisma, delegate } = fakeSpans([]);
    delegate.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(recordCoverage(prisma, obs(), PID, NOW, { bootClose: false })).resolves.toEqual({ extended: 0, closed: 0, opened: 0 });
  });

  it("any other write failure throws (safeRun's canary)", async () => {
    const { prisma, delegate } = fakeSpans([]);
    delegate.create.mockRejectedValueOnce(new Error("db down"));
    await expect(recordCoverage(prisma, obs(), PID, NOW, { bootClose: false })).rejects.toThrow("db down");
  });
});

describe("sourceStates — the learning state per camera (§6.6)", () => {
  const TZ = "America/New_York";
  const WINDOW = { from: "2026-08-26", to: "2026-09-22" };
  // Local midnight of a window date in New York (EDT, UTC−4).
  const day = (ymd: string, hourFrom: number, hourTo: number) => ({
    camera: "front",
    startedAt: new Date(`${ymd}T${String(hourFrom + 4).padStart(2, "0")}:00:00Z`),
    coveredUntil: new Date(new Date(`${ymd}T04:00:00Z`).getTime() + hourTo * 3_600_000),
  });
  const now = new Date("2026-09-23T12:00:00Z");

  it("a date counts at ≥ 1200 observed minutes, and not at 1199", () => {
    const spans = [
      day("2026-09-01", 0, 20), // exactly 1200 min
      { camera: "front", startedAt: new Date("2026-09-02T04:00:00Z"), coveredUntil: new Date("2026-09-03T00:59:00Z") }, // 1259 min
      { camera: "front", startedAt: new Date("2026-09-03T04:00:00Z"), coveredUntil: new Date("2026-09-03T23:59:00Z") }, // 1199 min
    ];
    const s = sourceStates(spans, WINDOW, TZ, new Date("2026-09-03T23:59:00Z")).get("front")!;
    expect(s.daysObserved).toBe(2);
  });

  it("pieces of one date add up; a span across midnight counts on both dates", () => {
    const spans = [
      { camera: "front", startedAt: new Date("2026-09-05T04:00:00Z"), coveredUntil: new Date("2026-09-05T14:00:00Z") }, // 10 h
      { camera: "front", startedAt: new Date("2026-09-05T15:00:00Z"), coveredUntil: new Date("2026-09-06T14:00:00Z") }, // 13 h on the 5th, 10 h on the 6th
    ];
    const s = sourceStates(spans, WINDOW, TZ, now).get("front")!;
    expect(s.daysObserved).toBe(1);
  });

  it("a 23-hour spring-forward day qualifies at 20 hours, like any other", () => {
    const spans = [{ camera: "front", startedAt: new Date("2026-03-08T05:00:00Z"), coveredUntil: new Date("2026-03-09T01:00:00Z") }];
    const s = sourceStates(spans, { from: "2026-02-10", to: "2026-03-09" }, TZ, new Date("2026-03-09T02:00:00Z")).get("front")!;
    expect(s.daysObserved).toBe(1);
  });

  it("learning below 14 days, active at 14, stale after 48 h unobserved — whatever the day count", () => {
    const days = (n: number) => Array.from({ length: n }, (_x, i) => day(`2026-09-${String(8 + i).padStart(2, "0")}`, 0, 24));
    const learning = sourceStates(days(13), WINDOW, TZ, new Date("2026-09-21T12:00:00Z")).get("front")!;
    expect(learning).toMatchObject({ daysObserved: 13, state: "learning" });
    const active = sourceStates(days(14), WINDOW, TZ, new Date("2026-09-22T12:00:00Z")).get("front")!;
    expect(active).toMatchObject({ daysObserved: 14, state: "active" });
    // Last seen 2026-09-22T04:00Z; 48 h later is 2026-09-24T04:00Z.
    expect(sourceStates(days(14), WINDOW, TZ, new Date("2026-09-24T04:00:00Z")).get("front")!.state).toBe("active");
    expect(sourceStates(days(14), WINDOW, TZ, new Date("2026-09-24T04:00:01Z")).get("front")!.state).toBe("stale");
  });

  it("firstSeenAt is the earliest start, lastSeenAt the latest confirmation; one row per camera", () => {
    const spans = [
      { camera: "front", startedAt: ago(3 * 3_600_000), coveredUntil: ago(2 * 3_600_000) },
      { camera: "front", startedAt: ago(90 * MIN), coveredUntil: ago(MIN) },
      { camera: "back", startedAt: ago(10 * MIN), coveredUntil: ago(MIN) },
    ];
    const m = sourceStates(spans, WINDOW, TZ, NOW);
    expect([...m.keys()].sort()).toEqual(["back", "front"]);
    expect(m.get("front")).toMatchObject({ firstSeenAt: ago(3 * 3_600_000), lastSeenAt: ago(MIN), state: "learning", daysObserved: 0 });
  });
});

describe("refreshBaselineSources — writes the learning state, keeps firstSeenAt, drops cameras gone 35 days", () => {
  it("creates new rows, updates changed ones (stateChangedAt only on a change), and deletes the rest", async () => {
    const spans = [
      { camera: "front", startedAt: ago(90 * MIN), coveredUntil: ago(MIN) },
      { camera: "back", startedAt: ago(30 * MIN), coveredUntil: ago(MIN) },
    ];
    const existing = [
      {
        sourceKey: "camera:front",
        camera: "front",
        state: "learning",
        daysObserved: 0,
        firstSeenAt: ago(10 * 86_400_000),
        lastSeenAt: ago(2 * MIN),
        stateChangedAt: ago(10 * 86_400_000),
      },
      { sourceKey: "camera:gone", camera: "gone", state: "stale", daysObserved: 0, firstSeenAt: ago(40 * 86_400_000), lastSeenAt: ago(36 * 86_400_000), stateChangedAt: ago(34 * 86_400_000) },
    ];
    const src = {
      findMany: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const cov = { findMany: vi.fn().mockResolvedValue(spans) };
    const prisma = { securityBaselineSource: src, securityCoverageSpan: cov } as never;
    const r = await refreshBaselineSources(prisma, "America/New_York", NOW);
    expect(r).toEqual({ cameras: 2, created: 1, updated: 1, deleted: 1 });
    expect(cov.findMany.mock.calls[0]![0].where).toEqual({ coveredUntil: { gte: ago(35 * 86_400_000) } });
    expect(src.update).toHaveBeenCalledWith({
      where: { sourceKey: "camera:front" },
      data: { state: "learning", daysObserved: 0, firstSeenAt: ago(10 * 86_400_000), lastSeenAt: ago(MIN), stateChangedAt: ago(10 * 86_400_000) },
    });
    expect(src.create).toHaveBeenCalledWith({
      data: { sourceKey: "camera:back", camera: "back", state: "learning", daysObserved: 0, firstSeenAt: ago(30 * MIN), lastSeenAt: ago(MIN), stateChangedAt: NOW },
    });
    expect(src.deleteMany).toHaveBeenCalledWith({ where: { sourceKey: { notIn: ["camera:front", "camera:back"] } } });
  });

  it("a source row another tick created first (P2002 — a tick that outlived its lock) is not an error (review #2352, finding 5)", async () => {
    const spans = [{ camera: "front", startedAt: ago(90 * MIN), coveredUntil: ago(MIN) }];
    const src = {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" })),
      update: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const prisma = { securityBaselineSource: src, securityCoverageSpan: { findMany: vi.fn().mockResolvedValue(spans) } } as never;
    await expect(refreshBaselineSources(prisma, "America/New_York", NOW)).resolves.toMatchObject({ created: 0 });
    src.create.mockRejectedValue(new Error("db down"));
    await expect(refreshBaselineSources(prisma, "America/New_York", NOW)).rejects.toThrow("db down");
  });

  it("a state change stamps stateChangedAt", async () => {
    const spans = [{ camera: "front", startedAt: ago(50 * 3_600_000), coveredUntil: ago(49 * 3_600_000) }];
    const src = {
      findMany: vi.fn().mockResolvedValue([
        { sourceKey: "camera:front", camera: "front", state: "learning", daysObserved: 0, firstSeenAt: ago(90 * MIN), lastSeenAt: ago(49 * 3_600_000), stateChangedAt: ago(86_400_000) },
      ]),
      create: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    const prisma = { securityBaselineSource: src, securityCoverageSpan: { findMany: vi.fn().mockResolvedValue(spans) } } as never;
    await refreshBaselineSources(prisma, "America/New_York", NOW);
    expect(src.update.mock.calls[0]![0].data).toMatchObject({ state: "stale", stateChangedAt: NOW });
  });
});
