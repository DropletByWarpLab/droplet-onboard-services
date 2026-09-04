/**
 * Route tests for the native PM surface (ADR-026, P2).
 *
 * The repo's global setup mocks @prisma/client (no Postgres), so these tests
 * mount `createPmNativeRouter` on a bare Express app with (a) a stub auth
 * middleware that sets `req.user` per-test — so the REAL requireRole /
 * requireRoleOrMcpService guards run — and (b) a compact in-memory Prisma fake
 * covering exactly the calls the service makes. They assert RBAC, validation,
 * per-project sequence numbering, default-state landing, and activity logging.
 */

import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import { createPmNativeRouter } from "./native.js";

// ── In-memory Prisma fake ────────────────────────────────────────────────────
// Only the methods the service uses, with just enough relation resolution.

interface Row {
  [k: string]: unknown;
}
let id = 0;
const uid = (p: string) => `${p}-${++id}`;

/** A Prisma-shaped known-request error the service detects structurally
 *  (`err.code`), matching the production stand-in used elsewhere in the repo
 *  (`name === "PrismaClientKnownRequestError"` + a `code`). Lets a test force a
 *  specific write to lose a race (P2002 / P2025 / P2003) without a real DB. */
function prismaError(code: string): Error & { code: string } {
  const e = new Error(`Prisma ${code}`) as Error & { code: string };
  e.name = "PrismaClientKnownRequestError";
  e.code = code;
  return e;
}

/** Per-operation throw hooks: set `hooks["<op>"] = "<P-code>"` to make the next
 *  matching write throw that Prisma error. Cleared after it fires (one-shot). */
type Hooks = Record<string, string | undefined>;

function makeFake(hooks: Hooks = {}) {
  const fire = (op: string) => {
    const code = hooks[op];
    if (code) {
      hooks[op] = undefined;
      throw prismaError(code);
    }
  };
  const db = {
    workspaces: [] as Row[],
    projects: [] as Row[],
    states: [] as Row[],
    labels: [] as Row[],
    items: [] as Row[],
    assignees: [] as Row[],
    itemLabels: [] as Row[],
    comments: [] as Row[],
    activity: [] as Row[],
    // WARP-2586: the relation edge table. No test in this file creates one —
    // relations have their own suite (routes/pm/relations.test.ts) — but the
    // store and its model methods must exist, because the work-item DETAIL
    // read and deleteWorkItem now both consult it.
    relations: [] as Row[],
  };

  const resolveItem = (it: Row, include?: Row) => {
    const out: Row = { ...it };
    if (include?.state) out.state = db.states.find((s) => s.id === it.stateId) ?? null;
    if (include?.assignees) out.assignees = db.assignees.filter((a) => a.workItemId === it.id);
    if (include?.labels) {
      out.labels = db.itemLabels
        .filter((l) => l.workItemId === it.id)
        .map((l) => ({ ...l, label: db.labels.find((lb) => lb.id === l.labelId) }));
    }
    if (include?._count) {
      out._count = {
        comments: db.comments.filter((c) => c.workItemId === it.id).length,
        children: db.items.filter((i) => i.parentId === it.id).length,
      };
    }
    return out;
  };

  const prisma: Record<string, unknown> = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),

    pmWorkspace: {
      upsert: async ({ where, create }: { where: Row; create: Row }) => {
        let ws = db.workspaces.find((w) => w.slug === where.slug);
        if (!ws) {
          ws = { id: uid("ws"), createdAt: new Date(), updatedAt: new Date(), ...create };
          db.workspaces.push(ws);
        }
        return ws;
      },
      findMany: async () => db.workspaces,
      findUnique: async ({ where }: { where: Row }) =>
        db.workspaces.find((w) => w.slug === where.slug || w.id === where.id) ?? null,
    },

    pmProject: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        let p: Row | undefined;
        if (where.workspaceId_identifier) {
          const k = where.workspaceId_identifier as Row;
          p = db.projects.find((x) => x.workspaceId === k.workspaceId && x.identifier === k.identifier);
        } else {
          p = db.projects.find((x) => x.id === where.id);
        }
        if (!p) return null;
        const out: Row = { ...p };
        if (include?.workspace) out.workspace = db.workspaces.find((w) => w.id === p!.workspaceId);
        if (include?.states) out.states = db.states.filter((s) => s.projectId === p!.id);
        return out;
      },
      findMany: async ({ include }: { include?: Row } = {}) =>
        db.projects.map((p) => ({
          ...p,
          ...(include?.workspace ? { workspace: db.workspaces.find((w) => w.id === p.workspaceId) } : {}),
        })),
      create: async ({ data, include }: { data: Row; include?: Row }) => {
        fire("pmProject.create");
        const p: Row = {
          id: uid("proj"),
          seqCounter: 0,
          sortOrder: 0,
          isArchived: false,
          archivedAt: null,
          description: null,
          icon: null,
          color: null,
          leadId: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        delete (p as Row).states;
        db.projects.push(p);
        const nested = (data.states as { create?: Row[] } | undefined)?.create ?? [];
        for (const s of nested) db.states.push({ id: uid("st"), projectId: p.id, color: null, ...s });
        const out: Row = { ...p };
        if (include?.workspace) out.workspace = db.workspaces.find((w) => w.id === p.workspaceId);
        return out;
      },
      update: async ({ where, data, include, select }: { where: Row; data: Row; include?: Row; select?: Row }) => {
        const p = db.projects.find((x) => x.id === where.id)!;
        if (data.seqCounter && typeof data.seqCounter === "object") {
          p.seqCounter = (p.seqCounter as number) + (data.seqCounter as { increment: number }).increment;
        }
        for (const [k, v] of Object.entries(data)) if (k !== "seqCounter") p[k] = v;
        if (select?.seqCounter) return { seqCounter: p.seqCounter };
        const out: Row = { ...p };
        if (include?.workspace) out.workspace = db.workspaces.find((w) => w.id === p.workspaceId);
        return out;
      },
      delete: async ({ where }: { where: Row }) => {
        fire("pmProject.delete");
        db.projects = db.projects.filter((x) => x.id !== where.id);
        return {};
      },
    },

    pmState: {
      findMany: async ({ where }: { where: Row }) => db.states.filter((s) => s.projectId === where.projectId),
      count: async ({ where }: { where: Row }) =>
        db.states.filter((s) => {
          if (where.projectId && s.projectId !== where.projectId) return false;
          if (where.isDefault !== undefined && s.isDefault !== where.isDefault) return false;
          const not = (where.id as { not?: string } | undefined)?.not;
          if (not && s.id === not) return false;
          return true;
        }).length,
      findUnique: async ({ where }: { where: Row }) => db.states.find((s) => s.id === where.id) ?? null,
      // Same filter shape as `count` above (projectId / isDefault / id.not) —
      // deleteState's fallback-default lookup is the only caller.
      findFirst: async ({ where }: { where: Row }) =>
        db.states.find((s) => {
          if (where.projectId && s.projectId !== where.projectId) return false;
          if (where.isDefault !== undefined && s.isDefault !== where.isDefault) return false;
          const not = (where.id as { not?: string } | undefined)?.not;
          if (not && s.id === not) return false;
          return true;
        }) ?? null,
      create: async ({ data }: { data: Row }) => {
        const s = { id: uid("st"), color: null, sortOrder: 0, isDefault: false, ...data };
        db.states.push(s);
        return s;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const s = db.states.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return s;
      },
      delete: async ({ where }: { where: Row }) => {
        fire("pmState.delete");
        db.states = db.states.filter((x) => x.id !== where.id);
        return {};
      },
    },

    pmLabel: {
      findMany: async ({ where }: { where: Row }) => db.labels.filter((l) => l.projectId === where.projectId),
      findUnique: async ({ where }: { where: Row }) => db.labels.find((l) => l.id === where.id) ?? null,
      create: async ({ data }: { data: Row }) => {
        const l = { id: uid("lb"), color: null, ...data };
        db.labels.push(l);
        return l;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const l = db.labels.find((x) => x.id === where.id)!;
        Object.assign(l, data);
        return l;
      },
      delete: async ({ where }: { where: Row }) => {
        fire("pmLabel.delete");
        db.labels = db.labels.filter((x) => x.id !== where.id);
        return {};
      },
    },

    pmWorkItem: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const it = db.items.find((i) => i.id === where.id);
        return it ? resolveItem(it, include) : null;
      },
      findFirst: async ({ where }: { where: Row }) =>
        db.items.find(
          (i) => i.id === where.id && (!where.projectId || i.projectId === where.projectId),
        ) ?? null,
      findMany: async ({ where, include }: { where: Row; include?: Row }) => {
        let rows = db.items;
        if (where.projectId !== undefined) rows = rows.filter((i) => i.projectId === where.projectId);
        if (where.stateId !== undefined) rows = rows.filter((i) => i.stateId === where.stateId);
        if (where.parentId !== undefined) rows = rows.filter((i) => i.parentId === where.parentId);
        return rows.map((i) => resolveItem(i, include));
      },
      create: async ({ data }: { data: Row }) => {
        fire("pmWorkItem.create");
        const it: Row = {
          id: uid("wi"),
          descriptionHtml: null,
          stateId: null,
          priority: "none",
          parentId: null,
          cycleId: null,
          createdById: null,
          startDate: null,
          dueDate: null,
          isCompleted: false,
          completedAt: null,
          isArchived: false,
          archivedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        const ass = (data.assignees as { create?: Row[] } | undefined)?.create ?? [];
        const lbs = (data.labels as { create?: Row[] } | undefined)?.create ?? [];
        delete (it as Row).assignees;
        delete (it as Row).labels;
        db.items.push(it);
        for (const a of ass) db.assignees.push({ id: uid("as"), workItemId: it.id, ...a });
        for (const l of lbs) db.itemLabels.push({ id: uid("il"), workItemId: it.id, ...l });
        return it;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const it = db.items.find((i) => i.id === where.id)!;
        if (data.state && typeof data.state === "object") {
          const st = data.state as { connect?: { id: string }; disconnect?: boolean };
          it.stateId = st.connect ? st.connect.id : null;
          delete (data as Row).state;
        }
        if (data.parent && typeof data.parent === "object") {
          const pt = data.parent as { connect?: { id: string }; disconnect?: boolean };
          it.parentId = pt.connect ? pt.connect.id : null;
          delete (data as Row).parent;
        }
        Object.assign(it, data);
        return it;
      },
      delete: async ({ where }: { where: Row }) => {
        fire("pmWorkItem.delete");
        db.items = db.items.filter((i) => i.id !== where.id);
        return {};
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const matches = db.items.filter((i) => {
          if (where.parentId !== undefined && i.parentId !== where.parentId) return false;
          if (where.stateId !== undefined && i.stateId !== where.stateId) return false;
          if (where.isCompleted !== undefined && i.isCompleted !== where.isCompleted) return false;
          return true;
        });
        for (const it of matches) Object.assign(it, data);
        return { count: matches.length };
      },
    },

    pmWorkItemAssignee: {
      deleteMany: async ({ where }: { where: Row }) => {
        db.assignees = db.assignees.filter((a) => a.workItemId !== where.workItemId);
        return {};
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const a of data) db.assignees.push({ id: uid("as"), ...a });
        return { count: data.length };
      },
    },
    pmWorkItemLabel: {
      deleteMany: async ({ where }: { where: Row }) => {
        db.itemLabels = db.itemLabels.filter((l) => l.workItemId !== where.workItemId);
        return {};
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const l of data) db.itemLabels.push({ id: uid("il"), ...l });
        return { count: data.length };
      },
    },

    pmComment: {
      findMany: async ({ where }: { where: Row }) => db.comments.filter((c) => c.workItemId === where.workItemId),
      create: async ({ data }: { data: Row }) => {
        const c = { id: uid("cm"), authorId: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.comments.push(c);
        return c;
      },
    },

    pmActivity: {
      create: async ({ data }: { data: Row }) => {
        const a = { id: uid("ac"), createdAt: new Date(), ...data };
        db.activity.push(a);
        return a;
      },
      createMany: async ({ data }: { data: Row[] }) => {
        for (const row of data) db.activity.push({ id: uid("ac"), createdAt: new Date(), ...row });
        return { count: data.length };
      },
    },

    // WARP-2586: consulted by the composed work-item detail read and by
    // deleteWorkItem's pre-cascade relation audit. Both pass the two-arm
    // `OR: [{ fromId }, { toId }]` shape; the store stays empty in this file,
    // so the behaviour under test is "an item with no relations reads and
    // deletes exactly as before".
    pmWorkItemRelation: {
      findMany: async ({ where, take }: { where: Row; take?: number }) => {
        const or = (where.OR as Row[] | undefined) ?? [];
        const rows = db.relations.filter((r) => {
          if (where.kind !== undefined && r.kind !== where.kind) return false;
          if (or.length === 0) return true;
          return or.some(
            (c) =>
              (c.fromId !== undefined && r.fromId === c.fromId) ||
              (c.toId !== undefined && r.toId === c.toId),
          );
        });
        return take === undefined ? rows : rows.slice(0, take);
      },
    },
  };

  return { prisma, db, hooks };
}

// ── App harness ──────────────────────────────────────────────────────────────

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
  app.use("/api", createPmNativeRouter(prisma as never));
  return app;
}

const OWNER = { id: "user-owner", role: "owner" };
const GUEST = { id: "user-guest", role: "guest" };
const MCP = { id: "_service:mcp", role: "service" };

describe("native PM routes — RBAC", () => {
  let prisma: unknown;
  beforeEach(() => {
    id = 0;
    prisma = makeFake().prisma;
  });

  it("guest cannot create a project (403)", async () => {
    const res = await request(makeApp(prisma, GUEST))
      .post("/api/pm/projects")
      .send({ name: "Secret" });
    expect(res.status).toBe(403);
  });

  it("guest CAN read projects (200)", async () => {
    const res = await request(makeApp(prisma, GUEST)).get("/api/pm/projects");
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  it("owner can create a project (201)", async () => {
    const res = await request(makeApp(prisma, OWNER))
      .post("/api/pm/projects")
      .send({ name: "Home Reno" });
    expect(res.status).toBe(201);
    expect(res.body.project.identifier).toBe("HOMER");
  });

  // WARP-2058 — project create USED to 403 the MCP principal ("human-only"),
  // which made `pm_create_project` impossible and stopped the assistant at
  // "here are the tasks, now go make a project by hand". The human gate did
  // not disappear; it MOVED to where every other assistant write already
  // keeps it — the tool layer's `requiresConfirmation`, which is the same
  // split work-item create has used since WARP-509 (see the file header).
  //
  // The distinction that still matters is role, not principal: a guest is
  // refused outright (asserted above), because no confirmation prompt can
  // grant a permission the human behind it never had.
  it("MCP service principal can create both a project and a work item", async () => {
    const mcpApp = makeApp(prisma, MCP);
    const proj = await request(mcpApp).post("/api/pm/projects").send({ name: "Inbox" });
    expect(proj.status).toBe(201); // tool layer owns the confirmation gate
    const pid = proj.body.project.id;

    const ok = await request(mcpApp)
      .post(`/api/pm/projects/${pid}/work-items`)
      .send({ name: "From the assistant" });
    expect(ok.status).toBe(201);
  });
});

describe("native PM routes — validation", () => {
  it("rejects an empty work-item name (400)", async () => {
    const { prisma } = makeFake();
    const app = makeApp(prisma, OWNER);
    const proj = await request(app).post("/api/pm/projects").send({ name: "P" });
    const res = await request(app)
      .post(`/api/pm/projects/${proj.body.project.id}/work-items`)
      .send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

describe("native PM routes — work-item lifecycle", () => {
  let prisma: unknown;
  let db: ReturnType<typeof makeFake>["db"];
  let pid: string;

  beforeEach(async () => {
    id = 0;
    const fake = makeFake();
    prisma = fake.prisma;
    db = fake.db;
    const proj = await request(makeApp(prisma, OWNER))
      .post("/api/pm/projects")
      .send({ name: "Inbox" });
    pid = proj.body.project.id;
  });

  it("seeds the 5 default states with Todo as the landing state", async () => {
    const res = await request(makeApp(prisma, OWNER)).get(`/api/pm/projects/${pid}/states`);
    expect(res.body.states).toHaveLength(5);
    const dflt = res.body.states.find((s: { isDefault: boolean }) => s.isDefault);
    expect(dflt.name).toBe("Todo");
    expect(dflt.group).toBe("unstarted");
  });

  it("numbers work items per-project and lands them in the default state", async () => {
    const app = makeApp(prisma, OWNER);
    const a = await request(app).post(`/api/pm/projects/${pid}/work-items`).send({ name: "First" });
    const b = await request(app).post(`/api/pm/projects/${pid}/work-items`).send({ name: "Second" });
    expect(a.body.work_item.key).toBe("INBOX-1");
    expect(b.body.work_item.key).toBe("INBOX-2");
    expect(a.body.work_item.state.name).toBe("Todo");
    // a 'created' activity row per work item
    expect(db.activity.filter((x) => x.verb === "created")).toHaveLength(2);
  });

  it("transitions a work item and logs a state_changed activity", async () => {
    const app = makeApp(prisma, OWNER);
    const wi = await request(app).post(`/api/pm/projects/${pid}/work-items`).send({ name: "Ship it" });
    const states = await request(app).get(`/api/pm/projects/${pid}/states`);
    const done = states.body.states.find((s: { group: string }) => s.group === "completed");

    const res = await request(app)
      .post(`/api/pm/work-items/${wi.body.work_item.id}/transition`)
      .send({ state_id: done.id });
    expect(res.status).toBe(200);
    expect(res.body.work_item.state.name).toBe("Done");
    expect(res.body.work_item.completedAt).not.toBeNull();
    expect(db.activity.some((x) => x.verb === "state_changed")).toBe(true);
  });

  it("adds a comment and logs a commented activity", async () => {
    const app = makeApp(prisma, OWNER);
    const wi = await request(app).post(`/api/pm/projects/${pid}/work-items`).send({ name: "Discuss" });
    const res = await request(app)
      .post(`/api/pm/work-items/${wi.body.work_item.id}/comments`)
      .send({ comment_html: "<p>looks good</p>" });
    expect(res.status).toBe(201);
    expect(res.body.comment.commentHtml).toBe("<p>looks good</p>");
    expect(db.activity.some((x) => x.verb === "commented")).toBe(true);
  });

  it("returns 404 for a missing work item", async () => {
    const res = await request(makeApp(prisma, OWNER)).get("/api/pm/work-items/nope");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("work_item_not_found");
  });
});

describe("native PM routes — cross-project link guards (ADR-026 P2)", () => {
  let prisma: unknown;
  let app: ReturnType<typeof makeApp>;
  let projA: string;
  let projB: string;

  beforeEach(async () => {
    id = 0;
    prisma = makeFake().prisma;
    app = makeApp(prisma, OWNER);
    const a = await request(app).post("/api/pm/projects").send({ name: "Alpha" });
    const b = await request(app).post("/api/pm/projects").send({ name: "Bravo" });
    projA = a.body.project.id;
    projB = b.body.project.id;
  });

  it("rejects creating a work item whose parent lives in another project (422)", async () => {
    const parentInB = await request(app)
      .post(`/api/pm/projects/${projB}/work-items`)
      .send({ name: "Parent in B" });
    const res = await request(app)
      .post(`/api/pm/projects/${projA}/work-items`)
      .send({ name: "Child in A", parent_id: parentInB.body.work_item.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_parent");
  });

  it("rejects updating a work item to a parent in another project (422)", async () => {
    const childInA = await request(app)
      .post(`/api/pm/projects/${projA}/work-items`)
      .send({ name: "Child in A" });
    const parentInB = await request(app)
      .post(`/api/pm/projects/${projB}/work-items`)
      .send({ name: "Parent in B" });
    const res = await request(app)
      .patch(`/api/pm/work-items/${childInA.body.work_item.id}`)
      .send({ parent_id: parentInB.body.work_item.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_parent");
  });

  it("rejects creating a work item with a state from another project (422)", async () => {
    const statesB = await request(app).get(`/api/pm/projects/${projB}/states`);
    const stateInB = statesB.body.states[0].id;
    const res = await request(app)
      .post(`/api/pm/projects/${projA}/work-items`)
      .send({ name: "Item in A", state_id: stateInB });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_state");
  });

  it("rejects updating a work item to a state from another project (422)", async () => {
    const itemInA = await request(app)
      .post(`/api/pm/projects/${projA}/work-items`)
      .send({ name: "Item in A" });
    const statesB = await request(app).get(`/api/pm/projects/${projB}/states`);
    const stateInB = statesB.body.states[0].id;
    const res = await request(app)
      .patch(`/api/pm/work-items/${itemInA.body.work_item.id}`)
      .send({ state_id: stateInB });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_state");
  });

  it("still 404s when the patched state id does not exist at all", async () => {
    const itemInA = await request(app)
      .post(`/api/pm/projects/${projA}/work-items`)
      .send({ name: "Item in A" });
    const res = await request(app)
      .patch(`/api/pm/work-items/${itemInA.body.work_item.id}`)
      .send({ state_id: "st-does-not-exist" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("state_not_found");
  });

  it("allows a same-project parent and state (200/201) — guard is not over-broad", async () => {
    const states = await request(app).get(`/api/pm/projects/${projA}/states`);
    const sameState = states.body.states[0].id;
    const parent = await request(app)
      .post(`/api/pm/projects/${projA}/work-items`)
      .send({ name: "Parent in A" });
    const child = await request(app)
      .post(`/api/pm/projects/${projA}/work-items`)
      .send({ name: "Child in A", parent_id: parent.body.work_item.id, state_id: sameState });
    expect(child.status).toBe(201);
    const patched = await request(app)
      .patch(`/api/pm/work-items/${child.body.work_item.id}`)
      .send({ state_id: sameState });
    expect(patched.status).toBe(200);
  });
});

describe("native PM routes — deleteState last/default guards", () => {
  let prisma: unknown;
  let pid: string;

  beforeEach(async () => {
    id = 0;
    prisma = makeFake().prisma;
    const proj = await request(makeApp(prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    pid = proj.body.project.id;
  });

  it("refuses to delete the sole isDefault state (409)", async () => {
    const states = await request(makeApp(prisma, OWNER)).get(`/api/pm/projects/${pid}/states`);
    const dflt = states.body.states.find((s: { isDefault: boolean }) => s.isDefault);
    const res = await request(makeApp(prisma, OWNER)).delete(`/api/pm/states/${dflt.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("state_is_default");
  });

  it("deletes a non-default state when others remain (200)", async () => {
    const states = await request(makeApp(prisma, OWNER)).get(`/api/pm/projects/${pid}/states`);
    const nonDefault = states.body.states.find((s: { isDefault: boolean }) => !s.isDefault);
    const res = await request(makeApp(prisma, OWNER)).delete(`/api/pm/states/${nonDefault.id}`);
    expect(res.status).toBe(200);
  });

  it("reassigns work items parked in a deleted state to the project's default state (WARP-885)", async () => {
    const app = makeApp(prisma, OWNER);
    const states = await request(app).get(`/api/pm/projects/${pid}/states`);
    const done = states.body.states.find((s: { group: string }) => s.group === "completed");
    const dflt = states.body.states.find((s: { isDefault: boolean }) => s.isDefault);

    const wi = await request(app)
      .post(`/api/pm/projects/${pid}/work-items`)
      .send({ name: "Ship it", state_id: done.id });
    expect(wi.body.work_item.stateId).toBe(done.id);
    expect(wi.body.work_item.completedAt).not.toBeNull();

    const del = await request(app).delete(`/api/pm/states/${done.id}`);
    expect(del.status).toBe(200);

    const after = await request(app).get(`/api/pm/work-items/${wi.body.work_item.id}`);
    // Reassigned to the default landing state (not left NULL) and the
    // completion signal re-synced since Todo (default) isn't terminal.
    expect(after.body.work_item.stateId).toBe(dflt.id);
    expect(after.body.work_item.completedAt).toBeNull();
  });

  it("refuses to delete the last remaining state (409)", async () => {
    // Drain every non-default state, then the lone remaining default must be
    // protected as both last-and-default.
    const states = await request(makeApp(prisma, OWNER)).get(`/api/pm/projects/${pid}/states`);
    for (const s of states.body.states.filter((x: { isDefault: boolean }) => !x.isDefault)) {
      await request(makeApp(prisma, OWNER)).delete(`/api/pm/states/${s.id}`);
    }
    const remaining = await request(makeApp(prisma, OWNER)).get(`/api/pm/projects/${pid}/states`);
    expect(remaining.body.states).toHaveLength(1);
    const res = await request(makeApp(prisma, OWNER)).delete(`/api/pm/states/${remaining.body.states[0].id}`);
    expect(res.status).toBe(409);
  });
});

describe("native PM routes — Prisma race → typed HTTP mapping", () => {
  it("createProject identifier race → P2002 → 409 identifier_taken", async () => {
    id = 0;
    const hooks: Hooks = { "pmProject.create": "P2002" };
    const prisma = makeFake(hooks).prisma;
    const res = await request(makeApp(prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("identifier_taken");
  });

  it("deleteProject concurrent-delete race → P2025 → 404", async () => {
    id = 0;
    const fake = makeFake();
    const proj = await request(makeApp(fake.prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    fake.hooks["pmProject.delete"] = "P2025";
    const res = await request(makeApp(fake.prisma, OWNER)).delete(`/api/pm/projects/${proj.body.project.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("project_not_found");
  });

  it("deleteWorkItem concurrent-delete race → P2025 → 404", async () => {
    id = 0;
    const fake = makeFake();
    const proj = await request(makeApp(fake.prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    const wi = await request(makeApp(fake.prisma, OWNER))
      .post(`/api/pm/projects/${proj.body.project.id}/work-items`)
      .send({ name: "Doomed" });
    fake.hooks["pmWorkItem.delete"] = "P2025";
    const res = await request(makeApp(fake.prisma, OWNER)).delete(`/api/pm/work-items/${wi.body.work_item.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("work_item_not_found");
  });

  it("deleteState concurrent-delete race → P2025 → 404", async () => {
    id = 0;
    const fake = makeFake();
    const proj = await request(makeApp(fake.prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    const states = await request(makeApp(fake.prisma, OWNER)).get(`/api/pm/projects/${proj.body.project.id}/states`);
    const nonDefault = states.body.states.find((s: { isDefault: boolean }) => !s.isDefault);
    fake.hooks["pmState.delete"] = "P2025";
    const res = await request(makeApp(fake.prisma, OWNER)).delete(`/api/pm/states/${nonDefault.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("state_not_found");
  });

  it("deleteLabel concurrent-delete race → P2025 → 404", async () => {
    id = 0;
    const fake = makeFake();
    const proj = await request(makeApp(fake.prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    const label = await request(makeApp(fake.prisma, OWNER))
      .post(`/api/pm/projects/${proj.body.project.id}/labels`)
      .send({ name: "bug" });
    fake.hooks["pmLabel.delete"] = "P2025";
    const res = await request(makeApp(fake.prisma, OWNER)).delete(`/api/pm/labels/${label.body.label.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("label_not_found");
  });

  it("createWorkItem parent FK race → P2003 → 422 invalid_parent", async () => {
    id = 0;
    const fake = makeFake();
    const proj = await request(makeApp(fake.prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    const parent = await request(makeApp(fake.prisma, OWNER))
      .post(`/api/pm/projects/${proj.body.project.id}/work-items`)
      .send({ name: "Parent" });
    // Parent passes the existence check, then the FK is violated at insert time
    // (parent deleted concurrently) → Prisma P2003.
    fake.hooks["pmWorkItem.create"] = "P2003";
    const res = await request(makeApp(fake.prisma, OWNER))
      .post(`/api/pm/projects/${proj.body.project.id}/work-items`)
      .send({ name: "Child", parent_id: parent.body.work_item.id });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_parent");
  });
});

describe("native PM routes — pagination + sortOrder input validation", () => {
  let prisma: unknown;
  let pid: string;

  beforeEach(async () => {
    id = 0;
    prisma = makeFake().prisma;
    const proj = await request(makeApp(prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    pid = proj.body.project.id;
  });

  it("rejects a non-numeric per_page (400)", async () => {
    const res = await request(makeApp(prisma, OWNER)).get(`/api/pm/projects/${pid}/work-items?per_page=abc`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects a non-numeric page (400)", async () => {
    const res = await request(makeApp(prisma, OWNER)).get(`/api/pm/projects/${pid}/work-items?page=xyz`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("accepts a valid numeric per_page (200)", async () => {
    const res = await request(makeApp(prisma, OWNER)).get(`/api/pm/projects/${pid}/work-items?per_page=10&page=1`);
    expect(res.status).toBe(200);
  });

  it("rejects sortOrder=Infinity in a PATCH (400)", async () => {
    const wi = await request(makeApp(prisma, OWNER))
      .post(`/api/pm/projects/${pid}/work-items`)
      .send({ name: "Item" });
    const res = await request(makeApp(prisma, OWNER))
      .patch(`/api/pm/work-items/${wi.body.work_item.id}`)
      .send({ sortOrder: "Infinity" });
    // a string "Infinity" or a float is rejected by the schema before Prisma
    expect(res.status).toBe(400);
  });
});

describe("native PM routes — identity PATCH writes no spurious activity row", () => {
  let prisma: unknown;
  let db: ReturnType<typeof makeFake>["db"];
  let pid: string;
  let wiId: string;

  beforeEach(async () => {
    id = 0;
    const fake = makeFake();
    prisma = fake.prisma;
    db = fake.db;
    const proj = await request(makeApp(prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    pid = proj.body.project.id;
    const wi = await request(makeApp(prisma, OWNER))
      .post(`/api/pm/projects/${pid}/work-items`)
      .send({ name: "Item", assignees: ["u1", "u2"], label_ids: [] });
    wiId = wi.body.work_item.id;
  });

  it("re-PATCHing the SAME assignees writes no 'updated' activity row", async () => {
    const before = db.activity.filter((a) => a.verb === "updated").length;
    const res = await request(makeApp(prisma, OWNER))
      .patch(`/api/pm/work-items/${wiId}`)
      .send({ assignees: ["u1", "u2"] });
    expect(res.status).toBe(200);
    const after = db.activity.filter((a) => a.verb === "updated").length;
    expect(after).toBe(before);
  });

  it("CHANGING the assignee set DOES write an 'updated' activity row", async () => {
    const before = db.activity.filter((a) => a.verb === "updated").length;
    const res = await request(makeApp(prisma, OWNER))
      .patch(`/api/pm/work-items/${wiId}`)
      .send({ assignees: ["u1", "u3"] });
    expect(res.status).toBe(200);
    const after = db.activity.filter((a) => a.verb === "updated").length;
    expect(after).toBe(before + 1);
  });

  it("re-PATCHing the SAME (empty) labelIds writes no 'updated' activity row", async () => {
    const before = db.activity.filter((a) => a.verb === "updated").length;
    const res = await request(makeApp(prisma, OWNER))
      .patch(`/api/pm/work-items/${wiId}`)
      .send({ label_ids: [] });
    expect(res.status).toBe(200);
    const after = db.activity.filter((a) => a.verb === "updated").length;
    expect(after).toBe(before);
  });
});
