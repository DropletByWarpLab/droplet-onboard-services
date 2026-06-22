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

function makeFake() {
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
        const p: Row = {
          id: uid("proj"),
          seqCounter: 0,
          sortOrder: 0,
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
        db.projects = db.projects.filter((x) => x.id !== where.id);
        return {};
      },
    },

    pmState: {
      findMany: async ({ where }: { where: Row }) => db.states.filter((s) => s.projectId === where.projectId),
      findUnique: async ({ where }: { where: Row }) => db.states.find((s) => s.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Row }) =>
        db.states.find((s) => s.id === where.id && (!where.projectId || s.projectId === where.projectId)) ?? null,
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
        let rows = db.items.filter((i) => i.projectId === where.projectId);
        if (where.stateId) rows = rows.filter((i) => i.stateId === where.stateId);
        return rows.map((i) => resolveItem(i, include));
      },
      create: async ({ data }: { data: Row }) => {
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
          completedAt: null,
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
        db.items = db.items.filter((i) => i.id !== where.id);
        return {};
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
    },
  };

  return { prisma, db };
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

  it("MCP service principal can create a work item but not a project", async () => {
    const app = makeApp(prisma, OWNER);
    const proj = await request(app).post("/api/pm/projects").send({ name: "Inbox" });
    const pid = proj.body.project.id;

    const mcpApp = makeApp(prisma, MCP);
    const denied = await request(mcpApp).post("/api/pm/projects").send({ name: "X" });
    expect(denied.status).toBe(403); // project create is human-only

    const ok = await request(mcpApp)
      .post(`/api/pm/projects/${pid}/work-items`)
      .send({ name: "From the assistant" });
    expect(ok.status).toBe(201); // work-item create admits the MCP principal
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
