/**
 * WARP-2980 (ADR-059 P5, spec §6.5) — the ONE statement that builds the
 * baseline cells, and the full build / area rebuild around it.
 *
 * This file is the only writer of `SecurityBaselineCell` (a grep test pins
 * it). Cells are derived facts, rebuilt from SecurityEvent (kept 30 days) and
 * the coverage spans; nobody edits them, and verdicts and suppressions (PR-B)
 * never reach them (brief §4.4).
 *
 * The statement never converts time: the site-local hour slots are cut in
 * TypeScript (lib/security-baseline-slots.ts) and arrive as UTC wall-clock
 * `timestamp(3)` text — Prisma's DateTime columns are `timestamp without
 * time zone` holding UTC, and a `timestamptz` parameter would be shifted by
 * the session zone. Every parameter is bound ONCE, in the leading `p` CTE.
 *
 * The rule-carrying pieces are `link` (parseLinkRef), `key_obs` (D3: an area
 * slot is observed only when EVERY linked camera was observed for ≥ 5/6 of
 * it) and `ev_key` (zonesForEvent's rules for detections; DISTINCT, so two
 * links into one area count an event once). security-baseline-build.pg.test.ts
 * runs this statement and `referenceCells` (which calls `zonesForEvent`
 * itself) over generated data and requires identical rows — the SQL matcher
 * is pinned to P2b's.
 *
 * Additions to the spec's statement, each keeping a CHECK from failing a whole
 * build: a detection whose label the cell CHECK would refuse (Frigate's COCO
 * map has "traffic light") is not counted; a negative duration never reaches
 * the dwell quantile; and a camera's observed time in a slot is the UNION of
 * its spans (`range_agg`, Postgres 14+), so overlapping spans — a replica, a
 * tick that outlived its lock — can neither count a minute twice nor push a
 * 120-minute fall-back slot past the `observedMinutes` CHECK (review #2352). Sorting (`cameras`, the label ranking) is
 * `COLLATE "C"`, so the database's collation cannot reorder names.
 */
import type { PrismaClient, SecurityBaselineBuildTrigger } from "@prisma/client";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";
import { BASELINE, SECURITY_BASELINE_RULESET_VERSION } from "../lib/security-baseline-math.js";
import { windowBounds, windowFor, windowSlots, type BaselineSlot, type BaselineWindow } from "../lib/security-baseline-slots.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("security-baseline-build");

/**
 * Bounds the build statement inside its transaction (§6.7, R10). 40 s / 50 s,
 * not the spec's 45 s / 55 s (review #2352): the whole tick runs inside the
 * cron runtime's 60 s advisory-lock transaction, and the build starts only in
 * the tick's first few seconds (SECURITY_BASELINE_BUILD_START_BUDGET_MS), so
 * a build always ends while its tick still holds the lock.
 */
export const BASELINE_BUILD_STATEMENT_TIMEOUT = "40s";
export const BASELINE_BUILD_TX_TIMEOUT_MS = 50_000;
/**
 * Area rebuilds of one build take turns (a tick that outlived its lock can
 * overlap the next): both would delete, then both insert, and the second
 * insert dies on the cell unique key. A transaction-level advisory lock,
 * taken before the delete, makes the second wait and then replace the
 * first's rows.
 */
export const BASELINE_CELLS_LOCK_KEY = "droplet:security-baseline-cells";
/** A `building` claim older than this is a dead process's: it is failed as 'interrupted'. */
export const BASELINE_BUILD_CLAIM_STALE_MS = 10 * 60_000;
/** Superseded (and failed) builds kept besides the ready one; their cells cascade. */
export const BASELINE_BUILDS_KEPT = 14;
/** Coverage spans ending before this many days ago are deleted after a full build. */
export const BASELINE_COVERAGE_KEEP_DAYS = 35;

export interface BuildCellsInput {
  buildId: string;
  slots: readonly BaselineSlot[];
  windowStart: Date;
  windowEnd: Date;
  /** null = every active area; otherwise only these areas' keys. */
  onlyZoneIds: readonly string[] | null;
  includeCameraKeys: boolean;
}

/** A UTC instant as `timestamp(3)` text: its UTC wall clock, no zone the session could reinterpret. */
function pgTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

type RawDb = Pick<PrismaClient, "$executeRaw">;

/**
 * The one INSERT … SELECT. Returns the rows inserted. A full build passes
 * `onlyZoneIds = null, includeCameraKeys = true`; an area rebuild passes the
 * changed ids and `false`.
 */
export async function buildCells(tx: RawDb, input: BuildCellsInput): Promise<number> {
  const ymds = input.slots.map((s) => s.ymd);
  const hours = input.slots.map((s) => String(s.hour));
  const dayTypes = input.slots.map((s) => s.dayType);
  const starts = input.slots.map((s) => pgTimestamp(s.start));
  const ends = input.slots.map((s) => pgTimestamp(s.end));
  const onlyZoneIds = input.onlyZoneIds ? [...input.onlyZoneIds] : null;
  const labels: string[] = [...BASELINE.labels];
  return tx.$executeRaw`
INSERT INTO "SecurityBaselineCell" ("buildId", "zoneKey", "keyKind", "zoneId", "camera", "zoneVersion", "cameras",
  "label", "dayType", "hour", "daysObserved", "daysWithEvent", "eventCount", "observedMinutes", "dwellSamples", "durationP99Sec")
WITH
p AS (
  SELECT ${input.buildId}::text AS build_id,
         ${ymds}::text[] AS ymds,
         ${hours}::text[] AS hours,
         ${dayTypes}::text[] AS day_types,
         ${starts}::text[] AS starts,
         ${ends}::text[] AS ends,
         ${pgTimestamp(input.windowStart)}::timestamp(3) AS window_start,
         ${pgTimestamp(input.windowEnd)}::timestamp(3) AS window_end,
         ${onlyZoneIds}::text[] AS only_zone_ids,
         ${input.includeCameraKeys}::boolean AS camera_keys,
         ${labels}::text[] AS labels
),
slot AS (
  -- cut in TypeScript by windowSlots(); SQL never converts time
  SELECT u.ymd, u.hour::smallint AS hour, u.day_type::"SecurityDayType" AS day_type,
         u.s_start::timestamp(3) AS s_start, u.s_end::timestamp(3) AS s_end
  FROM p CROSS JOIN LATERAL unnest(p.ymds, p.hours, p.day_types, p.starts, p.ends) AS u(ymd, hour, day_type, s_start, s_end)
),
link AS (
  -- parseLinkRef in SQL: active camera / camera_zone links of active areas
  SELECT l."zoneId" AS zone_id, z.version AS zone_version,
         split_part(l."sourceRef", '/', 1) AS camera,
         CASE WHEN l."sourceKind" = 'camera_zone' THEN split_part(l."sourceRef", '/', 2) END AS part
  FROM "SecurityZoneLink" l JOIN "SecurityZone" z ON z.id = l."zoneId" CROSS JOIN p
  WHERE l.state = 'active' AND z.state = 'active' AND l."sourceKind" IN ('camera', 'camera_zone')
    AND (p.only_zone_ids IS NULL OR l."zoneId" = ANY(p.only_zone_ids))
),
cam_slot AS (
  -- each camera's coverage inside each slot, as the UNION of its spans' pieces (range_agg): spans a second
  -- process left overlapping never count a moment twice, so a slot never holds more than its own length.
  -- An area rebuild reads only its linked cameras (review #2352): never a full-build scan for one link edit.
  SELECT sp.camera, s.ymd, s.hour, s.day_type, s.s_start, s.s_end,
         range_agg(tsrange(GREATEST(sp."startedAt", s.s_start), LEAST(sp."coveredUntil", s.s_end))) AS covered
  FROM p CROSS JOIN slot s JOIN "SecurityCoverageSpan" sp ON sp."startedAt" < s.s_end AND sp."coveredUntil" > s.s_start
  WHERE p.only_zone_ids IS NULL OR sp.camera IN (SELECT camera FROM link)
  GROUP BY sp.camera, s.ymd, s.hour, s.day_type, s.s_start, s.s_end
),
cam_obs AS (
  -- observed SECONDS per camera per slot (divided once, at the end, so ms-precision spans round exactly);
  -- keep slots observed for >= 5/6 of their length
  SELECT c.camera, c.ymd, c.hour, c.day_type, u.secs
  FROM cam_slot c
  CROSS JOIN LATERAL (SELECT COALESCE(SUM(EXTRACT(EPOCH FROM upper(r) - lower(r))), 0) AS secs FROM unnest(c.covered) AS r) u
  WHERE u.secs >= EXTRACT(EPOCH FROM c.s_end - c.s_start) * 5.0 / 6.0
),
area AS (
  SELECT zone_id, max(zone_version) AS zone_version,
         array_agg(DISTINCT camera COLLATE "C" ORDER BY camera COLLATE "C") AS cams
  FROM link GROUP BY zone_id
),
key_obs AS (
  -- D3: an area slot is observed only when EVERY linked camera was
  SELECT 'camera:' || o.camera AS zone_key, o.ymd, o.hour, o.day_type, o.secs
  FROM cam_obs o CROSS JOIN p WHERE p.camera_keys
  UNION ALL
  SELECT 'area:' || a.zone_id, o.ymd, o.hour, o.day_type, MIN(o.secs)
  FROM area a JOIN cam_obs o ON o.camera = ANY(a.cams)
  GROUP BY a.zone_id, a.cams, o.ymd, o.hour, o.day_type
  HAVING COUNT(DISTINCT o.camera) = cardinality(a.cams)
),
ev AS (
  -- detections only: never detection_low, never another source (lock rows are never timing evidence)
  SELECT e.id, e.camera, e.labels[1] AS label, e."cameraZones" AS zones,
         EXTRACT(EPOCH FROM e."endedAt" - e."startedAt") AS dur, s.ymd, s.hour, s.day_type
  FROM p CROSS JOIN slot s
  JOIN "SecurityEvent" e ON e."startedAt" >= s.s_start AND e."startedAt" < s.s_end
  WHERE e.source = 'frigate' AND e.kind = 'detection'
    AND e."startedAt" >= p.window_start AND e."startedAt" < p.window_end
    AND e.camera IS NOT NULL
    AND e.labels[1] ~ '^[a-zA-Z0-9_-]{1,64}$'
    AND (p.only_zone_ids IS NULL OR e.camera IN (SELECT camera FROM link))
),
ev_key AS (
  -- zonesForEvent's rules for detections; DISTINCT: two links into one area count an event once
  SELECT DISTINCT zone_key, id, label, dur, ymd, hour, day_type FROM (
    SELECT 'camera:' || ev.camera AS zone_key, ev.id, ev.label, ev.dur, ev.ymd, ev.hour, ev.day_type
    FROM ev CROSS JOIN p WHERE p.camera_keys
    UNION ALL
    SELECT 'area:' || l.zone_id, ev.id, ev.label, ev.dur, ev.ymd, ev.hour, ev.day_type
    FROM ev JOIN link l ON l.camera = ev.camera AND (l.part IS NULL OR l.part = ANY(ev.zones))
  ) x
),
ev_obs AS (
  -- only events in observed slots of their key
  SELECT k.zone_key, k.id, k.label, k.dur, k.ymd, k.hour, k.day_type
  FROM ev_key k JOIN key_obs o ON o.zone_key = k.zone_key AND o.ymd = k.ymd AND o.hour = k.hour
),
key_label AS (
  -- the tracked labels plus the most frequent others, at most 8 per key (BASELINE.maxLabelsPerKey)
  SELECT zone_key, label FROM (
    SELECT zone_key, label,
           ROW_NUMBER() OVER (PARTITION BY zone_key ORDER BY fixed DESC, n DESC, label COLLATE "C") AS r
    FROM (SELECT zone_key, label, bool_or(fixed) AS fixed, SUM(n) AS n FROM (
            SELECT DISTINCT o.zone_key, unnest(p.labels) AS label, true AS fixed, 0::bigint AS n
            FROM key_obs o CROSS JOIN p
            UNION ALL
            SELECT zone_key, label, false, COUNT(*) FROM ev_obs GROUP BY zone_key, label) u
          GROUP BY zone_key, label) t
  ) ranked WHERE r <= 8
),
grid AS (
  SELECT kl.zone_key, kl.label, g.day_type, g.hour
  FROM key_label kl CROSS JOIN (SELECT DISTINCT day_type, hour FROM slot) g
),
obs AS (SELECT zone_key, day_type, hour, COUNT(*) AS n, SUM(secs) AS secs FROM key_obs GROUP BY 1, 2, 3),
cnt AS (SELECT zone_key, label, day_type, hour, COUNT(DISTINCT ymd) AS d, COUNT(*) AS c FROM ev_obs GROUP BY 1, 2, 3, 4),
dwell AS (
  -- hour +/- 1 pooled (same day type, circular), person only
  SELECT zone_key, label, day_type, ((hour + o.off + 24) % 24)::smallint AS hour,
         COUNT(*) AS samples, percentile_disc(0.99) WITHIN GROUP (ORDER BY dur) AS p99
  FROM ev_obs CROSS JOIN (VALUES (-1), (0), (1)) AS o(off)
  WHERE label = 'person' AND dur IS NOT NULL AND dur >= 0
  GROUP BY 1, 2, 3, 4
)
SELECT p.build_id, g.zone_key,
       (CASE WHEN g.zone_key LIKE 'area:%' THEN 'area' ELSE 'camera' END)::"SecurityBaselineKeyKind",
       a.zone_id,
       CASE WHEN g.zone_key LIKE 'camera:%' THEN substr(g.zone_key, 8) END,
       a.zone_version,
       COALESCE(a.cams, ARRAY[substr(g.zone_key, 8)]),
       g.label, g.day_type, g.hour,
       COALESCE(o.n, 0), COALESCE(c.d, 0), COALESCE(c.c, 0), COALESCE(round(o.secs / 60.0), 0)::int,
       COALESCE(w.samples, 0), w.p99
FROM grid g CROSS JOIN p
LEFT JOIN area a ON g.zone_key = 'area:' || a.zone_id
LEFT JOIN obs o ON o.zone_key = g.zone_key AND o.day_type = g.day_type AND o.hour = g.hour
LEFT JOIN cnt c ON c.zone_key = g.zone_key AND c.label = g.label AND c.day_type = g.day_type AND c.hour = g.hour
LEFT JOIN dwell w ON w.zone_key = g.zone_key AND w.label = g.label AND w.day_type = g.day_type AND w.hour = g.hour`;
}

export type FullBuildOutcome =
  | { status: "built"; buildId: string; cellCount: number; eventCount: number }
  | { status: "claimed_elsewhere" }
  | { status: "failed"; buildId: string; error: string };

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

/**
 * What a failed build stores (≤ 500 chars, one line): Postgres's own message
 * when Prisma carries it (`meta.message`, e.g. "canceling statement due to
 * statement timeout"), else the first non-empty line. It is shown to nobody
 * verbatim — the health row maps it to plain words.
 */
export function buildErrorText(err: unknown): string {
  const meta = (err as { meta?: { message?: unknown; code?: unknown } } | null)?.meta;
  const raw =
    typeof meta?.message === "string" && meta.message.length > 0
      ? meta.message
      : err instanceof Error
        ? err.message
        : String(err);
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "unknown error";
  return line.slice(0, 500);
}

type BuildDb = Pick<PrismaClient, "$transaction" | "securityBaselineBuild" | "securityCoverageSpan">;

/**
 * A full build (§6.5):
 *   1. a `building` claim older than 10 minutes is failed as 'interrupted'
 *      (its process died or timed out);
 *   2. claim: insert `building`. A unique violation on
 *      SecurityBaselineBuild_one_building means another builder holds it →
 *      skip. This is the single-flight guard that holds even when a tick
 *      outlives its 60 s advisory-lock transaction;
 *   3. ONE READ COMMITTED transaction (55 s) under a 45 s statement timeout:
 *      the statement, then the old `ready` → superseded and this → ready.
 *      The partial unique index makes "exactly one ready" a database fact,
 *      and readers see the old cells or the new, never a mix;
 *   4. on a throw, a SEPARATE write marks this build failed; the previous
 *      ready build keeps serving;
 *   5. after commit, prune: superseded / failed builds beyond the newest 14
 *      (their cells cascade), and closed coverage spans older than 35 days.
 */
export async function runFullBuild(
  prisma: BuildDb,
  trigger: SecurityBaselineBuildTrigger,
  zone: string,
  now: Date,
  /** Test seam: the pg lane proves a timed-out build fails cleanly with `'1ms'`. */
  opts: { statementTimeout?: string } = {},
): Promise<FullBuildOutcome> {
  const statementTimeout = opts.statementTimeout ?? BASELINE_BUILD_STATEMENT_TIMEOUT;
  if (!/^[0-9]+(ms|s)$/.test(statementTimeout)) throw new RangeError(`not a statement timeout: ${statementTimeout}`);
  await prisma.securityBaselineBuild.updateMany({
    where: { state: "building", startedAt: { lt: new Date(now.getTime() - BASELINE_BUILD_CLAIM_STALE_MS) } },
    data: { state: "failed", error: "interrupted", finishedAt: now },
  });

  const window = windowFor(now, zone);
  let buildId: string;
  try {
    const claim = await prisma.securityBaselineBuild.create({
      data: {
        state: "building",
        trigger,
        timezone: zone,
        windowFrom: window.from,
        windowTo: window.to,
        rulesetVersion: SECURITY_BASELINE_RULESET_VERSION,
        startedAt: now,
      },
    });
    buildId = claim.id;
  } catch (err) {
    if (isUniqueViolation(err)) return { status: "claimed_elsewhere" };
    throw err;
  }

  let counts: { cellCount: number; eventCount: number };
  try {
    counts = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${statementTimeout}'`);
        const cellCount = await buildCells(tx, cellsInput(buildId, window, zone, null, true));
        const agg = await tx.securityBaselineCell.aggregate({
          where: { buildId, keyKind: "camera" },
          _sum: { eventCount: true },
        });
        const eventCount = agg._sum.eventCount ?? 0;
        await tx.securityBaselineBuild.updateMany({ where: { state: "ready" }, data: { state: "superseded" } });
        await tx.securityBaselineBuild.update({
          where: { id: buildId },
          data: { state: "ready", finishedAt: now, cellCount, eventCount, cellsVersion: 1 },
        });
        return { cellCount, eventCount };
      },
      { ...READ_COMMITTED_TX, timeout: BASELINE_BUILD_TX_TIMEOUT_MS },
    );
  } catch (err) {
    const error = buildErrorText(err);
    logger.error({ err, buildId, trigger, zone }, "security baseline build failed — the previous ready build keeps serving");
    await prisma.securityBaselineBuild.updateMany({
      where: { id: buildId, state: "building" },
      data: { state: "failed", error, finishedAt: now },
    });
    return { status: "failed", buildId, error };
  }

  try {
    await pruneBaselines(prisma, now);
  } catch (err) {
    // The build itself stands; the next build prunes again.
    logger.warn({ err }, "security baseline prune failed");
  }
  logger.info({ buildId, trigger, zone, window, ...counts }, "security baselines built");
  return { status: "built", buildId, ...counts };
}

function cellsInput(
  buildId: string,
  window: BaselineWindow,
  zone: string,
  onlyZoneIds: readonly string[] | null,
  includeCameraKeys: boolean,
): BuildCellsInput {
  const bounds = windowBounds(window, zone);
  return {
    buildId,
    slots: windowSlots(window.from, window.to, zone),
    windowStart: bounds.start,
    windowEnd: bounds.end,
    onlyZoneIds,
    includeCameraKeys,
  };
}

async function pruneBaselines(prisma: Pick<PrismaClient, "securityBaselineBuild" | "securityCoverageSpan">, now: Date): Promise<void> {
  const ENDED = ["superseded", "failed"] as const;
  const old = await prisma.securityBaselineBuild.findMany({
    where: { state: { in: [...ENDED] } },
    orderBy: { startedAt: "desc" },
    skip: BASELINE_BUILDS_KEPT,
    select: { id: true },
  });
  if (old.length > 0) {
    await prisma.securityBaselineBuild.deleteMany({ where: { id: { in: old.map((b) => b.id) }, state: { in: [...ENDED] } } });
  }
  await prisma.securityCoverageSpan.deleteMany({
    where: { state: "closed", coveredUntil: { lt: new Date(now.getTime() - BASELINE_COVERAGE_KEEP_DAYS * 86_400_000) } },
  });
}

export type AreaRebuildOutcome = { status: "rebuilt"; buildId: string; inserted: number } | { status: "no_ready_build" };

/**
 * Rebuild some areas' cells in the READY build, from that build's own window
 * and zone (§6.5, D2): one READ COMMITTED transaction under the same statement
 * timeout — delete those area keys' cells, run the statement for just those
 * areas (no camera keys), bump `cellsVersion`. An area that is archived or
 * has no active link gets no cells: it is simply absent from `link`.
 * The caller runs this only against a FRESH ready build (windowTo ≥ today − 2),
 * so every event the window needs is still inside event retention.
 */
export async function rebuildAreas(
  prisma: Pick<PrismaClient, "$transaction" | "securityBaselineBuild">,
  zoneIds: readonly string[],
): Promise<AreaRebuildOutcome> {
  const ready = await prisma.securityBaselineBuild.findFirst({
    where: { state: "ready" },
    select: { id: true, timezone: true, windowFrom: true, windowTo: true },
  });
  if (!ready) return { status: "no_ready_build" };
  const input = cellsInput(ready.id, { from: ready.windowFrom, to: ready.windowTo }, ready.timezone, zoneIds, false);
  const inserted = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${BASELINE_BUILD_STATEMENT_TIMEOUT}'`);
      // Released at commit or rollback; bounded by the statement timeout above.
      await tx.$queryRawUnsafe(`SELECT (pg_advisory_xact_lock(hashtext('${BASELINE_CELLS_LOCK_KEY}')) IS NULL) AS locked`);
      await tx.securityBaselineCell.deleteMany({
        where: { buildId: ready.id, zoneKey: { in: zoneIds.map((id) => `area:${id}`) } },
      });
      const n = await buildCells(tx, input);
      const cellCount = await tx.securityBaselineCell.count({ where: { buildId: ready.id } });
      await tx.securityBaselineBuild.update({
        where: { id: ready.id },
        data: { cellsVersion: { increment: 1 }, cellCount },
      });
      return n;
    },
    { ...READ_COMMITTED_TX, timeout: BASELINE_BUILD_TX_TIMEOUT_MS },
  );
  return { status: "rebuilt", buildId: ready.id, inserted };
}
