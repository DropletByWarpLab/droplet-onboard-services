/**
 * WARP-2586 (ADR-045 slice G) — PmWorkItemRelation, the PM edge that may span
 * projects.
 *
 * PM's other groupings cannot: PmModule and PmCycle both carry a projectId, so
 * an epic and a sprint stop at the project boundary. PmWorkItem.parentId can
 * physically cross one but is not allowed to — parenting is CONTAINMENT and is
 * now enforced same-project by a database trigger (see the WARP-2586
 * migration). This table is the other half of that decision: containment stays
 * inside a project, REFERENCE crosses freely.
 *
 * Lives beside pm.service.ts rather than inside it. Deliberate: this module
 * opens a SERIALIZABLE transaction, which puts every suite that imports it
 * directly into the WARP-1570 seam-adoption gate's scope, and pm.service.ts's
 * existing suites hand-roll their own $transaction stubs. Splitting keeps the
 * gate's blast radius to this module's own test.
 *
 * ── the symmetry problem, and how one row answers it ───────────────────────
 *
 * BLOCKS is DIRECTIONAL: "A blocks B" and "B blocks A" are different claims
 * (and together a cycle — refused on write).
 *
 * RELATES and DUPLICATES are SYMMETRIC: "A relates to B" IS "B relates to A".
 * The naive implementation writes both rows, and that is how the edge becomes
 * un-deletable: the drawer deletes the row it was rendered from, the mirror
 * survives, and the relation is back on the next refresh. Whoever debugs that
 * then adds a second delete keyed on the reverse pair, and now a partially
 * failed write leaves a half-edge nobody can see from either end.
 *
 * So: ONE row, canonically ordered — the lexicographically smaller id in
 * `fromId` for the symmetric kinds — and a read that matches on EITHER end and
 * reports which end the caller is standing on. The database holds the ordering
 * with a CHECK (`PmWorkItemRelation_symmetric_canonical_order`), pinned to the
 * C collation so Postgres text `<` and JavaScript `<` cannot disagree on a
 * cluster with an ICU collation.
 *
 * ── cycle detection, and its bound ─────────────────────────────────────────
 *
 * A BLOCKS cycle is a deadlock nobody can schedule out of, so it is refused at
 * write time. The check is: before inserting `from -> to`, does `to` already
 * reach `from` by following BLOCKS edges forward? That is reachability, and an
 * UNBOUNDED walk on a large tracker is its own defect — one pathological graph
 * and a write holds a SERIALIZABLE transaction open across thousands of
 * queries.
 *
 * The walk is therefore a breadth-first search with THREE explicit bounds and
 * ONE query per level (never one per node):
 *
 *   depth     <= RELATION_SCAN_MAX_DEPTH        (32 levels  => <= 32 queries)
 *   visited   <= RELATION_SCAN_MAX_NODES        (500 items)
 *   per level <= RELATION_SCAN_MAX_EDGES_PER_LEVEL (1000 edges)
 *
 * Exhausting any bound FAILS CLOSED: `relation_scan_exhausted` (409), never a
 * silent "probably fine". Fail-open would admit exactly the cycle the check
 * exists to reject, and it would do so on the biggest, least inspectable graph
 * on the box. The per-level cap is read as `take: LIMIT + 1` precisely so a
 * truncated level is DETECTED rather than quietly walked past — a bare `take`
 * would drop edges and turn the bound into a fail-open.
 *
 * ── isolation ──────────────────────────────────────────────────────────────
 *
 * The cycle check is read-then-decide-then-write, which is write skew: two
 * concurrent requests, one adding `A blocks B` and one adding `B blocks A`,
 * each read a graph without the other's edge, each pass, and under READ
 * COMMITTED both commit — landing the cycle. SERIALIZABLE_TX makes the loser
 * abort with P2034, which the route maps to 409 CONCURRENT_MUTATION rather
 * than a 500. (lib/prisma-tx.ts documents the rail; role-mutation-guard's
 * `isConcurrencyConflict` is the same predicate.)
 *
 * Errors are plain `Error(message)` with stable string codes, exactly as
 * pm.service.ts does, so the route layer maps codes to HTTP status.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import { PM_ERRORS } from "./pm.service.js";

/** A Prisma client OR an interactive-transaction handle — helpers that run
 *  inside `$transaction` take this so callers compose them atomically. Mirrors
 *  pm.service.ts's own `Db`; redeclared rather than imported because that one
 *  is module-private there. */
type Db = PrismaClient | Prisma.TransactionClient;

/** The three edge kinds, read off the generated client so a schema rename is a
 *  compile error here rather than a runtime surprise. */
export type ApiRelationKind = Prisma.PmWorkItemRelationCreateManyInput["kind"];

/**
 * Which kinds are symmetric. The ONLY place that answer lives — the
 * canonicaliser, the read mapper and the route copy all consult it, so adding
 * a fourth kind is one edit, not four.
 */
const SYMMETRIC_KINDS: ReadonlySet<string> = new Set(["RELATES", "DUPLICATES"]);

export function isSymmetricKind(kind: ApiRelationKind): boolean {
  return SYMMETRIC_KINDS.has(kind);
}

// ── Stable error codes ───────────────────────────────────────────────────────
// Shared so catch sites import the same literals the throw sites emit; a
// rename produces a compile error on both sides. WORK_ITEM_NOT_FOUND is
// re-exported from PM_ERRORS rather than restated, so the two surfaces cannot
// drift apart.
export const PM_RELATION_ERRORS = {
  WORK_ITEM_NOT_FOUND: PM_ERRORS.WORK_ITEM_NOT_FOUND,
  RELATION_NOT_FOUND: "relation_not_found",
  RELATION_SELF: "relation_self",
  RELATION_EXISTS: "relation_exists",
  RELATION_CYCLE: "relation_cycle",
  RELATION_SCAN_EXHAUSTED: "relation_scan_exhausted",
} as const;

// ── Cycle-walk bounds ────────────────────────────────────────────────────────
// Named, exported, and asserted in the unit test, so "how big a graph does this
// handle" has an answer somebody can read instead of a shrug. At household and
// small-business scale (the shipping shape) a BLOCKS chain 32 deep or 500 wide
// is already a data-entry accident, not a plan.
export const RELATION_SCAN_MAX_DEPTH = 32;
export const RELATION_SCAN_MAX_NODES = 500;
export const RELATION_SCAN_MAX_EDGES_PER_LEVEL = 1000;

/** Hard cap on the relations returned for one work item, so the drawer (and
 *  any tool result built on it) can never be handed an unbounded array. */
export const RELATIONS_PER_ITEM_LIMIT = 200;

// ── Prisma include shape + row type ──────────────────────────────────────────

const RELATION_END_SELECT = {
  id: true,
  name: true,
  sequenceId: true,
  projectId: true,
  project: { select: { identifier: true } },
} satisfies Prisma.PmWorkItemSelect;

const RELATION_INCLUDE = {
  from: { select: RELATION_END_SELECT },
  to: { select: RELATION_END_SELECT },
} satisfies Prisma.PmWorkItemRelationInclude;

type RelationRow = Prisma.PmWorkItemRelationGetPayload<{ include: typeof RELATION_INCLUDE }>;

// ── API shape ────────────────────────────────────────────────────────────────

/**
 * One relation, ORIENTED on the work item the caller asked about.
 *
 * `direction` is an explicit three-value discriminator, not something a client
 * re-derives by comparing ids (and gets wrong for the symmetric kinds, where
 * the stored order is a storage detail with no meaning). Same principle as the
 * WARP-884 `isCompleted` column: say the thing, do not make every reader infer
 * it.
 */
export interface ApiWorkItemRelation {
  id: string;
  kind: ApiRelationKind;
  /** `blocks` — the anchor blocks the other end. `blocked_by` — the reverse.
   *  `symmetric` — RELATES / DUPLICATES, where neither end leads. */
  direction: "blocks" | "blocked_by" | "symmetric";
  /** The item at the OTHER end of the edge. */
  relatedId: string;
  /** Human key of the other end, e.g. `OPS-7`. Cross-project relations are the
   *  point of this table, so the key must carry the other project's prefix. */
  relatedKey: string;
  relatedName: string;
  relatedProjectId: string;
  /** True when the other end lives in a different project. The dashboard uses
   *  it to badge the row; nothing infers it from the ids. */
  crossProject: boolean;
  createdById: string | null;
  createdAt: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Structural Prisma error-code check. Same shape as pm.service.ts's, matching
 *  both the real PrismaClientKnownRequestError and the repo's test stand-ins
 *  (`name === "PrismaClientKnownRequestError"` + a string `code`). */
function isPrismaCode(err: unknown, code: "P2002" | "P2025" | "P2003"): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/**
 * Put a symmetric pair in canonical order; leave BLOCKS alone.
 *
 * JavaScript `<` on two UUID strings is UTF-16 code-unit order. The database
 * CHECK compares `COLLATE "C"`, i.e. byte order. For ASCII those are the same
 * order, which is exactly why the constraint names the collation — without it
 * an ICU-collated cluster would reject rows this function considers ordered.
 */
function canonicalise(
  kind: ApiRelationKind,
  fromId: string,
  toId: string,
): { fromId: string; toId: string } {
  if (isSymmetricKind(kind) && fromId > toId) return { fromId: toId, toId: fromId };
  return { fromId, toId };
}

function mapRelation(row: RelationRow, anchorId: string): ApiWorkItemRelation {
  const anchorIsFrom = row.fromId === anchorId;
  const other = anchorIsFrom ? row.to : row.from;
  const anchorProjectId = anchorIsFrom ? row.from.projectId : row.to.projectId;
  return {
    id: row.id,
    kind: row.kind,
    direction: isSymmetricKind(row.kind)
      ? "symmetric"
      : anchorIsFrom
        ? "blocks"
        : "blocked_by",
    relatedId: other.id,
    relatedKey: `${other.project.identifier}-${other.sequenceId}`,
    relatedName: other.name,
    relatedProjectId: other.projectId,
    crossProject: other.projectId !== anchorProjectId,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Does a BLOCKS path already run from `startId` to `targetId`?
 *
 * Level-order BFS: ONE query per level over the `(fromId, kind)` index, never
 * one per node. Bounded on depth, visited-node count and per-level fan-out;
 * exhausting any bound throws `relation_scan_exhausted` rather than guessing.
 * See the module header for why fail-closed is the only defensible choice.
 */
async function blocksPathExists(db: Db, startId: string, targetId: string): Promise<boolean> {
  let frontier: string[] = [startId];
  const visited = new Set<string>([startId]);

  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth >= RELATION_SCAN_MAX_DEPTH) {
      throw new Error(PM_RELATION_ERRORS.RELATION_SCAN_EXHAUSTED);
    }

    // `take: LIMIT + 1` so a truncated level is DETECTED. A bare `take: LIMIT`
    // would silently drop edges and turn this bound into a fail-open — the
    // walk would report "no cycle" because it never looked at the edge that
    // closed it.
    const edges = await db.pmWorkItemRelation.findMany({
      where: { kind: "BLOCKS", fromId: { in: frontier } },
      select: { toId: true },
      take: RELATION_SCAN_MAX_EDGES_PER_LEVEL + 1,
    });
    if (edges.length > RELATION_SCAN_MAX_EDGES_PER_LEVEL) {
      throw new Error(PM_RELATION_ERRORS.RELATION_SCAN_EXHAUSTED);
    }

    const next: string[] = [];
    for (const edge of edges) {
      if (edge.toId === targetId) return true;
      if (visited.has(edge.toId)) continue;
      visited.add(edge.toId);
      if (visited.size > RELATION_SCAN_MAX_NODES) {
        throw new Error(PM_RELATION_ERRORS.RELATION_SCAN_EXHAUSTED);
      }
      next.push(edge.toId);
    }
    frontier = next;
  }
  return false;
}

/** One activity row per meaningful change, on BOTH ends — each item's own
 *  timeline has to explain what happened to it. `newValue` names the OTHER end
 *  from the perspective of the row's own work item. */
async function writeRelationActivity(
  db: Db,
  input: {
    actorId: string | null;
    verb: Prisma.PmActivityCreateManyInput["verb"];
    ends: Array<{ workItemId: string; otherId: string }>;
    kind: ApiRelationKind;
  },
): Promise<void> {
  const added = input.verb === "relation_added";
  for (const end of input.ends) {
    await db.pmActivity.create({
      data: {
        workItemId: end.workItemId,
        actorId: input.actorId,
        verb: input.verb,
        field: "relation",
        oldValue: added ? null : `${input.kind}:${end.otherId}`,
        newValue: added ? `${input.kind}:${end.otherId}` : null,
      },
    });
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Every relation touching `workItemId`, oriented on it.
 *
 * ONE query over both directions (`OR: [{ fromId }, { toId }]`, each arm served
 * by its own composite index). This is the read that makes a single symmetric
 * row visible from both ends — the whole reason the write side canonicalises
 * instead of mirroring.
 */
export async function listRelationsFor(
  db: Db,
  workItemId: string,
): Promise<ApiWorkItemRelation[]> {
  const item = await db.pmWorkItem.findUnique({
    where: { id: workItemId },
    select: { id: true },
  });
  if (!item) throw new Error(PM_RELATION_ERRORS.WORK_ITEM_NOT_FOUND);

  const rows = await db.pmWorkItemRelation.findMany({
    where: { OR: [{ fromId: workItemId }, { toId: workItemId }] },
    include: RELATION_INCLUDE,
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
    take: RELATIONS_PER_ITEM_LIMIT,
  });
  return rows.map((r) => mapRelation(r, workItemId));
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Link two work items. They may live in different projects — that is the
 * point.
 *
 * The returned relation is oriented on `input.fromId`, the end the CALLER
 * named, even when the row was stored the other way round by canonicalisation.
 * The answer should match the question that was asked.
 */
export async function createRelation(
  prisma: PrismaClient,
  actorId: string | null,
  input: { fromId: string; toId: string; kind: ApiRelationKind },
): Promise<ApiWorkItemRelation> {
  if (input.fromId === input.toId) throw new Error(PM_RELATION_ERRORS.RELATION_SELF);

  // Both ends must exist. One query, not two: a pair of ids either resolves to
  // two rows or the request is a 404, and which one is missing does not change
  // the answer.
  const ends = await prisma.pmWorkItem.findMany({
    where: { id: { in: [input.fromId, input.toId] } },
    select: { id: true },
  });
  if (ends.length !== 2) throw new Error(PM_RELATION_ERRORS.WORK_ITEM_NOT_FOUND);

  const canonical = canonicalise(input.kind, input.fromId, input.toId);

  let createdId: string;
  try {
    createdId = await prisma.$transaction(async (tx) => {
      // Only BLOCKS can cycle. A symmetric edge has no direction to follow.
      if (!isSymmetricKind(input.kind)) {
        if (await blocksPathExists(tx, canonical.toId, canonical.fromId)) {
          throw new Error(PM_RELATION_ERRORS.RELATION_CYCLE);
        }
      }

      const row = await tx.pmWorkItemRelation.create({
        data: {
          fromId: canonical.fromId,
          toId: canonical.toId,
          kind: input.kind,
          createdById: actorId,
        },
        select: { id: true },
      });

      await writeRelationActivity(tx, {
        actorId,
        verb: "relation_added",
        kind: input.kind,
        ends: [
          { workItemId: canonical.fromId, otherId: canonical.toId },
          { workItemId: canonical.toId, otherId: canonical.fromId },
        ],
      });

      return row.id;
    }, SERIALIZABLE_TX);
  } catch (err) {
    // The @@unique is on three NOT NULL columns, so — unlike a compound unique
    // with a nullable member, where NULL = NULL is false and `upsert` silently
    // never matches — a duplicate reliably surfaces as P2002 here. That is a
    // 409, not a retry.
    if (isPrismaCode(err, "P2002")) throw new Error(PM_RELATION_ERRORS.RELATION_EXISTS);
    // Either end deleted between the existence check and the insert.
    if (isPrismaCode(err, "P2003")) throw new Error(PM_RELATION_ERRORS.WORK_ITEM_NOT_FOUND);
    throw err;
  }

  const row = await prisma.pmWorkItemRelation.findUnique({
    where: { id: createdId },
    include: RELATION_INCLUDE,
  });
  if (!row) throw new Error(PM_RELATION_ERRORS.RELATION_NOT_FOUND);
  return mapRelation(row, input.fromId);
}

/**
 * Unlink. By relation id, which both ends' reads return — so a symmetric
 * relation is deleted by the same id whichever side the user is looking from.
 * That equivalence is the payoff for storing one row instead of two.
 */
export async function deleteRelation(
  prisma: PrismaClient,
  actorId: string | null,
  relationId: string,
): Promise<void> {
  const existing = await prisma.pmWorkItemRelation.findUnique({
    where: { id: relationId },
    select: { id: true, fromId: true, toId: true, kind: true },
  });
  if (!existing) throw new Error(PM_RELATION_ERRORS.RELATION_NOT_FOUND);

  try {
    await prisma.$transaction(async (tx) => {
      await writeRelationActivity(tx, {
        actorId,
        verb: "relation_removed",
        kind: existing.kind,
        ends: [
          { workItemId: existing.fromId, otherId: existing.toId },
          { workItemId: existing.toId, otherId: existing.fromId },
        ],
      });
      await tx.pmWorkItemRelation.delete({ where: { id: relationId } });
    });
  } catch (err) {
    // findUnique + delete is two round-trips; a concurrent delete between them
    // makes this throw P2025. Same 404 the existence check would have raised.
    if (isPrismaCode(err, "P2025")) throw new Error(PM_RELATION_ERRORS.RELATION_NOT_FOUND);
    throw err;
  }
}
