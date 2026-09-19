/**
 * WARP-2894 — the three ToolSpec routes the `routine_*` tools reach admit
 * the mcp principal AND resolve the human it acts for.
 *
 * `requireRoleOrMcpService` admits `_service:mcp` before any role check, so
 * a route that then reads `req.user` filters on a robot: `ownerId` matches
 * nothing, the scope resolver sees role `service` and returns un-narrowed,
 * `triggeredBy` records `_service:mcp`. That is the WARP-2810 defect class.
 * These pins say, per route:
 *
 *   - no acting user → 403, never an empty 200 and never a wider identity;
 *   - an acting user outside owner/admin/family (a guest) → 403, exactly the
 *     bar a browser caller meets;
 *   - the draft is OWNED by the acting user and born `draft` whatever the
 *     body says (there is no status field to say it with);
 *   - a run is pre-flighted against the acting user's tier — a family
 *     member's chat turn cannot run a write-tool spec the family member
 *     could not run from the page — and `triggeredBy` is that person;
 *   - a browser caller is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { createToolsRouter } from "../routes/tools.js";
import type { StepDispatcher } from "../services/tool-spec-runner.service.js";
import type { AuthUser } from "../middleware/auth.js";

const mcp: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };
const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "stefan", displayName: "stefan", role: "admin" };
const family: AuthUser = { id: "u-family", username: "kid", displayName: "kid", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "visitor", displayName: "visitor", role: "guest" };
const USERS = [owner, admin, family, guest];

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
  steps: StepRow[];
}

function liveSpec(slug: string, tool: string, writes: boolean): SpecRow {
  return {
    id: `spec-${slug}`,
    slug,
    name: slug,
    category: null,
    description: null,
    version: 1,
    status: "live",
    ownerId: "u-owner",
    share: null,
    safety: 1,
    writes,
    reversible: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    steps: [{ id: `s-${slug}`, specId: `spec-${slug}`, idx: 0, kind: "call", args: { tool, args: {} } }],
  };
}

function createPrismaMock(seed: SpecRow[] = []) {
  const specs = new Map(seed.map((s) => [s.slug, s]));
  const runs: Array<{ specId: string; triggeredBy: string | null }> = [];
  let n = 1;
  return {
    specs,
    runs,
    user: {
      findFirst: vi.fn(async ({ where }: { where: { username: string } }) => {
        const u = USERS.find((x) => x.username === where.username);
        return u ? { id: u.id, username: u.username, role: u.role } : null;
      }),
      findUnique: vi.fn(async () => ({ accessRoleId: null, accessRole: null })),
    },
    toolSpec: {
      findMany: vi.fn(async () => Array.from(specs.values()).map((s) => ({ ...s, _count: { steps: s.steps.length, runs: 0 } }))),
      findUnique: vi.fn(async ({ where }: { where: { slug: string } }) => specs.get(where.slug) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> & { steps: { create: Array<Omit<StepRow, "id" | "specId">> } } }) => {
        const id = `spec-${n++}`;
        const row: SpecRow = {
          id,
          slug: data.slug as string,
          name: data.name as string,
          category: (data.category as string | null) ?? null,
          description: (data.description as string | null) ?? null,
          version: 1,
          status: "draft",
          ownerId: (data.ownerId as string | null) ?? null,
          share: null,
          safety: 1,
          writes: data.writes as boolean,
          reversible: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          steps: data.steps.create.map((s, i) => ({ id: `s${n}-${i}`, specId: id, ...s })),
        };
        specs.set(row.slug, row);
        return row;
      }),
    },
    toolRun: {
      create: vi.fn(async ({ data }: { data: { specId: string; triggeredBy: string | null } }) => {
        runs.push({ specId: data.specId, triggeredBy: data.triggeredBy });
        return { id: `run-${n++}`, ...data, startedAt: new Date(), trace: [] };
      }),
    },
  };
}

const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };

function buildApp(prisma: ReturnType<typeof createPrismaMock>, user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createToolsRouter(prisma as never, dispatcher));
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/tools as the mcp principal", () => {
  it("answers for the acting user named by X-Nextcloud-User, schedules on the row", async () => {
    const spec = liveSpec("daily-files", "list_files", false) as SpecRow & { schedules?: unknown[] };
    spec.schedules = [{ rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0", timezone: "UTC", enabled: true, nextFireAt: new Date("2026-09-20T07:00:00Z") }];
    const prisma = createPrismaMock([spec]);
    const res = await request(buildApp(prisma, mcp)).get("/api/tools").set("X-Nextcloud-User", "kid");
    expect(res.status).toBe(200);
    expect(res.body.specs.map((s: { slug: string }) => s.slug)).toEqual(["daily-files"]);
    // WARP-2894 — the list row carries its schedules (additive), so
    // routine_list answers "when does this run" without a call per slug.
    expect(res.body.specs[0].schedules).toEqual([
      { rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0", timezone: "UTC", enabled: true, nextFireAt: "2026-09-20T07:00:00.000Z" },
    ]);
  });

  it("is 403 with no acting user — never an empty 200", async () => {
    const prisma = createPrismaMock([liveSpec("daily-files", "list_files", false)]);
    const res = await request(buildApp(prisma, mcp)).get("/api/tools");
    expect(res.status).toBe(403);
    expect(prisma.toolSpec.findMany).not.toHaveBeenCalled();
  });

  it("is 403 for an acting guest, and for a username that resolves to nobody", async () => {
    const prisma = createPrismaMock();
    expect((await request(buildApp(prisma, mcp)).get("/api/tools").set("X-Nextcloud-User", "visitor")).status).toBe(403);
    expect((await request(buildApp(prisma, mcp)).get("/api/tools?onBehalfOf=nobody")).status).toBe(403);
  });

  it("a browser caller is unchanged — the owner lists without any header", async () => {
    const prisma = createPrismaMock([liveSpec("daily-files", "list_files", false)]);
    const res = await request(buildApp(prisma, owner)).get("/api/tools");
    expect(res.status).toBe(200);
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("POST /api/tools as the mcp principal (routine_draft)", () => {
  it("creates a DRAFT owned by the acting user; onBehalfOf and any status in the body never reach the row", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mcp))
      .post("/api/tools")
      .send({
        onBehalfOf: "stefan",
        slug: "daily-files",
        name: "Daily files",
        status: "live",
        steps: [{ tool: "list_files", args: {} }],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    const created = prisma.toolSpec.create.mock.calls[0]![0].data as Record<string, unknown>;
    expect(created.ownerId).toBe("u-admin");
    expect(Object.keys(created)).not.toContain("onBehalfOf");
    expect(Object.keys(created)).not.toContain("status");
  });

  it("refuses a draft naming a tool this box does not have, with the names", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mcp))
      .post("/api/tools")
      .send({ onBehalfOf: "stefan", slug: "xx", name: "X", steps: [{ tool: "list_files" }, { tool: "list_reciepts" }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "unknown_tools", tools: ["list_reciepts"] });
    expect(prisma.toolSpec.create).not.toHaveBeenCalled();
  });

  it("is 403 with no acting user and for an acting guest", async () => {
    const prisma = createPrismaMock();
    const body = { slug: "xx", name: "X", steps: [{ tool: "list_files" }] };
    expect((await request(buildApp(prisma, mcp)).post("/api/tools").send(body)).status).toBe(403);
    expect((await request(buildApp(prisma, mcp)).post("/api/tools").send({ ...body, onBehalfOf: "visitor" })).status).toBe(403);
    expect(prisma.toolSpec.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/tools/:slug/runs as the mcp principal (routine_run)", () => {
  it("runs as the acting person and records them as the trigger", async () => {
    const prisma = createPrismaMock([liveSpec("daily-files", "list_files", false)]);
    const res = await request(buildApp(prisma, mcp)).post("/api/tools/daily-files/runs").send({ onBehalfOf: "kid" });
    expect(res.status).toBe(200);
    expect(prisma.runs).toEqual([{ specId: "spec-daily-files", triggeredBy: "kid" }]);
  });

  it("pre-flights against the ACTING person's tier — an admin's chat turn runs a write-tool spec", async () => {
    // MUTATION: pass `req.user` (the robot, role `service`) to the tier check
    // instead of the actor and this goes red — `service` is not privileged,
    // so the admin's turn would be refused as if it were a guest's. This is
    // the case that discriminates; the family case below cannot (both the
    // robot and a family member lose every write tool).
    const prisma = createPrismaMock([liveSpec("notify", "send_notification", true)]);
    const res = await request(buildApp(prisma, mcp)).post("/api/tools/notify/runs").send({ onBehalfOf: "stefan" });
    expect(res.status).toBe(200);
    expect(prisma.runs).toEqual([{ specId: "spec-notify", triggeredBy: "stefan" }]);
  });

  it("...and a family member's chat turn cannot run that same spec", async () => {
    const prisma = createPrismaMock([liveSpec("notify", "send_notification", true)]);
    const res = await request(buildApp(prisma, mcp)).post("/api/tools/notify/runs").send({ onBehalfOf: "kid" });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "forbidden_tool_for_role", tool: "send_notification", axis: "write_tier" });
    expect(prisma.runs).toEqual([]);
  });

  it("is 403 with no acting user; the spec is never even looked up", async () => {
    const prisma = createPrismaMock([liveSpec("daily-files", "list_files", false)]);
    const res = await request(buildApp(prisma, mcp)).post("/api/tools/daily-files/runs").send({});
    expect(res.status).toBe(403);
    expect(prisma.toolSpec.findUnique).not.toHaveBeenCalled();
  });
});
