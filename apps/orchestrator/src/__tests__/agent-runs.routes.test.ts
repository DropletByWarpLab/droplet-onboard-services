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
      maxWallMs: 2_400_000,
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
    expect(row).toMatchObject({ userId: "u-owner", goal: "tidy old files", model: "gpt-oss:20b", status: "queued", maxIter: 10 });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "tool_run", refs: expect.objectContaining({ agentRunId: res.body.id }) }),
    );
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
});

describe("agent-runs routes — recurring runs (WARP-2180)", () => {
  it("creates a schedule from a supported RRULE, lists it, and deletes it — per person", async () => {
    const db = createAgentRunPrismaMock({ users: [owner, admin] });
    const { app } = buildApp(owner, db);
    const bad = await request(app).post("/api/agent-runs/schedules").send({ goal: "sweep clips", rrule: "FREQ=MINUTELY" });
    expect(bad.status).toBe(400);
    const res = await request(app)
      .post("/api/agent-runs/schedules")
      .send({ goal: "sweep clips", rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0", timezone: "America/Los_Angeles" });
    expect(res.status).toBe(201);
    expect(res.body.nextFireAt).toBeTruthy();
    expect(db.schedules[0]).toMatchObject({ userId: "u-owner", goal: "sweep clips", model: "gpt-oss:20b", maxIter: 10, timezone: "America/Los_Angeles" });

    const mine = await request(app).get("/api/agent-runs/schedules");
    expect(mine.body.schedules).toHaveLength(1);
    const theirs = await request(buildApp(admin, db).app).get("/api/agent-runs/schedules");
    expect(theirs.body.schedules).toHaveLength(0);
    expect((await request(buildApp(admin, db).app).delete(`/api/agent-runs/schedules/${res.body.id}`)).status).toBe(404);
    expect((await request(app).delete(`/api/agent-runs/schedules/${res.body.id}`)).status).toBe(204);
    expect(db.schedules).toHaveLength(0);
  });
});
