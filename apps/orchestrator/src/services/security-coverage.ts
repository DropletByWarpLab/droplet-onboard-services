/**
 * WARP-2980 (ADR-059 P5, spec §6.3, §6.6) — coverage: when Droplet could
 * PROVE it was listening to each camera, recorded as it happens, and the
 * learning state per camera derived from it.
 *
 * Why it exists: the camera MQTT client uses a clean session
 * (camera.service.ts), so events that happen while the orchestrator is down
 * or disconnected are lost and leave no row. A day with no rows can mean
 * "nobody came" or "Droplet wasn't listening"; the only way to tell them
 * apart is to record the listening itself. It is the one baseline input that
 * cannot be rebuilt later — history before this shipped counts as
 * unobserved (D6).
 *
 * A camera is OBSERVING at tick time when (`observingCameras`):
 *   1. the ingest is subscribed (`frigateSubscribed`, with a SUBACK time);
 *   2. Frigate itself reads `online`;
 *   3. the camera's detect stream reads `online`;
 *   4. no write has failed since the last one that succeeded (a failing
 *      write means events are being dropped — security-events.service.ts's
 *      own `failing` test).
 *
 * A span is EXTENDED only when, in addition, nothing changed since it was
 * last confirmed (`planCoverage`): it belongs to THIS process; no reconnect
 * (`frigateSubscribedAt`), no change of Frigate's or the camera's health
 * (`since`, not `at`: a repeated reading is not a change), and no failed
 * write since its `coveredUntil` — even one a later write followed, because
 * an event may have been lost. Everything else closes at its last
 * confirmation: a span never claims time it did not see. A new span starts
 * at the latest of those proofs and never before the camera's last span
 * ended, so one camera's spans never overlap and the build's overlap sums
 * never count a minute twice. Continuity is "nothing changed since
 * coveredUntil", not tick spacing: a slow or skipped tick needs no case.
 *
 * The first tick of a process closes every span another process left open:
 * nobody can prove the old process kept listening until it died.
 *
 * FRIGATE'S /api/stats (review #2352). The tracker only knows a camera once
 * `frigate/<cam>/status/detect` arrives, and whether Frigate retains that
 * topic is not verified. Not retained: every orchestrator restart with
 * Frigate up would leave live cameras unheard (no span) for as long as their
 * status never changes. Retained: a removed or renamed camera would keep a
 * ghost `online` forever. So each tick also reads Frigate's stats:
 *   · a camera streaming (`camera_fps > 0`, detection not turned off) with
 *     no tracker reading is SEEDED online, `since` = the first stats read
 *     that saw it — kept across ticks, forgotten the moment it stops
 *     streaming or stats go unanswered. Frigate itself is seeded the same way
 *     when the tracker has no `frigate/available` reading. A real tracker
 *     reading always wins, and replaces the seed;
 *   · when stats answered, a camera absent from them, at 0 fps, or with
 *     detection off is NOT observing, whatever the tracker says (the ghost);
 *   · when stats did not answer, nothing is seeded, no new span opens (a
 *     tracker `online` may be a ghost), and an open span continues only while
 *     the tracker itself says online and nothing changed — a seed-only span
 *     closes at its last confirmation. The next seed starts at the next
 *     stats read, so no span ever claims the outage.
 */
import type { PrismaClient, SecurityBaselineState } from "@prisma/client";
import { FRIGATE_NAME, type SourceHealth } from "./security-event-ingest.js";
import { BASELINE } from "../lib/security-baseline-math.js";
import { dayBounds, windowDates, windowFor, type BaselineWindow } from "../lib/security-baseline-slots.js";

/** Coverage spans are kept this long (the window plus a week); sources without a span this recent are dropped. */
export const COVERAGE_KEEP_MS = 35 * 86_400_000;

/** One tracker reading (security-events.service.ts `TrackedHealth`). */
export interface CoverageReading {
  health: SourceHealth;
  at: Date;
  /** When the health last changed. */
  since: Date;
}

/** The ingest facts coverage reads (security-events.service.ts `securityIngestHealthState()`). */
export interface CoverageIngest {
  frigateSubscribed: boolean;
  frigateSubscribedAt: Date | null;
  lastRecordedAt: Date | null;
  lastWriteError: { at: Date } | null;
}

/** One camera in Frigate's /api/stats. */
export interface FrigateCameraStat {
  fps: number;
  /** `detection_enabled`, when this Frigate reports it; null when it does not. */
  detectionEnabled: boolean | null;
}

/** Frigate's /api/stats as coverage reads it, and when it was read. */
export interface FrigateStatsView {
  at: Date;
  cameras: ReadonlyMap<string, FrigateCameraStat>;
}

/** What one tick sees: the ingest state, every reading (null key = Frigate itself), and Frigate's stats. */
export interface CoverageObservation {
  ingest: CoverageIngest;
  readings: ReadonlyMap<string | null, CoverageReading>;
  /** null = Frigate's stats did not answer this tick. */
  stats: FrigateStatsView | null;
}

/** Throws when the body is not an object (the caller treats that as "stats did not answer"). */
export function parseFrigateStats(raw: unknown, at: Date): FrigateStatsView {
  if (raw === null || typeof raw !== "object") throw new TypeError("Frigate stats: not an object");
  const map = (raw as { cameras?: unknown }).cameras;
  const cameras = new Map<string, FrigateCameraStat>();
  if (map && typeof map === "object") {
    for (const [name, s] of Object.entries(map as Record<string, unknown>)) {
      if (!FRIGATE_NAME.test(name) || !s || typeof s !== "object") continue;
      const fps = Number((s as { camera_fps?: unknown }).camera_fps ?? 0);
      const de = (s as { detection_enabled?: unknown }).detection_enabled;
      cameras.set(name, { fps: Number.isFinite(fps) ? fps : 0, detectionEnabled: typeof de === "boolean" ? de : null });
    }
  }
  return { at, cameras };
}

/** Frigate is running this camera's detector on live frames. */
export function statsSaysLive(stat: FrigateCameraStat | undefined): boolean {
  return stat !== undefined && stat.fps > 0 && stat.detectionEnabled !== false;
}

/**
 * Pure. The tracker's readings with stats seeds laid over the gaps (see the
 * file header). `seeds` — last tick's seeds (key → since); the returned
 * `seeds` replace them.
 */
export function withStatsSeeds(
  tracker: ReadonlyMap<string | null, CoverageReading>,
  stats: FrigateStatsView | null,
  seeds: ReadonlyMap<string | null, Date>,
): { readings: Map<string | null, CoverageReading>; seeds: Map<string | null, Date> } {
  const readings = new Map(tracker);
  const next = new Map<string | null, Date>();
  if (!stats) return { readings, seeds: next };
  const seed = (key: string | null) => {
    if (tracker.has(key)) return;
    const since = seeds.get(key) ?? stats.at;
    readings.set(key, { health: "online", at: stats.at, since });
    next.set(key, since);
  };
  seed(null);
  for (const [name, stat] of stats.cameras) if (statsSaysLive(stat)) seed(name);
  return { readings, seeds: next };
}

/** An open span as the tick reads it. */
export interface OpenCoverageSpan {
  id: bigint;
  camera: string;
  startedAt: Date;
  coveredUntil: Date;
  processId: string;
}

export interface CoveragePlan {
  /** Continuing spans: coveredUntil → now. */
  extend: bigint[];
  /** Spans that failed the test: closed at their last confirmation. */
  close: bigint[];
  /** New spans for observing cameras with no continuing span. */
  open: Array<{ camera: string; startedAt: Date }>;
}

const latest = (...ds: Array<Date | null | undefined>): Date =>
  new Date(Math.max(...ds.filter((d): d is Date => d instanceof Date).map((d) => d.getTime())));

/**
 * The cameras observing right now, each with the instant from which that can
 * be proven: the latest of its own `since`, Frigate's `since`, the
 * subscription, and any failed write.
 */
export function observingCameras(obs: CoverageObservation): Map<string, Date> {
  const out = new Map<string, Date>();
  const { ingest, readings, stats } = obs;
  if (!ingest.frigateSubscribed || !ingest.frigateSubscribedAt) return out;
  const frigate = readings.get(null);
  if (!frigate || frigate.health !== "online") return out;
  const failing =
    ingest.lastWriteError !== null && (!ingest.lastRecordedAt || ingest.lastWriteError.at > ingest.lastRecordedAt);
  if (failing) return out;
  for (const [camera, reading] of readings) {
    if (camera === null || reading.health !== "online" || !FRIGATE_NAME.test(camera)) continue;
    // Stats answered: only a camera Frigate is actually running counts (no ghosts).
    if (stats && !statsSaysLive(stats.cameras.get(camera))) continue;
    out.set(camera, latest(reading.since, frigate.since, ingest.frigateSubscribedAt, ingest.lastWriteError?.at));
  }
  return out;
}

/** Pure. `lastCoveredUntil` — each camera's latest CLOSED span end, for the no-overlap clamp. */
export function planCoverage(
  openSpans: readonly OpenCoverageSpan[],
  obs: CoverageObservation,
  processId: string,
  now: Date,
  lastCoveredUntil: ReadonlyMap<string, Date> = new Map(),
): CoveragePlan {
  const observing = observingCameras(obs);
  const { ingest, readings } = obs;
  const frigate = readings.get(null);
  const plan: CoveragePlan = { extend: [], close: [], open: [] };
  const continuing = new Set<string>();
  const closedUntil = new Map<string, Date>();

  for (const s of openSpans) {
    const reading = readings.get(s.camera);
    const unchanged =
      observing.has(s.camera) &&
      s.processId === processId &&
      ingest.frigateSubscribedAt !== null &&
      ingest.frigateSubscribedAt <= s.coveredUntil &&
      frigate !== undefined &&
      frigate.since <= s.coveredUntil &&
      reading !== undefined &&
      reading.since <= s.coveredUntil &&
      !(ingest.lastWriteError && ingest.lastWriteError.at > s.coveredUntil);
    if (unchanged && !continuing.has(s.camera)) {
      plan.extend.push(s.id);
      continuing.add(s.camera);
    } else {
      plan.close.push(s.id);
      closedUntil.set(s.camera, latest(closedUntil.get(s.camera), s.coveredUntil));
    }
  }

  for (const [camera, provenSince] of observing) {
    if (continuing.has(camera)) continue;
    // No stats this tick: a tracker `online` may be a ghost — never open on it alone.
    if (!obs.stats) continue;
    const startedAt = latest(provenSince, lastCoveredUntil.get(camera), closedUntil.get(camera));
    plan.open.push({ camera, startedAt: startedAt > now ? now : startedAt });
  }
  return plan;
}

export interface CoverageTickResult {
  extended: number;
  closed: number;
  opened: number;
}

type SpanDb = Pick<PrismaClient, "securityCoverageSpan">;

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

/** Each camera's latest closed span end (for cameras about to open a span only — rare). */
async function lastClosedUntil(prisma: SpanDb, cameras: readonly string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (const camera of cameras) {
    const row = await prisma.securityCoverageSpan.findFirst({
      where: { camera, state: "closed" },
      orderBy: { coveredUntil: "desc" },
      select: { coveredUntil: true },
    });
    if (row) out.set(camera, row.coveredUntil);
  }
  return out;
}

/**
 * One tick's writes. Each is its own short statement on the outer client:
 *   1. (first tick of this process) close every span another process left open;
 *   2. read the open spans and plan;
 *   3. close, THEN open (one open span per camera is a partial unique index),
 *      then extend — each extend is by id, still open, this process's, and
 *      only forward in time.
 * A P2002 on an open means another process opened that camera's span first;
 * that is not an error, the next tick sees it as foreign and closes it.
 */
export async function recordCoverage(
  prisma: SpanDb,
  obs: CoverageObservation,
  processId: string,
  now: Date,
  opts: { bootClose: boolean },
): Promise<CoverageTickResult> {
  const result: CoverageTickResult = { extended: 0, closed: 0, opened: 0 };
  if (opts.bootClose) {
    const r = await prisma.securityCoverageSpan.updateMany({
      where: { state: "open", processId: { not: processId } },
      data: { state: "closed", closedAt: now },
    });
    result.closed += r.count;
  }
  const open = await prisma.securityCoverageSpan.findMany({
    where: { state: "open" },
    select: { id: true, camera: true, startedAt: true, coveredUntil: true, processId: true },
  });
  let plan = planCoverage(open, obs, processId, now);
  if (plan.open.length > 0) {
    plan = planCoverage(open, obs, processId, now, await lastClosedUntil(prisma, plan.open.map((o) => o.camera)));
  }

  for (const id of plan.close) {
    const r = await prisma.securityCoverageSpan.updateMany({
      where: { id, state: "open" },
      data: { state: "closed", closedAt: now },
    });
    result.closed += r.count;
  }
  for (const o of plan.open) {
    try {
      await prisma.securityCoverageSpan.create({
        data: { camera: o.camera, state: "open", startedAt: o.startedAt, coveredUntil: now, processId },
      });
      result.opened += 1;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  for (const id of plan.extend) {
    const r = await prisma.securityCoverageSpan.updateMany({
      where: { id, state: "open", processId, coveredUntil: { lt: now } },
      data: { coveredUntil: now },
    });
    result.extended += r.count;
  }
  return result;
}

// ── the learning state (§6.6) ────────────────────────────────────────────

export interface CoverageSpanTimes {
  camera: string;
  startedAt: Date;
  coveredUntil: Date;
}

export interface SourceStateRow {
  camera: string;
  /** Window dates with ≥ 1200 observed minutes, 0–28. */
  daysObserved: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  state: SecurityBaselineState;
}

/**
 * Pure. Per camera: the window dates (cut at local midnights by the
 * converter, so a 23-hour spring day qualifies at 20 h like any other) its
 * spans cover for ≥ 1200 minutes; the earliest start; the latest
 * confirmation; and the state — stale after 48 h unobserved, else learning
 * below 14 days, else active. "Silent" means the SOURCE: a camera that
 * reports and sees nothing is observing zeros, which is valid data.
 */
export function sourceStates(
  spans: readonly CoverageSpanTimes[],
  window: BaselineWindow,
  tz: string,
  now: Date,
): Map<string, SourceStateRow> {
  const days = windowDates(window.from, window.to).map((ymd) => dayBounds(ymd, tz));
  const byCamera = new Map<string, CoverageSpanTimes[]>();
  for (const s of spans) {
    const list = byCamera.get(s.camera);
    if (list) list.push(s);
    else byCamera.set(s.camera, [s]);
  }
  const out = new Map<string, SourceStateRow>();
  for (const [camera, list] of byCamera) {
    let daysObserved = 0;
    for (const day of days) {
      let ms = 0;
      for (const s of list) {
        const from = Math.max(s.startedAt.getTime(), day.start.getTime());
        const to = Math.min(s.coveredUntil.getTime(), day.end.getTime());
        if (to > from) ms += to - from;
      }
      if (ms >= BASELINE.fullDayMinutes * 60_000) daysObserved += 1;
    }
    const firstSeenAt = new Date(Math.min(...list.map((s) => s.startedAt.getTime())));
    const lastSeenAt = new Date(Math.max(...list.map((s) => s.coveredUntil.getTime())));
    const state: SecurityBaselineState =
      now.getTime() - lastSeenAt.getTime() > BASELINE.staleAfterMs
        ? "stale"
        : daysObserved < BASELINE.learningDays
          ? "learning"
          : "active";
    out.set(camera, { camera, daysObserved, firstSeenAt, lastSeenAt, state });
  }
  return out;
}

export interface SourceRefreshResult {
  cameras: number;
  created: number;
  updated: number;
  deleted: number;
}

/**
 * The hourly step's first part (§6.7 step 4.1): recompute the learning state
 * of every camera with a span in the last 35 days, in `tz`'s window. A
 * camera appears on its first span; `firstSeenAt` is kept across updates
 * (spans older than 35 days are trimmed); `stateChangedAt` moves only on a
 * change. Rows for cameras with no span in 35 days are deleted. Machine
 * state: no ActivityRow (the same rule as P3's incidents opening).
 */
export async function refreshBaselineSources(
  prisma: Pick<PrismaClient, "securityCoverageSpan" | "securityBaselineSource">,
  tz: string,
  now: Date,
): Promise<SourceRefreshResult> {
  const spans = await prisma.securityCoverageSpan.findMany({
    where: { coveredUntil: { gte: new Date(now.getTime() - COVERAGE_KEEP_MS) } },
    select: { camera: true, startedAt: true, coveredUntil: true },
  });
  const states = sourceStates(spans, windowFor(now, tz), tz, now);
  const existing = new Map(
    (await prisma.securityBaselineSource.findMany({ where: { sourceKey: { startsWith: "camera:" } } })).map((r) => [r.sourceKey, r]),
  );
  const result: SourceRefreshResult = { cameras: states.size, created: 0, updated: 0, deleted: 0 };
  const keys: string[] = [];
  for (const s of states.values()) {
    const sourceKey = `camera:${s.camera}`;
    keys.push(sourceKey);
    const row = existing.get(sourceKey);
    if (!row) {
      try {
        await prisma.securityBaselineSource.create({
          data: {
            sourceKey,
            camera: s.camera,
            state: s.state,
            daysObserved: s.daysObserved,
            firstSeenAt: s.firstSeenAt,
            lastSeenAt: s.lastSeenAt,
            stateChangedAt: now,
          },
        });
        result.created += 1;
      } catch (err) {
        // Another tick (one that outlived its lock) created it first: its row is as good as this one.
        if (!isUniqueViolation(err)) throw err;
      }
      continue;
    }
    await prisma.securityBaselineSource.update({
      where: { sourceKey },
      data: {
        state: s.state,
        daysObserved: s.daysObserved,
        firstSeenAt: row.firstSeenAt < s.firstSeenAt ? row.firstSeenAt : s.firstSeenAt,
        lastSeenAt: s.lastSeenAt,
        stateChangedAt: row.state === s.state ? row.stateChangedAt : now,
      },
    });
    result.updated += 1;
  }
  // Camera sources only: coverage knows nothing about P5c's `activity:*` sources, and must never sweep them.
  const { count } = await prisma.securityBaselineSource.deleteMany({ where: { sourceKey: { startsWith: "camera:", notIn: keys } } });
  result.deleted = count;
  return result;
}
