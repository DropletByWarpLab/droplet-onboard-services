/**
 * WARP-2180 — the agent-runs REST surface.
 *
 *   - owner/admin start, list, read, cancel and decide; `family` and `guest`
 *     get 403 on every route;
 *   - a person sees only their own runs — another person's run is a 404 on
 *     detail, cancel and confirm, and absent from the list;
 *   - the mcp principal acts ON BEHALF OF a named user: the run is attributed
 *     to that user, that user's role is what is checked (a `family` member
 *     cannot start a run from chat — no privilege laundering by delegation),
 *     and no `onBehalfOf` is a 403, never a wider identity;
 *   - list filters by status and pages by cursor;
 *   - detail carries the trace and the parked call with its provenance;
 *   - confirm maps the worker's decision results onto 403/404/409;
 *   - recurring runs: create validates the RRULE, list is per person, delete
 *     is per person.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AGENT_BLANK_TURN_DEBUG: false,
    OLLAMA_CONTEXT_LENGTH: 16384,
    TOOL_SELECTION_MODE: "off",
    AGENT_TOOL_RESULT_CAP_CHARS: 8000,
    agentMaxIter: { defaultIter: 10, capIter: 10 },
    agentRuns: {
      concurrency: 1,
      tickMs: 5_000,
      heartbeatMs: 15_000,
      reclaimAfterMs: 60_000,
      maxAttempts: 3,
      maxWallMs: 2_400_000, maxIter: 12,
    },
  },
}));
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
vi.mock("../services/notifications.service.js", () => ({
  sendNotification: vi.fn().mockResolvedValue({ id: "n", channels: [], delivered: false }),
}));

// WARP-2997 — only ever read for a cloud-resolving model; every local-model
// test in this file never reaches it.
vi.mock("../services/effective-access.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/effective-access.service.js")>()),
  resolveEffectiveAccess: vi.fn(async () => ({ cloud: false })),
}));

// WARP-3047 — a run with no `model` runs on the box's ACTIVE model. The
// resolver (active-model.service, own suite) is observed here; by default it
// answers what it answers on a box with a blank row and no confirmable
// listing — LLM_MODEL — so the WARP-2180 cases below keep their meaning.
const { resolveActiveModelMock } = vi.hoisted(() => ({
  resolveActiveModelMock: vi.fn(),
}));
vi.mock("../services/active-model.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/active-model.service.js")>()),
  resolveActiveModel: (...args: unknown[]) => resolveActiveModelMock(...args),
}));

import { createAgentRunsRouter } from "../routes/agent-runs.js";
import { enqueueAgentRun } from "../services/agent-run-worker.service.js";
import { createAgentRunPrismaMock } from "./helpers/agent-run-prisma-mock.js";
import type { AuthUser } from "../middleware/auth.js";

const mcpPrincipal: AuthUser = {
  id: "_service:mcp",
  username: "_service:mcp",
  displayName: "MCP Server",
  role: "service",
};
const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "stefan", displayName: "stefan", role: "admin" };
const family: AuthUser = { id: "u-family", username: "kid", displayName: "kid", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "guest", displayName: "guest", role: "guest" };

function buildApp(user: AuthUser, db = createAgentRunPrismaMock({ users: [owner, admin, family, guest] })) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createAgentRunsRouter(db.prisma));
  return { app, db };
}

beforeEach(() => {
  recordActivityMock.mockClear();
  process.env.LLM_MODEL = "gpt-oss:20b";
  resolveActiveModelMock.mockReset();
  resolveActiveModelMock.mockImplementation(async () => (process.env.LLM_MODEL ?? "").trim() || null);
});

describe("agent-runs routes — roles (WARP-2180)", () => {
  it.each([
    ["family", family],
    ["guest", guest],
  ])("%s gets 403 on every route", async (_label, user) => {
    const { app } = buildApp(user);
    expect((await request(app).post("/api/agent-runs").send({ goal: "g" })).status).toBe(403);
    expect((await request(app).get("/api/agent-runs")).status).toBe(403);
    expect((await request(app).get("/api/agent-runs/x")).status).toBe(403);
    expect((await request(app).post("/api/agent-runs/x/cancel")).status).toBe(403);
    expect((await request(app).post("/api/agent-runs/x/confirm").send({ decision: "approved" })).status).toBe(403);
    expect((await request(app).get("/api/agent-runs/schedules")).status).toBe(403);
    expect((await request(app).post("/api/agent-runs/schedules").send({ goal: "g", rrule: "FREQ=DAILY" })).status).toBe(403);
  });

  it("owner starts a run: 201, attributed to the owner, default model from LLM_MODEL, audited", async () => {
    const { app, db } = buildApp(owner);
    const res = await request(app).post("/api/agent-runs").send({ goal: "tidy old files" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "queued" });
    const row = db.row(res.body.id);
    // WARP-2749 — the default is the RUN cap (12 here), not the chat cap (10).
    expect(row).toMatchObject({ userId: "u-owner", goal: "tidy old files", model: "gpt-oss:20b", status: "queued", maxIter: 12 });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tool_run", refs: expect.objectContaining({ agentRunId: res.body.id }) }),
    );
  });

  it("WARP-2997: a cloud model the person may not use is refused up front — 451, chat's body, no row", async () => {
    const { app, db } = buildApp(owner);
    const run = await request(app).post("/api/agent-runs").send({ goal: "g", model: "claude-opus-4-20250514" });
    expect(run.status).toBe(451);
    expect(run.body).toMatchObject({ error: "off_lan_blocked", provider: "anthropic", scope: "per_person" });
    const sched = await request(app)
      .post("/api/agent-runs/schedules")
      .send({ goal: "g", model: "claude-opus-4-20250514", rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0" });
    expect(sched.status).toBe(451);
    expect(db.rows).toHaveLength(0);
    expect(db.schedules).toHaveLength(0);
  });

  it("rejects an empty goal and, with no model configured, a missing model", async () => {
    const { app } = buildApp(owner);
    expect((await request(app).post("/api/agent-runs").send({ goal: "  " })).status).toBe(400);
    delete process.env.LLM_MODEL;
    delete process.env.DEFAULT_MODEL;
    expect((await request(app).post("/api/agent-runs").send({ goal: "g" })).status).toBe(400);
    expect((await request(app).post("/api/agent-runs").send({ goal: "g", model: "m" })).status).toBe(201);
  });
});

describe("agent-runs routes — a workshop run is bound to one workspace (WARP-2896)", () => {
  async function seedWorkspace(db: ReturnType<typeof createAgentRunPrismaMock>, id: string, status = "active") {
    await db.prisma.workshopWorkspace.create({ data: { id, userId: "u-owner", name: id, status } });
  }

  it("binds the run to an existing, active workspace and echoes it", async () => {
    const { app, db } = buildApp(owner);
    await seedWorkspace(db, "ws-a");
    const res = await request(app).post("/api/agent-runs").send({ goal: "add a tool", workspaceId: "ws-a" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "queued", workspaceId: "ws-a" });
    expect(db.row(res.body.id)).toMatchObject({ workspaceId: "ws-a" });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ refs: expect.objectContaining({ workspaceId: "ws-a" }) }),
    );
  });

  it("404 for a workspace that does not exist; 409 for one already proposed", async () => {
    const { app, db } = buildApp(owner);
    await seedWorkspace(db, "ws-done", "proposed");
    expect((await request(app).post("/api/agent-runs").send({ goal: "g", workspaceId: "ws-none" })).status).toBe(404);
    const res = await request(app).post("/api/agent-runs").send({ goal: "g", workspaceId: "ws-done" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/proposed/);
    expect(db.rows).toHaveLength(0);
  });

  it("409 while another run is live in the workspace; free again once it ends", async () => {
    const { app, db } = buildApp(owner);
    await seedWorkspace(db, "ws-a");
    const first = await request(app).post("/api/agent-runs").send({ goal: "one", workspaceId: "ws-a" });
    expect(first.status).toBe(201);
    for (const status of ["queued", "running", "awaiting_confirmation"]) {
      db.row(first.body.id).status = status;
      const res = await request(app).post("/api/agent-runs").send({ goal: "two", workspaceId: "ws-a" });
      expect(res.status, status).toBe(409);
      expect(res.body.error).toMatch(/already working/);
    }
    db.row(first.body.id).status = "succeeded";
    expect((await request(app).post("/api/agent-runs").send({ goal: "two", workspaceId: "ws-a" })).status).toBe(201);
    expect(db.rows).toHaveLength(2);
  });

  it("two starts racing past the count: the partial unique index's P2002 is the same 409, not a 500", async () => {
    // The count saw nothing; by the time the create runs, another start has
    // landed. Postgres refuses it through AgentRun_workspaceId_active_key and
    // the route must answer as if the count had seen it.
    // Mutation: drop the catch around enqueueAgentRun → 500.
    const { app, db } = buildApp(owner);
    await seedWorkspace(db, "ws-a");
    const clash = Object.assign(new Error("Unique constraint failed on the fields: (`workspaceId`)"), {
      code: "P2002",
      meta: { target: "AgentRun_workspaceId_active_key" },
    });
    db.prisma.agentRun.create.mockRejectedValueOnce(clash);
    const res = await request(app).post("/api/agent-runs").send({ goal: "two", workspaceId: "ws-a" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already working/);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("a P2002 on an ORDINARY run is not a workspace clash — it stays an error", async () => {
    // No workspace → no partial-index predicate can match; whatever tripped
    // is a real fault and must not be dressed up as "workspace busy".
    const { app, db } = buildApp(owner);
    db.prisma.agentRun.create.mockRejectedValueOnce(Object.assign(new Error("clash"), { code: "P2002" }));
    const res = await request(app).post("/api/agent-runs").send({ goal: "plain" });
    expect(res.status).toBe(500);
  });
});

describe("agent-runs routes — the mcp principal acts on behalf of a person (WARP-2180)", () => {
  it("attributes the run to the named user", async () => {
    const { app, db } = buildApp(mcpPrincipal);
    const res = await request(app).post("/api/agent-runs").send({ goal: "g", onBehalfOf: "stefan" });
    expect(res.status).toBe(201);
    expect(db.row(res.body.id).userId).toBe("u-admin");
  });

  it("a family member cannot start a run from chat — no privilege laundering by delegation", async () => {
    const { app, db } = buildApp(mcpPrincipal);
    const res = await request(app).post("/api/agent-runs").send({ goal: "g", onBehalfOf: "kid" });
    expect(res.status).toBe(403);
    expect(db.rows).toHaveLength(0);
  });

  it("no onBehalfOf, or an unknown one, is a 403 — never a wider identity", async () => {
    const { app, db } = buildApp(mcpPrincipal);
    expect((await request(app).post("/api/agent-runs").send({ goal: "g" })).status).toBe(403);
    expect((await request(app).post("/api/agent-runs").send({ goal: "g", onBehalfOf: "nobody" })).status).toBe(403);
    expect((await request(app).get("/api/agent-runs")).status).toBe(403);
    expect(db.rows).toHaveLength(0);
  });

  it("lists only the named user's runs", async () => {
    const db = createAgentRunPrismaMock({ users: [owner, admin] });
    await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: "mine", model: "m" });
    await enqueueAgentRun(db.prisma, { userId: "u-admin", goal: "theirs", model: "m" });
    const { app } = buildApp(mcpPrincipal, db);
    const res = await request(app).get("/api/agent-runs").query({ onBehalfOf: "romain" });
    expect(res.status).toBe(200);
    expect(res.body.items.map((r: { goal: string }) => r.goal)).toEqual(["mine"]);
  });
});

describe("agent-runs routes — ownership, list, detail, cancel (WARP-2180)", () => {
  it("another person's run is a 404 on detail, cancel and confirm, and absent from the list", async () => {
    const db = createAgentRunPrismaMock({ users: [owner, admin] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: "mine", model: "m" });
    const { app } = buildApp(admin, db);
    expect((await request(app).get(`/api/agent-runs/${id}`)).status).toBe(404);
    expect((await request(app).post(`/api/agent-runs/${id}/cancel`)).status).toBe(404);
    expect((await request(app).post(`/api/agent-runs/${id}/confirm`).send({ decision: "approved" })).status).toBe(404);
    const list = await request(app).get("/api/agent-runs");
    expect(list.body.items).toEqual([]);
  });

  it("lists newest first, filters by status, and pages by cursor", async () => {
    let t = new Date("2026-09-04T10:00:00Z").getTime();
    const db = createAgentRunPrismaMock({ users: [owner], now: () => new Date((t += 1000)) });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: `g${i}`, model: "m" })).id);
    }
    db.row(ids[1]!).status = "succeeded";
    const { app } = buildApp(owner, db);
    const page1 = await request(app).get("/api/agent-runs").query({ limit: 2 });
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((r: { goal: string }) => r.goal)).toEqual(["g2", "g1"]);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await request(app).get("/api/agent-runs").query({ limit: 2, cursor: page1.body.nextCursor });
    expect(page2.body.items.map((r: { goal: string }) => r.goal)).toEqual(["g0"]);
    expect(page2.body.nextCursor).toBeNull();
    const done = await request(app).get("/api/agent-runs").query({ status: "succeeded" });
    expect(done.body.items.map((r: { goal: string }) => r.goal)).toEqual(["g1"]);
    // The list never carries the trace; detail does.
    expect(page1.body.items[0]).not.toHaveProperty("trace");
  });

  it("pages by (createdAt, id): rows created in the same millisecond straddling a page boundary are not skipped", async () => {
    const same = new Date("2026-09-04T10:00:00Z");
    const db = createAgentRunPrismaMock({ users: [owner], now: () => same });
    for (let i = 0; i < 4; i++) await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: `g${i}`, model: "m" });
    const { app } = buildApp(owner, db);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5 && (page === 0 || cursor); page++) {
      const res = await request(app).get("/api/agent-runs").query({ limit: 2, ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((r: { goal: string }) => r.goal));
      cursor = res.body.nextCursor;
    }
    expect(seen).toEqual(["g3", "g2", "g1", "g0"]);
    expect((await request(app).get("/api/agent-runs").query({ cursor: "not-a-cursor" })).status).toBe(400);
  });

  it("a finished run never reports a pending call, even if the columns were left behind", async () => {
    const db = createAgentRunPrismaMock({ users: [owner] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: "g", model: "m" });
    Object.assign(db.row(id), {
      status: "succeeded",
      pendingTool: "delete_file",
      pendingArgs: { path: "/old.txt" },
      parkedAt: new Date("2026-09-04T03:00:00Z"),
    });
    const { app } = buildApp(owner, db);
    const res = await request(app).get(`/api/agent-runs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.pending).toBeNull();
    const list = await request(app).get("/api/agent-runs");
    expect(list.body.items[0].pending).toBeNull();
  });

  it("detail carries the trace and the parked call with its provenance", async () => {
    const db = createAgentRunPrismaMock({ users: [owner] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: "tidy up", model: "m" });
    Object.assign(db.row(id), {
      status: "awaiting_confirmation",
      iteration: 2,
      trace: [{ tool_call_id: "c1", tool: "list_files", args: { path: "/" }, iteration: 0, dispatchedAt: "x", text: "[]" }],
      pendingTool: "delete_file",
      pendingArgs: { path: "/old.txt" },
      parkedAt: new Date("2026-09-04T03:00:00Z"),
    });
    const { app } = buildApp(owner, db);
    const res = await request(app).get(`/api/agent-runs/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      goal: "tidy up",
      status: "awaiting_confirmation",
      iteration: 2,
      pending: { tool: "delete_file", args: { path: "/old.txt" }, parkedAt: "2026-09-04T03:00:00.000Z" },
    });
    expect(res.body.pending.summary.tool).toBe("delete_file");
    expect(res.body.pending.summary.fields.map((f: { key: string }) => f.key)).toEqual(["path"]);
    expect(res.body.trace).toHaveLength(1);
  });

  it("cancel flips a live run and 409s a finished one", async () => {
    const db = createAgentRunPrismaMock({ users: [owner] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: "g", model: "m" });
    const { app } = buildApp(owner, db);
    const first = await request(app).post(`/api/agent-runs/${id}/cancel`);
    expect(first.status).toBe(200);
    expect(db.row(id).status).toBe("cancelled");
    expect((await request(app).post(`/api/agent-runs/${id}/cancel`)).status).toBe(409);
  });

  it("confirm maps the worker's decision results: 409 when not parked, 200 + queued when approved", async () => {
    const db = createAgentRunPrismaMock({ users: [owner] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: "g", model: "m" });
    const { app } = buildApp(owner, db);
    expect((await request(app).post(`/api/agent-runs/${id}/confirm`).send({ decision: "approved" })).status).toBe(409);
    expect((await request(app).post(`/api/agent-runs/${id}/confirm`).send({ decision: "maybe" })).status).toBe(400);
    Object.assign(db.row(id), {
      status: "awaiting_confirmation",
      pendingTool: "get_current_datetime",
      pendingBindingHash: "h",
      pendingArgs: {},
      parkedAt: new Date(),
    });
    const res = await request(app).post(`/api/agent-runs/${id}/confirm`).send({ decision: "approved" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, tool: "get_current_datetime", decision: "approved", status: "queued" });
    expect(db.row(id).status).toBe("queued");
  });

  it("WARP-3044: a second confirm on the same park is a 409 and changes nothing — one approval, one decision on the row", async () => {
    const db = createAgentRunPrismaMock({ users: [owner] });
    const { id } = await enqueueAgentRun(db.prisma, { userId: "u-owner", goal: "g", model: "m" });
    const { app } = buildApp(owner, db);
    Object.assign(db.row(id), {
      status: "awaiting_confirmation",
      pendingTool: "get_current_datetime",
      pendingBindingHash: "h",
      pendingArgs: {},
      parkedAt: new Date(),
    });
    expect((await request(app).post(`/api/agent-runs/${id}/confirm`).send({ decision: "approved" })).status).toBe(200);
    const decided = { ...db.row(id) };
    const again = await request(app).post(`/api/agent-runs/${id}/confirm`).send({ decision: "approved" });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: "not_parked", id });
    // A late denial cannot overwrite the approval either.
    expect((await request(app).post(`/api/agent-runs/${id}/confirm`).send({ decision: "denied" })).status).toBe(409);
    const row = db.row(id);
    expect(row.status).toBe("queued");
    expect(row.pendingDecision).toBe("approved");
    expect(row.pendingDecidedAt).toEqual(decided.pendingDecidedAt);
    expect(row.deadlineAt).toEqual(decided.deadlineAt);
  });
});

describe("agent-runs routes — recurring runs (WARP-2180)", () => {
  it("creates a schedule from a supported RRULE, lists it, and deletes it — per person", async () => {
    const db = createAgentRunPrismaMock({ users: [owner, admin] });
    const { app } = buildApp(owner, db);
    const bad = await request(app).post("/api/agent-runs/schedules").send({ goal: "sweep clips", rrule: "FREQ=MINUTELY" });
    expect(bad.status).toBe(400);
    const res = await request(app)
      .post("/api/agent-runs/schedules")
      .send({ goal: "sweep clips", rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0", timezone: "America/Los_Angeles", maxIter: 50 });
    expect(res.status).toBe(201);
    expect(res.body.nextFireAt).toBeTruthy();
    // WARP-2749 — clamped to the RUN cap (12), not the chat cap (10).
    expect(db.schedules[0]).toMatchObject({ userId: "u-owner", goal: "sweep clips", model: "gpt-oss:20b", maxIter: 12, timezone: "America/Los_Angeles" });

    const mine = await request(app).get("/api/agent-runs/schedules");
    expect(mine.body.schedules).toHaveLength(1);
    const theirs = await request(buildApp(admin, db).app).get("/api/agent-runs/schedules");
    expect(theirs.body.schedules).toHaveLength(0);
    expect((await request(buildApp(admin, db).app).delete(`/api/agent-runs/schedules/${res.body.id}`)).status).toBe(404);
    expect((await request(app).delete(`/api/agent-runs/schedules/${res.body.id}`)).status).toBe(204);
    expect(db.schedules).toHaveLength(0);
  });
});

describe("agent-runs routes — runs follow the box's ACTIVE model (WARP-3047)", () => {
  const ACTIVE = "docker.io/ai/qwen3:8B-Q4_K_M";

  it("a run with no model is queued on the active model, asked for a TOOLS-capable one", async () => {
    // LLM_MODEL still names the provisioned model; the owner switched to B.
    resolveActiveModelMock.mockResolvedValue(ACTIVE);
    const { app, db } = buildApp(owner);
    const res = await request(app).post("/api/agent-runs").send({ goal: "tidy old files" });
    expect(res.status).toBe(201);
    expect(db.row(res.body.id).model).toBe(ACTIVE);
    expect(resolveActiveModelMock).toHaveBeenCalledWith(db.prisma, { requireTools: true });
  });

  it("an explicit model still wins and the resolver is not asked", async () => {
    resolveActiveModelMock.mockResolvedValue(ACTIVE);
    const { app, db } = buildApp(owner);
    const res = await request(app).post("/api/agent-runs").send({ goal: "g", model: "gpt-oss:20b" });
    expect(res.status).toBe(201);
    expect(db.row(res.body.id).model).toBe("gpt-oss:20b");
    expect(resolveActiveModelMock).not.toHaveBeenCalled();
  });

  it("a schedule with no model FOLLOWS the active model — the ticker resolves it at every fire", async () => {
    resolveActiveModelMock.mockResolvedValue(ACTIVE);
    const { app, db } = buildApp(owner);
    const res = await request(app)
      .post("/api/agent-runs/schedules")
      .send({ goal: "sweep clips", rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0" });
    expect(res.status).toBe(201);
    // `model` still holds a real id (what was active at creation): the
    // fallback when nothing resolves at fire, and what an older build fires.
    expect(db.schedules[0]).toMatchObject({ model: ACTIVE, followsActiveModel: true });
    expect(resolveActiveModelMock).toHaveBeenCalledWith(db.prisma, { requireTools: true });

    const listed = await request(app).get("/api/agent-runs/schedules");
    expect(listed.body.schedules[0]).toMatchObject({ model: ACTIVE, followsActiveModel: true });
  });

  it("a schedule with an explicit model is pinned to it", async () => {
    resolveActiveModelMock.mockResolvedValue(ACTIVE);
    const { app, db } = buildApp(owner);
    const res = await request(app)
      .post("/api/agent-runs/schedules")
      .send({ goal: "sweep clips", model: "gpt-oss:20b", rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0" });
    expect(res.status).toBe(201);
    expect(db.schedules[0]).toMatchObject({ model: "gpt-oss:20b", followsActiveModel: false });
    expect(resolveActiveModelMock).not.toHaveBeenCalled();
  });

  it("a schedule with no model on a box with no model at all → 400", async () => {
    resolveActiveModelMock.mockResolvedValue(null);
    const { app, db } = buildApp(owner);
    const res = await request(app)
      .post("/api/agent-runs/schedules")
      .send({ goal: "sweep clips", rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0" });
    expect(res.status).toBe(400);
    expect(db.schedules).toHaveLength(0);
  });

  it("nothing resolvable → 400, never a queued run on a guessed model", async () => {
    resolveActiveModelMock.mockResolvedValue(null);
    const { app, db } = buildApp(owner);
    expect((await request(app).post("/api/agent-runs").send({ goal: "g" })).status).toBe(400);
    expect(db.rows).toHaveLength(0);
  });
});
