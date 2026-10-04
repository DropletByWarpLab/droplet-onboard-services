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
function prismaError(code: string, fieldName?: string): Error & { code: string } {
  const e = new Error(`Prisma ${code}`) as Error & { code: string; meta?: Row };
  e.name = "PrismaClientKnownRequestError";
  e.code = code;
  // ADR-048 — a real P2003 names the constraint it violated. `PmProject` has
  // three settable FKs, so the service maps ONLY the company one; tests need
  // the field name to prove that discrimination works.
  if (fieldName) e.meta = { field_name: fieldName };
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
      const [c, field] = code.split(":");
      throw prismaError(c, field);
    }
  };
  const db = {
    workspaces: [] as Row[],
    projects: [] as Row[],
    // ADR-048 (WARP-2729) — `assertCompanyExists` probes this before a project
    // may be filed under a customer.
    companies: [] as Row[],
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
    // WARP-3519 — the collaboration tables the comment / create / assign paths
    // now write or read. The watch list is written by createWorkItem,
    // updateWorkItem and addComment; mentions and reactions are read back by
    // every comment list.
    watchers: [] as Row[],
    mentions: [] as Row[],
    reactions: [] as Row[],
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
          companyId: null,
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
        fire("pmProject.update");
        const p = db.projects.find((x) => x.id === where.id)!;
        // Prisma's checked update exposes relations, not raw FKs — mirror the
        // connect/disconnect the service actually sends.
        const rel = data.company as { connect?: Row; disconnect?: boolean } | undefined;
        if (rel) {
          p.companyId = rel.disconnect ? null : (rel.connect as Row).id;
          delete (data as Row).company;
        }
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

    crmCompany: {
      findUnique: async ({ where }: { where: Row }) =>
        db.companies.find((c) => c.id === where.id) ?? null,
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
        // WARP-3407 — `assignees: { some: { userId } }` (the own-assignments list, and `?assignee=`).
        const some = (where.assignees as { some?: { userId?: string } } | undefined)?.some;
        if (some?.userId) {
          rows = rows.filter((i) => db.assignees.some((a) => a.workItemId === i.id && a.userId === some.userId));
        }
        return rows.map((i) => {
          const out = resolveItem(i, include);
          // The cross-project readers join the project per row.
          if (include?.project) {
            const p = db.projects.find((x) => x.id === i.projectId);
            out.project = { identifier: p?.identifier, department: null };
          }
          return out;
        });
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
      // WARP-3369 — the per-item guard's lookup: "is this item (or, for the
      // state list, an item in this project) assigned to this user".
      findFirst: async ({ where }: { where: Row }) =>
        db.assignees.find(
          (a) =>
            (where.userId === undefined || a.userId === where.userId) &&
            (where.workItemId === undefined || a.workItemId === where.workItemId) &&
            (where.workItem === undefined ||
              db.items.find((i) => i.id === a.workItemId)?.projectId === (where.workItem as Row).projectId),
        ) ?? null,
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

    // WARP-3519 — `skipDuplicates` on the unique (workItemId, userId), as the
    // real table does it.
    pmWorkItemWatcher: {
      createMany: async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const w of data) {
          if (db.watchers.some((x) => x.workItemId === w.workItemId && x.userId === w.userId)) continue;
          db.watchers.push({ id: uid("wt"), createdAt: new Date(), ...w });
          count++;
        }
        return { count };
      },
    },
    // The comment list batches mentions and reactions in two reads.
    pmCommentMention: {
      findMany: async ({ where }: { where: Row }) =>
        db.mentions.filter((m) => (where.commentId as { in: string[] }).in.includes(m.commentId as string)),
    },
    pmCommentReaction: {
      findMany: async ({ where }: { where: Row }) =>
        db.reactions.filter((r) => (where.commentId as { in: string[] }).in.includes(r.commentId as string)),
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

  // WARP-3369: this router alone does not floor reads, and this pins that it
  // does not — the external-guest refusal is the `projects` module's tier floor
  // mounted by `mountModuleGates` (proved through the real mount in
  // __tests__/guest-company-data.test.ts), so a guest never reaches here.
  it("a read that reaches the router unguarded is served (the guest floor is the module gate's, not this router's)", async () => {
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

  it("CHANGING the assignee set writes assigned/unassigned, not a generic 'updated'", async () => {
    // WARP-2587 — this case used to pin `updated`, because assignee churn was
    // folded into the `updated`/`fields` bucket. It is not any more: `assigned`
    // and `unassigned` had been members of PmActivityVerb since WARP-884 with
    // ZERO writers, and this is the change that gave them one.
    //
    // The test's intent is unchanged and is what still holds — an identity
    // PATCH writes nothing, a real change writes an audit row. What changed is
    // that the row now NAMES what happened, which is strictly more information
    // and which the dashboard was already built to render: `detail.tsx`'s
    // `humanizeActivity` has carried `case "assigned": "changed assignees"`
    // all along, against a producer that did not exist. `updated` rendered as
    // the vaguer "updated the item".
    //
    // Asserted per-verb rather than as a total, so this cannot pass on a
    // future change that emits the right COUNT of the wrong rows.
    const before = db.activity.length;
    const res = await request(makeApp(prisma, OWNER))
      .patch(`/api/pm/work-items/${wiId}`)
      .send({ assignees: ["u1", "u3"] });
    expect(res.status).toBe(200);

    const written = db.activity.slice(before);
    // u1,u2 -> u1,u3 is exactly one departure and one arrival.
    expect(written.filter((a) => a.verb === "unassigned")).toHaveLength(1);
    expect(written.filter((a) => a.verb === "assigned")).toHaveLength(1);
    // ...and NOT the generic bucket, which is the regression this replaces.
    expect(written.filter((a) => a.verb === "updated")).toHaveLength(0);
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

// ── WARP-3519 — updateWorkItem names what changed ────────────────────────────
// A name, description, priority, start-date or label change used to share ONE
// generic `updated` row (priority had its own field on it). Each now has a verb
// that names it, so the item's timeline can say what happened.

describe("native PM routes — activity names what changed (WARP-3519)", () => {
  let prisma: unknown;
  let db: ReturnType<typeof makeFake>["db"];
  let pid: string;
  let wiId: string;

  const patch = (body: Record<string, unknown>) =>
    request(makeApp(prisma, OWNER)).patch(`/api/pm/work-items/${wiId}`).send(body);

  beforeEach(async () => {
    id = 0;
    const fake = makeFake();
    prisma = fake.prisma;
    db = fake.db;
    const proj = await request(makeApp(prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    pid = proj.body.project.id;
    const wi = await request(makeApp(prisma, OWNER))
      .post(`/api/pm/projects/${pid}/work-items`)
      .send({ name: "Item", assignees: ["u1"] });
    wiId = wi.body.work_item.id;
  });

  const written = (before: number) => db.activity.slice(before);

  it("a rename writes title_changed with the old and the new name, and nothing generic", async () => {
    const before = db.activity.length;
    expect((await patch({ name: "Renamed" })).status).toBe(200);
    expect(written(before)).toEqual([
      expect.objectContaining({ verb: "title_changed", field: "name", oldValue: "Item", newValue: "Renamed" }),
    ]);
  });

  it("a description edit writes description_changed WITHOUT storing the document", async () => {
    const before = db.activity.length;
    expect((await patch({ description_html: "<p>new text</p>" })).status).toBe(200);
    const rows = written(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verb: "description_changed", field: "description" });
    expect(rows[0].oldValue ?? null).toBeNull();
    expect(rows[0].newValue ?? null).toBeNull();
  });

  it("a priority change writes priority_changed (it used to be updated/priority)", async () => {
    const before = db.activity.length;
    expect((await patch({ priority: "high" })).status).toBe(200);
    expect(written(before)).toEqual([
      expect.objectContaining({ verb: "priority_changed", field: "priority", oldValue: "none", newValue: "high" }),
    ]);
  });

  it("a start-date change is the one that still writes `updated`, with an explicit field", async () => {
    const before = db.activity.length;
    expect((await patch({ start_date: "2026-10-05T00:00:00.000Z" })).status).toBe(200);
    expect(written(before)).toEqual([
      expect.objectContaining({
        verb: "updated",
        field: "startDate",
        oldValue: null,
        newValue: "2026-10-05T00:00:00.000Z",
      }),
    ]);
  });

  it("label changes write one label_added / label_removed per label, carrying the label id", async () => {
    db.labels.push(
      { id: "lab-old", projectId: pid, name: "old", color: null },
      { id: "lab-new", projectId: pid, name: "new", color: null },
    );
    db.itemLabels.push({ id: "il-seed", workItemId: wiId, labelId: "lab-old" });
    const before = db.activity.length;
    expect((await patch({ label_ids: ["lab-new"] })).status).toBe(200);
    const rows = written(before);
    expect(rows.find((r) => r.verb === "label_added")).toMatchObject({
      field: "labels",
      oldValue: null,
      newValue: "lab-new",
    });
    expect(rows.find((r) => r.verb === "label_removed")).toMatchObject({
      field: "labels",
      oldValue: "lab-old",
      newValue: null,
    });
    expect(rows).toHaveLength(2);
  });

  it("an identity PATCH of all of them writes nothing", async () => {
    const before = db.activity.length;
    expect((await patch({ name: "Item", priority: "none", label_ids: [] })).status).toBe(200);
    expect(written(before)).toEqual([]);
  });
});

// ── WARP-3519 — the automatic half of the watch list ─────────────────────────

describe("native PM routes — creating, assigning and commenting subscribe (WARP-3519)", () => {
  let prisma: unknown;
  let db: ReturnType<typeof makeFake>["db"];
  let pid: string;

  beforeEach(async () => {
    id = 0;
    const fake = makeFake();
    prisma = fake.prisma;
    db = fake.db;
    const proj = await request(makeApp(prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    pid = proj.body.project.id;
  });

  const create = (body: Record<string, unknown>, user = OWNER) =>
    request(makeApp(prisma, user)).post(`/api/pm/projects/${pid}/work-items`).send(body);

  it("the creator watches as CREATOR and each assignee as ASSIGNEE", async () => {
    const res = await create({ name: "Item", assignees: ["u1", "u2"] });
    expect(res.status).toBe(201);
    const rows = db.watchers.filter((w) => w.workItemId === res.body.work_item.id);
    expect(rows.map((w) => [w.userId, w.reason]).sort()).toEqual(
      [
        [OWNER.id, "CREATOR"],
        ["u1", "ASSIGNEE"],
        ["u2", "ASSIGNEE"],
      ].sort(),
    );
  });

  it("a creator who is also an assignee is ONE watcher, recorded as the creator", async () => {
    const res = await create({ name: "Item", assignees: [OWNER.id] });
    const rows = db.watchers.filter((w) => w.workItemId === res.body.work_item.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: OWNER.id, reason: "CREATOR" });
  });

  it("a newly assigned person watches; unassigning them does NOT unwatch", async () => {
    const res = await create({ name: "Item", assignees: ["u1"] });
    const wid = res.body.work_item.id as string;
    await request(makeApp(prisma, OWNER)).patch(`/api/pm/work-items/${wid}`).send({ assignees: ["u1", "u3"] });
    expect(db.watchers.find((w) => w.workItemId === wid && w.userId === "u3")).toMatchObject({
      reason: "ASSIGNEE",
    });
    await request(makeApp(prisma, OWNER)).patch(`/api/pm/work-items/${wid}`).send({ assignees: ["u3"] });
    expect(db.watchers.some((w) => w.workItemId === wid && w.userId === "u1")).toBe(true);
  });

  it("commenting watches as COMMENTER, and a comment carries its id on the activity row", async () => {
    const res = await create({ name: "Item" });
    const wid = res.body.work_item.id as string;
    const comment = await request(makeApp(prisma, { id: "user-member", role: "family" }))
      .post(`/api/pm/work-items/${wid}/comments`)
      .send({ comment_html: "<p>hello</p>" });
    expect(comment.status).toBe(201);
    expect(db.watchers.find((w) => w.workItemId === wid && w.userId === "user-member")).toMatchObject({
      reason: "COMMENTER",
    });
    // The notify sweep reads the comment id off this row (field + newValue).
    expect(db.activity.find((a) => a.verb === "commented")).toMatchObject({
      field: "comment",
      newValue: comment.body.comment.id,
    });
    // The wire shape grew, additively.
    expect(comment.body.comment).toMatchObject({
      editedAt: null,
      deleted: false,
      deletedAt: null,
      deletedById: null,
      mentions: [],
      reactions: [],
    });
  });
});

// ── ADR-048 (WARP-2729) — filing a project under a customer ──────────────────
// The `company_id` writer added by this PR was previously unobservable and
// undefended: nothing asserted the round-trip, `""` slipped past the existence
// check into an invalid FK write, and a customer deleted mid-request produced a
// raw 500 instead of a 404.

describe("native PM routes — project → customer link (ADR-048)", () => {
  const COMPANY = "co-acme";

  function seeded() {
    id = 0;
    const fake = makeFake();
    fake.db.companies.push({ id: COMPANY, name: "Acme" });
    return fake;
  }

  it("POST company_id links the project AND the link is readable back", async () => {
    const fake = seeded();
    const app = makeApp(fake.prisma, OWNER);
    const created = await request(app).post("/api/pm/projects").send({ name: "Roof", company_id: COMPANY });
    expect(created.status).toBe(201);
    // Observability: without `companyId` on ApiProject the write could only be
    // confirmed by reading Postgres directly.
    expect(created.body.project.companyId).toBe(COMPANY);

    const fetched = await request(app).get(`/api/pm/projects/${created.body.project.id}`);
    expect(fetched.body.project.companyId).toBe(COMPANY);
  });

  it("POST an unknown company_id → 404 company_not_found", async () => {
    const fake = seeded();
    const res = await request(makeApp(fake.prisma, OWNER))
      .post("/api/pm/projects")
      .send({ name: "Roof", company_id: "co-nope" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("company_not_found");
  });

  it('POST company_id: "" is rejected at the boundary (400), never written', async () => {
    // The defect: "" is falsy, so the old truthy guard skipped the existence
    // check, and `?? null` does not coerce "" — an empty FK reached Postgres.
    const fake = seeded();
    const res = await request(makeApp(fake.prisma, OWNER))
      .post("/api/pm/projects")
      .send({ name: "Roof", company_id: "" });
    expect(res.status).toBe(400);
    expect(fake.db.projects).toHaveLength(0);
  });

  it('PATCH company_id: "" is rejected (400) — "" is malformed, not a clear', async () => {
    const fake = seeded();
    const app = makeApp(fake.prisma, OWNER);
    const proj = await request(app).post("/api/pm/projects").send({ name: "Roof", company_id: COMPANY });
    const res = await request(app).patch(`/api/pm/projects/${proj.body.project.id}`).send({ company_id: "" });
    expect(res.status).toBe(400);
    // …and the existing link is untouched.
    const after = await request(app).get(`/api/pm/projects/${proj.body.project.id}`);
    expect(after.body.project.companyId).toBe(COMPANY);
  });

  it("PATCH company_id: null clears the link", async () => {
    const fake = seeded();
    const app = makeApp(fake.prisma, OWNER);
    const proj = await request(app).post("/api/pm/projects").send({ name: "Roof", company_id: COMPANY });
    const res = await request(app).patch(`/api/pm/projects/${proj.body.project.id}`).send({ company_id: null });
    expect(res.status).toBe(200);
    expect(res.body.project.companyId).toBeNull();
  });

  it("createProject company FK race → P2003 → 404 company_not_found", async () => {
    // The company passes `assertCompanyExists`, then is hard-deleted before the
    // insert. Companies CAN be hard-deleted, so this race is reachable.
    const fake = seeded();
    fake.hooks["pmProject.create"] = "P2003:PmProject_companyId_fkey (index)";
    const res = await request(makeApp(fake.prisma, OWNER))
      .post("/api/pm/projects")
      .send({ name: "Roof", company_id: COMPANY });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("company_not_found");
  });

  it("updateProject company FK race → P2003 → 404 company_not_found", async () => {
    const fake = seeded();
    const app = makeApp(fake.prisma, OWNER);
    const proj = await request(app).post("/api/pm/projects").send({ name: "Roof" });
    fake.hooks["pmProject.update"] = "P2003:PmProject_companyId_fkey (index)";
    const res = await request(app)
      .patch(`/api/pm/projects/${proj.body.project.id}`)
      .send({ company_id: COMPANY });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("company_not_found");
  });

  it("🔴 a P2003 on a DIFFERENT foreign key is NOT reported as company_not_found", async () => {
    // The discrimination that makes the mapping honest. `PmProject` has three
    // settable FKs; blanket-mapping P2003 would tell an operator the customer
    // is missing when the DEPARTMENT is the row that vanished.
    const fake = seeded();
    fake.hooks["pmProject.create"] = "P2003:PmProject_departmentId_fkey (index)";
    const res = await request(makeApp(fake.prisma, OWNER))
      .post("/api/pm/projects")
      .send({ name: "Roof", company_id: COMPANY });
    expect(res.body.error).not.toBe("company_not_found");
  });
});

// ── WARP-3369 (Romain, 2026-09-30): assigning a work item to an external guest
// SHARES that one item with them. The router's own per-item guard, with the
// router mounted alone (no prefix floor): the defence that holds if the mount
// ever changes. The mount-level half is __tests__/guest-work-item-share.test.ts.
describe("native PM routes — a work item assigned to an external guest is shared with them (WARP-3369)", () => {
  const GUEST_ASSIGNED = { id: "user-guest", role: "guest" };
  const OTHER_GUEST = { id: "user-other-guest", role: "guest" };
  let prisma: unknown;
  let pid: string;
  let mine: string;
  let theirs: string;
  let doneStateId: string;

  beforeEach(async () => {
    id = 0;
    prisma = makeFake().prisma;
    const owner = makeApp(prisma, OWNER);
    pid = (await request(owner).post("/api/pm/projects").send({ name: "Inbox" })).body.project.id;
    mine = (
      await request(owner)
        .post(`/api/pm/projects/${pid}/work-items`)
        .send({ name: "Mine", assignees: [GUEST_ASSIGNED.id] })
    ).body.work_item.id;
    theirs = (
      await request(owner).post(`/api/pm/projects/${pid}/work-items`).send({ name: "Theirs" })
    ).body.work_item.id;
    const states = await request(owner).get(`/api/pm/projects/${pid}/states`);
    doneStateId = states.body.states.find((s: { group: string }) => s.group === "completed").id;
  });

  const refused = (res: { status: number; body: { error?: string; module?: string } }) =>
    res.status === 404 && res.body.error === "module_disabled" && res.body.module === "projects";

  it("the assigned guest reads the item, reads and writes its comments, and moves its state", async () => {
    const app = makeApp(prisma, GUEST_ASSIGNED);
    const item = await request(app).get(`/api/pm/work-items/${mine}`);
    expect(item.status).toBe(200);
    expect(item.body.work_item.name).toBe("Mine");

    expect((await request(app).get(`/api/pm/work-items/${mine}/comments`)).status).toBe(200);
    const comment = await request(app)
      .post(`/api/pm/work-items/${mine}/comments`)
      .send({ comment_html: "<p>on it</p>" });
    expect(comment.status).toBe(201);

    // the state names to move it to, for the project holding an item assigned to them
    const states = await request(app).get(`/api/pm/projects/${pid}/states`);
    expect(states.status).toBe(200);
    const moved = await request(app)
      .post(`/api/pm/work-items/${mine}/transition`)
      .send({ state_id: doneStateId });
    expect(moved.status).toBe(200);
    expect(moved.body.work_item.state.name).toBe("Done");
  });

  it("the guest's detail carries the item and NO relations (a relation names another item)", async () => {
    const res = await request(makeApp(prisma, GUEST_ASSIGNED)).get(`/api/pm/work-items/${mine}`);
    expect(res.body.relations).toEqual([]);
  });

  it("an item NOT assigned to them is 404 module_disabled on all five routes — and so is one that does not exist", async () => {
    const app = makeApp(prisma, GUEST_ASSIGNED);
    for (const [method, url] of [
      ["get", `/api/pm/work-items/${theirs}`],
      ["get", `/api/pm/work-items/${theirs}/comments`],
      ["post", `/api/pm/work-items/${theirs}/comments`],
      ["post", `/api/pm/work-items/${theirs}/transition`],
      ["get", `/api/pm/work-items/no-such-item`],
      ["post", `/api/pm/work-items/no-such-item/comments`],
    ] as const) {
      const res = await request(app)[method](url).send({ comment_html: "<p>x</p>", state_id: doneStateId });
      expect(refused(res), `${method} ${url} -> ${res.status}`).toBe(true);
    }
    // nothing was written
    expect((await request(makeApp(prisma, OWNER)).get(`/api/pm/work-items/${theirs}/comments`)).body.comments).toEqual([]);
  });

  it("the state list is for a project holding an item assigned to them, and for no other", async () => {
    const other = (await request(makeApp(prisma, OWNER)).post("/api/pm/projects").send({ name: "Other" })).body.project.id;
    const res = await request(makeApp(prisma, GUEST_ASSIGNED)).get(`/api/pm/projects/${other}/states`);
    expect(refused(res)).toBe(true);
  });

  it("another guest, to whom nothing is assigned, reaches none of it", async () => {
    const app = makeApp(prisma, OTHER_GUEST);
    expect(refused(await request(app).get(`/api/pm/work-items/${mine}`))).toBe(true);
    expect(refused(await request(app).get(`/api/pm/projects/${pid}/states`))).toBe(true);
    expect(refused(await request(app).post(`/api/pm/work-items/${mine}/comments`).send({ comment_html: "<p>x</p>" }))).toBe(true);
  });

  it("the assigned guest still cannot edit, delete or assign: those routes stay role-gated", async () => {
    const app = makeApp(prisma, GUEST_ASSIGNED);
    expect((await request(app).patch(`/api/pm/work-items/${mine}`).send({ name: "renamed" })).status).toBe(403);
    expect((await request(app).delete(`/api/pm/work-items/${mine}`)).status).toBe(403);
    expect((await request(app).post(`/api/pm/projects/${pid}/work-items`).send({ name: "new" })).status).toBe(403);
  });

  it("members, admins and owners are untouched by the guard (no lookup is made for them)", async () => {
    for (const role of ["family", "admin", "owner"]) {
      const app = makeApp(prisma, { id: `user-${role}`, role });
      expect((await request(app).get(`/api/pm/work-items/${theirs}`)).status, role).toBe(200);
      expect((await request(app).get(`/api/pm/work-items/${theirs}/comments`)).status, role).toBe(200);
    }
    // a member's detail still carries the relations key as before
    const detail = await request(makeApp(prisma, { id: "user-family", role: "family" })).get(`/api/pm/work-items/${theirs}`);
    expect(Array.isArray(detail.body.relations)).toBe(true);
  });

  // WARP-3407 — how the guest FINDS what was shared with them: the list of the
  // items assigned to them, and nothing else.
  it("the assigned guest lists exactly the items assigned to them", async () => {
    const res = await request(makeApp(prisma, GUEST_ASSIGNED)).get("/api/pm/assigned-to-me");
    expect(res.status).toBe(200);
    expect(res.body.work_items.map((w: { id: string }) => w.id)).toEqual([mine]);
    expect(res.body.work_items[0].key).toBe("INBOX-1");
  });

  it("another guest lists nothing, and no query widens anyone's list to someone else's work", async () => {
    const other = await request(makeApp(prisma, OTHER_GUEST)).get("/api/pm/assigned-to-me");
    expect(other.status).toBe(200);
    expect(other.body.work_items).toEqual([]);
    const widened = await request(makeApp(prisma, GUEST_ASSIGNED)).get(
      `/api/pm/assigned-to-me?assignee=user-owner&userId=user-owner&project=${pid}`,
    );
    expect(widened.body.work_items.map((w: { id: string }) => w.id)).toEqual([mine]);
  });

  it("a member's own list is theirs too, and a bad page is a 400", async () => {
    const owner = makeApp(prisma, OWNER);
    const theirsToo = (
      await request(owner).post(`/api/pm/projects/${pid}/work-items`).send({ name: "Member's", assignees: ["user-family"] })
    ).body.work_item.id;
    const app = makeApp(prisma, { id: "user-family", role: "family" });
    expect((await request(app).get("/api/pm/assigned-to-me")).body.work_items.map((w: { id: string }) => w.id)).toEqual([theirsToo]);
    expect((await request(app).get("/api/pm/assigned-to-me?per_page=abc")).status).toBe(400);
  });

  it("the MCP service principal is not a guest: the guard lets it through", async () => {
    const res = await request(makeApp(prisma, MCP)).get(`/api/pm/work-items/${theirs}`);
    expect(res.status).toBe(200);
  });

  it("a guest cannot lead a project (lead_is_guest, 422), wherever the lead id is asserted", async () => {
    // the fake has no `user` model: give the service the one lookup it makes
    (prisma as { user?: unknown }).user = {
      findUnique: async ({ where }: { where: { id: string } }) => ({ role: where.id.startsWith("user-guest") ? "guest" : "family" }),
    };
    const owner = makeApp(prisma, OWNER);
    const refused422 = await request(owner).patch(`/api/pm/projects/${pid}`).send({ leadId: GUEST_ASSIGNED.id });
    expect(refused422.status).toBe(422);
    expect(refused422.body).toEqual({ error: "lead_is_guest" });
    const ok = await request(owner).patch(`/api/pm/projects/${pid}`).send({ leadId: "user-family" });
    expect(ok.status).toBe(200);
  });
});
