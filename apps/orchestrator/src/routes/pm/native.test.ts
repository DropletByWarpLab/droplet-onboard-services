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

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import { createPmNativeRouter } from "./native.js";

// WARP-3370 — the audit recorder is the real singleton's job (and is proved
// against Postgres in __tests__/pm-project-lifecycle.pg.test.ts); here it is a
// pair of spies so the route's CALLS to it — which row, what it names, who — are
// what is asserted. `recordActivityInTx` is the in-transaction append the hard
// delete uses; `recordActivity` is the best-effort one archive/restore use.
const audit = vi.hoisted(() => ({
  recordActivity: vi.fn(async (_row: unknown) => null),
  recordActivityInTx: vi.fn(async (_tx: unknown, _row: unknown) => ({})),
}));
vi.mock("../../services/activity.singleton.js", () => audit);

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

/**
 * WARP-3371 — a small interpreter for the `where` / `orderBy` shapes the PM
 * lists build: scalar equality, `{ gt | lt | in | contains }`, `assignees.some`,
 * and `AND` / `OR`. A key the row does not carry (`project`, `department`, …)
 * is treated as satisfied — the same "returns what it can" stance this fake has
 * always taken — so the department clauses, which have their own suites, stay
 * inert here. It exists so a route test can drive a REAL cursor walk (limit,
 * keyset, total) instead of asserting against a stub that ignores `take`.
 */
function cmp(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number | string);
  const y = b instanceof Date ? b.getTime() : (b as number | string);
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchesWhere(row: Row, where: Row | undefined, assignees: Row[]): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "AND") {
      if (!(cond as Row[]).every((w) => matchesWhere(row, w, assignees))) return false;
      continue;
    }
    if (key === "OR") {
      if (!(cond as Row[]).some((w) => matchesWhere(row, w, assignees))) return false;
      continue;
    }
    if (key === "assignees") {
      const some = (cond as { some?: { userId?: string } }).some;
      if (some?.userId && !assignees.some((a) => a.workItemId === row.id && a.userId === some.userId)) return false;
      continue;
    }
    if (!(key in row)) continue;
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { gt?: unknown; lt?: unknown; in?: unknown[]; contains?: string; mode?: string };
      if (c.gt !== undefined && !(cmp(value, c.gt) > 0)) return false;
      if (c.lt !== undefined && !(cmp(value, c.lt) < 0)) return false;
      if (c.in !== undefined && !c.in.includes(value)) return false;
      if (c.contains !== undefined && !String(value ?? "").toLowerCase().includes(c.contains.toLowerCase())) return false;
      continue;
    }
    if (cond instanceof Date ? cmp(value, cond) !== 0 : value !== cond) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, "asc" | "desc">>;
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const [field, dir] = Object.entries(k)[0];
      const c = cmp(a[field], b[field]);
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
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
    // WARP-3372 — the people roster reads `user`.
    users: [] as Row[],
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

    // WARP-3372 — `where` / `orderBy` are interpreted, so the roster's filter
    // (ACTIVE humans only) is what is under test, not a stub that ignores it.
    user: {
      findMany: async ({ where, orderBy }: { where?: Row; orderBy?: unknown } = {}) => {
        // `id: { in }` is the assignee check (WARP-3371). A person is known if
        // seeded; an id that is not a `ghost-` one is treated as an ordinary
        // active member, so a test that only NAMES a user need not seed one. The
        // remaining `where` (ACTIVE, not a service principal) is still applied.
        const ids = (where?.id as { in?: string[] } | undefined)?.in;
        const pool: Row[] = ids
          ? ids
              .filter((i) => db.users.some((u) => u.id === i) || !i.startsWith("ghost-"))
              .map((i) => db.users.find((u) => u.id === i) ?? { id: i, role: "family", directoryStatus: "ACTIVE" })
          : db.users;
        return sortRows(
          pool.filter((u) => matchesWhere(u, where, db.assignees)),
          orderBy,
        );
      },
      findUnique: async ({ where }: { where: Row }) => db.users.find((u) => u.id === where.id) ?? null,
    },

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
      findMany: async ({ include, take }: { include?: Row; take?: number } = {}) =>
        db.projects
          .map((p) => ({
            ...p,
            ...(include?.workspace ? { workspace: db.workspaces.find((w) => w.id === p.workspaceId) } : {}),
          }))
          .slice(0, take),
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
      // WARP-3370 — compare-and-set writes: the `where` carries the state the
      // row must STILL be in, and `count` says whether this call moved it.
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = db.projects.filter((p) => matchesWhere(p, where, db.assignees));
        for (const p of hit) Object.assign(p, data);
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Row }) => {
        fire("pmProject.deleteMany");
        const hit = db.projects.filter((p) => matchesWhere(p, where, db.assignees));
        db.projects = db.projects.filter((p) => !hit.includes(p));
        return { count: hit.length };
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
      // `where` is interpreted (`id: { in }` + `projectId`): the label check scopes
      // its lookup to the project, and that scoping is what is under test.
      findMany: async ({ where }: { where: Row }) => db.labels.filter((l) => matchesWhere(l, where, db.assignees)),
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
      findMany: async ({
        where,
        include,
        orderBy,
        skip,
        take,
      }: {
        where: Row;
        include?: Row;
        orderBy?: unknown;
        skip?: number;
        take?: number;
      }) => {
        // WARP-3407 — `assignees: { some: { userId } }` (the own-assignments
        // list, and `?assignee=`) is interpreted by `matchesWhere`.
        let rows = sortRows(
          db.items.filter((i) => matchesWhere(i, where, db.assignees)),
          orderBy,
        );
        if (skip) rows = rows.slice(skip);
        if (take !== undefined) rows = rows.slice(0, take);
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
      // WARP-3371 — every list counts the filtered set for its `total`.
      count: async ({ where }: { where: Row }) =>
        db.items.filter((i) => matchesWhere(i, where, db.assignees)).length,
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
      findMany: async ({ where, orderBy, skip, take }: { where: Row; orderBy?: unknown; skip?: number; take?: number }) => {
        let rows = sortRows(
          db.comments.filter((c) => matchesWhere(c, where, db.assignees)),
          orderBy,
        );
        if (skip) rows = rows.slice(skip);
        return take === undefined ? rows : rows.slice(0, take);
      },
      count: async ({ where }: { where: Row }) => db.comments.filter((c) => matchesWhere(c, where, db.assignees)).length,
      create: async ({ data }: { data: Row }) => {
        const c = { id: uid("cm"), authorId: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.comments.push(c);
        return c;
      },
    },

    pmActivity: {
      findMany: async ({ where, orderBy, skip, take }: { where: Row; orderBy?: unknown; skip?: number; take?: number }) => {
        let rows = sortRows(
          db.activity.filter((a) => matchesWhere(a, where, db.assignees)),
          orderBy,
        );
        if (skip) rows = rows.slice(skip);
        return take === undefined ? rows : rows.slice(0, take);
      },
      count: async ({ where }: { where: Row }) => db.activity.filter((a) => matchesWhere(a, where, db.assignees)).length,
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

  it("deleteProject: the project is deleted by someone else between the check and the delete → 404", async () => {
    // (Was a P2025 on `delete`; the delete is now a compare-and-set `deleteMany`
    // whose count says whether it landed, so there is no P2025 to map.)
    id = 0;
    const fake = makeFake();
    const proj = await request(makeApp(fake.prisma, OWNER)).post("/api/pm/projects").send({ name: "Inbox" });
    const projectId = proj.body.project.id;
    await request(makeApp(fake.prisma, OWNER)).patch(`/api/pm/projects/${projectId}`).send({ archived: true });
    // The service reads the row (archived, exists), then another request removes it.
    const prisma = fake.prisma as { pmProject: { findUnique: (a: unknown) => Promise<unknown> } };
    const realFind = prisma.pmProject.findUnique;
    let first = true;
    prisma.pmProject.findUnique = async (a) => {
      const row = await realFind(a);
      if (first) {
        first = false;
        fake.db.projects = fake.db.projects.filter((p) => p.id !== projectId);
      }
      return row;
    };
    const res = await request(makeApp(fake.prisma, OWNER))
      .delete(`/api/pm/projects/${projectId}`)
      .send({ confirm_identifier: "INBOX" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("project_not_found");
    expect(audit.recordActivityInTx).not.toHaveBeenCalled();
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

// ── WARP-3371 — every work-item list is a PAGE ───────────────────────────────

describe("native PM routes — work-item lists are pages, never a silent ceiling (WARP-3371)", () => {
  let prisma: unknown;
  let db: ReturnType<typeof makeFake>["db"];
  let pid: string;
  let app: ReturnType<typeof makeApp>;

  beforeEach(async () => {
    id = 0;
    const fake = makeFake();
    prisma = fake.prisma;
    db = fake.db;
    app = makeApp(prisma, OWNER);
    const proj = await request(app).post("/api/pm/projects").send({ name: "Inbox" });
    pid = proj.body.project.id;
  });

  /** Seed rows straight into the fake: 250 POSTs buy nothing a loop of rows does not. */
  function seed(n: number, over: (i: number) => Row = () => ({})): void {
    const stateId = db.states.find((s) => s.projectId === pid && s.isDefault)!.id;
    for (let i = 1; i <= n; i += 1) {
      db.items.push({
        id: `wi-seed-${String(i).padStart(4, "0")}`,
        projectId: pid,
        sequenceId: i,
        name: `Item ${i}`,
        descriptionHtml: null,
        stateId,
        priority: "none",
        parentId: null,
        cycleId: null,
        departmentId: null,
        createdById: null,
        startDate: null,
        dueDate: null,
        sortOrder: i,
        isCompleted: false,
        completedAt: null,
        isArchived: false,
        archivedAt: null,
        createdAt: new Date(2026, 0, 1, 0, 0, i),
        updatedAt: new Date(2026, 0, 1, 0, 0, i),
        ...over(i),
      });
    }
  }

  const seedId = (n: number) => `wi-seed-${String(n).padStart(4, "0")}`;

  type PageBody = { work_items: Array<{ id: string }>; nextCursor: string | null; total: number };

  /** Follow `nextCursor` until it is null, the way the board does. */
  async function walk(base: string, query = ""): Promise<{ pages: PageBody[]; ids: string[] }> {
    const pages: PageBody[] = [];
    let cursor: string | null = null;
    do {
      const params = [query, cursor ? `cursor=${encodeURIComponent(cursor)}` : ""].filter(Boolean).join("&");
      const url: string = params ? `${base}${base.includes("?") ? "&" : "?"}${params}` : base;
      const res = await request(app).get(url);
      expect(res.status, url).toBe(200);
      const body = res.body as PageBody;
      pages.push(body);
      cursor = body.nextCursor;
      expect(pages.length).toBeLessThan(50); // a stuck cursor must fail, not hang
    } while (cursor);
    return { pages, ids: pages.flatMap((p) => p.work_items.map((w) => w.id)) };
  }

  const LIST = () => `/api/pm/projects/${pid}/work-items`;

  it("250 items: the default page is 100 of 250, and the cursor reaches every one exactly once, in order", async () => {
    seed(250);
    const first = await request(app).get(LIST());
    expect(first.status).toBe(200);
    expect(first.body.work_items).toHaveLength(100);
    expect(first.body.total).toBe(250);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const { pages, ids } = await walk(LIST());
    expect(pages.map((p) => p.work_items.length)).toEqual([100, 100, 50]);
    expect(pages.map((p) => p.total)).toEqual([250, 250, 250]);
    expect(pages[2].nextCursor).toBeNull();
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
    expect(ids).toEqual(Array.from({ length: 250 }, (_, i) => seedId(i + 1)));
  });

  it("`limit` up to 500 is honoured and nextCursor is null exactly when nothing remains", async () => {
    seed(120);
    const all = await request(app).get(`${LIST()}?limit=500`);
    expect(all.body.work_items).toHaveLength(120);
    expect(all.body.nextCursor).toBeNull();
    expect(all.body.total).toBe(120);

    // The page that ends EXACTLY at the last row is the last page: the extra
    // row the query fetches is the only proof of more, and there is none.
    const exact = await request(app).get(`${LIST()}?limit=120`);
    expect(exact.body.work_items).toHaveLength(120);
    expect(exact.body.nextCursor).toBeNull();
  });

  it("`per_page` still works as the old name for `limit`", async () => {
    seed(30);
    const res = await request(app).get(`${LIST()}?per_page=7`);
    expect(res.body.work_items).toHaveLength(7);
    expect(res.body.total).toBe(30);
    const both = await request(app).get(`${LIST()}?limit=3&per_page=9`);
    expect(both.body.work_items).toHaveLength(3); // `limit` wins
  });

  it("a legacy `page` still addresses an offset, and the cursor it returns continues from there", async () => {
    seed(10);
    const p2 = await request(app).get(`${LIST()}?limit=4&page=2`);
    expect(p2.body.work_items.map((w: { id: string }) => w.id)).toEqual([5, 6, 7, 8].map(seedId));
    const next = await request(app).get(`${LIST()}?limit=4&cursor=${encodeURIComponent(p2.body.nextCursor)}`);
    expect(next.body.work_items.map((w: { id: string }) => w.id)).toEqual([9, 10].map(seedId));
  });

  it("rows that share a sortOrder neither repeat nor vanish across a page boundary (id closes the tie)", async () => {
    seed(7, () => ({ sortOrder: 5 }));
    const { ids } = await walk(LIST(), "limit=2");
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
  });

  it("a row deleted between two pages does not shift or lose the next page — even the row the cursor points at", async () => {
    seed(10);
    const first = await request(app).get(`${LIST()}?limit=3`);
    const seen = first.body.work_items.map((w: { id: string }) => w.id);
    // The cursor names the LAST row of page 1; delete that very row.
    db.items = db.items.filter((i) => i.id !== seen[2]);
    const rest = await request(app).get(`${LIST()}?limit=100&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(rest.status).toBe(200);
    expect(rest.body.work_items.map((w: { id: string }) => w.id)).toEqual([4, 5, 6, 7, 8, 9, 10].map(seedId));
  });

  it("`total` counts the FILTERED set, not the page and not the project", async () => {
    seed(20, (i) => ({ priority: i % 4 === 0 ? "high" : "none" }));
    const res = await request(app).get(`${LIST()}?limit=2&priority=high`);
    expect(res.body.total).toBe(5);
    expect(res.body.work_items).toHaveLength(2);
    expect(res.body.nextCursor).toEqual(expect.any(String));
  });

  it.each([
    ["limit=0"],
    ["limit=501"],
    ["limit=abc"],
    ["limit=2.5"],
    ["limit="],
    ["per_page=0"],
    ["per_page=-3"],
    ["page=0"],
    ["page=abc"],
    ["page=100001"],
    ["cursor="],
    ["limit=1&limit=2"],
  ])("rejects out-of-range or non-numeric paging with 400, never a 500: ?%s", async (query) => {
    const res = await request(app).get(`${LIST()}?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("a cursor and a page together are a 400, not a guess", async () => {
    seed(5);
    const first = await request(app).get(`${LIST()}?limit=2`);
    const res = await request(app).get(`${LIST()}?page=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(res.status).toBe(400);
  });

  it("a cursor this list did not mint is a 400 invalid_cursor (garbage, and another list's)", async () => {
    seed(5);
    const garbage = await request(app).get(`${LIST()}?cursor=not-a-cursor`);
    expect(garbage.status).toBe(400);
    expect(garbage.body).toEqual({ error: "invalid_cursor" });

    // A search cursor (an `updatedAt` keyset) handed to the board (a `sortOrder` keyset).
    const search = await request(app).get(`/api/pm/work-items?q=Item&limit=2`);
    expect(search.body.nextCursor).toEqual(expect.any(String));
    const wrong = await request(app).get(`${LIST()}?cursor=${encodeURIComponent(search.body.nextCursor)}`);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("invalid_cursor");
  });

  it("the workspace search is a page too: newest change first, cursor-walkable, total exact", async () => {
    seed(25);
    const { pages, ids } = await walk(`/api/pm/work-items?q=Item`, "limit=10");
    expect(pages.map((p) => p.work_items.length)).toEqual([10, 10, 5]);
    expect(pages.every((p) => p.total === 25)).toBe(true);
    expect(new Set(ids).size).toBe(25);
    // newest `updatedAt` first
    expect(ids[0]).toBe(seedId(25));
    expect(ids[24]).toBe(seedId(1));
  });

  it("the search answers 400, not 500, for `?per_page=abc` (it used to reach `take` as NaN)", async () => {
    const res = await request(app).get(`/api/pm/work-items?q=x&per_page=abc`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("an empty search with no filter is an empty last page, with a total of zero", async () => {
    seed(3);
    const res = await request(app).get(`/api/pm/work-items?q=`);
    expect(res.body).toEqual({ work_items: [], nextCursor: null, total: 0 });
  });

  it("assigned-to-me is a page too, and walks to the end", async () => {
    seed(12);
    for (let i = 1; i <= 12; i += 1) {
      db.assignees.push({ id: `as-${i}`, workItemId: seedId(i), userId: OWNER.id });
    }
    const { pages, ids } = await walk(`/api/pm/assigned-to-me`, "limit=5");
    expect(pages.map((p) => p.work_items.length)).toEqual([5, 5, 2]);
    expect(pages.every((p) => p.total === 12)).toBe(true);
    expect(new Set(ids).size).toBe(12);
    const bad = await request(app).get(`/api/pm/assigned-to-me?cursor=nope`);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_cursor");
  });
});

// ── WARP-3372 — who a PM id names ───────────────────────────────────────────

describe("native PM routes — GET /pm/people names the people on the board (WARP-3372)", () => {
  let fake: ReturnType<typeof makeFake>;
  const user = (userId: string, displayName: string, over: Row = {}): Row => ({
    id: userId,
    displayName,
    role: "family",
    directoryStatus: "ACTIVE",
    // Everything the admin roster carries that this one must NOT leak.
    username: `${userId}-handle`,
    email: `${userId}@example.test`,
    ...over,
  });

  beforeEach(() => {
    id = 0;
    fake = makeFake();
    fake.db.users.push(
      user("u-zoe", "Zoe Park", { role: "owner" }),
      user("u-sam", "Sam Rubinchik", { role: "admin" }),
      user("u-ana", "Ana Lopez"),
      user("u-gus", "Gus Guest", { role: "guest" }),
      user("_service:mcp", "MCP", { role: "service" }),
      user("u-old", "Olga Leaver", { directoryStatus: "DEACTIVATED" }),
    );
  });

  it("a MEMBER (family) is answered — the 403 that left them looking at `User 1a2b` is gone", async () => {
    const res = await request(makeApp(fake.prisma, { id: "u-ana", role: "family" })).get("/api/pm/people");
    expect(res.status).toBe(200);
    expect(res.body.people).toHaveLength(4);
  });

  it("owners and admins are answered too", async () => {
    for (const role of ["owner", "admin"]) {
      const res = await request(makeApp(fake.prisma, { id: "x", role })).get("/api/pm/people");
      expect(res.status, role).toBe(200);
    }
  });

  it("returns exactly {id, displayName, avatarUrl}, ordered by name — and nothing from the admin roster", async () => {
    const res = await request(makeApp(fake.prisma, OWNER)).get("/api/pm/people");
    expect(res.body).toEqual({
      people: [
        { id: "u-ana", displayName: "Ana Lopez", avatarUrl: null },
        { id: "u-gus", displayName: "Gus Guest", avatarUrl: null },
        { id: "u-sam", displayName: "Sam Rubinchik", avatarUrl: null },
        { id: "u-zoe", displayName: "Zoe Park", avatarUrl: null },
      ],
    });
    // No email, username or role crosses this boundary.
    expect(JSON.stringify(res.body)).not.toMatch(/example\.test|-handle|"role"/);
  });

  it("leaves out service principals and deactivated people (their ids render as 'Former member')", async () => {
    const res = await request(makeApp(fake.prisma, OWNER)).get("/api/pm/people");
    const ids = res.body.people.map((p: { id: string }) => p.id);
    expect(ids).not.toContain("_service:mcp");
    expect(ids).not.toContain("u-old");
  });

  it("an external guest and the MCP principal are refused by the router itself (the module floor 404s a guest before it gets here)", async () => {
    expect((await request(makeApp(fake.prisma, GUEST)).get("/api/pm/people")).status).toBe(403);
    expect((await request(makeApp(fake.prisma, MCP)).get("/api/pm/people")).status).toBe(403);
  });
});

// ── WARP-3372 — a due date is a calendar date, the same in every zone ───────

describe.each(["America/Los_Angeles", "Pacific/Auckland"])(
  "native PM routes — dates are calendar dates under TZ=%s (WARP-3372)",
  (zone) => {
    const originalTz = process.env.TZ;
    let fake: ReturnType<typeof makeFake>;
    let app: ReturnType<typeof makeApp>;
    let pid: string;

    beforeAll(() => {
      process.env.TZ = zone;
      expect(new Date(2026, 5, 25).getTimezoneOffset()).toBe(zone === "America/Los_Angeles" ? 420 : -720);
    });
    afterAll(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    beforeEach(async () => {
      id = 0;
      fake = makeFake();
      app = makeApp(fake.prisma, OWNER);
      pid = (await request(app).post("/api/pm/projects").send({ name: "Inbox" })).body.project.id;
    });

    const create = (body: Row) =>
      request(app).post(`/api/pm/projects/${pid}/work-items`).send({ name: "Dated", ...body });

    it("the date entered is the date returned, and the stored value is that day at 00:00:00Z", async () => {
      const res = await create({ start_date: "2026-06-20", due_date: "2026-06-25" });
      expect(res.status).toBe(201);
      expect(res.body.work_item.dueDate).toBe("2026-06-25");
      expect(res.body.work_item.startDate).toBe("2026-06-20");
      const stored = fake.db.items[0];
      expect((stored.dueDate as Date).toISOString()).toBe("2026-06-25T00:00:00.000Z");
      expect((stored.startDate as Date).toISOString()).toBe("2026-06-20T00:00:00.000Z");

      const list = await request(app).get(`/api/pm/projects/${pid}/work-items`);
      expect(list.body.work_items[0].dueDate).toBe("2026-06-25");
      const one = await request(app).get(`/api/pm/work-items/${res.body.work_item.id}`);
      expect(one.body.work_item.dueDate).toBe("2026-06-25");
    });

    it("a client that still sends an ISO instant ending in Z keeps working, with the UTC date it names", async () => {
      const res = await create({ due_date: "2026-06-25T00:00:00.000Z" });
      expect(res.status).toBe(201);
      expect(res.body.work_item.dueDate).toBe("2026-06-25");
      const late = await create({ due_date: "2026-06-25T17:30:00Z" });
      expect(late.body.work_item.dueDate).toBe("2026-06-25");
    });

    it.each([
      ["a day that does not exist", "2026-02-30"],
      ["a locale format", "25/06/2026"],
      ["an offset instant (ambiguous)", "2026-06-25T00:00:00+02:00"],
      ["free text", "next tuesday"],
      ["a number", 1750000000000],
    ])("rejects %s with 400, never March", async (_label, bad) => {
      const res = await create({ due_date: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(fake.db.items).toHaveLength(0);
    });

    it("PATCH sets, changes and clears a date; null clears, absent leaves it", async () => {
      const wi = (await create({ due_date: "2026-06-25" })).body.work_item;
      const set = await request(app).patch(`/api/pm/work-items/${wi.id}`).send({ due_date: "2026-07-01" });
      expect(set.body.work_item.dueDate).toBe("2026-07-01");
      const untouched = await request(app).patch(`/api/pm/work-items/${wi.id}`).send({ name: "Renamed" });
      expect(untouched.body.work_item.dueDate).toBe("2026-07-01");
      const cleared = await request(app).patch(`/api/pm/work-items/${wi.id}`).send({ due_date: null });
      expect(cleared.body.work_item.dueDate).toBeNull();
    });

    it("re-sending the SAME date writes no due_date_changed row; changing it writes exactly one", async () => {
      const wi = (await create({ due_date: "2026-06-25" })).body.work_item;
      const rows = () => fake.db.activity.filter((a) => a.verb === "due_date_changed").length;
      await request(app).patch(`/api/pm/work-items/${wi.id}`).send({ due_date: "2026-06-25" });
      await request(app).patch(`/api/pm/work-items/${wi.id}`).send({ due_date: "2026-06-25T00:00:00.000Z" });
      expect(rows()).toBe(0);
      await request(app).patch(`/api/pm/work-items/${wi.id}`).send({ due_date: "2026-06-26" });
      expect(rows()).toBe(1);
    });

    describe("summary overdue is measured against the caller's own calendar day", () => {
      it("due today is NOT overdue; due yesterday is — for the day the caller names", async () => {
        await create({ due_date: "2026-06-25" });
        const on = (today: string) =>
          request(app)
            .get(`/api/pm/summary?today=${today}`)
            .then((r) => r.body.summary.overdue as number);
        expect(await on("2026-06-24")).toBe(0);
        expect(await on("2026-06-25")).toBe(0);
        expect(await on("2026-06-26")).toBe(1);
      });

      it("with no `today` it falls back to the UTC date (an item due long ago is overdue)", async () => {
        await create({ due_date: "2020-01-01" });
        await create({ due_date: "2999-01-01" });
        const res = await request(app).get("/api/pm/summary");
        expect(res.body.summary.overdue).toBe(1);
      });

      it("a `today` that is not a calendar date is a 400", async () => {
        for (const bad of ["2026-02-30", "today", "2026-06-25T00:00:00Z"]) {
          const res = await request(app).get(`/api/pm/summary?today=${encodeURIComponent(bad)}`);
          expect(res.status, bad).toBe(400);
        }
      });
    });
  },
);

// ── WARP-3370 — archive / restore are audited transitions; hard delete is gated ──

describe("native PM routes — archive, restore and hard delete (WARP-3370)", () => {
  let fake: ReturnType<typeof makeFake>;
  let owner: ReturnType<typeof makeApp>;
  let pid: string;
  const MEMBER = { id: "user-family", role: "family" };
  const ADMIN = { id: "user-admin", role: "admin" };

  const project = () => fake.db.projects.find((p) => p.id === pid)!;
  const archive = (app: ReturnType<typeof makeApp>, archived: boolean) =>
    request(app).patch(`/api/pm/projects/${pid}`).send({ archived });
  const hardDelete = (app: ReturnType<typeof makeApp>, body?: Row) => {
    const req = request(app).delete(`/api/pm/projects/${pid}`);
    return body === undefined ? req : req.send(body);
  };

  beforeEach(async () => {
    id = 0;
    audit.recordActivity.mockClear();
    audit.recordActivityInTx.mockClear();
    fake = makeFake();
    owner = makeApp(fake.prisma, OWNER);
    const res = await request(owner).post("/api/pm/projects").send({ name: "Home Reno", identifier: "RENO" });
    pid = res.body.project.id;
  });

  describe("archive and restore", () => {
    it("a MEMBER can archive: it hides the project and stamps archivedAt together with isArchived", async () => {
      const res = await archive(makeApp(fake.prisma, MEMBER), true);
      expect(res.status).toBe(200);
      expect(res.body.project.archived).toBe(true);
      expect(project().isArchived).toBe(true);
      expect(project().archivedAt).toBeInstanceOf(Date);
      // gone from the default index, back behind ?archived=1
      expect((await request(owner).get("/api/pm/projects")).body.projects).toHaveLength(1);
    });

    it("restore puts it back and clears archivedAt", async () => {
      await archive(owner, true);
      const res = await archive(owner, false);
      expect(res.status).toBe(200);
      expect(res.body.project.archived).toBe(false);
      expect(project().isArchived).toBe(false);
      expect(project().archivedAt).toBeNull();
    });

    it("each transition writes ONE audit row naming the actor and the project", async () => {
      await archive(makeApp(fake.prisma, MEMBER), true);
      expect(audit.recordActivity).toHaveBeenCalledTimes(1);
      expect(audit.recordActivity.mock.calls[0][0]).toMatchObject({
        kind: "system",
        severity: "ok",
        what: "Project archived",
        sub: "Home Reno (RENO)",
        actor: { type: "user", id: "user-family" },
        refs: { actor: "user-family", projectId: pid, projectName: "Home Reno", projectIdentifier: "RENO" },
      });

      await archive(owner, false);
      expect(audit.recordActivity).toHaveBeenCalledTimes(2);
      expect(audit.recordActivity.mock.calls[1][0]).toMatchObject({
        what: "Project restored",
        actor: { type: "user", id: "user-owner" },
        refs: { projectId: pid },
      });
    });

    it("asking for the state it is already in is a 200 that audits nothing", async () => {
      await archive(owner, true);
      audit.recordActivity.mockClear();
      const again = await archive(owner, true);
      expect(again.status).toBe(200);
      expect(again.body.project.archived).toBe(true);
      const notArchivedRestore = await archive(makeApp(fake.prisma, ADMIN), false);
      expect(notArchivedRestore.status).toBe(200);
      audit.recordActivity.mockClear();
      expect((await archive(owner, false)).status).toBe(200); // already active
      expect(audit.recordActivity).not.toHaveBeenCalled();
    });

    it("an archive-only PATCH does not rewrite the row's other fields, and a field PATCH still works", async () => {
      await request(owner).patch(`/api/pm/projects/${pid}`).send({ name: "Renamed", archived: true });
      expect(project().name).toBe("Renamed");
      expect(project().isArchived).toBe(true);
      // the audit row names the project AS IT IS NOW
      expect(audit.recordActivity.mock.calls.at(-1)?.[0]).toMatchObject({ sub: "Renamed (RENO)" });
    });

    it("a project that does not exist is a 404, audited as nothing", async () => {
      const res = await request(owner).patch("/api/pm/projects/nope").send({ archived: true });
      expect(res.status).toBe(404);
      expect(audit.recordActivity).not.toHaveBeenCalled();
    });

    it("a guest cannot archive (403) and nothing is audited", async () => {
      expect((await archive(makeApp(fake.prisma, GUEST), true)).status).toBe(403);
      expect(project().isArchived).toBe(false);
      // (the role guard's own "Access denied" row is a different audit and is fine)
      const projectRows = (audit.recordActivity.mock.calls as unknown as Array<[{ what: string }]>).filter(([row]) =>
        row.what.startsWith("Project "),
      );
      expect(projectRows).toEqual([]);
    });
  });

  describe("hard delete", () => {
    beforeEach(async () => {
      await archive(owner, true);
      audit.recordActivity.mockClear();
    });

    it("an ARCHIVED project, with its identifier typed, by an owner is deleted and its audit row is appended in the transaction", async () => {
      const res = await hardDelete(owner, { confirm_identifier: "RENO" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: pid });
      expect(fake.db.projects.find((p) => p.id === pid)).toBeUndefined();

      expect(audit.recordActivityInTx).toHaveBeenCalledTimes(1);
      const [tx, params] = audit.recordActivityInTx.mock.calls[0] as unknown as [unknown, Row];
      expect(tx).toBe(fake.prisma); // the transaction handle, not the bare client path
      expect(params).toMatchObject({
        kind: "system",
        severity: "warn",
        what: "Project deleted",
        sub: "Home Reno (RENO)",
        actor: { type: "user", id: "user-owner" },
        refs: { actor: "user-owner", projectId: pid, projectName: "Home Reno", projectIdentifier: "RENO", workItemsDeleted: 0 },
      });
      // never through the best-effort recorder
      expect(audit.recordActivity).not.toHaveBeenCalled();
    });

    it("the audit row says how many work items went with the project", async () => {
      await request(owner).patch(`/api/pm/projects/${pid}`).send({ archived: false });
      for (let i = 0; i < 3; i += 1) {
        await request(owner).post(`/api/pm/projects/${pid}/work-items`).send({ name: `Item ${i}` });
      }
      await archive(owner, true);
      await hardDelete(owner, { confirm_identifier: "RENO" });
      expect((audit.recordActivityInTx.mock.calls[0] as unknown as [unknown, Row])[1].refs).toMatchObject({
        workItemsDeleted: 3,
      });
    });

    it("an admin may delete too", async () => {
      const res = await hardDelete(makeApp(fake.prisma, ADMIN), { confirm_identifier: "RENO" });
      expect(res.status).toBe(200);
      expect(audit.recordActivityInTx.mock.calls[0]).toBeDefined();
    });

    it("a MEMBER gets 403 — they archive, they cannot destroy — and nothing is touched", async () => {
      const res = await hardDelete(makeApp(fake.prisma, MEMBER), { confirm_identifier: "RENO" });
      expect(res.status).toBe(403);
      expect(project()).toBeDefined();
      expect(audit.recordActivityInTx).not.toHaveBeenCalled();
    });

    it("a guest and the MCP principal are refused too", async () => {
      expect((await hardDelete(makeApp(fake.prisma, GUEST), { confirm_identifier: "RENO" })).status).toBe(403);
      expect((await hardDelete(makeApp(fake.prisma, MCP), { confirm_identifier: "RENO" })).status).toBe(403);
      expect(project()).toBeDefined();
    });

    it("an ACTIVE project cannot be deleted: 409 project_not_archived, and nothing is audited", async () => {
      await archive(owner, false);
      const res = await hardDelete(owner, { confirm_identifier: "RENO" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "project_not_archived" });
      expect(project()).toBeDefined();
      expect(audit.recordActivityInTx).not.toHaveBeenCalled();
    });

    it("the identifier must be typed: missing is 400, wrong is 422 identifier_mismatch (case-sensitive)", async () => {
      expect((await hardDelete(owner)).status).toBe(400);
      expect((await hardDelete(owner, {})).status).toBe(400);
      expect((await hardDelete(owner, { confirm_identifier: "" })).status).toBe(400);
      const wrong = await hardDelete(owner, { confirm_identifier: "OTHER" });
      expect(wrong.status).toBe(422);
      expect(wrong.body).toEqual({ error: "identifier_mismatch" });
      expect((await hardDelete(owner, { confirm_identifier: "reno" })).status).toBe(422);
      expect(project()).toBeDefined();
      expect(audit.recordActivityInTx).not.toHaveBeenCalled();
    });

    it("a restore that wins the race against the delete cancels it: 409, not cascaded away", async () => {
      // The service has read `archived`; another request restores it before the
      // compare-and-set delete lands.
      const prisma = fake.prisma as { pmProject: { findUnique: (a: unknown) => Promise<unknown> } };
      const realFind = prisma.pmProject.findUnique;
      let first = true;
      prisma.pmProject.findUnique = async (a) => {
        const row = await realFind(a);
        if (first) {
          first = false;
          project().isArchived = false; // restored under us
        }
        return row;
      };
      const res = await hardDelete(owner, { confirm_identifier: "RENO" });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("project_not_archived");
      expect(project()).toBeDefined();
      expect(audit.recordActivityInTx).not.toHaveBeenCalled();
    });

    it("a project that does not exist is a 404", async () => {
      const res = await request(owner).delete("/api/pm/projects/nope").send({ confirm_identifier: "RENO" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("project_not_found");
    });

    it("if the audit row cannot be appended the delete fails (500) — the real transaction rolls it back", async () => {
      audit.recordActivityInTx.mockRejectedValueOnce(new Error("activity recorder not initialised"));
      const res = await hardDelete(owner, { confirm_identifier: "RENO" });
      expect(res.status).toBe(500);
    });
  });
});

// ── WARP-3371 — the work-item API refuses what it used to swallow ───────────

describe("native PM routes — input validation (WARP-3371)", () => {
  let fake: ReturnType<typeof makeFake>;
  let app: ReturnType<typeof makeApp>;
  let pid: string;

  beforeEach(async () => {
    id = 0;
    fake = makeFake();
    app = makeApp(fake.prisma, OWNER);
    pid = (await request(app).post("/api/pm/projects").send({ name: "Inbox" })).body.project.id;
  });

  const makeItem = async (body: Row = {}) =>
    (await request(app).post(`/api/pm/projects/${pid}/work-items`).send({ name: "Item", ...body })).body.work_item;
  const patch = (itemId: string, body: Row) => request(app).patch(`/api/pm/work-items/${itemId}`).send(body);
  const stateOf = (group: string) => fake.db.states.find((s) => s.projectId === pid && s.group === group)!.id as string;

  describe("paging params on every list are validated, not coerced to NaN", () => {
    it.each([
      ["/api/pm/projects?per_page=abc"],
      ["/api/pm/projects?per_page=0"],
      ["/api/pm/projects?per_page=501"],
      ["/api/pm/projects?limit=2.5"],
      ["/api/pm/work-items?q=x&per_page=abc"],
      ["/api/pm/work-items?q=x&limit=-1"],
      ["/api/pm/assigned-to-me?limit=abc"],
    ])("%s is a 400, never a 500", async (url) => {
      const res = await request(app).get(url);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("a valid per_page on /pm/projects is honoured", async () => {
      for (const name of ["A", "B", "C"]) await request(app).post("/api/pm/projects").send({ name });
      const res = await request(app).get("/api/pm/projects?per_page=2");
      expect(res.status).toBe(200);
      expect(res.body.projects.length).toBeLessThanOrEqual(2);
    });
  });

  describe("parent cycles", () => {
    it("a parent that is a DESCENDANT of the item is a 422 parent_cycle — child, grandchild, any depth", async () => {
      const a = await makeItem({ name: "A" });
      const b = await makeItem({ name: "B", parent_id: a.id });
      const c = await makeItem({ name: "C", parent_id: b.id });

      const underChild = await patch(a.id, { parent_id: b.id });
      expect(underChild.status).toBe(422);
      expect(underChild.body).toEqual({ error: "parent_cycle" });
      expect((await patch(a.id, { parent_id: c.id })).body.error).toBe("parent_cycle");
      expect((await patch(b.id, { parent_id: c.id })).body.error).toBe("parent_cycle");
      // nothing moved
      expect(fake.db.items.find((i) => i.id === a.id)!.parentId).toBeNull();
    });

    it("moves that do NOT close a loop still work: to an ancestor, to a sibling, to nothing", async () => {
      const a = await makeItem({ name: "A" });
      const b = await makeItem({ name: "B", parent_id: a.id });
      const c = await makeItem({ name: "C", parent_id: b.id });
      const d = await makeItem({ name: "D" });
      expect((await patch(c.id, { parent_id: a.id })).status).toBe(200); // up to a grandparent
      expect((await patch(b.id, { parent_id: d.id })).status).toBe(200); // across
      expect((await patch(b.id, { parent_id: null })).status).toBe(200); // detach
      // re-sending the parent it already has is not a move and is never walked
      expect((await patch(c.id, { parent_id: a.id })).status).toBe(200);
    });

    it("self-parenting is still invalid_parent (its own code, unchanged)", async () => {
      const a = await makeItem({ name: "A" });
      const res = await patch(a.id, { parent_id: a.id });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("invalid_parent");
    });

    it("fails CLOSED on a loop already in the data (only self-parenting used to be refused)", async () => {
      const a = await makeItem({ name: "A" });
      const b = await makeItem({ name: "B" });
      const d = await makeItem({ name: "D" });
      // an older write left A <-> B pointing at each other
      fake.db.items.find((i) => i.id === a.id)!.parentId = b.id;
      fake.db.items.find((i) => i.id === b.id)!.parentId = a.id;
      const res = await patch(d.id, { parent_id: a.id });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("parent_cycle");
    });

    it("fails CLOSED on a chain deeper than the walk's bound", async () => {
      let parent: string | null = null;
      let leaf = "";
      for (let n = 0; n < 40; n += 1) {
        leaf = (await makeItem({ name: `L${n}`, ...(parent ? { parent_id: parent } : {}) })).id;
        parent = leaf;
      }
      const loose = await makeItem({ name: "Loose" });
      const res = await patch(loose.id, { parent_id: leaf });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("parent_cycle");
    });
  });

  describe("an item keeps its state", () => {
    it("state_id:null on an item that has one is a 422 state_required, and nothing changes", async () => {
      const a = await makeItem({ name: "A" });
      const before = fake.db.items.find((i) => i.id === a.id)!.stateId;
      expect(before).toBeTruthy();
      const res = await patch(a.id, { state_id: null });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "state_required" });
      expect(fake.db.items.find((i) => i.id === a.id)!.stateId).toBe(before);
      expect(fake.db.activity.filter((x) => x.verb === "state_changed")).toHaveLength(0);
    });

    it("an item that already has none, sent null again, is not a change (an identity PATCH never fails)", async () => {
      const a = await makeItem({ name: "A" });
      fake.db.items.find((i) => i.id === a.id)!.stateId = null;
      expect((await patch(a.id, { state_id: null, name: "Renamed" })).status).toBe(200);
    });

    it("a real state change still works", async () => {
      const a = await makeItem({ name: "A" });
      const res = await patch(a.id, { state_id: stateOf("completed") });
      expect(res.status).toBe(200);
      expect(res.body.work_item.state.group).toBe("completed");
    });
  });

  describe("label ids", () => {
    it("an unknown id is a 422 invalid_label naming it — it used to surface as invalid_parent or a 500", async () => {
      const res = await request(app)
        .post(`/api/pm/projects/${pid}/work-items`)
        .send({ name: "X", label_ids: ["ghost-label"] });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "invalid_label", ids: ["ghost-label"] });
      expect(fake.db.items).toHaveLength(0);
    });

    it("names EVERY offender — unknown and another project's — and only those", async () => {
      const mine = (await request(app).post(`/api/pm/projects/${pid}/labels`).send({ name: "bug" })).body.label;
      const otherProject = (await request(app).post("/api/pm/projects").send({ name: "Other" })).body.project.id;
      const theirs = (await request(app).post(`/api/pm/projects/${otherProject}/labels`).send({ name: "foreign" })).body.label;
      const a = await makeItem({ name: "A" });
      const res = await patch(a.id, { label_ids: [mine.id, "ghost-1", theirs.id] });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe("invalid_label");
      expect(res.body.ids).toEqual(["ghost-1", theirs.id]);
    });

    it("a repeated id is folded, not a unique-violation", async () => {
      const mine = (await request(app).post(`/api/pm/projects/${pid}/labels`).send({ name: "bug" })).body.label;
      const res = await request(app)
        .post(`/api/pm/projects/${pid}/work-items`)
        .send({ name: "X", label_ids: [mine.id, mine.id] });
      expect(res.status).toBe(201);
      expect(res.body.work_item.labels).toHaveLength(1);
    });
  });

  describe("assignee ids", () => {
    beforeEach(() => {
      fake.db.users.push(
        { id: "u-ana", displayName: "Ana", role: "family", directoryStatus: "ACTIVE" },
        { id: "u-gus", displayName: "Gus", role: "guest", directoryStatus: "ACTIVE" },
        { id: "u-old", displayName: "Olga", role: "family", directoryStatus: "DEACTIVATED" },
        { id: "_service:mcp", displayName: "MCP", role: "service", directoryStatus: "ACTIVE" },
      );
    });

    it("an id that is not a person is a 422 invalid_assignee naming every such id", async () => {
      const res = await request(app)
        .post(`/api/pm/projects/${pid}/work-items`)
        .send({ name: "X", assignees: ["ghost-1", "u-ana", "ghost-2"] });
      expect(res.status).toBe(422);
      expect(res.body).toEqual({ error: "invalid_assignee", ids: ["ghost-1", "ghost-2"] });
      expect(fake.db.items).toHaveLength(0);
    });

    it("a deactivated person and a service principal are not assignable; an external guest is", async () => {
      const bad = await request(app)
        .post(`/api/pm/projects/${pid}/work-items`)
        .send({ name: "X", assignees: ["u-old", "_service:mcp"] });
      expect(bad.status).toBe(422);
      expect(bad.body.ids).toEqual(["u-old", "_service:mcp"]);
      const ok = await request(app)
        .post(`/api/pm/projects/${pid}/work-items`)
        .send({ name: "X", assignees: ["u-gus"] });
      expect(ok.status).toBe(201);
      expect(ok.body.work_item.assignees).toEqual(["u-gus"]);
    });

    it("a repeated id is folded, not a unique-violation", async () => {
      const res = await request(app)
        .post(`/api/pm/projects/${pid}/work-items`)
        .send({ name: "X", assignees: ["u-ana", "u-ana"] });
      expect(res.status).toBe(201);
      expect(res.body.work_item.assignees).toEqual(["u-ana"]);
    });

    it("PATCH checks only who it ADDS: a set that still holds a leaver is editable, and the leaver can always be removed", async () => {
      const a = await makeItem({ name: "A", assignees: ["u-ana"] });
      // the assignee leaves after the item was assigned
      fake.db.users.find((u) => u.id === "u-ana")!.directoryStatus = "DEACTIVATED";
      // re-sending the same set (an identity PATCH) works…
      expect((await patch(a.id, { assignees: ["u-ana"], name: "Renamed" })).status).toBe(200);
      // …adding a ghost does not…
      const add = await patch(a.id, { assignees: ["u-ana", "ghost-9"] });
      expect(add.status).toBe(422);
      expect(add.body).toEqual({ error: "invalid_assignee", ids: ["ghost-9"] });
      // …and removing the leaver does.
      const gus = await patch(a.id, { assignees: ["u-gus"] });
      expect(gus.status).toBe(200);
      expect(gus.body.work_item.assignees).toEqual(["u-gus"]);
    });
  });

  describe("sortOrder is a Float", () => {
    it.each([2.5, 1e-7, -3.25, 0.1 + 0.2, 123456.789])("PATCH sortOrder %s is stored exactly", async (value) => {
      const a = await makeItem({ name: "A" });
      const res = await patch(a.id, { sortOrder: value });
      expect(res.status).toBe(200);
      expect(res.body.work_item.sortOrder).toBe(value);
      expect(fake.db.items.find((i) => i.id === a.id)!.sortOrder).toBe(value);
    });

    it.each(["Infinity", "NaN", "2.5", null])("still refuses %j", async (value) => {
      const a = await makeItem({ name: "A" });
      expect((await patch(a.id, { sortOrder: value })).status).toBe(400);
    });
  });

  describe("comments and activity are pages (default 100, max 500)", () => {
    let itemId: string;
    const seedComments = (n: number) => {
      for (let i = 1; i <= n; i += 1) {
        fake.db.comments.push({
          id: `cm-seed-${String(i).padStart(4, "0")}`,
          workItemId: itemId,
          authorId: null,
          commentHtml: `<p>${i}</p>`,
          createdAt: new Date(2026, 0, 1, 0, 0, i),
          updatedAt: new Date(2026, 0, 1, 0, 0, i),
        });
      }
    };
    const seedActivity = (n: number) => {
      for (let i = 1; i <= n; i += 1) {
        fake.db.activity.push({
          id: `ac-seed-${String(i).padStart(4, "0")}`,
          workItemId: itemId,
          actorId: null,
          verb: "updated",
          field: "fields",
          oldValue: null,
          newValue: null,
          createdAt: new Date(2026, 0, 2, 0, 0, i),
        });
      }
    };
    const walk = async (url: string, key: "comments" | "activity") => {
      const ids: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: { status: number; body: Row } = await request(app).get(
          `${url}?limit=60${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        expect(res.status).toBe(200);
        ids.push(...(res.body[key] as Array<{ id: string }>).map((r) => r.id));
        cursor = res.body.nextCursor as string | null;
        pages += 1;
        expect(pages).toBeLessThan(20);
      } while (cursor);
      return ids;
    };

    beforeEach(async () => {
      itemId = (await makeItem({ name: "Threaded" })).id;
      fake.db.activity.length = 0; // the item's own `created` row is not under test
    });

    it("a caller that sends nothing gets the first 100, a cursor and the exact total — never an unbounded array", async () => {
      seedComments(250);
      const res = await request(app).get(`/api/pm/work-items/${itemId}/comments`);
      expect(res.status).toBe(200);
      expect(res.body.comments).toHaveLength(100);
      expect(res.body.total).toBe(250);
      expect(res.body.nextCursor).toEqual(expect.any(String));
      expect(res.body.comments[0].id).toBe("cm-seed-0001"); // oldest first, as before
    });

    it("a short thread is returned whole with a null cursor — what an old caller always got", async () => {
      seedComments(3);
      const res = await request(app).get(`/api/pm/work-items/${itemId}/comments`);
      expect(res.body.comments.map((c: { id: string }) => c.id)).toEqual(["cm-seed-0001", "cm-seed-0002", "cm-seed-0003"]);
      expect(res.body.nextCursor).toBeNull();
      expect(res.body.total).toBe(3);
    });

    it("the cursor walks every comment exactly once, oldest to newest", async () => {
      seedComments(250);
      const ids = await walk(`/api/pm/work-items/${itemId}/comments`, "comments");
      expect(ids).toHaveLength(250);
      expect(ids).toEqual(Array.from({ length: 250 }, (_, i) => `cm-seed-${String(i + 1).padStart(4, "0")}`));
    });

    it("the activity feed is paged the same way", async () => {
      seedActivity(130);
      const first = await request(app).get(`/api/pm/work-items/${itemId}/activity`);
      expect(first.body.activity).toHaveLength(100);
      expect(first.body.total).toBe(130);
      const ids = await walk(`/api/pm/work-items/${itemId}/activity`, "activity");
      expect(ids).toHaveLength(130);
      expect(new Set(ids).size).toBe(130);
    });

    it("limit tops out at 500", async () => {
      seedComments(120);
      expect((await request(app).get(`/api/pm/work-items/${itemId}/comments?limit=500`)).body.comments).toHaveLength(120);
      expect((await request(app).get(`/api/pm/work-items/${itemId}/comments?limit=501`)).status).toBe(400);
    });

    it.each(["limit=abc", "limit=0", "cursor=", "page=0"])("?%s is a 400 on both", async (query) => {
      expect((await request(app).get(`/api/pm/work-items/${itemId}/comments?${query}`)).status).toBe(400);
      expect((await request(app).get(`/api/pm/work-items/${itemId}/activity?${query}`)).status).toBe(400);
    });

    it("a cursor from another list is a 400 invalid_cursor", async () => {
      seedComments(5);
      seedActivity(5);
      const c = await request(app).get(`/api/pm/work-items/${itemId}/comments?limit=2`);
      const wrong = await request(app).get(
        `/api/pm/work-items/${itemId}/activity?cursor=${encodeURIComponent(c.body.nextCursor)}`,
      );
      expect(wrong.status).toBe(400);
      expect(wrong.body).toEqual({ error: "invalid_cursor" });
    });

    it("a missing work item is still a 404", async () => {
      expect((await request(app).get("/api/pm/work-items/nope/comments")).status).toBe(404);
      expect((await request(app).get("/api/pm/work-items/nope/activity")).status).toBe(404);
    });
  });
});
