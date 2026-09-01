/**
 * WARP-2586 (ADR-045 slice G) — pm-relations.service unit cover.
 *
 * Inherits the shared transaction seam (WARP-1570) rather than hand-rolling
 * `$transaction: async (fn) => fn(self)`. Two reasons, one of them a gate:
 *
 *   * pm-relations.service.ts declares SERIALIZABLE_TX, and this file imports
 *     it directly, so prisma-tx-seam-adoption.test.ts requires the harness
 *     here. A hand-rolled stub drops the options argument, which means
 *     deleting `SERIALIZABLE_TX` from createRelation would fail nothing.
 *   * The seam records the options, so "the cycle check runs at SERIALIZABLE"
 *     is an assertion instead of a comment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SERIALIZABLE_TX } from "../../lib/prisma-tx.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
  type TransactionSeam,
} from "../../__tests__/helpers/prisma-tx-harness.js";
import {
  createRelation,
  deleteRelation,
  listRelationsFor,
  PM_RELATION_ERRORS,
  RELATION_SCAN_MAX_DEPTH,
  RELATION_SCAN_MAX_NODES,
  RELATION_SCAN_MAX_EDGES_PER_LEVEL,
} from "./pm-relations.service.js";

interface ItemRow {
  id: string;
  name: string;
  sequenceId: number;
  projectId: string;
  project: { identifier: string };
}
interface RelRow {
  id: string;
  fromId: string;
  toId: string;
  kind: "BLOCKS" | "RELATES" | "DUPLICATES";
  createdById: string | null;
  createdAt: Date;
}
interface ActRow {
  workItemId: string;
  actorId: string | null;
  verb: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
}

let seq = 0;
const uid = (p: string) => `${p}-${String(++seq).padStart(4, "0")}`;

function makeFake() {
  const items: ItemRow[] = [];
  const relations: RelRow[] = [];
  const activity: ActRow[] = [];

  const addItem = (projectId: string, identifier: string, name: string): ItemRow => {
    const row: ItemRow = {
      id: uid("wi"),
      name,
      sequenceId: items.filter((i) => i.projectId === projectId).length + 1,
      projectId,
      project: { identifier },
    };
    items.push(row);
    return row;
  };

  const end = (id: string) => items.find((i) => i.id === id);

  const self: Record<string, unknown> = {
    pmWorkItem: {
      findUnique: async ({ where }: { where: { id: string } }) => end(where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        items.filter((i) => where.id.in.includes(i.id)),
    },

    pmWorkItemRelation: {
      findMany: async ({
        where,
        include,
        take,
      }: {
        where: Record<string, unknown>;
        include?: unknown;
        take?: number;
      }) => {
        let rows = relations;
        if (where.kind !== undefined) rows = rows.filter((r) => r.kind === where.kind);
        const from = where.fromId as { in?: string[] } | string | undefined;
        if (typeof from === "string") rows = rows.filter((r) => r.fromId === from);
        else if (from?.in) rows = rows.filter((r) => from.in!.includes(r.fromId));
        const or = where.OR as Array<{ fromId?: string; toId?: string }> | undefined;
        if (or) {
          rows = rows.filter((r) =>
            or.some((c) => (c.fromId && r.fromId === c.fromId) || (c.toId && r.toId === c.toId)),
          );
        }
        const limited = take === undefined ? rows : rows.slice(0, take);
        return include
          ? limited.map((r) => ({ ...r, from: end(r.fromId), to: end(r.toId) }))
          : limited.map((r) => ({ ...r }));
      },
      findUnique: async ({ where, include }: { where: { id: string }; include?: unknown }) => {
        const r = relations.find((x) => x.id === where.id);
        if (!r) return null;
        return include ? { ...r, from: end(r.fromId), to: end(r.toId) } : { ...r };
      },
      create: async ({ data }: { data: Omit<RelRow, "id" | "createdAt"> }) => {
        // The database's real guards, modelled: the unique triple and the
        // canonical-order CHECK. Without them this fake would happily accept
        // the exact rows Postgres rejects, and the suite would prove nothing
        // about the shape that actually ships.
        if (data.fromId === data.toId) {
          throw Object.assign(new Error("check"), {
            name: "PrismaClientKnownRequestError",
            code: "P2000",
          });
        }
        if (data.kind !== "BLOCKS" && data.fromId > data.toId) {
          throw new Error("canonical order violated — the service should have swapped");
        }
        if (
          relations.some(
            (r) => r.fromId === data.fromId && r.toId === data.toId && r.kind === data.kind,
          )
        ) {
          throw Object.assign(new Error("unique"), {
            name: "PrismaClientKnownRequestError",
            code: "P2002",
          });
        }
        const row: RelRow = { id: uid("rel"), createdAt: new Date(), ...data };
        relations.push(row);
        return { ...row };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = relations.findIndex((r) => r.id === where.id);
        if (i < 0) {
          throw Object.assign(new Error("missing"), {
            name: "PrismaClientKnownRequestError",
            code: "P2025",
          });
        }
        relations.splice(i, 1);
        return {};
      },
    },

    pmActivity: {
      create: async ({ data }: { data: ActRow }) => {
        activity.push({ ...data });
        return { ...data };
      },
    },
  };

  const seam: TransactionSeam = createTransactionSeam({ client: () => self });
  self.$transaction = seam.$transaction;

  return { prisma: self as never, items, relations, activity, addItem, seam };
}

describe("PmWorkItemRelation — symmetric kinds are ONE row, read from both ends", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("canonicalises RELATES so the smaller id is always `fromId`, whichever way it was asked", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "first");
    const b = f.addItem("proj-a", "ALPHA", "second");
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];

    // Ask in the NON-canonical direction on purpose.
    await createRelation(f.prisma, "user-1", { fromId: hi.id, toId: lo.id, kind: "RELATES" });

    expect(f.relations).toHaveLength(1);
    expect(f.relations[0].fromId).toBe(lo.id);
    expect(f.relations[0].toId).toBe(hi.id);
  });

  it("the SAME symmetric fact asked from the other end is a duplicate, not a second row", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "first");
    const b = f.addItem("proj-a", "ALPHA", "second");

    await createRelation(f.prisma, null, { fromId: a.id, toId: b.id, kind: "DUPLICATES" });
    await expect(
      createRelation(f.prisma, null, { fromId: b.id, toId: a.id, kind: "DUPLICATES" }),
    ).rejects.toThrow(PM_RELATION_ERRORS.RELATION_EXISTS);
    expect(f.relations).toHaveLength(1);
  });

  it("one row is visible from BOTH ends, with the same id — so either side can delete it", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "first");
    const b = f.addItem("proj-b", "BRAVO", "second");

    const created = await createRelation(f.prisma, null, {
      fromId: a.id,
      toId: b.id,
      kind: "RELATES",
    });

    const fromA = await listRelationsFor(f.prisma, a.id);
    const fromB = await listRelationsFor(f.prisma, b.id);

    expect(fromA).toHaveLength(1);
    expect(fromB).toHaveLength(1);
    expect(fromA[0].id).toBe(created.id);
    expect(fromB[0].id).toBe(created.id);
    // Each end sees the OTHER end, with the other project's key prefix.
    expect(fromA[0].relatedId).toBe(b.id);
    expect(fromA[0].relatedKey).toBe(`BRAVO-${b.sequenceId}`);
    expect(fromB[0].relatedId).toBe(a.id);
    expect(fromB[0].relatedKey).toBe(`ALPHA-${a.sequenceId}`);
    // Symmetric: neither end leads, and the read says so explicitly rather
    // than leaving a client to compare ids and invent a direction.
    expect(fromA[0].direction).toBe("symmetric");
    expect(fromB[0].direction).toBe("symmetric");
    // Cross-project is an explicit flag on both ends.
    expect(fromA[0].crossProject).toBe(true);
    expect(fromB[0].crossProject).toBe(true);
  });

  it("BLOCKS is directional: the blocker reads `blocks`, the blocked reads `blocked_by`", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "blocker");
    const b = f.addItem("proj-b", "BRAVO", "blocked");

    await createRelation(f.prisma, null, { fromId: a.id, toId: b.id, kind: "BLOCKS" });

    expect((await listRelationsFor(f.prisma, a.id))[0].direction).toBe("blocks");
    expect((await listRelationsFor(f.prisma, b.id))[0].direction).toBe("blocked_by");
    // Stored exactly as asked — BLOCKS is exempt from canonicalisation.
    expect(f.relations[0].fromId).toBe(a.id);
  });

  it("refuses a self-edge before it reaches the database", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "only");
    await expect(
      createRelation(f.prisma, null, { fromId: a.id, toId: a.id, kind: "BLOCKS" }),
    ).rejects.toThrow(PM_RELATION_ERRORS.RELATION_SELF);
    expect(f.relations).toHaveLength(0);
  });

  it("404s when either end does not exist", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "only");
    await expect(
      createRelation(f.prisma, null, { fromId: a.id, toId: "wi-missing", kind: "RELATES" }),
    ).rejects.toThrow(PM_RELATION_ERRORS.WORK_ITEM_NOT_FOUND);
  });
});

describe("PmWorkItemRelation — BLOCKS cycle detection is bounded and fails CLOSED", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("refuses the 2-cycle A blocks B, B blocks A", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "a");
    const b = f.addItem("proj-b", "BRAVO", "b");
    await createRelation(f.prisma, null, { fromId: a.id, toId: b.id, kind: "BLOCKS" });
    await expect(
      createRelation(f.prisma, null, { fromId: b.id, toId: a.id, kind: "BLOCKS" }),
    ).rejects.toThrow(PM_RELATION_ERRORS.RELATION_CYCLE);
    expect(f.relations).toHaveLength(1);
  });

  it("refuses a long cycle that CROSSES projects — the reason the walk exists at all", async () => {
    const f = makeFake();
    const chain = [
      f.addItem("proj-a", "ALPHA", "1"),
      f.addItem("proj-b", "BRAVO", "2"),
      f.addItem("proj-c", "CHAR", "3"),
      f.addItem("proj-a", "ALPHA", "4"),
    ];
    for (let i = 0; i < chain.length - 1; i += 1) {
      await createRelation(f.prisma, null, {
        fromId: chain[i].id,
        toId: chain[i + 1].id,
        kind: "BLOCKS",
      });
    }
    await expect(
      createRelation(f.prisma, null, {
        fromId: chain[chain.length - 1].id,
        toId: chain[0].id,
        kind: "BLOCKS",
      }),
    ).rejects.toThrow(PM_RELATION_ERRORS.RELATION_CYCLE);
  });

  it("a diamond is not a cycle — the walk must not reject merely re-converging paths", async () => {
    const f = makeFake();
    const [top, l, r, bot] = [
      f.addItem("proj-a", "ALPHA", "top"),
      f.addItem("proj-a", "ALPHA", "left"),
      f.addItem("proj-a", "ALPHA", "right"),
      f.addItem("proj-a", "ALPHA", "bottom"),
    ];
    await createRelation(f.prisma, null, { fromId: top.id, toId: l.id, kind: "BLOCKS" });
    await createRelation(f.prisma, null, { fromId: top.id, toId: r.id, kind: "BLOCKS" });
    await createRelation(f.prisma, null, { fromId: l.id, toId: bot.id, kind: "BLOCKS" });
    await expect(
      createRelation(f.prisma, null, { fromId: r.id, toId: bot.id, kind: "BLOCKS" }),
    ).resolves.toBeTruthy();
    expect(f.relations).toHaveLength(4);
  });

  it("a chain longer than the depth bound is REFUSED, not admitted unchecked", async () => {
    // Fail-closed is the whole point. An unbounded walk is a defect; a bound
    // that gives up and says yes is a WORSE defect, because it admits exactly
    // the cycle the check exists to reject, on the largest graph on the box.
    const f = makeFake();
    const nodes = Array.from({ length: RELATION_SCAN_MAX_DEPTH + 3 }, (_, i) =>
      f.addItem("proj-a", "ALPHA", `n${i}`),
    );
    for (let i = 1; i < nodes.length - 1; i += 1) {
      f.relations.push({
        id: uid("rel"),
        fromId: nodes[i].id,
        toId: nodes[i + 1].id,
        kind: "BLOCKS",
        createdById: null,
        createdAt: new Date(),
      });
    }
    await expect(
      createRelation(f.prisma, null, { fromId: nodes[0].id, toId: nodes[1].id, kind: "BLOCKS" }),
    ).rejects.toThrow(PM_RELATION_ERRORS.RELATION_SCAN_EXHAUSTED);
    // And nothing was written.
    expect(f.relations.some((r) => r.fromId === nodes[0].id)).toBe(false);
  });

  it("the bounds are named constants a reader can check, not magic numbers", () => {
    expect(RELATION_SCAN_MAX_DEPTH).toBe(32);
    expect(RELATION_SCAN_MAX_NODES).toBe(500);
    expect(RELATION_SCAN_MAX_EDGES_PER_LEVEL).toBe(1000);
  });

  it("a symmetric link never walks the graph at all", async () => {
    // RELATES has no direction, so there is nothing to cycle. Proven by
    // building a chain that WOULD exhaust the depth bound and showing a
    // RELATES write across it still succeeds.
    const f = makeFake();
    const nodes = Array.from({ length: RELATION_SCAN_MAX_DEPTH + 3 }, (_, i) =>
      f.addItem("proj-a", "ALPHA", `n${i}`),
    );
    for (let i = 0; i < nodes.length - 1; i += 1) {
      f.relations.push({
        id: uid("rel"),
        fromId: nodes[i].id,
        toId: nodes[i + 1].id,
        kind: "BLOCKS",
        createdById: null,
        createdAt: new Date(),
      });
    }
    await expect(
      createRelation(f.prisma, null, {
        fromId: nodes[nodes.length - 1].id,
        toId: nodes[0].id,
        kind: "RELATES",
      }),
    ).resolves.toBeTruthy();
  });
});

describe("PmWorkItemRelation — audit and isolation", () => {
  beforeEach(() => {
    seq = 0;
  });

  it("writes one relation_added row on EACH end, each naming the other", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "a");
    const b = f.addItem("proj-b", "BRAVO", "b");
    await createRelation(f.prisma, "user-7", { fromId: a.id, toId: b.id, kind: "BLOCKS" });

    expect(f.activity).toHaveLength(2);
    const onA = f.activity.find((r) => r.workItemId === a.id)!;
    const onB = f.activity.find((r) => r.workItemId === b.id)!;
    expect(onA.verb).toBe("relation_added");
    expect(onA.newValue).toBe(`BLOCKS:${b.id}`);
    expect(onA.actorId).toBe("user-7");
    expect(onB.newValue).toBe(`BLOCKS:${a.id}`);
  });

  it("writes one relation_removed row on each end before the row goes", async () => {
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "a");
    const b = f.addItem("proj-a", "ALPHA", "b");
    const rel = await createRelation(f.prisma, null, {
      fromId: a.id,
      toId: b.id,
      kind: "RELATES",
    });
    f.activity.length = 0;

    await deleteRelation(f.prisma, "user-9", rel.id);

    expect(f.relations).toHaveLength(0);
    expect(f.activity.map((r) => r.verb)).toEqual(["relation_removed", "relation_removed"]);
    expect(f.activity.every((r) => r.oldValue?.startsWith("RELATES:"))).toBe(true);
  });

  it("404s deleting a relation that is not there", async () => {
    const f = makeFake();
    await expect(deleteRelation(f.prisma, null, "rel-nope")).rejects.toThrow(
      PM_RELATION_ERRORS.RELATION_NOT_FOUND,
    );
  });

  it("the check-then-write runs at SERIALIZABLE — asserted, not hoped", async () => {
    // The write-skew this closes: two requests, one adding `A blocks B` and
    // one adding `B blocks A`, each read a graph without the other's edge,
    // each pass the cycle check, and under READ COMMITTED both commit. The
    // seam records the options argument, so dropping SERIALIZABLE_TX from the
    // service turns this red instead of nothing.
    const f = makeFake();
    const a = f.addItem("proj-a", "ALPHA", "a");
    const b = f.addItem("proj-a", "ALPHA", "b");
    await createRelation(f.prisma, null, { fromId: a.id, toId: b.id, kind: "BLOCKS" });
    expectAllTransactionsAt(f.seam, SERIALIZABLE_TX);
  });
});
