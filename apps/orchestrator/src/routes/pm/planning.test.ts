/**
 * WARP-3521 — route tests for the cycle / module surface (routes/pm/planning.ts).
 *
 * The services are mocked: what is under test here is the HTTP contract — the
 * REAL requireRole guard (a stub auth middleware sets `req.user`), zod
 * validation, which service function gets which arguments, and the mapping of
 * every service error code to its status. The behaviour behind the calls is
 * pinned by the service suites and by pm-cycles-modules.pg.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import { PmPlanningError } from "../../services/pm/pm-planning.js";
import * as cycles from "../../services/pm/pm-cycles.service.js";
import * as modules from "../../services/pm/pm-modules.service.js";
import { createPmPlanningRouter } from "./planning.js";

vi.mock("../../services/pm/pm-cycles.service.js", () => ({
  listCycles: vi.fn(),
  getCycle: vi.fn(),
  createCycle: vi.fn(),
  updateCycle: vi.fn(),
  deleteCycle: vi.fn(),
  startCycle: vi.fn(),
  completeCycle: vi.fn(),
  getCycleBurndown: vi.fn(),
  listCycleWorkItems: vi.fn(),
  listBacklog: vi.fn(),
}));
vi.mock("../../services/pm/pm-modules.service.js", () => ({
  listModules: vi.fn(),
  getModule: vi.fn(),
  createModule: vi.fn(),
  updateModule: vi.fn(),
  deleteModule: vi.fn(),
  listModuleWorkItems: vi.fn(),
  addModuleWorkItems: vi.fn(),
  removeModuleWorkItems: vi.fn(),
  listModulesForWorkItem: vi.fn(),
}));

const OWNER = { id: "user-owner", role: "owner" };
const ADMIN = { id: "user-admin", role: "admin" };
const FAMILY = { id: "user-family", role: "family" };
const GUEST = { id: "user-guest", role: "guest" };
const MCP = { id: "_service:mcp", role: "service" };

function makeApp(user: { id: string; role: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) {
      (req as Request & { user?: AuthUser }).user = {
        id: user.id,
        username: user.id,
        displayName: user.id,
        role: user.role as AuthUser["role"],
      };
    }
    next();
  });
  app.use("/api", createPmPlanningRouter({} as never));
  return app;
}

const fn = <T extends (...a: never[]) => unknown>(f: T) => vi.mocked(f);
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeEach(() => {
  vi.clearAllMocks();
});

// ── RBAC ──────────────────────────────────────────────────────────────────────

describe("planning routes — RBAC", () => {
  const WRITES: Array<[string, string, object | undefined]> = [
    ["post", "/api/pm/projects/p1/cycles", { name: "S" }],
    ["patch", "/api/pm/cycles/c1", { name: "S" }],
    ["delete", "/api/pm/cycles/c1", undefined],
    ["post", "/api/pm/cycles/c1/start", undefined],
    ["post", "/api/pm/cycles/c1/complete", { moveIncompleteTo: "backlog" }],
    ["post", "/api/pm/projects/p1/modules", { name: "M" }],
    ["patch", "/api/pm/modules/m1", { name: "M" }],
    ["delete", "/api/pm/modules/m1", undefined],
    ["post", "/api/pm/modules/m1/work-items", { work_item_ids: ["w1"] }],
    ["delete", "/api/pm/modules/m1/work-items", { work_item_ids: ["w1"] }],
    ["delete", "/api/pm/modules/m1/work-items/w1", undefined],
  ];

  it.each(WRITES)("a guest cannot %s %s (403)", async (method, path, body) => {
    const req = (request(makeApp(GUEST)) as unknown as Record<string, (p: string) => request.Test>)[method](path);
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(403);
  });

  it.each(WRITES)("the MCP service principal cannot %s %s (403) — no tool writes planning", async (method, path, body) => {
    const req = (request(makeApp(MCP)) as unknown as Record<string, (p: string) => request.Test>)[method](path);
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(403);
  });

  it.each(WRITES)("a request with no role at all cannot %s %s (403)", async (method, path, body) => {
    const req = (request(makeApp(null)) as unknown as Record<string, (p: string) => request.Test>)[method](path);
    const res = await (body ? req.send(body) : req);
    expect(res.status).toBe(403);
  });

  it.each([OWNER, ADMIN, FAMILY])("owner, admin and family may write ($role)", async (user) => {
    fn(cycles.createCycle).mockResolvedValue({ id: "c1" } as never);
    const res = await request(makeApp(user)).post("/api/pm/projects/p1/cycles").send({ name: "S" });
    expect(res.status).toBe(201);
  });

  it("the services are never reached on a refused write", async () => {
    await request(makeApp(GUEST)).post("/api/pm/projects/p1/cycles").send({ name: "S" });
    await request(makeApp(GUEST)).post("/api/pm/cycles/c1/complete").send({ moveIncompleteTo: "backlog" });
    expect(cycles.createCycle).not.toHaveBeenCalled();
    expect(cycles.completeCycle).not.toHaveBeenCalled();
  });

  it("reads that reach the router are served to any authenticated role (the guest floor is the module gate's)", async () => {
    fn(cycles.listCycles).mockResolvedValue([]);
    fn(modules.listModules).mockResolvedValue([]);
    expect((await request(makeApp(GUEST)).get("/api/pm/projects/p1/cycles")).status).toBe(200);
    expect((await request(makeApp(GUEST)).get("/api/pm/projects/p1/modules")).status).toBe(200);
  });
});

// ── cycles ────────────────────────────────────────────────────────────────────

describe("cycle routes", () => {
  it("GET /projects/:id/cycles wraps the list in { cycles }", async () => {
    fn(cycles.listCycles).mockResolvedValue([{ id: "c1" }] as never);
    const res = await request(makeApp(OWNER)).get("/api/pm/projects/p1/cycles");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cycles: [{ id: "c1" }] });
    expect(cycles.listCycles).toHaveBeenCalledWith(expect.anything(), "p1");
  });

  it("POST /projects/:id/cycles turns snake_case dates into calendar dates", async () => {
    fn(cycles.createCycle).mockResolvedValue({ id: "c1", name: "Sprint 12" } as never);
    const res = await request(makeApp(OWNER))
      .post("/api/pm/projects/p1/cycles")
      .send({ name: "  Sprint 12  ", description: "Ship", start_date: "2026-10-05", end_date: "2026-10-16" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ cycle: { id: "c1", name: "Sprint 12" } });
    expect(cycles.createCycle).toHaveBeenCalledWith(expect.anything(), "p1", {
      name: "Sprint 12", // trimmed
      description: "Ship",
      startDate: d("2026-10-05"),
      endDate: d("2026-10-16"),
    });
  });

  it("dates are optional on create", async () => {
    fn(cycles.createCycle).mockResolvedValue({ id: "c1" } as never);
    await request(makeApp(OWNER)).post("/api/pm/projects/p1/cycles").send({ name: "Someday" });
    expect(cycles.createCycle).toHaveBeenCalledWith(expect.anything(), "p1", {
      name: "Someday",
      description: undefined,
      startDate: undefined,
      endDate: undefined,
    });
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a whitespace-only name", { name: "   " }],
    ["no name", {}],
    ["a name over 200 chars", { name: "x".repeat(201) }],
    ["a date with the wrong shape", { name: "S", start_date: "2026-10-5" }],
    ["an ISO datetime where a calendar date is required", { name: "S", start_date: "2026-10-05T00:00:00Z" }],
    ["an impossible calendar date", { name: "S", end_date: "2026-02-30" }],
    ["a numeric date", { name: "S", end_date: 20261016 }],
    ["a description over 5000 chars", { name: "S", description: "x".repeat(5001) }],
  ])("create refuses %s (400, service not called)", async (_label, body) => {
    const res = await request(makeApp(OWNER)).post("/api/pm/projects/p1/cycles").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(cycles.createCycle).not.toHaveBeenCalled();
  });

  it("PATCH passes null through as a CLEAR and absence as 'leave alone'", async () => {
    fn(cycles.updateCycle).mockResolvedValue({ id: "c1" } as never);
    await request(makeApp(OWNER)).patch("/api/pm/cycles/c1").send({ end_date: null, description: null });
    expect(cycles.updateCycle).toHaveBeenCalledWith(expect.anything(), "c1", {
      name: undefined,
      description: null,
      startDate: undefined,
      endDate: null,
    });
  });

  it("PATCH refuses an empty name", async () => {
    const res = await request(makeApp(OWNER)).patch("/api/pm/cycles/c1").send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("PATCH {} is not a request error: it reaches the service and answers the cycle (review S3)", async () => {
    // The same body on a module is a no-op too; the service owns the "nothing to
    // change" answer so a direct caller gets it as well.
    fn(cycles.updateCycle).mockResolvedValue({ id: "c1", name: "Same" } as never);
    fn(modules.updateModule).mockResolvedValue({ id: "m1", name: "Same" } as never);
    const cycle = await request(makeApp(OWNER)).patch("/api/pm/cycles/c1").send({});
    expect(cycle.status).toBe(200);
    expect(cycle.body).toEqual({ cycle: { id: "c1", name: "Same" } });
    expect(cycles.updateCycle).toHaveBeenCalledWith(expect.anything(), "c1", {
      name: undefined,
      description: undefined,
      startDate: undefined,
      endDate: undefined,
    });
    const mod = await request(makeApp(OWNER)).patch("/api/pm/modules/m1").send({});
    expect(mod.status).toBe(200);
  });

  it("DELETE answers { deleted } and attributes the audit rows to the caller", async () => {
    fn(cycles.deleteCycle).mockResolvedValue(undefined);
    const res = await request(makeApp(ADMIN)).delete("/api/pm/cycles/c1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: "c1" });
    expect(cycles.deleteCycle).toHaveBeenCalledWith(expect.anything(), "user-admin", "c1");
  });

  it("start", async () => {
    fn(cycles.startCycle).mockResolvedValue({ id: "c1", status: "active" } as never);
    const res = await request(makeApp(OWNER)).post("/api/pm/cycles/c1/start");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cycle: { id: "c1", status: "active" } });
    expect(cycles.startCycle).toHaveBeenCalledWith(expect.anything(), "c1");
  });

  describe("complete", () => {
    it("`backlog` means null", async () => {
      fn(cycles.completeCycle).mockResolvedValue({ cycle: { id: "c1" }, moved: { count: 2, to: null } } as never);
      const res = await request(makeApp(OWNER)).post("/api/pm/cycles/c1/complete").send({ moveIncompleteTo: "backlog" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ cycle: { id: "c1" }, moved: { count: 2, to: null } });
      expect(cycles.completeCycle).toHaveBeenCalledWith(expect.anything(), "user-owner", "c1", {
        moveIncompleteTo: null,
      });
    });

    it("a cycle id is passed through", async () => {
      fn(cycles.completeCycle).mockResolvedValue({ cycle: {}, moved: { count: 0, to: "c2" } } as never);
      await request(makeApp(OWNER)).post("/api/pm/cycles/c1/complete").send({ moveIncompleteTo: "c2" });
      expect(cycles.completeCycle).toHaveBeenCalledWith(expect.anything(), "user-owner", "c1", {
        moveIncompleteTo: "c2",
      });
    });

    it("the destination is REQUIRED — completing never guesses where unfinished work goes", async () => {
      const res = await request(makeApp(OWNER)).post("/api/pm/cycles/c1/complete").send({});
      expect(res.status).toBe(400);
      expect(cycles.completeCycle).not.toHaveBeenCalled();
    });

    it.each([[""], [null], [42]])("refuses a destination of %j", async (to) => {
      const res = await request(makeApp(OWNER)).post("/api/pm/cycles/c1/complete").send({ moveIncompleteTo: to });
      expect(res.status).toBe(400);
    });

    it("attributes the moved items' activity to the actor; an MCP principal would be null (but it is refused earlier)", async () => {
      fn(cycles.completeCycle).mockResolvedValue({ cycle: {}, moved: { count: 0, to: null } } as never);
      await request(makeApp(FAMILY)).post("/api/pm/cycles/c1/complete").send({ moveIncompleteTo: "backlog" });
      expect(vi.mocked(cycles.completeCycle).mock.calls[0][1]).toBe("user-family");
    });
  });

  it("burndown wraps the series in { burndown }", async () => {
    fn(cycles.getCycleBurndown).mockResolvedValue({ cycleId: "c1", days: [] } as never);
    const res = await request(makeApp(OWNER)).get("/api/pm/cycles/c1/burndown");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ burndown: { cycleId: "c1", days: [] } });
  });

  it("the cycle's work items and the backlog take pagination, and reject a malformed one", async () => {
    fn(cycles.listCycleWorkItems).mockResolvedValue({ work_items: [], total: 0 });
    fn(cycles.listBacklog).mockResolvedValue({ work_items: [], total: 0 });
    await request(makeApp(OWNER)).get("/api/pm/cycles/c1/work-items?per_page=50&page=2");
    expect(cycles.listCycleWorkItems).toHaveBeenCalledWith(expect.anything(), "c1", { perPage: 50, page: 2 });
    await request(makeApp(OWNER)).get("/api/pm/projects/p1/backlog");
    expect(cycles.listBacklog).toHaveBeenCalledWith(expect.anything(), "p1", { perPage: undefined, page: undefined });

    for (const bad of ["per_page=abc", "per_page=0", "per_page=201", "page=-1", "page=1.5"]) {
      const a = await request(makeApp(OWNER)).get(`/api/pm/cycles/c1/work-items?${bad}`);
      const b = await request(makeApp(OWNER)).get(`/api/pm/projects/p1/backlog?${bad}`);
      expect(a.status, bad).toBe(400);
      expect(b.status, bad).toBe(400);
    }
  });
});

// ── modules ───────────────────────────────────────────────────────────────────

describe("module routes", () => {
  it("POST /projects/:id/modules maps lead_id / target_date and validates status", async () => {
    fn(modules.createModule).mockResolvedValue({ id: "m1" } as never);
    const res = await request(makeApp(OWNER)).post("/api/pm/projects/p1/modules").send({
      name: "Launch",
      lead_id: "user-1",
      status: "in_progress",
      start_date: "2026-10-05",
      target_date: "2026-12-01",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ module: { id: "m1" } });
    expect(modules.createModule).toHaveBeenCalledWith(expect.anything(), "p1", {
      name: "Launch",
      description: undefined,
      leadId: "user-1",
      status: "in_progress",
      startDate: d("2026-10-05"),
      targetDate: d("2026-12-01"),
    });
  });

  it.each([
    ["an unknown status", { name: "M", status: "someday" }],
    ["an empty lead id (not a clear)", { name: "M", lead_id: "" }],
    ["a bad target date", { name: "M", target_date: "soon" }],
    ["no name", {}],
  ])("create refuses %s (400)", async (_l, body) => {
    const res = await request(makeApp(OWNER)).post("/api/pm/projects/p1/modules").send(body);
    expect(res.status).toBe(400);
    expect(modules.createModule).not.toHaveBeenCalled();
  });

  it("PATCH: null clears the lead, absence leaves it", async () => {
    fn(modules.updateModule).mockResolvedValue({ id: "m1" } as never);
    await request(makeApp(OWNER)).patch("/api/pm/modules/m1").send({ lead_id: null, status: "paused" });
    expect(modules.updateModule).toHaveBeenCalledWith(expect.anything(), "m1", {
      name: undefined,
      description: undefined,
      leadId: null,
      status: "paused",
      startDate: undefined,
      targetDate: undefined,
    });
  });

  it("DELETE answers { deleted }", async () => {
    fn(modules.deleteModule).mockResolvedValue(undefined);
    const res = await request(makeApp(OWNER)).delete("/api/pm/modules/m1");
    expect(res.body).toEqual({ deleted: "m1" });
    expect(modules.deleteModule).toHaveBeenCalledWith(expect.anything(), "user-owner", "m1");
  });

  describe("membership", () => {
    it("POST adds the ids", async () => {
      fn(modules.addModuleWorkItems).mockResolvedValue({ added: 2, module: { id: "m1" } } as never);
      const res = await request(makeApp(OWNER)).post("/api/pm/modules/m1/work-items").send({ work_item_ids: ["a", "b"] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ added: 2, module: { id: "m1" } });
      expect(modules.addModuleWorkItems).toHaveBeenCalledWith(expect.anything(), "user-owner", "m1", ["a", "b"]);
    });

    it("DELETE with a body removes those ids (the spec's form)", async () => {
      fn(modules.removeModuleWorkItems).mockResolvedValue({ removed: 1, module: {} } as never);
      const res = await request(makeApp(OWNER)).delete("/api/pm/modules/m1/work-items").send({ work_item_ids: ["a"] });
      expect(res.status).toBe(200);
      expect(modules.removeModuleWorkItems).toHaveBeenCalledWith(expect.anything(), "user-owner", "m1", ["a"]);
    });

    it("DELETE with the id in the path removes that one item (the form that survives a proxy that drops bodies)", async () => {
      fn(modules.removeModuleWorkItems).mockResolvedValue({ removed: 1, module: {} } as never);
      await request(makeApp(OWNER)).delete("/api/pm/modules/m1/work-items/w9");
      expect(modules.removeModuleWorkItems).toHaveBeenCalledWith(expect.anything(), "user-owner", "m1", ["w9"]);
    });

    it.each([
      ["no ids", { work_item_ids: [] }],
      ["a missing field", {}],
      ["a non-array", { work_item_ids: "a" }],
      ["an empty id", { work_item_ids: [""] }],
      ["more than 200 ids", { work_item_ids: Array.from({ length: 201 }, (_, i) => `w${i}`) }],
    ])("refuses %s (400)", async (_l, body) => {
      const res = await request(makeApp(OWNER)).post("/api/pm/modules/m1/work-items").send(body);
      expect(res.status).toBe(400);
      expect(modules.addModuleWorkItems).not.toHaveBeenCalled();
    });

    it("accepts exactly 200 ids", async () => {
      fn(modules.addModuleWorkItems).mockResolvedValue({ added: 200, module: {} } as never);
      const res = await request(makeApp(OWNER))
        .post("/api/pm/modules/m1/work-items")
        .send({ work_item_ids: Array.from({ length: 200 }, (_, i) => `w${i}`) });
      expect(res.status).toBe(200);
    });
  });

  it("the module's work items take pagination", async () => {
    fn(modules.listModuleWorkItems).mockResolvedValue({ work_items: [], total: 0 });
    await request(makeApp(OWNER)).get("/api/pm/modules/m1/work-items?per_page=10");
    expect(modules.listModuleWorkItems).toHaveBeenCalledWith(expect.anything(), "m1", { perPage: 10, page: undefined });
  });

  it("GET /work-items/:id/modules answers the drawer's picker data", async () => {
    fn(modules.listModulesForWorkItem).mockResolvedValue([{ id: "m1", name: "Launch", status: "planned" }]);
    const res = await request(makeApp(OWNER)).get("/api/pm/work-items/w1/modules");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ modules: [{ id: "m1", name: "Launch", status: "planned" }] });
    expect(modules.listModulesForWorkItem).toHaveBeenCalledWith(expect.anything(), "w1");
  });

  it("GET /modules/:id", async () => {
    fn(modules.getModule).mockResolvedValue({ id: "m1" } as never);
    expect((await request(makeApp(OWNER)).get("/api/pm/modules/m1")).body).toEqual({ module: { id: "m1" } });
  });
});

// ── error mapping ─────────────────────────────────────────────────────────────

describe("service errors → HTTP", () => {
  const cases: Array<[string, number]> = [
    ["project_not_found", 404],
    ["cycle_not_found", 404],
    ["module_not_found", 404],
    ["work_item_not_found", 404],
    ["invalid_cycle", 422],
    ["invalid_work_item", 422],
    ["invalid_dates", 422],
    ["cycle_dates_required", 422],
    ["lead_is_guest", 422],
    ["cycle_already_active", 409],
    ["cycle_not_draft", 409],
    ["cycle_not_active", 409],
    ["cycle_completed", 409],
    ["concurrent_mutation", 409],
  ];

  it.each(cases)("%s → %i, with the code in the body", async (code, status) => {
    fn(cycles.startCycle).mockRejectedValue(new Error(code));
    const res = await request(makeApp(OWNER)).post("/api/pm/cycles/c1/start");
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  it("the same mapping applies to every handler (a module write)", async () => {
    fn(modules.addModuleWorkItems).mockRejectedValue(new Error("invalid_work_item"));
    const res = await request(makeApp(OWNER)).post("/api/pm/modules/m1/work-items").send({ work_item_ids: ["a"] });
    expect(res.status).toBe(422);
  });

  it("cycle_already_active names the cycle in the way, in `details` and in a sentence", async () => {
    fn(cycles.startCycle).mockRejectedValue(
      new PmPlanningError("cycle_already_active", { activeCycleId: "c9", activeCycleName: "Sprint 11" }),
    );
    const res = await request(makeApp(OWNER)).post("/api/pm/cycles/c1/start");
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual({ activeCycleId: "c9", activeCycleName: "Sprint 11" });
    expect(res.body.message).toBe("Sprint 11 is already active. Complete it before starting another.");
  });

  it("cycle_already_active without a name (the race-loser form) still reads well", async () => {
    fn(cycles.startCycle).mockRejectedValue(new Error("cycle_already_active"));
    const res = await request(makeApp(OWNER)).post("/api/pm/cycles/c1/start");
    expect(res.body.message).toBe("Another cycle is already active. Complete it before starting another.");
  });

  it("invalid_dates carries its reason", async () => {
    fn(cycles.createCycle).mockRejectedValue(new PmPlanningError("invalid_dates", { reason: "end_before_start" }));
    const res = await request(makeApp(OWNER)).post("/api/pm/projects/p1/cycles").send({ name: "S" });
    expect(res.status).toBe(422);
    expect(res.body.details).toEqual({ reason: "end_before_start" });
  });

  it("work_item_not_found carries the missing ids", async () => {
    fn(modules.addModuleWorkItems).mockRejectedValue(new PmPlanningError("work_item_not_found", { missingIds: ["ghost"] }));
    const res = await request(makeApp(OWNER)).post("/api/pm/modules/m1/work-items").send({ work_item_ids: ["ghost"] });
    expect(res.status).toBe(404);
    expect(res.body.details).toEqual({ missingIds: ["ghost"] });
  });

  it("concurrent_mutation says nothing was applied", async () => {
    fn(cycles.completeCycle).mockRejectedValue(new Error("concurrent_mutation"));
    const res = await request(makeApp(OWNER)).post("/api/pm/cycles/c1/complete").send({ moveIncompleteTo: "backlog" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MUTATION");
    expect(res.body.message).toMatch(/Nothing was applied/);
  });

  it("an unknown error is NOT swallowed into a 4xx — it reaches the global handler (500)", async () => {
    fn(cycles.getCycle).mockRejectedValue(new Error("boom"));
    const app = makeApp(OWNER);
    app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.status(500).json({ error: "internal" });
    });
    const res = await request(app).get("/api/pm/cycles/c1");
    expect(res.status).toBe(500);
  });
});
