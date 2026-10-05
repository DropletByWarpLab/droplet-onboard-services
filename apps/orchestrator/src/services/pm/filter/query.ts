/**
 * WARP-3522 (ADR-069 §8) — the query API's service: `POST /api/pm/work-items/query`.
 *
 * One entry point that answers "which work items?" for the board, the list, a
 * saved view's chip counts and (WS-6b, WS-7, WS-8, and the assistant later) every
 * other consumer, by the same path: validate → resolve what the filter names →
 * compile → `WHERE`. The old `GET /api/pm/projects/:id/work-items` and its
 * ad-hoc `?state=&assignee=&…` filters stay for the callers that use them
 * (mobile, `business_find`); nothing here replaces them.
 *
 * ── what a query ranges over ────────────────────────────────────────────────
 *
 * `projectId` set: that project, archived or not (looking at an archived project
 * is allowed — it is how Restore is reached). `projectId` absent: the whole
 * workspace, minus items of ARCHIVED projects, which is what the index and the
 * summary already mean by "the work". The `kind = PROJECT` scope applies to
 * rows, counts and groups alike; a service-desk row must never reach a
 * `/api/pm` read.
 *
 * ── archived ITEMS ──────────────────────────────────────────────────────────
 *
 * Hidden unless the filter says something about `isArchived`. That is the rule
 * the board and list have always had (`isArchived: false`), expressed so the
 * "Archived" view (WS-4) is simply `isArchived is true`, with no flag beside the
 * filter and no way for the two to disagree.
 *
 * ── what comes back ─────────────────────────────────────────────────────────
 *
 * The page (`work_items`, the SAME shape as every other work-item read — one
 * include, one mapper), an exact `total`, a `nextCursor` (null at the end), and
 * on request: `counts` (a number per named filter, for the saved-view chips),
 * `groups` (exact per-group counts for a group-by, over the whole result and not
 * just the page), and — when the filter named something that has since been
 * deleted — `stale` plus the `filter` that was actually applied.
 *
 * `groups` counts are per GROUP, not per item: an item with two assignees is in
 * two assignee groups, so the sum can exceed `total`.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  parseWorkItemKey,
  pmFilterConditions,
  type PmFilter,
  type PmGroupByField,
  type PmSortSpec,
} from "@droplet/shared-types";
import { canonicalZone, isValidIanaZone } from "../../../lib/zoned-time.js";
import { DEPARTMENT_SELECT } from "../pm-department.js";
import {
  HOME_WORKSPACE_SLUG,
  PM_ERRORS,
  WORK_ITEM_INCLUDE,
  mapWorkItem,
  type ApiWorkItem,
} from "../pm.service.js";
import { compileFilter } from "./compile.js";
import { decodeCursor, encodeCursor, queryFingerprint } from "./cursor.js";
import { PM_QUERY_ERRORS } from "./errors.js";
import { resolveFilterRefs, type PmStaleRef } from "./resolve.js";

type Where = Prisma.PmWorkItemWhereInput;

export const QUERY_DEFAULT_LIMIT = 100;
export const QUERY_MAX_LIMIT = 500;
/** Named filters one request may count. Brief §3.9 caps saved views at 12 per
 *  owner and 12 shared per project, plus the five built-ins. */
export const QUERY_MAX_COUNTS = 32;

export interface PmQueryRequest {
  /** One project, or — absent / null — the whole workspace. */
  projectId?: string | null;
  /** Workspace slug for a cross-project query. Default `home`. */
  workspace?: string;
  filter?: PmFilter;
  sort?: PmSortSpec[];
  groupBy?: PmGroupByField;
  cursor?: string | null;
  /** 0 returns no rows — only `total`, `counts`, `groups`. */
  limit?: number;
  /** IANA zone relative dates resolve in. Falls back to the box's zone, then UTC. */
  tz?: string;
  /** Named filters whose match counts to return. */
  counts?: Record<string, PmFilter>;
}

export interface PmQueryActor {
  /** The person asking, for `me`. `null` for the assistant's service principal. */
  userId: string | null;
}

export interface PmQueryGroup {
  /** The group's id (a state, an assignee, a priority …); `null` is "none". */
  key: string | null;
  count: number;
}

export interface PmQueryResult {
  work_items: ApiWorkItem[];
  nextCursor: string | null;
  total: number;
  groups?: PmQueryGroup[];
  counts?: Record<string, number>;
  /** Present only when the filter named rows that no longer exist. */
  stale?: PmStaleRef[];
  /** Present only with `stale`: the filter that was actually applied. */
  filter?: PmFilter;
}

// ── pieces ──────────────────────────────────────────────────────────────────

const ROW_INCLUDE = {
  ...WORK_ITEM_INCLUDE,
  // Every row joins its project: the key needs the identifier, a cross-project
  // page spans projects, and the department rule needs the project's.
  project: { select: { identifier: true, department: { select: DEPARTMENT_SELECT } } },
} satisfies Prisma.PmWorkItemInclude;

/** The orderBy for each sort field. `key` sorts by project identifier then
 *  number; `state` by the column's position then its name; a nullable date puts
 *  its empties last in BOTH directions; `priority` follows the enum's declared
 *  order (urgent first when ascending). */
const ORDER_BY: Record<
  PmSortSpec["field"],
  (dir: "asc" | "desc") => Prisma.PmWorkItemOrderByWithRelationInput[]
> = {
  sortOrder: (d) => [{ sortOrder: d }],
  key: (d) => [{ project: { identifier: d } }, { sequenceId: d }],
  name: (d) => [{ name: d }],
  state: (d) => [{ state: { sortOrder: d } }, { state: { name: d } }],
  priority: (d) => [{ priority: d }],
  dueDate: (d) => [{ dueDate: { sort: d, nulls: "last" } }],
  startDate: (d) => [{ startDate: { sort: d, nulls: "last" } }],
  createdAt: (d) => [{ createdAt: d }],
  updatedAt: (d) => [{ updatedAt: d }],
};

/** What a list is ordered by when nothing says: a project's manual order (the
 *  kanban's `sortOrder`), a workspace's newest change first. */
export function defaultSort(projectScoped: boolean): PmSortSpec[] {
  return projectScoped ? [{ field: "sortOrder", dir: "asc" }] : [{ field: "updatedAt", dir: "desc" }];
}

/** The requested keys, then `sequenceId` and `id` so the order is TOTAL — an
 *  offset cursor over a non-total order repeats and skips rows. */
export function buildOrderBy(sort: readonly PmSortSpec[]): Prisma.PmWorkItemOrderByWithRelationInput[] {
  return [
    ...sort.flatMap((s) => ORDER_BY[s.field](s.dir)),
    { sequenceId: "asc" },
    { id: "asc" },
  ];
}

/** The zone a request resolves relative dates in: the one it sent (refused if it
 *  is not an IANA zone), else the box's own, else UTC. */
export async function resolveQueryTimezone(prisma: PrismaClient, requested: string | undefined): Promise<string> {
  if (requested !== undefined) {
    if (!isValidIanaZone(requested)) throw new Error(PM_QUERY_ERRORS.INVALID_TIMEZONE);
    return canonicalZone(requested);
  }
  const ws = await prisma.workspace.findUnique({ where: { id: 1 }, select: { tz: true } });
  return ws?.tz && isValidIanaZone(ws.tz) ? canonicalZone(ws.tz) : "UTC";
}

function archivedDefault(filter: PmFilter): Where | null {
  for (const c of pmFilterConditions(filter)) if (c.field === "isArchived") return null;
  return { isArchived: false };
}

function toGroups(tally: Map<string | null, number>): PmQueryGroup[] {
  return [...tally]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key === b.key ? 0 : a.key === null ? 1 : b.key === null ? -1 : a.key < b.key ? -1 : 1));
}

async function computeGroups(prisma: PrismaClient, where: Where, by: PmGroupByField): Promise<PmQueryGroup[]> {
  const tally = new Map<string | null, number>();
  const add = (key: string | null, n: number) => tally.set(key, (tally.get(key) ?? 0) + n);

  switch (by) {
    case "state":
      for (const r of await prisma.pmWorkItem.groupBy({ by: ["stateId"], where, _count: { _all: true } })) {
        add(r.stateId, r._count._all);
      }
      break;
    case "priority":
      for (const r of await prisma.pmWorkItem.groupBy({ by: ["priority"], where, _count: { _all: true } })) {
        add(r.priority, r._count._all);
      }
      break;
    case "cycle":
      for (const r of await prisma.pmWorkItem.groupBy({ by: ["cycleId"], where, _count: { _all: true } })) {
        add(r.cycleId, r._count._all);
      }
      break;
    case "project":
      for (const r of await prisma.pmWorkItem.groupBy({ by: ["projectId"], where, _count: { _all: true } })) {
        add(r.projectId, r._count._all);
      }
      break;
    case "stateGroup": {
      // States are per project, so a cross-project view groups by what a state
      // MEANS. Group by state, then fold the states into their groups.
      const byState = await prisma.pmWorkItem.groupBy({ by: ["stateId"], where, _count: { _all: true } });
      const ids = byState.flatMap((r) => (r.stateId ? [r.stateId] : []));
      const states = ids.length
        ? await prisma.pmState.findMany({ where: { id: { in: ids } }, select: { id: true, group: true } })
        : [];
      const groupOf = new Map<string, string>(states.map((s) => [s.id, s.group]));
      for (const r of byState) add(r.stateId ? (groupOf.get(r.stateId) ?? null) : null, r._count._all);
      break;
    }
    case "assignee": {
      const [rows, unassigned] = await Promise.all([
        prisma.pmWorkItemAssignee.groupBy({ by: ["userId"], where: { workItem: { is: where } }, _count: { _all: true } }),
        prisma.pmWorkItem.count({ where: { AND: [where, { assignees: { none: {} } }] } }),
      ]);
      for (const r of rows) add(r.userId, r._count._all);
      if (unassigned > 0) add(null, unassigned);
      break;
    }
    case "label": {
      const [rows, unlabelled] = await Promise.all([
        prisma.pmWorkItemLabel.groupBy({ by: ["labelId"], where: { workItem: { is: where } }, _count: { _all: true } }),
        prisma.pmWorkItem.count({ where: { AND: [where, { labels: { none: {} } }] } }),
      ]);
      for (const r of rows) add(r.labelId, r._count._all);
      if (unlabelled > 0) add(null, unlabelled);
      break;
    }
    case "module": {
      const [rows, none] = await Promise.all([
        prisma.pmModuleWorkItem.groupBy({ by: ["moduleId"], where: { workItem: { is: where } }, _count: { _all: true } }),
        prisma.pmWorkItem.count({ where: { AND: [where, { modules: { none: {} } }] } }),
      ]);
      for (const r of rows) add(r.moduleId, r._count._all);
      if (none > 0) add(null, none);
      break;
    }
    case "department": {
      // The EFFECTIVE department: an item's own, else its project's.
      const [own, inheriting] = await Promise.all([
        prisma.pmWorkItem.groupBy({
          by: ["departmentId"],
          where: { AND: [where, { departmentId: { not: null } }] },
          _count: { _all: true },
        }),
        prisma.pmWorkItem.groupBy({
          by: ["projectId"],
          where: { AND: [where, { departmentId: null }] },
          _count: { _all: true },
        }),
      ]);
      const projects = inheriting.length
        ? await prisma.pmProject.findMany({
            where: { id: { in: inheriting.map((r) => r.projectId) } },
            select: { id: true, departmentId: true },
          })
        : [];
      const deptOf = new Map<string, string | null>(projects.map((p) => [p.id, p.departmentId]));
      for (const r of own) add(r.departmentId, r._count._all);
      for (const r of inheriting) add(deptOf.get(r.projectId) ?? null, r._count._all);
      break;
    }
  }
  return toGroups(tally);
}

// ── the query ───────────────────────────────────────────────────────────────

export async function queryWorkItems(
  prisma: PrismaClient,
  actor: PmQueryActor,
  req: PmQueryRequest,
  now: Date = new Date(),
): Promise<PmQueryResult> {
  const projectId = req.projectId ?? null;
  const projectScoped = projectId !== null;
  const workspaceSlug = req.workspace ?? HOME_WORKSPACE_SLUG;

  if (projectScoped) {
    const exists = await prisma.pmProject.findFirst({ where: { id: projectId, kind: "PROJECT" }, select: { id: true } });
    if (!exists) throw new Error(PM_ERRORS.PROJECT_NOT_FOUND);
  }
  const tz = await resolveQueryTimezone(prisma, req.tz);

  const scopeWhere: Where = projectScoped
    ? { projectId, project: { is: { kind: "PROJECT" } } }
    : { project: { is: { kind: "PROJECT", isArchived: false, workspace: { slug: workspaceSlug } } } };

  const requested: PmFilter = req.filter ?? { and: [] };
  const sort = req.sort ?? defaultSort(projectScoped);
  const fingerprint = queryFingerprint({
    scope: projectScoped ? `project:${projectId}` : `workspace:${workspaceSlug}`,
    filter: requested,
    sort,
    tz,
  });
  const offset = req.cursor ? decodeCursor(req.cursor, fingerprint) : 0;
  const limit = Math.min(Math.max(req.limit ?? QUERY_DEFAULT_LIMIT, 0), QUERY_MAX_LIMIT);

  /** Scope AND the archived default AND the compiled filter, for any filter. */
  const build = async (filter: PmFilter) => {
    const resolved = await resolveFilterRefs(prisma, filter);
    const compiled = compileFilter(resolved.filter, {
      now,
      tz,
      userId: actor.userId,
      departments: resolved.departments,
    });
    const parts: Where[] = [scopeWhere];
    const archived = archivedDefault(resolved.filter);
    if (archived) parts.push(archived);
    if (Object.keys(compiled).length > 0) parts.push(compiled);
    return { where: (parts.length === 1 ? parts[0] : { AND: parts }) as Where, resolved };
  };

  const { where, resolved } = await build(requested);

  const names = Object.keys(req.counts ?? {});
  const [rows, total, groups, countValues] = await Promise.all([
    limit === 0
      ? Promise.resolve([])
      : prisma.pmWorkItem.findMany({
          where,
          include: ROW_INCLUDE,
          orderBy: buildOrderBy(sort),
          skip: offset,
          take: limit,
        }),
    prisma.pmWorkItem.count({ where }),
    req.groupBy ? computeGroups(prisma, where, req.groupBy) : Promise.resolve(undefined),
    Promise.all(
      names.map(async (name) => prisma.pmWorkItem.count({ where: (await build(req.counts![name])).where })),
    ),
  ]);

  const result: PmQueryResult = {
    work_items: rows.map((r) => mapWorkItem(r, r.project.identifier, r.project.department)),
    nextCursor:
      limit > 0 && rows.length === limit && offset + rows.length < total
        ? encodeCursor(offset + rows.length, fingerprint)
        : null,
    total,
  };
  if (groups) result.groups = groups;
  if (names.length > 0) result.counts = Object.fromEntries(names.map((n, i) => [n, countValues[i]]));
  if (resolved.stale.length > 0) {
    result.stale = resolved.stale;
    result.filter = resolved.filter;
  }
  return result;
}

// ── by key ──────────────────────────────────────────────────────────────────

/**
 * `INBOX-42` → the work item. What a deep link (`?p=INBOX&item=INBOX-42`) and a
 * notification carry is the KEY, which is human, stable and survives a
 * re-created project; the API's other reads take an id. Case-insensitive on the
 * identifier, like the search box. A malformed key, an unknown project and an
 * unknown number are ONE answer — `work_item_not_found` — so the route cannot be
 * used to find out which project keys exist.
 */
export async function findWorkItemByKey(
  prisma: PrismaClient,
  key: string,
  workspaceSlug: string = HOME_WORKSPACE_SLUG,
): Promise<ApiWorkItem> {
  const parsed = parseWorkItemKey(key);
  if (!parsed) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const project = await prisma.pmProject.findFirst({
    where: {
      identifier: { equals: parsed.identifier, mode: "insensitive" },
      workspace: { slug: workspaceSlug },
      kind: "PROJECT",
    },
    include: { department: { select: DEPARTMENT_SELECT } },
  });
  if (!project) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  const row = await prisma.pmWorkItem.findUnique({
    where: { projectId_sequenceId: { projectId: project.id, sequenceId: parsed.sequenceId } },
    include: WORK_ITEM_INCLUDE,
  });
  if (!row) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  return mapWorkItem(row, project.identifier, project.department);
}
