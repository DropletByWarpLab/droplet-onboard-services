/**
 * WARP-462 (C1) — ToolSpec CRUD + imperative run-now lifecycle.
 *
 * Same supertest pattern as scenes.routes.test.ts (WARP-474). The
 * StepDispatcher is mocked so the imperative walker is exercised
 * without a real MCP child.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  createToolsRouter,
} from "../routes/tools.js";
import type { StepDispatcher } from "../services/tool-spec-runner.service.js";
import type { AuthUser } from "../middleware/auth.js";

interface StepRow {
  id: string;
  specId: string;
  idx: number;
  kind: string;
  args: unknown;
}
interface SpecRow {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  version: number;
  status: "live" | "draft" | "suggested";
  ownerId: string | null;
  share: string | null;
  safety: number;
  writes: boolean;
  reversible: boolean;
  createdAt: Date;
  updatedAt: Date;
}
interface RunRow {
  id: string;
  specId: string;
  triggeredBy: string | null;
  startedAt: Date;
  endedAt: Date | null;
  status: "ok" | "failed" | "cancelled";
  error: string | null;
  trace: unknown;
}

function createPrismaMock(
  initialSpecs: Array<SpecRow & { steps: StepRow[] }> = [],
) {
  const specs = new Map<string, SpecRow & { steps: StepRow[] }>(
    initialSpecs.map((s) => [s.slug, s]),
  );
  const runs: RunRow[] = [];
  let nextId = 1;
  const mkId = (prefix: string) => `${prefix}-${nextId++}`;

  const tables = {
    specs,
    runs,
    toolSpec: {
      findMany: vi.fn(
        async ({
          where,
          include,
        }: {
          where?: { status?: string; category?: string };
          include?: { _count?: unknown };
          orderBy?: unknown;
        } = {}) => {
          let rows = [...specs.values()];
          if (where?.status) rows = rows.filter((r) => r.status === where.status);
          if (where?.category) rows = rows.filter((r) => r.category === where.category);
          if (include?._count) {
            return rows.map((r) => ({
              ...r,
              _count: {
                steps: r.steps.length,
                runs: runs.filter((rn) => rn.specId === r.id).length,
              },
            }));
          }
          return rows;
        },
      ),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { slug?: string; id?: string };
          include?: { steps?: unknown };
        }) => {
          if (where.slug) return specs.get(where.slug) ?? null;
          for (const r of specs.values()) {
            if (r.id === where.id) return r;
          }
          return null;
        },
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            slug: string;
            name: string;
            category: string | null;
            description: string | null;
            share: string | null;
            safety: number;
            writes: boolean;
            reversible: boolean;
            ownerId: string | null;
            steps: {
              create: Array<{ idx: number; kind: string; args: unknown }>;
            };
          };
          include?: { steps?: unknown };
        }) => {
          if (specs.has(data.slug)) {
            const err = new Error("unique") as Error & { code: string };
            err.code = "P2002";
            throw err;
          }
          const id = mkId("spec");
          const now = new Date();
          const stepRows: StepRow[] = data.steps.create.map((s, i) => ({
            id: `${id}-s${i}`,
            specId: id,
            ...s,
          }));
          const row: SpecRow & { steps: StepRow[] } = {
            id,
            slug: data.slug,
            name: data.name,
            category: data.category,
            description: data.description,
            version: 1,
            status: "draft",
            ownerId: data.ownerId,
            share: data.share,
            safety: data.safety,
            writes: data.writes,
            reversible: data.reversible,
            createdAt: now,
            updatedAt: now,
            steps: stepRows,
          };
          specs.set(data.slug, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { slug: string };
          data: {
            ownerId?: string;
            name?: string;
            category?: string | null;
            description?: string | null;
            share?: string | null;
            safety?: number;
            writes?: boolean;
            reversible?: boolean;
            status?: "live" | "draft" | "suggested";
            version?: { increment: number };
            steps?: {
              create: Array<{ idx: number; kind: string; args: unknown }>;
            };
          };
          include?: { steps?: unknown };
        }) => {
          const existing = specs.get(where.slug);
          if (!existing) throw new Error("not found");
          if (data.ownerId !== undefined) existing.ownerId = data.ownerId;
          if (data.name) existing.name = data.name;
          if (data.category !== undefined) existing.category = data.category;
          if (data.description !== undefined) existing.description = data.description;
          if (data.share !== undefined) existing.share = data.share;
          if (data.safety !== undefined) existing.safety = data.safety;
          if (data.writes !== undefined) existing.writes = data.writes;
          if (data.reversible !== undefined) existing.reversible = data.reversible;
          if (data.status) existing.status = data.status;
          if (data.version?.increment) existing.version += data.version.increment;
          if (data.steps) {
            existing.steps = data.steps.create.map((s, i) => ({
              id: `${existing.id}-s${i}`,
              specId: existing.id,
              ...s,
            }));
          }
          existing.updatedAt = new Date();
          return existing;
        },
      ),
    },
    toolStep: {
      deleteMany: vi.fn(
        async ({ where }: { where: { specId: string } }) => {
          for (const s of specs.values()) {
            if (s.id === where.specId) {
              const count = s.steps.length;
              s.steps = [];
              return { count };
            }
          }
          return { count: 0 };
        },
      ),
    },
    // WARP-1580 — run-now resolves the caller's §3 tool scope before
    // dispatching, which means one indexed User read. Every fixture in THIS
    // suite is deliberately role-less (`accessRoleId: null`) so the §3 axis
    // never narrows and these tests keep pinning the WALK, not the RBAC.
    // The narrowed-role cases live in tool-spec-access.test.ts.
    //
    // WARP-1621 — role-less is NOT "unrestricted": the coarse ADR-004 write
    // tier still applies underneath, so the run-now fixtures below that call
    // a `requiresWrite` tool (`send_notification`) run as `owner`. That gate
    // has its own suite, tool-spec-write-tier.test.ts.
    user: {
      findUnique: vi.fn(async () => ({ accessRoleId: null, accessRole: null })),
    },
    toolRun: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            specId: string;
            triggeredBy: string | null;
            endedAt: Date;
            status: "ok" | "failed" | "cancelled";
            error: string | null;
            trace: unknown;
          };
        }) => {
          const id = mkId("run");
          const row: RunRow = {
            id,
            specId: data.specId,
            triggeredBy: data.triggeredBy,
            startedAt: new Date(),
            endedAt: data.endedAt,
            status: data.status,
            error: data.error,
            trace: data.trace,
          };
          runs.push(row);
          return row;
        },
      ),
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { specId: string };
          orderBy?: unknown;
          take?: number;
        }) => {
          const rows = runs.filter((r) => r.specId === where.specId);
          const sorted = [...rows].sort(
            (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
          );
          return take ? sorted.slice(0, take) : sorted;
        },
      ),
    },
  };
  // tools.ts PATCH replaces steps + bumps version inside
  // prisma.$transaction(async (tx) => ...); run the callback against the
  // same tables — tests need the API shape, not rollback semantics.
  // Object.assign (not an inline self-reference) avoids TS7022.
  return Object.assign(tables, {
    $transaction: vi.fn(
      async (fn: (tx: typeof tables) => unknown) => fn(tables),
    ),
  });
}

function mkUser(role: AuthUser["role"], username = "stefan"): AuthUser {
  return { id: `user-${role}`, username, displayName: username, role };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  dispatcher: StepDispatcher,
  user: AuthUser,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createToolsRouter(prismaMock as any, dispatcher));
  return app;
}

const noopDispatcher: StepDispatcher = {
  call: vi.fn().mockResolvedValue({ ok: true }),
};

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

// ── CRUD ─────────────────────────────────────────────────────────
describe("WARP-462 — Tool spec CRUD", () => {
  it("creates a draft spec; rejects malformed slug", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, noopDispatcher, mkUser("family"));
    const res = await request(app)
      .post("/api/tools")
      .send({
        slug: "carrier-delay-recap",
        name: "Carrier delay recap",
        category: "operations",
        steps: [
          { tool: "list_recent_files", args: { limit: 10 } },
          { tool: "send_notification", args: { title: "Recap" } },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.steps[0].args).toEqual({
      tool: "list_recent_files",
      args: { limit: 10 },
    });

    const bad = await request(app)
      .post("/api/tools")
      .send({
        slug: "BAD SLUG",
        name: "x",
        steps: [{ tool: "list_files" }],
      });
    expect(bad.status).toBe(400);
  });

  it("returns 409 on duplicate slug", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, noopDispatcher, mkUser("family"));
    const body = {
      slug: "dupe",
      name: "x",
      steps: [{ tool: "list_files" }],
    };
    expect((await request(app).post("/api/tools").send(body)).status).toBe(201);
    const second = await request(app).post("/api/tools").send(body);
    expect(second.status).toBe(409);
  });

  it("filters list by ?status=", async () => {
    const now = new Date();
    const prisma = createPrismaMock([
      {
        id: "s1",
        slug: "a",
        name: "Draft A",
        category: null,
        description: null,
        version: 1,
        status: "draft",
        ownerId: null,
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: now,
        updatedAt: now,
        steps: [],
      },
      {
        id: "s2",
        slug: "b",
        name: "Live B",
        category: null,
        description: null,
        version: 1,
        status: "live",
        ownerId: null,
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: now,
        updatedAt: now,
        steps: [],
      },
    ]);
    const app = buildApp(prisma, noopDispatcher, mkUser("family"));
    const res = await request(app).get("/api/tools?status=live");
    expect(res.status).toBe(200);
    expect(res.body.specs).toHaveLength(1);
    expect(res.body.specs[0].slug).toBe("b");

    const bad = await request(app).get("/api/tools?status=garbage");
    expect(bad.status).toBe(400);
  });

  it("PATCH publishes a draft → live and bumps version", async () => {
    const prisma = createPrismaMock([
      {
        id: "s1",
        slug: "x",
        name: "x",
        category: null,
        description: null,
        version: 1,
        status: "draft",
        ownerId: null,
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: [],
      },
    ]);
    const app = buildApp(prisma, noopDispatcher, mkUser("admin"));
    const res = await request(app)
      .patch("/api/tools/x")
      .send({ status: "live", name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("live");
    expect(res.body.name).toBe("Renamed");
    expect(res.body.version).toBe(2);
  });

  // WARP-1580 — a scheduled fire runs as the spec's attributed creator, so a
  // spec with no creator can never be scheduled (the ticker fails closed).
  // The WARP-464 miner writes `suggested` specs with ownerId null, so
  // promotion is the moment a human takes ownership.
  it("PATCH draft→live adopts an unowned spec for the publisher", async () => {
    const prisma = createPrismaMock([
      {
        id: "s1",
        slug: "mined",
        name: "Mined suggestion",
        category: "suggested",
        description: null,
        version: 1,
        status: "suggested",
        ownerId: null,
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: [],
      },
    ]);
    const app = buildApp(prisma, noopDispatcher, mkUser("admin"));
    const res = await request(app).patch("/api/tools/mined").send({ status: "live" });
    expect(res.status).toBe(200);
    expect(res.body.ownerId).toBe("user-admin");
  });

  it("PATCH never re-attributes a spec that already has an owner", async () => {
    const prisma = createPrismaMock([
      {
        id: "s1",
        slug: "owned",
        name: "Owned",
        category: null,
        description: null,
        version: 1,
        status: "draft",
        ownerId: "someone-else",
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: [],
      },
    ]);
    const app = buildApp(prisma, noopDispatcher, mkUser("admin"));
    const res = await request(app).patch("/api/tools/owned").send({ status: "live" });
    expect(res.status).toBe(200);
    expect(res.body.ownerId).toBe("someone-else");
  });

  it("PATCH that does not publish leaves an unowned spec unowned", async () => {
    const prisma = createPrismaMock([
      {
        id: "s1",
        slug: "mined",
        name: "Mined suggestion",
        category: "suggested",
        description: null,
        version: 1,
        status: "suggested",
        ownerId: null,
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: [],
      },
    ]);
    const app = buildApp(prisma, noopDispatcher, mkUser("admin"));
    const res = await request(app).patch("/api/tools/mined").send({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.ownerId).toBeNull();
  });

  it("PATCH replaces steps wholesale", async () => {
    const prisma = createPrismaMock([
      {
        id: "s1",
        slug: "x",
        name: "x",
        category: null,
        description: null,
        version: 1,
        status: "draft",
        ownerId: null,
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: [
          { id: "old", specId: "s1", idx: 0, kind: "call", args: { tool: "old_tool", args: {} } },
        ],
      },
    ]);
    const app = buildApp(prisma, noopDispatcher, mkUser("admin"));
    const res = await request(app)
      .patch("/api/tools/x")
      .send({
        steps: [
          { tool: "new_tool_a" },
          { tool: "new_tool_b" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.steps).toHaveLength(2);
    expect(res.body.steps.map((s: { args: { tool: string } }) => s.args.tool)).toEqual([
      "new_tool_a",
      "new_tool_b",
    ]);
  });

  it("family-role PATCH is 403 (admin/owner only on patch)", async () => {
    const prisma = createPrismaMock([
      {
        id: "s1",
        slug: "x",
        name: "x",
        category: null,
        description: null,
        version: 1,
        status: "draft",
        ownerId: null,
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: [],
      },
    ]);
    const app = buildApp(prisma, noopDispatcher, mkUser("family"));
    const res = await request(app)
      .patch("/api/tools/x")
      .send({ status: "live" });
    expect(res.status).toBe(403);
  });
});

// ── Run-now ──────────────────────────────────────────────────────
describe("WARP-462 — POST /api/tools/:slug/runs", () => {
  function liveSpec(steps: StepRow[]) {
    return {
      id: "spec-live",
      slug: "demo",
      name: "Demo",
      category: null,
      description: null,
      version: 1,
      status: "live" as const,
      ownerId: null,
      share: null,
      safety: 1,
      writes: false,
      reversible: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      steps,
    };
  }

  it("walks steps in order; calls dispatcher with parsed args", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const dispatcher: StepDispatcher = {
      call: vi.fn(async (tool, args) => {
        calls.push({ tool, args });
        return { tool, ran: true };
      }),
    };
    const prisma = createPrismaMock([
      liveSpec([
        {
          id: "x1",
          specId: "spec-live",
          idx: 0,
          kind: "call",
          args: { tool: "list_recent_files", args: { limit: 5 } },
        },
        {
          id: "x2",
          specId: "spec-live",
          idx: 1,
          kind: "call",
          args: { tool: "send_notification", args: { title: "Recap" } },
        },
      ]),
    ]);
    // owner: this spec calls `send_notification` (requiresWrite) and the
    // WARP-1621 tier gate refuses that for `family`. What's under test is the
    // step walk, not the RBAC.
    const app = buildApp(prisma, dispatcher, mkUser("owner"));
    const res = await request(app).post("/api/tools/demo/runs").send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(calls).toEqual([
      { tool: "list_recent_files", args: { limit: 5 } },
      { tool: "send_notification", args: { title: "Recap" } },
    ]);
    expect(res.body.trace).toHaveLength(2);
  });

  it("substitutes ${prev} from previous step result", async () => {
    const dispatcher: StepDispatcher = {
      call: vi.fn(async (_tool, _args) => ({ filePath: "/foo.pdf" })),
    };
    const prisma = createPrismaMock([
      liveSpec([
        { id: "x1", specId: "spec-live", idx: 0, kind: "call", args: { tool: "list_recent_files" } },
        {
          id: "x2",
          specId: "spec-live",
          idx: 1,
          kind: "call",
          args: { tool: "send_notification", args: { context: "${prev}" } },
        },
      ]),
    ]);
    // owner: this spec calls `send_notification` (requiresWrite) and the
    // WARP-1621 tier gate refuses that for `family`. What's under test is the
    // step walk, not the RBAC.
    const app = buildApp(prisma, dispatcher, mkUser("owner"));
    const res = await request(app).post("/api/tools/demo/runs").send({});
    expect(res.status).toBe(200);
    expect(dispatcher.call).toHaveBeenNthCalledWith(2, "send_notification", {
      context: { filePath: "/foo.pdf" },
    });
  });

  it("halts on first failure; does NOT advance to subsequent steps", async () => {
    const dispatcher: StepDispatcher = {
      call: vi.fn(async (tool) => {
        if (tool === "send_notification") throw new Error("notify down");
        return { ok: true };
      }),
    };
    const prisma = createPrismaMock([
      liveSpec([
        { id: "x1", specId: "spec-live", idx: 0, kind: "call", args: { tool: "list_recent_files" } },
        { id: "x2", specId: "spec-live", idx: 1, kind: "call", args: { tool: "send_notification" } },
        { id: "x3", specId: "spec-live", idx: 2, kind: "call", args: { tool: "list_files" } },
      ]),
    ]);
    // owner: this spec calls `send_notification` (requiresWrite) and the
    // WARP-1621 tier gate refuses that for `family`. What's under test is the
    // step walk, not the RBAC.
    const app = buildApp(prisma, dispatcher, mkUser("owner"));
    const res = await request(app).post("/api/tools/demo/runs").send({});
    expect(res.status).toBe(207);
    expect(res.body.status).toBe("failed");
    expect(res.body.error).toContain("send_notification");
    expect(dispatcher.call).toHaveBeenCalledTimes(2); // step 3 never dispatched
    expect(res.body.trace).toHaveLength(2);
    expect(res.body.trace[1].ok).toBe(false);
  });

  it("refuses to run a draft spec (400)", async () => {
    const prisma = createPrismaMock([
      {
        ...liveSpec([{ id: "x", specId: "spec-live", idx: 0, kind: "call", args: { tool: "list_files" } }]),
        status: "draft" as const,
      },
    ]);
    const app = buildApp(prisma, noopDispatcher, mkUser("family"));
    const res = await request(app).post("/api/tools/demo/runs").send({});
    expect(res.status).toBe(400);
    expect(res.body.status).toBe("draft");
  });

  it("404 on unknown spec", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, noopDispatcher, mkUser("family"));
    const res = await request(app).post("/api/tools/nope/runs").send({});
    expect(res.status).toBe(404);
  });
});

// ── Runs history ─────────────────────────────────────────────────
describe("WARP-462 — GET /api/tools/:slug/runs", () => {
  it("returns runs newest first; limit clamped to [1, 100]", async () => {
    const prisma = createPrismaMock([
      {
        id: "spec-h",
        slug: "history",
        name: "History",
        category: null,
        description: null,
        version: 1,
        status: "live",
        ownerId: null,
        share: null,
        safety: 1,
        writes: false,
        reversible: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        steps: [
          { id: "x", specId: "spec-h", idx: 0, kind: "call", args: { tool: "list_files" } },
        ],
      },
    ]);
    const dispatcher: StepDispatcher = {
      call: vi.fn().mockResolvedValue({ ok: true }),
    };
    const app = buildApp(prisma, dispatcher, mkUser("family"));
    await request(app).post("/api/tools/history/runs").send({});
    await request(app).post("/api/tools/history/runs").send({});
    const res = await request(app).get("/api/tools/history/runs?limit=200");
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0].status).toBe("ok");
  });
});
