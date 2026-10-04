/**
 * WARP-3524 (WS-8) — Insights: what `GET /api/pm/insights` computes.
 *
 * Throughput, created-vs-finished, cycle and lead time, cumulative flow,
 * workload and aging work-in-progress, for ONE project or for the whole
 * workspace. Every number is an aggregate in SQL (`$queryRaw`, parameters bound,
 * never interpolated) over the rows PM already writes; nothing new is stored.
 * The one thing PM has no table for is history, so history is rebuilt from
 * `PmActivity`, and the rules for that are the part to read before changing
 * anything here.
 *
 * ── Definitions ─────────────────────────────────────────────────────────────
 *  - In scope: work items that are not archived, in the chosen project, or in
 *    every non-archived project of the workspace.
 *  - Open: the state's group is backlog / unstarted / started, or the item has
 *    no state at all (an uncategorised item counts as unstarted, the same rule
 *    `listProjects` and `getSummary` apply).
 *  - Finished: `isCompleted` AND the state's group is `completed`, stamped at
 *    `completedAt`. Cancelled work is NOT finished work: it is left out of
 *    throughput, cycle time and lead time, and shows as its own band in the
 *    cumulative flow. (`isCompleted` itself is true for both groups.)
 *  - Lead time: `createdAt` → `completedAt`. Cycle time: the FIRST time the item
 *    entered a state in the `started` group → `completedAt`. An item that never
 *    passed through `started` (Todo straight to Done) has a lead time but no
 *    cycle time. Work that was re-opened is measured from its first start.
 *  - Days and weeks are the workspace's own calendar (`Workspace.tz` → the box
 *    zone → UTC). Weeks start on Monday. `from` is moved back to the first day of
 *    the bucket that holds it, so no bucket is ever half-counted at the left
 *    edge; `to` is clamped to today. The response says what it measured.
 *  - Workload and aging work-in-progress describe NOW, not the range.
 *
 * ── Rebuilding history (cumulative flow, started-at, aging) ─────────────────
 *  `state_changed` rows store the OLD and NEW state ids, and `created` rows
 *  store nothing about the landing state. So an item's timeline is: the state it
 *  was created in (the old value of its FIRST state change, or its current state
 *  if it never changed), then each state change's new value in time order. Each
 *  stretch between two changes puts the item in exactly one group, so every item
 *  is in exactly one band every day and the bands always add up.
 *
 *  What that cannot know, stated rather than guessed:
 *   - A state that has since been deleted no longer resolves to a group. Its
 *     stretch is reported as `unknown`. `deleteState` re-parents the items to the
 *     default state without writing an activity row, so an item that was parked
 *     in a deleted state stays `unknown` until its next real move.
 *   - A state whose group was edited is read through its CURRENT group; history
 *     is not re-interpreted as it was at the time.
 *   - Items that were hard-deleted take their activity with them and are absent
 *     from every day. Archived items are left out entirely.
 *   - Only `state_changed` and `created` are used. Many other verbs are declared
 *     in the schema and not yet written; none is relied on here.
 *
 * ── Estimates ───────────────────────────────────────────────────────────────
 *  "Open estimate" needs `PmWorkItem.estimate`, which WS-4 adds. This slice must
 *  ship without it, so the column is probed in the catalog on each (cached)
 *  computation: absent, `estimateAvailable` is false and every estimate is 0;
 *  present, it is summed. No code change is needed when WS-4 lands.
 *
 * ── Caching ─────────────────────────────────────────────────────────────────
 *  One in-process entry per (project or workspace, range, bucket, zone) for five
 *  minutes (`pm-insights-cache.ts`). `meta.generatedAt` says how fresh a response
 *  is. Reads are household-shared like the rest of PM, so one entry serves every
 *  reader; there is nothing per-user in the key.
 */

import type { PrismaClient } from "@prisma/client";
import {
  isCalendarYmd,
  isoWeekdayOf,
  parseYmd,
  ymdAddDays,
  zonedDateMinuteToUtc,
} from "../../lib/zoned-time.js";
import { localDayInZone } from "../scene-schedule-tz-backfill.service.js";
import { HOME_WORKSPACE_SLUG, PM_ERRORS } from "./pm.service.js";
import { TtlCache } from "./pm-insights-cache.js";

// ── Contract ────────────────────────────────────────────────────────────────

export const INSIGHTS_GROUP_BY = ["day", "week", "month"] as const;
export type InsightsGroupBy = (typeof INSIGHTS_GROUP_BY)[number];

export const INSIGHTS_ERRORS = {
  /** `from` after `to`, a range wholly in the future, or one over a year long. */
  INVALID_RANGE: "invalid_range",
} as const;

/** The range when the caller names none: twelve weeks, ending today. */
export const INSIGHTS_DEFAULT_DAYS = 84;
/** The longest range accepted (days). The cumulative flow is one point per day. */
export const INSIGHTS_MAX_DAYS = 366;
export const INSIGHTS_CACHE_TTL_MS = 5 * 60 * 1000;
const INSIGHTS_CACHE_MAX_ENTRIES = 64;
/** Histogram edges for cycle and lead time, in days: under 1, 1–2, 2–4, 4–7, 7–14, 14–30, 30 or more. */
export const INSIGHTS_DURATION_EDGES_DAYS = [1, 2, 4, 7, 14, 30] as const;
/** How many of the oldest in-progress items the aging list carries. */
export const AGING_WIP_LIMIT = 10;

export type ApiInsightsGroup =
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "cancelled"
  | "unknown";

const CFD_GROUPS: readonly ApiInsightsGroup[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
  "unknown",
];

export interface ApiInsightsDuration {
  /** Items measured: finished inside the range (and, for cycle time, started). */
  count: number;
  /** Days, one decimal. Null when nothing was measured. */
  p50: number | null;
  p85: number | null;
  p95: number | null;
  /** `counts[i]` items took under `edgesDays[i]` days; the last entry took at least the last edge. */
  edgesDays: number[];
  counts: number[];
}

export interface ApiPmInsights {
  meta: {
    scope: "project" | "workspace";
    projectId: string | null;
    /** The range measured, `YYYY-MM-DD`, workspace-local days. */
    from: string;
    to: string;
    groupBy: InsightsGroupBy;
    timezone: string;
    generatedAt: string;
    /** Live items in scope, in any state. Zero means there is nothing to chart yet. */
    itemCount: number;
  };
  throughput: {
    total: number;
    buckets: Array<{ start: string; completed: number }>;
  };
  createdVsCompleted: {
    created: number;
    completed: number;
    buckets: Array<{ start: string; created: number; completed: number }>;
  };
  cycleTime: ApiInsightsDuration;
  leadTime: ApiInsightsDuration;
  cumulativeFlow: {
    /** The bands present, in a fixed order. `unknown` is listed only when some day has one. */
    groups: ApiInsightsGroup[];
    days: Array<{ date: string } & Record<ApiInsightsGroup, number>>;
  };
  workload: {
    /** False until `PmWorkItem.estimate` exists; every `openEstimate` is then 0. */
    estimateAvailable: boolean;
    /** Largest first. `userId` null is the unassigned row, present only when it is not empty. */
    assignees: Array<{ userId: string | null; openItems: number; openEstimate: number }>;
  };
  agingWip: {
    /** Every in-progress item, not just the ones listed. */
    total: number;
    /** The oldest first, at most `AGING_WIP_LIMIT`. */
    items: Array<{
      id: string;
      key: string;
      name: string;
      stateName: string;
      since: string;
      ageDays: number;
    }>;
  };
}

export interface InsightsQuery {
  projectId?: string;
  /** Workspace slug when no project is named. Defaults to the home workspace. */
  workspaceSlug?: string;
  from?: string;
  to?: string;
  groupBy?: InsightsGroupBy;
}

export interface InsightsOptions {
  /** The clock. Also the cache's clock, so a test can step past the TTL. */
  now?: Date;
  /** Skips the `Workspace.tz` lookup. For tests. */
  timezone?: string;
}

// ── Range ───────────────────────────────────────────────────────────────────

/** The first day of the bucket that holds `ymd`. */
export function bucketStart(ymd: string, groupBy: InsightsGroupBy): string {
  if (groupBy === "day") return ymd;
  if (groupBy === "week") return ymdAddDays(ymd, -(isoWeekdayOf(ymd) - 1));
  return `${ymd.slice(0, 7)}-01`;
}

function daysInclusive(from: string, to: string): number {
  const a = parseYmd(from);
  const b = parseYmd(to);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000) + 1;
}

/**
 * The range actually measured. `to` defaults to today and is clamped to it
 * (nothing has happened tomorrow); `from` defaults to twelve weeks back and is
 * moved back to the start of its bucket. Throws `invalid_range` for a `from`
 * after `to` — including a range that starts in the future — or a range longer
 * than a year.
 */
export function resolveInsightsRange(
  input: { from?: string; to?: string; groupBy: InsightsGroupBy },
  today: string,
): { from: string; to: string } {
  for (const ymd of [input.from, input.to]) {
    if (ymd !== undefined && !isCalendarYmd(ymd)) throw new Error(INSIGHTS_ERRORS.INVALID_RANGE);
  }
  let to = input.to ?? today;
  if (to > today) to = today;
  const requestedFrom = input.from ?? ymdAddDays(to, -(INSIGHTS_DEFAULT_DAYS - 1));
  if (requestedFrom > to) throw new Error(INSIGHTS_ERRORS.INVALID_RANGE);
  if (daysInclusive(requestedFrom, to) > INSIGHTS_MAX_DAYS) {
    throw new Error(INSIGHTS_ERRORS.INVALID_RANGE);
  }
  return { from: bucketStart(requestedFrom, input.groupBy), to };
}

// ── Row shapes of the raw queries ───────────────────────────────────────────

interface FlowRow {
  bucket: string;
  created: number;
  completed: number;
}
interface CfdRow {
  day: string;
  grp: ApiInsightsGroup;
  n: number;
}
interface DurationRow {
  kind: "lead" | "cycle";
  bucket: number | null;
  n: number;
  p50: number | null;
  p85: number | null;
  p95: number | null;
}
interface WorkloadRow {
  user_id: string | null;
  open_items: number;
}
interface EstimateRow {
  user_id: string | null;
  open_estimate: number;
}
interface AgingRow {
  id: string;
  key: string;
  name: string;
  state_name: string;
  since: Date;
  total: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const roundOrNull = (n: number | null): number | null => (n === null ? null : round1(n));

// ── Computation ─────────────────────────────────────────────────────────────

async function resolveScope(
  prisma: PrismaClient,
  q: InsightsQuery,
): Promise<{ scope: "project" | "workspace"; projectId: string | null; projectIds: string[] }> {
  if (q.projectId) {
    const project = await prisma.pmProject.findUnique({
      where: { id: q.projectId },
      select: { id: true },
    });
    if (!project) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
    return { scope: "project", projectId: project.id, projectIds: [project.id] };
  }
  // Archived projects are out of the workspace view, as they are out of the
  // summary strip. Naming one by id (above) still works.
  const projects = await prisma.pmProject.findMany({
    where: { workspace: { slug: q.workspaceSlug ?? HOME_WORKSPACE_SLUG }, isArchived: false },
    select: { id: true },
  });
  return { scope: "workspace", projectId: null, projectIds: projects.map((p) => p.id) };
}

async function computeInsights(
  prisma: PrismaClient,
  q: InsightsQuery,
  now: Date,
  timezone: string | undefined,
): Promise<ApiPmInsights> {
  const groupBy = q.groupBy ?? "week";
  const workspace = timezone ? null : await prisma.workspace.findUnique({
    where: { id: 1 },
    select: { tz: true },
  });
  const { date: today, zone } = localDayInZone(now, timezone ?? workspace?.tz ?? null);
  const { from, to } = resolveInsightsRange({ from: q.from, to: q.to, groupBy }, today);
  const { scope, projectId, projectIds } = await resolveScope(prisma, q);

  // The range as UTC instants, [fromTs, toTs): local midnight of the first day
  // to local midnight after the last. Strings, cast to `timestamp` in SQL — the
  // columns are Prisma's zone-less UTC `timestamp(3)`, so the comparison must
  // not depend on the database session's TimeZone.
  const fromTs = zonedDateMinuteToUtc(from, 0, zone).toISOString();
  const toTs = zonedDateMinuteToUtc(ymdAddDays(to, 1), 0, zone).toISOString();
  // As text and cast in SQL: a JS number array is not bound with a type Postgres can
  // be trusted to read as `float8[]`.
  const edges = INSIGHTS_DURATION_EDGES_DAYS.map(String);
  const step = groupBy === "day" ? "1 day" : groupBy === "week" ? "1 week" : "1 month";

  const estimateProbe = prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'PmWorkItem' AND column_name = 'estimate'
    ) AS present`;

  const [flowRows, cfdRows, durationRows, workloadRows, agingRows, itemCount, probe] =
    await Promise.all([
      // Created and finished per bucket, zero-filled so the axis is continuous.
      prisma.$queryRaw<FlowRow[]>`
        WITH buckets AS (
          SELECT g::date AS bucket
            FROM generate_series(${from}::timestamp, ${to}::timestamp, ${step}::interval) AS g
        ),
        created AS (
          SELECT date_trunc(${groupBy}, (w."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone})::date AS bucket,
                 count(*) AS n
            FROM "PmWorkItem" w
           WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
             AND w."createdAt" >= ${fromTs}::timestamp AND w."createdAt" < ${toTs}::timestamp
           GROUP BY 1
        ),
        finished AS (
          SELECT date_trunc(${groupBy}, (w."completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${zone})::date AS bucket,
                 count(*) AS n
            FROM "PmWorkItem" w
            JOIN "PmState" s ON s.id = w."stateId"
           WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
             AND w."isCompleted" = true AND s."group" = 'completed'
             AND w."completedAt" >= ${fromTs}::timestamp AND w."completedAt" < ${toTs}::timestamp
           GROUP BY 1
        )
        SELECT to_char(b.bucket, 'YYYY-MM-DD') AS bucket,
               coalesce(c.n, 0)::int AS created,
               coalesce(f.n, 0)::int AS completed
          FROM buckets b
          LEFT JOIN created c ON c.bucket = b.bucket
          LEFT JOIN finished f ON f.bucket = b.bucket
         ORDER BY b.bucket`,

      // Cumulative flow: one row per (day, group), the count at the END of the day.
      // See "Rebuilding history" above for what `steps` and `segments` are.
      prisma.$queryRaw<CfdRow[]>`
        WITH items AS (
          SELECT w.id, w."createdAt", w."stateId"
            FROM "PmWorkItem" w
           WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
             AND w."createdAt" < ${toTs}::timestamp
        ),
        changes AS (
          SELECT a."workItemId" AS item, a."createdAt" AS ts,
                 a."oldValue" AS old_state, a."newValue" AS new_state,
                 row_number() OVER (PARTITION BY a."workItemId" ORDER BY a."createdAt", a.id) AS rn
            FROM "PmActivity" a
           WHERE a.verb = 'state_changed' AND a."workItemId" IN (SELECT id FROM items)
        ),
        steps AS (
          SELECT i.id AS item, i."createdAt" AS ts, 0 AS ord,
                 CASE WHEN c.item IS NULL THEN i."stateId" ELSE c.old_state END AS state_id
            FROM items i
            LEFT JOIN changes c ON c.item = i.id AND c.rn = 1
          UNION ALL
          SELECT item, ts, rn AS ord, new_state FROM changes
        ),
        segments AS (
          SELECT s.item, s.ts AS seg_start,
                 lead(s.ts) OVER (PARTITION BY s.item ORDER BY s.ts, s.ord) AS seg_end,
                 CASE WHEN s.state_id IS NULL THEN 'unstarted'
                      WHEN st.id IS NULL THEN 'unknown'
                      ELSE st."group"::text END AS grp
            FROM steps s
            LEFT JOIN "PmState" st ON st.id = s.state_id
        ),
        events AS (
          SELECT seg_start AS ts, grp, 1 AS delta FROM segments
          UNION ALL
          SELECT seg_end AS ts, grp, -1 AS delta FROM segments WHERE seg_end IS NOT NULL
        ),
        days AS (
          SELECT g::date AS day
            FROM generate_series(${from}::timestamp, ${to}::timestamp, interval '1 day') AS g
        ),
        bands AS (
          SELECT unnest(ARRAY['backlog','unstarted','started','completed','cancelled','unknown']) AS grp
        ),
        base AS (
          SELECT grp, sum(delta) AS n FROM events WHERE ts < ${fromTs}::timestamp GROUP BY grp
        ),
        daily AS (
          SELECT grp, date_trunc('day', (ts AT TIME ZONE 'UTC') AT TIME ZONE ${zone})::date AS day,
                 sum(delta) AS n
            FROM events
           WHERE ts >= ${fromTs}::timestamp AND ts < ${toTs}::timestamp
           GROUP BY 1, 2
        )
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day, g.grp AS grp,
               (coalesce(b.n, 0) + coalesce(sum(dl.n) OVER (PARTITION BY g.grp ORDER BY d.day), 0))::int AS n
          FROM days d
          CROSS JOIN bands g
          LEFT JOIN base b ON b.grp = g.grp
          LEFT JOIN daily dl ON dl.grp = g.grp AND dl.day = d.day
         ORDER BY d.day, g.grp`,

      // Lead and cycle time of what finished in the range: percentiles and a
      // histogram, one statement.
      prisma.$queryRaw<DurationRow[]>`
        WITH done AS (
          SELECT w.id, w."createdAt", w."completedAt"
            FROM "PmWorkItem" w
            JOIN "PmState" s ON s.id = w."stateId"
           WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
             AND w."isCompleted" = true AND s."group" = 'completed'
             AND w."completedAt" >= ${fromTs}::timestamp AND w."completedAt" < ${toTs}::timestamp
        ),
        first_change AS (
          SELECT DISTINCT ON (a."workItemId") a."workItemId" AS item, a."oldValue" AS old_state
            FROM "PmActivity" a
           WHERE a.verb = 'state_changed' AND a."workItemId" IN (SELECT id FROM done)
           ORDER BY a."workItemId", a."createdAt", a.id
        ),
        first_start AS (
          SELECT a."workItemId" AS item, min(a."createdAt") AS ts
            FROM "PmActivity" a
            JOIN "PmState" ns ON ns.id = a."newValue" AND ns."group" = 'started'
           WHERE a.verb = 'state_changed' AND a."workItemId" IN (SELECT id FROM done)
           GROUP BY a."workItemId"
        ),
        spans AS (
          SELECT d.id,
                 (EXTRACT(EPOCH FROM (d."completedAt" - d."createdAt")) / 86400)::double precision AS lead_days,
                 (EXTRACT(EPOCH FROM (
                    d."completedAt" - LEAST(fs.ts, CASE WHEN os."group" = 'started' THEN d."createdAt" END)
                 )) / 86400)::double precision AS cycle_days
            FROM done d
            LEFT JOIN first_change fc ON fc.item = d.id
            LEFT JOIN "PmState" os ON os.id = fc.old_state
            LEFT JOIN first_start fs ON fs.item = d.id
        )
        SELECT 'lead'::text AS kind, NULL::int AS bucket, count(lead_days)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY lead_days) AS p50,
               percentile_cont(0.85) WITHIN GROUP (ORDER BY lead_days) AS p85,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY lead_days) AS p95
          FROM spans
        UNION ALL
        SELECT 'cycle', NULL, count(cycle_days)::int,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY cycle_days),
               percentile_cont(0.85) WITHIN GROUP (ORDER BY cycle_days),
               percentile_cont(0.95) WITHIN GROUP (ORDER BY cycle_days)
          FROM spans
        UNION ALL
        SELECT 'lead', width_bucket(lead_days, (${edges}::text[])::double precision[]), count(*)::int, NULL, NULL, NULL
          FROM spans GROUP BY 2
        UNION ALL
        SELECT 'cycle', width_bucket(cycle_days, (${edges}::text[])::double precision[]), count(*)::int, NULL, NULL, NULL
          FROM spans WHERE cycle_days IS NOT NULL GROUP BY 2`,

      // Workload: open items per assignee. An item with two assignees counts
      // for both, so the rows can add up to more than the open items.
      prisma.$queryRaw<WorkloadRow[]>`
        SELECT a."userId" AS user_id, count(*)::int AS open_items
          FROM "PmWorkItem" w
          LEFT JOIN "PmState" s ON s.id = w."stateId"
          JOIN "PmWorkItemAssignee" a ON a."workItemId" = w.id
         WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
           AND (w."stateId" IS NULL OR s."group" IN ('backlog', 'unstarted', 'started'))
         GROUP BY a."userId"
        UNION ALL
        SELECT NULL, count(*)::int
          FROM "PmWorkItem" w
          LEFT JOIN "PmState" s ON s.id = w."stateId"
         WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
           AND (w."stateId" IS NULL OR s."group" IN ('backlog', 'unstarted', 'started'))
           AND NOT EXISTS (SELECT 1 FROM "PmWorkItemAssignee" a WHERE a."workItemId" = w.id)`,

      // Aging work in progress: how long each in-progress item has been in the
      // started group. The clock starts at the LAST move into `started` from
      // outside it (a move between two started states does not restart it), or
      // at creation for an item that was born in progress.
      prisma.$queryRaw<AgingRow[]>`
        WITH wip AS (
          SELECT w.id, w.name, w."sequenceId", w."createdAt", p.identifier, s.name AS state_name
            FROM "PmWorkItem" w
            JOIN "PmState" s ON s.id = w."stateId" AND s."group" = 'started'
            JOIN "PmProject" p ON p.id = w."projectId"
           WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
        ),
        entered AS (
          SELECT a."workItemId" AS item, max(a."createdAt") AS ts
            FROM "PmActivity" a
            JOIN "PmState" ns ON ns.id = a."newValue" AND ns."group" = 'started'
            LEFT JOIN "PmState" os ON os.id = a."oldValue"
           WHERE a.verb = 'state_changed' AND a."workItemId" IN (SELECT id FROM wip)
             AND os."group" IS DISTINCT FROM 'started'
           GROUP BY a."workItemId"
        )
        SELECT wip.id, wip.identifier || '-' || wip."sequenceId" AS key, wip.name, wip.state_name,
               coalesce(e.ts, wip."createdAt") AS since,
               (count(*) OVER ())::int AS total
          FROM wip
          LEFT JOIN entered e ON e.item = wip.id
         ORDER BY since ASC, wip.id ASC
         LIMIT ${AGING_WIP_LIMIT}`,

      prisma.pmWorkItem.count({ where: { projectId: { in: projectIds }, isArchived: false } }),
      estimateProbe,
    ]);

  // Estimates only if the column exists; a separate statement so the common one
  // above stays a single static text.
  const estimateAvailable = probe[0]?.present === true;
  const estimateRows = estimateAvailable
    ? await prisma.$queryRaw<EstimateRow[]>`
        SELECT a."userId" AS user_id, coalesce(sum(w."estimate"), 0)::double precision AS open_estimate
          FROM "PmWorkItem" w
          LEFT JOIN "PmState" s ON s.id = w."stateId"
          JOIN "PmWorkItemAssignee" a ON a."workItemId" = w.id
         WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
           AND (w."stateId" IS NULL OR s."group" IN ('backlog', 'unstarted', 'started'))
         GROUP BY a."userId"
        UNION ALL
        SELECT NULL, coalesce(sum(w."estimate"), 0)::double precision
          FROM "PmWorkItem" w
          LEFT JOIN "PmState" s ON s.id = w."stateId"
         WHERE w."projectId" = ANY(${projectIds}::text[]) AND w."isArchived" = false
           AND (w."stateId" IS NULL OR s."group" IN ('backlog', 'unstarted', 'started'))
           AND NOT EXISTS (SELECT 1 FROM "PmWorkItemAssignee" a WHERE a."workItemId" = w.id)`
    : [];

  return shapeInsights({
    now,
    from,
    to,
    groupBy,
    zone,
    scope,
    projectId,
    itemCount,
    flowRows,
    cfdRows,
    durationRows,
    workloadRows,
    estimateRows,
    estimateAvailable,
    agingRows,
  });
}

function shapeDuration(rows: DurationRow[], kind: "lead" | "cycle"): ApiInsightsDuration {
  const edgesDays = [...INSIGHTS_DURATION_EDGES_DAYS];
  const counts = new Array<number>(edgesDays.length + 1).fill(0);
  let summary: DurationRow | undefined;
  for (const r of rows) {
    if (r.kind !== kind) continue;
    if (r.bucket === null) summary = r;
    else counts[r.bucket] = r.n;
  }
  // The statement emits one summary row per kind, even over no items (an
  // aggregate always returns a row). Zeros here would read as "nothing
  // finished", so a missing row is a bug to surface, not a default to supply.
  if (!summary) throw new Error(`insights: no ${kind} duration summary row`);
  return {
    count: summary.n,
    p50: roundOrNull(summary.p50),
    p85: roundOrNull(summary.p85),
    p95: roundOrNull(summary.p95),
    edgesDays,
    counts,
  };
}

function shapeInsights(i: {
  now: Date;
  from: string;
  to: string;
  groupBy: InsightsGroupBy;
  zone: string;
  scope: "project" | "workspace";
  projectId: string | null;
  itemCount: number;
  flowRows: FlowRow[];
  cfdRows: CfdRow[];
  durationRows: DurationRow[];
  workloadRows: WorkloadRow[];
  estimateRows: EstimateRow[];
  estimateAvailable: boolean;
  agingRows: AgingRow[];
}): ApiPmInsights {
  const throughputBuckets = i.flowRows.map((r) => ({ start: r.bucket, completed: r.completed }));

  // Pivot (day, group, n) rows into one object per day.
  const byDay = new Map<string, { date: string } & Record<ApiInsightsGroup, number>>();
  for (const r of i.cfdRows) {
    let day = byDay.get(r.day);
    if (!day) {
      day = { date: r.day, backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0, unknown: 0 };
      byDay.set(r.day, day);
    }
    day[r.grp] = r.n;
  }
  const days = [...byDay.values()];
  const hasUnknown = days.some((d) => d.unknown > 0);

  const estimates = new Map<string | null, number>(i.estimateRows.map((r) => [r.user_id, r.open_estimate]));
  const assignees = i.workloadRows
    .filter((r) => r.open_items > 0)
    .map((r) => ({
      userId: r.user_id,
      openItems: r.open_items,
      openEstimate: round1(estimates.get(r.user_id) ?? 0),
    }))
    // Largest first; ties by id so the order is stable across reads. The
    // unassigned row (null id) sorts last among equals.
    .sort(
      (a, b) =>
        b.openItems - a.openItems ||
        (a.userId === null ? 1 : 0) - (b.userId === null ? 1 : 0) ||
        String(a.userId).localeCompare(String(b.userId)),
    );

  return {
    meta: {
      scope: i.scope,
      projectId: i.projectId,
      from: i.from,
      to: i.to,
      groupBy: i.groupBy,
      timezone: i.zone,
      generatedAt: i.now.toISOString(),
      itemCount: i.itemCount,
    },
    throughput: {
      total: throughputBuckets.reduce((n, b) => n + b.completed, 0),
      buckets: throughputBuckets,
    },
    createdVsCompleted: {
      created: i.flowRows.reduce((n, r) => n + r.created, 0),
      completed: i.flowRows.reduce((n, r) => n + r.completed, 0),
      buckets: i.flowRows.map((r) => ({ start: r.bucket, created: r.created, completed: r.completed })),
    },
    cycleTime: shapeDuration(i.durationRows, "cycle"),
    leadTime: shapeDuration(i.durationRows, "lead"),
    cumulativeFlow: {
      groups: CFD_GROUPS.filter((g) => g !== "unknown" || hasUnknown),
      days,
    },
    workload: { estimateAvailable: i.estimateAvailable, assignees },
    agingWip: {
      total: i.agingRows[0]?.total ?? 0,
      items: i.agingRows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        stateName: r.state_name,
        since: r.since.toISOString(),
        ageDays: round1(Math.max(0, (i.now.getTime() - r.since.getTime()) / 86_400_000)),
      })),
    },
  };
}

// ── Entry point ─────────────────────────────────────────────────────────────

const cache = new TtlCache<ApiPmInsights>(INSIGHTS_CACHE_TTL_MS, INSIGHTS_CACHE_MAX_ENTRIES);

/** Drops every cached response. For tests. */
export function clearInsightsCache(): void {
  cache.clear();
}

/**
 * Insights for a project (`projectId`) or for a workspace, cached for five
 * minutes per (scope, range, bucket, zone). Throws `project_not_found` for an
 * unknown project and `invalid_range` for a bad range; neither is cached.
 */
export async function getInsights(
  prisma: PrismaClient,
  query: InsightsQuery,
  opts: InsightsOptions = {},
): Promise<ApiPmInsights> {
  const now = opts.now ?? new Date();
  // The key is the REQUEST, not the resolved range: a cache hit must not cost
  // the `Workspace.tz` and project lookups it exists to avoid. "Today" can move
  // under a defaulted range for at most the five minutes an entry lives.
  const key = [
    query.projectId ? `p:${query.projectId}` : `w:${query.workspaceSlug ?? HOME_WORKSPACE_SLUG}`,
    query.from ?? "",
    query.to ?? "",
    query.groupBy ?? "week",
    opts.timezone ?? "",
  ].join("|");
  return cache.getOrCompute(key, now.getTime(), () =>
    computeInsights(prisma, query, now, opts.timezone),
  );
}
