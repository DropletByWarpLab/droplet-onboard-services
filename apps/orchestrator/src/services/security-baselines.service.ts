/**
 * WARP-2980 (ADR-059 P5, spec §6.7, §6.14) — the baseline job and its
 * `patterns` health row.
 *
 * ONE tick every 60 s on the cron runtime, under ONE advisory lock. Never a
 * cron spec (specs fire in process time, and the site's day is what
 * matters), never a second hourly timer: one tick with its watermarks in the
 * database is restart-safe by construction. Each step is its own short
 * statement on the outer client; the lock transaction only holds the lock.
 *
 *   1. coverage — every tick, zone or not (spans are instants). The first
 *      tick of this process closes every span another process left open;
 *   1b. WARP-2980 PR-B (spec D18) — expected activity whose `expiresAt` has
 *      passed is marked `expired`, zone or not, each with its system audit
 *      after its own commit (security-suppressions.service.ts). A failed
 *      audit is rethrown only after the tick's work (and `lastOkAt`) — never
 *      through `lastError`, whose words ("Couldn't check which cameras…")
 *      would be false. Every reader also requires `expiresAt > now`, so a
 *      tick that runs late never extends one;
 *   2. the zone — `resolveSecurityTimezone` (site zone, else a valid
 *      Workspace.tz). None → stop: nothing can be cut into site hours;
 *   3. the job-state row, created lazily at the current site hour;
 *   4. the hourly step, when the last completed site hour ended after
 *      `hourlyThrough`: recompute the learning state per camera, then move
 *      the watermark (CAS). After downtime it runs once, not once per missed
 *      hour. It adds NO counts (D4): today's events never enter the cells
 *      that score today — an intruder's first hour must not become part of
 *      the normal their later events are judged against;
 *   5. a full build when there is no ready build (`first`), the ready one was
 *      cut in another zone (`timezone_changed`), it is two days behind
 *      (`catch_up`, any hour) or one day behind at ≥ 00:10 site time
 *      (`nightly`). After a build, step 4's sources again (the window moved)
 *      and no step 6 (the build read every current link);
 *   6. area rebuilds, only against a FRESH ready build (windowTo ≥ today − 2):
 *      areas whose `version` moved since their cells, linked areas with no
 *      cells, and cells of areas no longer linked — one call;
 *   7. health: `lastOkAt`. A throw sets `lastError` and rethrows into
 *      safeRun's failure canary.
 *
 * Single flight: the advisory lock stops two ticks overlapping; the
 * `building` partial unique index stops two builds even when a tick outlives
 * its 60 s lock transaction (cron-runtime.service.ts) or a replica exists.
 *
 * Registered unconditionally (the DS-015 rule): the learning clock must not
 * start from zero the day the owner turns Security on.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient, SecurityBaselineBuildState, SecurityBaselineBuildTrigger, SecurityBaselineState } from "@prisma/client";
import type { CronRuntime } from "./cron-runtime.service.js";
import { securityIngestHealthState, type SecurityHealthRow } from "./security-events.service.js";
import type { SecurityViewerScope } from "./security-access.js";
import { securityStatusSnapshot } from "./camera.service.js";
import { resolveSecurityTimezone } from "./security-mode.service.js";
import {
  parseFrigateStats,
  recordCoverage,
  refreshBaselineSources,
  withStatsSeeds,
  type CoverageObservation,
  type FrigateStatsView,
} from "./security-coverage.js";
import { fetchStats } from "./frigate.client.js";
import { config } from "../config.js";
import { rebuildAreas, runFullBuild, type FullBuildOutcome } from "./security-baseline-build.js";
import { expireSuppressions } from "./security-suppressions.service.js";
import { BASELINE } from "../lib/security-baseline-math.js";
import { PATTERN_RELEASE } from "../lib/security-rules.js";
import { patternRuleHealth, plainTickError, type PatternRuleHealth } from "./security-pattern-rules.js";
import { slotOf } from "../lib/security-baseline-slots.js";
import { localPartsOf, ymdAddDays } from "../lib/zoned-time.js";
import { siteDayClockCopy } from "../lib/security-hours.js";
import { createLogger } from "../lib/logger.js";

export {
  BASELINE_BUILDS_KEPT,
  BASELINE_BUILD_CLAIM_STALE_MS,
  BASELINE_BUILD_STATEMENT_TIMEOUT,
  BASELINE_BUILD_TX_TIMEOUT_MS,
  BASELINE_COVERAGE_KEEP_DAYS,
} from "./security-baseline-build.js";

const logger = createLogger("security-baselines");

export const SECURITY_BASELINE_INTERVAL_MS = 60_000;
export const SECURITY_BASELINE_LOCK_KEY = "droplet:security-baselines";
/** The nightly build waits until 00:10 site time, so yesterday's last `end` events have landed. */
export const BASELINE_NIGHTLY_AFTER_MINUTE = 10;
/** A ready build older than this pauses the rules (`buildPause`, PR-B) and area rebuilds — one fingerprinted number. */
export const BASELINE_FRESH_WINDOW_DAYS = BASELINE.freshWindowDays;
/**
 * A full build that FAILED is not retried within this long (spec silent):
 * a build that times out at 45 s would otherwise run again every minute.
 * The previous ready build keeps serving meanwhile, and the health row says
 * why the new one failed.
 */
export const BASELINE_BUILD_RETRY_AFTER_MS = 60 * 60_000;
/** An area rebuild that failed is not retried within this long for the same (build, area version). */
export const BASELINE_AREA_REBUILD_RETRY_AFTER_MS = 60 * 60_000;
/** `scheduleInterval` has no immediate tick: a freshly registered job gets this long before "hasn't checked" reads as down. */
export const SECURITY_BASELINE_GRACE_MS = 3 * 60_000;
/**
 * A full build or an area rebuild starts only within this long of the tick's
 * start: with BASELINE_BUILD_TX_TIMEOUT_MS it must end before the cron
 * runtime's 60 s advisory-lock transaction does (review #2352). A slow tick
 * leaves its build to the next one.
 */
export const SECURITY_BASELINE_BUILD_START_BUDGET_MS = 5_000;
/** Frigate's /api/stats, read every tick for coverage: short, so a slow Frigate cannot eat the tick. */
export const SECURITY_BASELINE_STATS_TIMEOUT_MS = 3_000;

const SINGLETON = "singleton";

// ── health state ──────────────────────────────────────────────────────────

export interface BaselineHealthState {
  /** Set by `registerSecurityBaselineJobs`. Null = the job is not running (the §7 boot assertion). */
  registeredAt: Date | null;
  /** The last tick that ran every step. */
  lastOkAt: Date | null;
  /**
   * The last tick that threw. `message` is plain words for the patterns row
   * (`plainTickError`); the raw error goes to the log and safeRun's canary only.
   */
  lastError: { at: Date; message: string } | null;
  /**
   * The last time an area rebuild failed, while any area still waits out its
   * backoff; null once they are all rebuilt. A failed rebuild never fails the
   * tick (review #2352), so it is shown here instead.
   */
  areaRebuildFailedAt?: Date | null;
}

const baselineHealth: BaselineHealthState = { registeredAt: null, lastOkAt: null, lastError: null, areaRebuildFailedAt: null };

export function baselineHealthState(): Readonly<BaselineHealthState> {
  return baselineHealth;
}

/** Test seam — module state survives between tests otherwise. */
export function _resetBaselineHealthForTests(): void {
  Object.assign(baselineHealth, {
    registeredAt: null,
    lastOkAt: null,
    lastError: null,
    areaRebuildFailedAt: null,
  } satisfies BaselineHealthState);
}

// ── the tick ──────────────────────────────────────────────────────────────

/** Random per orchestrator boot: only the process that opened a coverage span may extend it. */
const BOOT_PROCESS_ID = randomUUID();
/** Processes whose first tick (the boot close) has run. */
const bootClosed = new Set<string>();
/** Coverage seeds from Frigate's stats (key → since), per process; see security-coverage.ts. */
let coverageSeeds = new Map<string | null, Date>();
/**
 * Areas whose last rebuild produced no cells (nothing observed yet), keyed
 * `zoneId → "<buildId>:<version>"`, so a quiet area is not rebuilt every
 * minute. A restart forgets it: at most one extra rebuild per such area.
 */
const noCellAreas = new Map<string, string>();
/**
 * Areas whose last rebuild FAILED, `zoneId → {key: "<buildId>:<version>", at}`.
 * The same key waits BASELINE_AREA_REBUILD_RETRY_AFTER_MS: a rebuild that
 * times out would otherwise re-run its full statement every minute. A new
 * version (someone changed the links) or a new build retries at once.
 */
const failedAreaRebuilds = new Map<string, { key: string; at: number }>();

/** Test seam. */
export function _resetBaselineJobForTests(): void {
  bootClosed.clear();
  noCellAreas.clear();
  failedAreaRebuilds.clear();
  coverageSeeds = new Map();
}

export interface BaselineJobDeps {
  /** The zone the slots are cut in. Default: `resolveSecurityTimezone(prisma)`. */
  zone?: () => Promise<string | null>;
  /** What the ingest and the status tracker say right now. Default: the live module state. */
  observe?: () => Omit<CoverageObservation, "stats">;
  /** Frigate's /api/stats body. Default: `fetchStats` with a short timeout. A throw = no stats this tick. */
  stats?: () => Promise<unknown>;
  /** Default: this boot's random id. */
  processId?: string;
  /** Wall-clock milliseconds for the tick's start budget. Default: Date.now. */
  clock?: () => number;
}

/** The live ingest + tracker state, as coverage reads it. */
function liveObservation(): Omit<CoverageObservation, "stats"> {
  const ingest = securityIngestHealthState();
  return {
    ingest: {
      frigateSubscribed: ingest.frigateSubscribed,
      frigateSubscribedAt: ingest.frigateSubscribedAt,
      lastRecordedAt: ingest.lastRecordedAt,
      lastWriteError: ingest.lastWriteError,
    },
    readings: securityStatusSnapshot(),
  };
}

export interface BaselineTickResult {
  zone: string | null;
  hourly: boolean;
  trigger: SecurityBaselineBuildTrigger | null;
  build: FullBuildOutcome | null;
  rebuiltAreas: string[];
}

type JobDb = PrismaClient;

async function jobState(prisma: JobDb, zone: string, now: Date): Promise<{ hourlyThrough: Date }> {
  const row = await prisma.securityBaselineJobState.findUnique({ where: { id: SINGLETON } });
  if (row) return row;
  // INSERT … ON CONFLICT DO NOTHING, then a read — never upsert({update:{}}),
  // which Prisma 5 runs as read-then-insert (a P2002 on a first-tick race).
  await prisma.securityBaselineJobState.createMany({
    data: [{ id: SINGLETON, hourlyThrough: slotOf(now, zone).start }],
    skipDuplicates: true,
  });
  return prisma.securityBaselineJobState.findUniqueOrThrow({ where: { id: SINGLETON } });
}

/** Which full build, if any, this tick must run (§6.7 step 5). */
async function fullBuildTrigger(prisma: JobDb, zone: string, now: Date): Promise<SecurityBaselineBuildTrigger | null> {
  const ready = await prisma.securityBaselineBuild.findFirst({
    where: { state: "ready" },
    select: { timezone: true, windowTo: true },
  });
  const { ymd: today, minuteOfDay } = localPartsOf(now, zone);
  const yesterday = ymdAddDays(today, -1);
  let trigger: SecurityBaselineBuildTrigger | null = null;
  if (!ready) trigger = "first";
  else if (ready.timezone !== zone) trigger = "timezone_changed";
  else if (ready.windowTo < ymdAddDays(yesterday, -1)) trigger = "catch_up";
  else if (ready.windowTo < yesterday && minuteOfDay >= BASELINE_NIGHTLY_AFTER_MINUTE) trigger = "nightly";
  if (!trigger) return null;

  const newest = await prisma.securityBaselineBuild.findFirst({
    orderBy: { startedAt: "desc" },
    select: { state: true, startedAt: true, timezone: true },
  });
  // The backoff is for retrying the SAME build: a build that failed in another
  // zone never holds back the new zone's (review #2352).
  if (
    newest?.state === "failed" &&
    newest.timezone === zone &&
    now.getTime() - newest.startedAt.getTime() < BASELINE_BUILD_RETRY_AFTER_MS
  ) {
    return null;
  }
  return trigger;
}

/**
 * One row per built area key: every kept key has all four tracked labels and
 * all 48 (dayType, hour) rows (the build statement's `key_label` / `grid`,
 * pinned by the pg property test), so (person, weekday, 00) is exactly one
 * row per key. Never Prisma's `distinct`, which Prisma 5 runs in memory over
 * every matching cell (review #2352).
 */
const ONE_ROW_PER_KEY = { label: "person", dayType: "weekday", hour: 0 } as const;

/** §6.7 step 6. Returns the areas it rebuilt. */
async function rebuildChangedAreas(prisma: JobDb, zone: string, now: Date): Promise<string[]> {
  const ready = await prisma.securityBaselineBuild.findFirst({
    where: { state: "ready" },
    select: { id: true, timezone: true, windowTo: true },
  });
  if (!ready || ready.timezone !== zone) return [];
  const today = localPartsOf(now, zone).ymd;
  if (ready.windowTo < ymdAddDays(today, -BASELINE_FRESH_WINDOW_DAYS)) return [];

  const [built, live] = await Promise.all([
    prisma.securityBaselineCell.findMany({
      where: { buildId: ready.id, keyKind: "area", ...ONE_ROW_PER_KEY },
      select: { zoneId: true, zoneVersion: true },
    }),
    prisma.securityZone.findMany({
      where: { state: "active", links: { some: { state: "active", sourceKind: { in: ["camera", "camera_zone"] } } } },
      select: { id: true, version: true },
    }),
  ]);
  const builtVersion = new Map(built.filter((b) => b.zoneId !== null).map((b) => [b.zoneId!, b.zoneVersion]));
  const liveVersion = new Map(live.map((z) => [z.id, z.version]));
  const keyOf = (id: string) => `${ready.id}:${liveVersion.get(id) ?? "gone"}`;
  // A failure whose key moved (new build, new version) is stale: retry it now.
  for (const [id, f] of failedAreaRebuilds) if (f.key !== keyOf(id)) failedAreaRebuilds.delete(id);
  const waiting = (id: string) => {
    const f = failedAreaRebuilds.get(id);
    return f !== undefined && now.getTime() - f.at < BASELINE_AREA_REBUILD_RETRY_AFTER_MS;
  };
  const ids: string[] = [];
  for (const [id, version] of liveVersion) {
    const had = builtVersion.get(id);
    if (had === undefined) {
      if (noCellAreas.get(id) !== `${ready.id}:${version}`) ids.push(id);
    } else if (had !== version) {
      ids.push(id);
    }
  }
  for (const id of builtVersion.keys()) if (!liveVersion.has(id)) ids.push(id);
  const due = ids.filter((id) => !waiting(id));
  if (due.length === 0) {
    if (failedAreaRebuilds.size === 0) baselineHealth.areaRebuildFailedAt = null;
    return [];
  }

  let r: Awaited<ReturnType<typeof rebuildAreas>>;
  try {
    r = await rebuildAreas(prisma, due);
  } catch (err) {
    // Never fails the tick: coverage, the hourly step and lastOkAt stand. The
    // areas wait out the backoff; the patterns row says so meanwhile.
    for (const id of due) failedAreaRebuilds.set(id, { key: keyOf(id), at: now.getTime() });
    baselineHealth.areaRebuildFailedAt = now;
    logger.error({ err, areas: due }, "security baselines: area rebuild failed — retrying within the hour");
    return [];
  }
  for (const id of due) failedAreaRebuilds.delete(id);
  if (failedAreaRebuilds.size === 0) baselineHealth.areaRebuildFailedAt = null;
  if (r.status === "rebuilt") {
    const withCells = await prisma.securityBaselineCell.findMany({
      where: { buildId: r.buildId, keyKind: "area", zoneId: { in: due }, ...ONE_ROW_PER_KEY },
      select: { zoneId: true },
    });
    const has = new Set(withCells.map((c) => c.zoneId));
    for (const id of due) {
      const version = liveVersion.get(id);
      if (version !== undefined && !has.has(id)) noCellAreas.set(id, `${r.buildId}:${version}`);
      else noCellAreas.delete(id);
    }
    logger.info({ areas: due, inserted: r.inserted }, "security baselines: areas rebuilt after a link change");
  }
  return due;
}

/**
 * A tick failure in words the Sources card can show — moved to
 * security-pattern-rules.ts (WARP-2980 PR-B), which the incident engine also
 * uses and which must not import this file.
 */
export { plainTickError };

/** Frigate's stats for this tick, or null when they did not answer (or Frigate is not set up). Never throws. */

async function readFrigateStats(deps: BaselineJobDeps, now: Date): Promise<FrigateStatsView | null> {
  const read =
    deps.stats ??
    (() =>
      config.FRIGATE_URL && config.FRIGATE_URL.trim()
        ? fetchStats({ timeoutMs: SECURITY_BASELINE_STATS_TIMEOUT_MS })
        : Promise.reject(new Error("no camera system is set up")));
  try {
    return parseFrigateStats(await read(), now);
  } catch (err) {
    logger.debug({ err }, "baseline tick: Frigate stats unavailable — nothing seeded, no new coverage span");
    return null;
  }
}

export async function tickSecurityBaselines(
  prisma: JobDb,
  now: Date = new Date(),
  deps: BaselineJobDeps = {},
): Promise<BaselineTickResult> {
  const expiry: { auditError?: unknown } = {};
  const result = await runBaselineTick(prisma, now, deps, expiry);
  // D18: the tick's work (and lastOkAt) is done; a failed expiry audit reaches safeRun's canary now.
  if (expiry.auditError !== undefined) throw expiry.auditError;
  return result;
}

async function runBaselineTick(
  prisma: JobDb,
  now: Date,
  deps: BaselineJobDeps,
  expiry: { auditError?: unknown },
): Promise<BaselineTickResult> {
  const processId = deps.processId ?? BOOT_PROCESS_ID;
  const clock = deps.clock ?? Date.now;
  const tickStart = clock();
  const mayStartBuild = () => clock() - tickStart <= SECURITY_BASELINE_BUILD_START_BUDGET_MS;
  const result: BaselineTickResult = { zone: null, hourly: false, trigger: null, build: null, rebuiltAreas: [] };
  try {
    const bootClose = !bootClosed.has(processId);
    const stats = await readFrigateStats(deps, now);
    const tracker = (deps.observe ?? liveObservation)();
    const seeded = withStatsSeeds(tracker.readings, stats, coverageSeeds);
    coverageSeeds = seeded.seeds;
    await recordCoverage(prisma, { ingest: tracker.ingest, readings: seeded.readings, stats }, processId, now, { bootClose });
    bootClosed.add(processId);

    // 1b. Expected activity past its expiresAt — zone or not (D18).
    expiry.auditError = (await expireSuppressions(prisma, now)).auditError;

    const zone = await (deps.zone ?? (() => resolveSecurityTimezone(prisma)))();
    result.zone = zone;
    if (!zone) {
      baselineHealth.lastOkAt = now;
      return result;
    }

    const state = await jobState(prisma, zone, now);
    const hourEnd = slotOf(now, zone).start;
    if (hourEnd.getTime() > state.hourlyThrough.getTime()) {
      await refreshBaselineSources(prisma, zone, now);
      await prisma.securityBaselineJobState.updateMany({
        where: { id: SINGLETON, hourlyThrough: state.hourlyThrough },
        data: { hourlyThrough: hourEnd },
      });
      result.hourly = true;
    }

    result.trigger = await fullBuildTrigger(prisma, zone, now);
    if (result.trigger && !mayStartBuild()) {
      logger.info({ trigger: result.trigger }, "baseline tick ran long: the full build waits for the next tick");
    } else if (result.trigger) {
      result.build = await runFullBuild(prisma, result.trigger, zone, now);
      if (result.build.status === "built") await refreshBaselineSources(prisma, zone, now);
    }
    if (result.build?.status !== "built" && mayStartBuild()) result.rebuiltAreas = await rebuildChangedAreas(prisma, zone, now);

    baselineHealth.lastOkAt = now;
    return result;
  } catch (err) {
    baselineHealth.lastError = { at: now, message: plainTickError(err) };
    throw err;
  }
}

/**
 * The job on the cron runtime, single-flighted on its own advisory lock, and
 * `registeredAt` — the §7 boot assertion the `patterns` row reads.
 */
export function registerSecurityBaselineJobs(
  cronRuntime: Pick<CronRuntime, "scheduleInterval">,
  prisma: PrismaClient,
  deps: BaselineJobDeps = {},
): void {
  cronRuntime.scheduleInterval(
    SECURITY_BASELINE_INTERVAL_MS,
    async () => {
      await tickSecurityBaselines(prisma, new Date(), deps);
    },
    { lockKey: SECURITY_BASELINE_LOCK_KEY },
  );
  baselineHealth.registeredAt = new Date();
}

// ── the `patterns` health row (§6.14) ─────────────────────────────────────

/** What the row reads from the database. Null = it could not be read. */
export interface PatternsHealthDb {
  timezone: string | null;
  sources: ReadonlyArray<{ camera: string; state: SecurityBaselineState; daysObserved: number }>;
  ready: { finishedAt: Date | null; windowTo: string } | null;
  newest: { state: SecurityBaselineBuildState; error: string | null } | null;
  /** Camera rows (names). */
  cameras: readonly string[];
  /** Cameras with an OPEN coverage span: Droplet can hear them right now. */
  openSpanCameras: readonly string[];
}

/** A stored build error, in words the Sources card can show verbatim. Never the raw database text. */
function failureReason(error: string | null): string {
  if (error === "interrupted") return "it was interrupted";
  if (error && /statement timeout/i.test(error)) return "it took too long";
  return "something went wrong";
}

const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "today", "yesterday", "Sat" (within 6 days) or "Sep 19" — the site's calendar. */
function siteDayCopy(instant: Date, tz: string, now: Date): string {
  const at = localPartsOf(instant, tz);
  const today = localPartsOf(now, tz).ymd;
  if (at.ymd === today) return "today";
  if (at.ymd === ymdAddDays(today, -1)) return "yesterday";
  for (let back = 2; back <= 6; back += 1) if (at.ymd === ymdAddDays(today, -back)) return WEEKDAY_SHORT[at.isoWeekday];
  const [, month, day] = at.ymd.split("-").map(Number);
  return `${MONTH_SHORT[month! - 1]} ${day}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The `patterns` row of the /security header. Visible to every viewer; its
 * counts cover only the cameras the viewer may see (DS-005):
 *   · down "Not running" — never registered (the boot assertion);
 *   · down "Hasn't checked which cameras Droplet can hear since 2:14 AM" —
 *     registered more than 3 minutes ago and no ok tick within 3 minutes
 *     (site clock; "for N minutes" without a zone);
 *   · down "Couldn't read what normal looks like" — the rows (or the
 *     viewer's grants) could not be read;
 *   · not_configured — no zone; no camera the viewer may see is set up;
 *   · (no source row yet) quiet "Learning … 0 of 14 days" when a visible
 *     camera is being heard; else down "Can't confirm Droplet is hearing any
 *     camera yet" (quiet "Checking …" before the first tick) — cameras set up
 *     but none confirmed is a fault, never a harmless not_configured;
 *   · down — the newest build failed and there is no ready build or it is
 *     out of date; or the ready build is out of date (the rules pause);
 *   · down "Couldn't compare new events with what's usual: …" — WARP-2980
 *     PR-B: the latest pattern evaluation of the incident engine failed
 *     (`rules`, security-pattern-rules.ts). Only for a viewer who sees EVERY
 *     camera: it flips on a detection's evaluation, so for anyone else its
 *     timing would reveal a detection on a camera they cannot see (DS-005
 *     covers times);
 *   · quiet — learning ("9 of 14 days", the most any visible camera has), or
 *     every visible camera silent for over two days;
 *   · ok — "Knows what normal looks like for 3 cameras; 1 still learning",
 *     with "· Trial: pattern flags aren't raised yet" while any P5 code is trial.
 * `lastSeenAt` is the ready build's finish.
 */
export function patternsHealthRow(
  state: Readonly<BaselineHealthState>,
  db: PatternsHealthDb | null,
  scope: Pick<SecurityViewerScope, "visibleCameras"> | null,
  now: Date,
  rules: Readonly<PatternRuleHealth> = patternRuleHealth(),
): SecurityHealthRow {
  const lastSeenAt = db?.ready?.finishedAt ? db.ready.finishedAt.toISOString() : null;
  const row = (s: SecurityHealthRow["state"], detail: string): SecurityHealthRow => ({ id: "patterns", state: s, detail, lastSeenAt });
  const registeredAt = state.registeredAt;
  if (!registeredAt) return row("down", "Not running");

  const nowMs = now.getTime();
  const lastOk = state.lastOkAt;
  if (state.lastError && (!lastOk || state.lastError.at.getTime() > lastOk.getTime())) {
    return row("down", `Couldn't check which cameras Droplet can hear: ${state.lastError.message}`);
  }
  if (nowMs - registeredAt.getTime() > SECURITY_BASELINE_GRACE_MS && (!lastOk || nowMs - lastOk.getTime() > SECURITY_BASELINE_GRACE_MS)) {
    const since = lastOk ?? registeredAt;
    const tz = db?.timezone ?? null;
    return row(
      "down",
      tz
        ? `Hasn't checked which cameras Droplet can hear since ${siteDayClockCopy(since, tz, now)}`
        : `Hasn't checked which cameras Droplet can hear for ${Math.floor((nowMs - since.getTime()) / 60_000)} minutes`,
    );
  }
  if (!db || !scope) return row("down", "Couldn't read what normal looks like");
  const tz = db.timezone;
  if (!tz) return row("not_configured", "Needs the site's timezone. Set the opening hours to choose it.");

  const cams = scope.visibleCameras;
  const canSee = (camera: string) => cams === "all" || cams.has(camera);
  const sources = db.sources.filter((s) => canSee(s.camera));
  if (sources.length === 0) {
    if (db.openSpanCameras.some(canSee)) {
      return row("quiet", `Learning what normal looks like — 0 of ${BASELINE.learningDays} days`);
    }
    if (!db.cameras.some(canSee)) return row("not_configured", "No cameras are set up yet");
    return lastOk ? row("down", "Can't confirm Droplet is hearing any camera yet") : row("quiet", "Checking which cameras Droplet can hear");
  }

  const today = localPartsOf(now, tz).ymd;
  const outOfDate = db.ready !== null && db.ready.windowTo < ymdAddDays(today, -BASELINE_FRESH_WINDOW_DAYS);
  if (db.newest?.state === "failed" && (!db.ready || outOfDate)) {
    return row("down", `Couldn't work out what normal looks like: ${failureReason(db.newest.error)}`);
  }
  if (db.ready && outOfDate) {
    const when = db.ready.finishedAt ? siteDayCopy(db.ready.finishedAt, tz, now) : "a while ago";
    return row("down", `What normal looks like is out of date (last worked out ${when})`);
  }
  if (state.areaRebuildFailedAt && nowMs - state.areaRebuildFailedAt.getTime() < BASELINE_AREA_REBUILD_RETRY_AFTER_MS * 2) {
    return row("down", "Couldn't update what's usual after an area's cameras changed; trying again within the hour");
  }
  if (rules.lastError && cams === "all") {
    return row("down", `Couldn't compare new events with what's usual: ${rules.lastError.message}`);
  }

  const active = sources.filter((s) => s.state === "active");
  const learning = sources.filter((s) => s.state === "learning");
  if (active.length === 0) {
    if (learning.length === 0) return row("quiet", "No camera has reported for more than 2 days");
    const most = Math.min(BASELINE.learningDays, Math.max(...learning.map((s) => s.daysObserved)));
    return row("quiet", `Learning what normal looks like — ${most} of ${BASELINE.learningDays} days`);
  }
  let detail = `Knows what normal looks like for ${plural(active.length, "camera", "cameras")}`;
  if (learning.length > 0) detail += `; ${learning.length} still learning`;
  if (Object.values(PATTERN_RELEASE).some((r) => r === "trial")) detail += " · Trial: pattern flags aren't raised yet";
  return row("ok", detail);
}

/**
 * Load what `patternsHealthRow` needs and build the row — the one call the
 * /security/health handler makes, with the VIEWER's scope. Never throws: a
 * read failure (or a scope that could not be read, `null`) is a `down` row,
 * not a 503 of the whole header.
 */
export async function securityPatternsHealth(
  prisma: PrismaClient,
  scope: SecurityViewerScope | null,
  now: Date,
): Promise<SecurityHealthRow> {
  if (!scope) return patternsHealthRow(baselineHealth, null, null, now);
  try {
    const [timezone, sources, ready, newest, cameraRows, open] = await Promise.all([
      resolveSecurityTimezone(prisma),
      prisma.securityBaselineSource.findMany({ select: { camera: true, state: true, daysObserved: true } }),
      prisma.securityBaselineBuild.findFirst({ where: { state: "ready" }, select: { finishedAt: true, windowTo: true } }),
      prisma.securityBaselineBuild.findFirst({ orderBy: { startedAt: "desc" }, select: { state: true, error: true } }),
      prisma.camera.findMany({ select: { name: true } }),
      prisma.securityCoverageSpan.findMany({ where: { state: "open" }, select: { camera: true } }),
    ]);
    return patternsHealthRow(
      baselineHealth,
      { timezone, sources, ready, newest, cameras: cameraRows.map((c) => c.name), openSpanCameras: open.map((s) => s.camera) },
      scope,
      now,
    );
  } catch (err) {
    logger.warn({ err }, "patterns health read failed");
    return patternsHealthRow(baselineHealth, null, scope, now);
  }
}
