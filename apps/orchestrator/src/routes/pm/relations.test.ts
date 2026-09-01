/**
 * WARP-2586 (ADR-045 slice G) — route tests for /api/pm/work-items/:id/relations.
 *
 * Same harness shape as routes/pm/native.test.ts: a bare Express app, a stub
 * auth middleware that sets `req.user` per test so the REAL requireRole guard
 * runs, and a compact in-memory Prisma fake covering exactly the calls the
 * service makes.
 *
 * The `$transaction` comes from the shared seam (WARP-1570), not a hand-rolled
 * one. This file does not import the isolation-declaring service directly
 * today, so the seam-adoption gate does not currently reach it — inheriting the
 * seam anyway means it stays correct if that import graph ever changes, and it
 * costs one line.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import { createTransactionSeam } from "../../__tests__/helpers/prisma-tx-harness.js";
import { createPmRelationsRouter } from "./relations.js";

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
  kind: string;
  createdById: string | null;
  createdAt: Date;
}

let seq = 0;
const uid = (p: string) => `${p}-${String(++seq).padStart(4, "0")}`;

function makeFake() {
  const items: ItemRow[] = [];
  const relations: RelRow[] = [];
  const activity: Array<Record<string, unknown>> = [];
  /** Force the next pmWorkItemRelation.create to lose a race with this code. */
  const hooks: { createCode?: string } = {};

  const add = (projectId: string, identifier: string, name: string): ItemRow => {
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
        const from = where.fromId as { in?: string[] } | undefined;
        if (from?.in) rows = rows.filter((r) => from.in!.includes(r.fromId));
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
        if (hooks.createCode) {
          const code = hooks.createCode;
          hooks.createCode = undefined;
          throw Object.assign(new Error(`Prisma ${code}`), {
            name: "PrismaClientKnownRequestError",
            code,
          });
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
      create: async ({ data }: { data: Record<string, unknown> }) => {
        activity.push({ ...data });
        return { ...data };
      },
    },
  };

  const seam = createTransactionSeam({ client: () => self });
  self.$transaction = seam.$transaction;

  return { prisma: self, items, relations, activity, add, hooks };
}

function makeApp(prisma: unknown, user: { id: string; role: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) {
      const u: AuthUser = {
        id: user.id,
        username: user.id,
        displayName: user.id,
        role: user.role as AuthUser["role"],
      };
      (req as Request & { user?: AuthUser }).user = u;
    }
    next();
  });
  app.use("/api", createPmRelationsRouter(prisma as never));
  return app;
}

const OWNER = { id: "user-owner", role: "owner" };
const GUEST = { id: "user-guest", role: "guest" };
const MCP = { id: "_service:mcp", role: "service" };

describe("PM relation routes — RBAC", () => {
  let f: ReturnType<typeof makeFake>;
  let a: ItemRow;
  let b: ItemRow;

  beforeEach(() => {
    seq = 0;
    f = makeFake();
    a = f.add("proj-a", "ALPHA", "one");
    b = f.add("proj-b", "BRAVO", "two");
  });

  it("guest CAN read relations (PM is household-shared)", async () => {
    const res = await request(makeApp(f.prisma, GUEST)).get(`/api/pm/work-items/${a.id}/relations`);
    expect(res.status).toBe(200);
    expect(res.body.relations).toEqual([]);
  });

  it("guest cannot create a relation (403)", async () => {
    const res = await request(makeApp(f.prisma, GUEST))
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "BLOCKS" });
    expect(res.status).toBe(403);
    expect(f.relations).toHaveLength(0);
  });

  it("the MCP service principal is NOT admitted to relation writes (403)", async () => {
    // Deliberate, and pinned so it is a decision rather than an oversight: no
    // registered pm_* tool writes relations, so nothing dispatches here. A
    // change that registers one widens this guard AND adds the TOOL_ROUTES
    // hop in the same diff.
    const res = await request(makeApp(f.prisma, MCP))
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "BLOCKS" });
    expect(res.status).toBe(403);
  });

  it("owner can create, and the row lands once", async () => {
    const res = await request(makeApp(f.prisma, OWNER))
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "BLOCKS" });
    expect(res.status).toBe(201);
    expect(res.body.relation.direction).toBe("blocks");
    expect(res.body.relation.relatedKey).toBe(`BRAVO-${b.sequenceId}`);
    expect(res.body.relation.crossProject).toBe(true);
    expect(f.relations).toHaveLength(1);
  });
});

describe("PM relation routes — validation and status mapping", () => {
  let f: ReturnType<typeof makeFake>;
  let a: ItemRow;
  let b: ItemRow;

  beforeEach(() => {
    seq = 0;
    f = makeFake();
    a = f.add("proj-a", "ALPHA", "one");
    b = f.add("proj-a", "ALPHA", "two");
  });

  it("an unknown kind is a 400, not a 500", async () => {
    const res = await request(makeApp(f.prisma, OWNER))
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "SUPERSEDES" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("a self-link is 422 relation_self", async () => {
    const res = await request(makeApp(f.prisma, OWNER))
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: a.id, kind: "RELATES" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("relation_self");
  });

  it("a missing far end is 404", async () => {
    const res = await request(makeApp(f.prisma, OWNER))
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: "wi-nope", kind: "RELATES" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("work_item_not_found");
  });

  it("a duplicate is 409 relation_exists", async () => {
    const app = makeApp(f.prisma, OWNER);
    await request(app)
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "RELATES" });
    const res = await request(app)
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "RELATES" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("relation_exists");
  });

  it("a BLOCKS cycle is 409 relation_cycle, with an explanation a person can act on", async () => {
    const app = makeApp(f.prisma, OWNER);
    await request(app)
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "BLOCKS" });
    const res = await request(app)
      .post(`/api/pm/work-items/${b.id}/relations`)
      .send({ to_work_item_id: a.id, kind: "BLOCKS" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("relation_cycle");
    expect(res.body.message).toContain("blockers");
  });

  it("a SERIALIZABLE loser (P2034) is 409 CONCURRENT_MUTATION, not a 500", async () => {
    f.hooks.createCode = "P2034";
    const res = await request(makeApp(f.prisma, OWNER))
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "BLOCKS" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MUTATION");
  });

  it("delete works from EITHER end using the id that end's read returned", async () => {
    const app = makeApp(f.prisma, OWNER);
    await request(app)
      .post(`/api/pm/work-items/${a.id}/relations`)
      .send({ to_work_item_id: b.id, kind: "RELATES" });

    // Read it from the FAR end and delete using the id that read returned.
    const fromB = await request(app).get(`/api/pm/work-items/${b.id}/relations`);
    const res = await request(app).delete(`/api/pm/relations/${fromB.body.relations[0].id}`);
    expect(res.status).toBe(200);
    expect(f.relations).toHaveLength(0);

    // And it is gone from the near end too — one row, not two.
    const fromA = await request(app).get(`/api/pm/work-items/${a.id}/relations`);
    expect(fromA.body.relations).toEqual([]);
  });

  it("deleting an unknown relation is 404", async () => {
    const res = await request(makeApp(f.prisma, OWNER)).delete("/api/pm/relations/rel-nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("relation_not_found");
  });

  it("reading relations for a missing work item is 404", async () => {
    const res = await request(makeApp(f.prisma, OWNER)).get("/api/pm/work-items/wi-nope/relations");
    expect(res.status).toBe(404);
  });
});
