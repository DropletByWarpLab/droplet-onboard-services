/**
 * WARP-3520 (ADR-069 WS-4) — the ROUTE layer of the editing surfaces in
 * routes/pm/native.ts: RBAC per role, zod validation (field-level errors), the
 * date-only inputs, status mapping of every new error code, and the plumbing of
 * the new query/body parameters into the service.
 *
 * The service is mocked (everything real except the functions this file stubs),
 * because what is under test is the HTTP contract, and the service's own
 * behaviour — against a real database, where the partial unique index, the
 * completion re-sync and the cycle walk actually live — is proven in
 * src/__tests__/pm-work-item-editing.pg.test.ts. The REAL requireRole guards run
 * behind a stub auth middleware that sets `req.user` per test.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";

const svc = vi.hoisted(() => ({
  archiveWorkItem: vi.fn(),
  restoreWorkItem: vi.fn(),
  deleteWorkItem: vi.fn(),
  getWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
  createWorkItem: vi.fn(),
  listWorkItems: vi.fn(),
  updateState: vi.fn(),
  deleteState: vi.fn(),
  reorderStates: vi.fn(),
}));
const audit = vi.hoisted(() => ({ recordActivity: vi.fn() }));

vi.mock("../../services/pm/pm.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/pm/pm.service.js")>()),
  ...svc,
}));
vi.mock("../../services/activity.singleton.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/activity.singleton.js")>()),
  ...audit,
}));

import { createPmNativeRouter } from "./native.js";

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
  app.use("/api", createPmNativeRouter({} as never));
  return app;
}

const OWNER = { id: "u-owner", role: "owner" };
const ADMIN = { id: "u-admin", role: "admin" };
const FAMILY = { id: "u-family", role: "family" };
const GUEST = { id: "u-guest", role: "guest" };
const MCP = { id: "_service:mcp", role: "service" };

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
  audit.recordActivity.mockReset();
  svc.updateWorkItem.mockResolvedValue({ id: "w1" });
  svc.createWorkItem.mockResolvedValue({ id: "w1" });
  svc.archiveWorkItem.mockResolvedValue({ id: "w1", isArchived: true });
  svc.restoreWorkItem.mockResolvedValue({ id: "w1", isArchived: false });
  svc.listWorkItems.mockResolvedValue([]);
  svc.updateState.mockResolvedValue({ id: "s1" });
  svc.reorderStates.mockResolvedValue([]);
});

const reject = (code: string) => new Error(code);

describe("archive / restore", () => {
  it.each([OWNER, ADMIN, FAMILY])("lets $role archive and restore", async (user) => {
    const archived = await request(makeApp(user)).post("/api/pm/work-items/w1/archive");
    expect(archived.status).toBe(200);
    expect(archived.body.work_item).toEqual({ id: "w1", isArchived: true });
    expect(svc.archiveWorkItem).toHaveBeenCalledWith(expect.anything(), user.id, "w1");

    const restored = await request(makeApp(user)).post("/api/pm/work-items/w1/restore");
    expect(restored.status).toBe(200);
    expect(svc.restoreWorkItem).toHaveBeenCalledWith(expect.anything(), user.id, "w1");
  });

  it.each([GUEST, MCP, null])("refuses %o with 403 and never reaches the service", async (user) => {
    for (const path of ["archive", "restore"]) {
      const res = await request(makeApp(user)).post(`/api/pm/work-items/w1/${path}`);
      expect(res.status).toBe(403);
    }
    expect(svc.archiveWorkItem).not.toHaveBeenCalled();
    expect(svc.restoreWorkItem).not.toHaveBeenCalled();
  });

  it.each([
    ["archive", "work_item_archived", 409],
    ["archive", "work_item_not_found", 404],
    ["restore", "work_item_not_archived", 409],
    ["restore", "work_item_not_found", 404],
  ])("maps %s -> %s to %i", async (path, code, status) => {
    (path === "archive" ? svc.archiveWorkItem : svc.restoreWorkItem).mockRejectedValue(reject(code));
    const res = await request(makeApp(OWNER)).post(`/api/pm/work-items/w1/${path}`);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });
});

const deleteRows = () =>
  audit.recordActivity.mock.calls.map((c) => c[0]).filter((row) => row.what === "pm_work_item_delete");

describe("hard delete is owner/admin only, and leaves a signed audit row", () => {
  beforeEach(() => {
    svc.getWorkItem.mockResolvedValue({ id: "w1", projectId: "p1", key: "INBOX-7", name: "Secret plan" });
    svc.deleteWorkItem.mockResolvedValue(undefined);
  });

  it.each([OWNER, ADMIN])("lets $role delete and records ids and the key only", async (user) => {
    const res = await request(makeApp(user)).delete("/api/pm/work-items/w1");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: "w1" });
    expect(deleteRows()).toHaveLength(1);
    const row = deleteRows()[0];
    expect(row).toMatchObject({
      kind: "system",
      what: "pm_work_item_delete",
      sub: "INBOX-7",
      actor: { type: "user", id: user.id },
    });
    // The audit stream is exported wholesale: ids and the key, never the title.
    expect(Object.keys(row.refs).sort()).toEqual(["key", "projectId", "surface", "workItemId"]);
    expect(JSON.stringify(row)).not.toContain("Secret plan");
  });

  it.each([FAMILY, GUEST, MCP, null])("refuses %o with 403 and deletes nothing", async (user) => {
    const res = await request(makeApp(user)).delete("/api/pm/work-items/w1");
    expect(res.status).toBe(403);
    expect(svc.deleteWorkItem).not.toHaveBeenCalled();
    // A refused request still leaves the guard's own access-denied row; what must
    // not exist is a DELETE row for something that was not deleted.
    expect(deleteRows()).toEqual([]);
  });

  it("is a 404 with no audit row when the item is already gone", async () => {
    svc.getWorkItem.mockRejectedValue(reject("work_item_not_found"));
    const res = await request(makeApp(OWNER)).delete("/api/pm/work-items/w1");
    expect(res.status).toBe(404);
    expect(svc.deleteWorkItem).not.toHaveBeenCalled();
    expect(deleteRows()).toEqual([]);
  });
});

describe("work item create / patch — type, estimate, dates", () => {
  const patch = (body: unknown, user = OWNER) =>
    request(makeApp(user)).patch("/api/pm/work-items/w1").send(body as object);
  const create = (body: unknown, user = OWNER) =>
    request(makeApp(user)).post("/api/pm/projects/p1/work-items").send(body as object);

  it("passes type and estimate through on patch, including an explicit null estimate", async () => {
    expect((await patch({ type: "bug", estimate: 5 })).status).toBe(200);
    expect(svc.updateWorkItem.mock.calls[0][3]).toMatchObject({ type: "bug", estimate: 5 });

    svc.updateWorkItem.mockClear();
    expect((await patch({ estimate: null })).status).toBe(200);
    expect(svc.updateWorkItem.mock.calls[0][3].estimate).toBeNull();

    svc.updateWorkItem.mockClear();
    expect((await patch({ name: "x" })).status).toBe(200);
    expect(svc.updateWorkItem.mock.calls[0][3].estimate).toBeUndefined();
  });

  it("passes type and estimate through on create", async () => {
    expect((await create({ name: "x", type: "incident", estimate: 0.5 })).status).toBe(201);
    expect(svc.createWorkItem.mock.calls[0][3]).toMatchObject({ type: "incident", estimate: 0.5 });
  });

  it.each([
    ["type", { type: "epic" }],
    ["type", { type: "" }],
    ["estimate", { estimate: -1 }],
    ["estimate", { estimate: 1000.5 }],
    ["estimate", { estimate: "5" }],
  ])("rejects a bad %s with a field-level error", async (field, body) => {
    for (const res of [await patch(body), await create({ name: "x", ...body })]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
      expect(res.body.details.fieldErrors[field]).toBeTruthy();
    }
    expect(svc.updateWorkItem).not.toHaveBeenCalled();
    expect(svc.createWorkItem).not.toHaveBeenCalled();
  });

  it("stores calendar dates at 00:00:00Z, including an accepted legacy ISO datetime", async () => {
    await patch({ start_date: "2026-10-04", due_date: "2026-10-09T13:45:10.000Z" });
    const fields = svc.updateWorkItem.mock.calls[0][3];
    expect((fields.startDate as Date).toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect((fields.dueDate as Date).toISOString()).toBe("2026-10-09T00:00:00.000Z");

    await create({ name: "x", due_date: "2026-12-31" });
    expect((svc.createWorkItem.mock.calls[0][3].dueDate as Date).toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("clears a date with null on patch", async () => {
    await patch({ start_date: null, due_date: null });
    const fields = svc.updateWorkItem.mock.calls[0][3];
    expect(fields.startDate).toBeNull();
    expect(fields.dueDate).toBeNull();
  });

  it.each(["2026-02-30", "2026-13-01", "tomorrow", "10/04/2026"])("rejects the date %s", async (bad) => {
    for (const res of [await patch({ due_date: bad }), await patch({ start_date: bad })]) {
      expect(res.status).toBe(400);
    }
    expect((await patch({ due_date: bad })).body.details.fieldErrors.due_date).toBeTruthy();
  });

  it.each([OWNER, ADMIN, FAMILY])("lets $role edit every built-in field this slice added", async (user) => {
    const res = await patch(
      { type: "bug", estimate: 3, start_date: "2026-10-04", due_date: "2026-10-09", parent_id: "w2", department_id: "d1" },
      user,
    );
    expect(res.status).toBe(200);
    expect(svc.updateWorkItem).toHaveBeenLastCalledWith(expect.anything(), user.id, "w1", expect.objectContaining({ type: "bug", estimate: 3 }));
    expect((await create({ name: "x", type: "feature", estimate: 2 }, user)).status).toBe(201);
  });

  it("refuses a guest and a missing session, and admits the MCP principal (the confirmed write path)", async () => {
    expect((await patch({ type: "bug" }, GUEST)).status).toBe(403);
    expect((await request(makeApp(null)).patch("/api/pm/work-items/w1").send({ type: "bug" })).status).toBe(403);
    expect(svc.updateWorkItem).not.toHaveBeenCalled();
    expect((await patch({ type: "bug" }, MCP)).status).toBe(200);
  });

  it("maps parent_cycle to 422", async () => {
    svc.updateWorkItem.mockRejectedValue(reject("parent_cycle"));
    const res = await patch({ parent_id: "w2" });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("parent_cycle");
  });
});

describe("the Archived list", () => {
  it("passes archived=only to the service", async () => {
    const res = await request(makeApp(FAMILY)).get("/api/pm/projects/p1/work-items?archived=only");
    expect(res.status).toBe(200);
    expect(svc.listWorkItems.mock.calls[0][2]).toMatchObject({ archived: "only" });
  });

  it("treats an absent or empty archived param as the live list", async () => {
    await request(makeApp(FAMILY)).get("/api/pm/projects/p1/work-items");
    await request(makeApp(FAMILY)).get("/api/pm/projects/p1/work-items?archived=");
    for (const call of svc.listWorkItems.mock.calls) expect(call[2].archived).toBeUndefined();
  });

  it("rejects any other value rather than silently showing the live board", async () => {
    const res = await request(makeApp(FAMILY)).get("/api/pm/projects/p1/work-items?archived=yes");
    expect(res.status).toBe(400);
    expect(svc.listWorkItems).not.toHaveBeenCalled();
  });
});

describe("state management", () => {
  it("sets the default with isDefault: true", async () => {
    const res = await request(makeApp(OWNER)).patch("/api/pm/states/s1").send({ isDefault: true });
    expect(res.status).toBe(200);
    expect(svc.updateState.mock.calls[0][2]).toEqual({ isDefault: true });
  });

  it("refuses isDefault: false — a project always has one default, so it moves, it is never cleared", async () => {
    const res = await request(makeApp(OWNER)).patch("/api/pm/states/s1").send({ isDefault: false });
    expect(res.status).toBe(400);
    expect(res.body.details.fieldErrors.isDefault).toBeTruthy();
    expect(svc.updateState).not.toHaveBeenCalled();
  });

  it("maps state_default_terminal to 422", async () => {
    svc.updateState.mockRejectedValue(reject("state_default_terminal"));
    const res = await request(makeApp(OWNER)).patch("/api/pm/states/s1").send({ isDefault: true });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe("state_default_terminal");
  });

  it("plumbs ?reassign_to into the delete, and omits it when absent", async () => {
    svc.deleteState.mockResolvedValue(undefined);
    await request(makeApp(OWNER)).delete("/api/pm/states/s1?reassign_to=s2");
    expect(svc.deleteState).toHaveBeenLastCalledWith(expect.anything(), "s1", { reassignTo: "s2" });
    await request(makeApp(OWNER)).delete("/api/pm/states/s1");
    expect(svc.deleteState).toHaveBeenLastCalledWith(expect.anything(), "s1", { reassignTo: undefined });
  });

  it("rejects an empty reassign_to", async () => {
    const res = await request(makeApp(OWNER)).delete("/api/pm/states/s1?reassign_to=");
    expect(res.status).toBe(400);
    expect(svc.deleteState).not.toHaveBeenCalled();
  });

  it.each([
    ["state_not_found", 404],
    ["invalid_state", 422],
    ["state_is_default", 409],
    ["state_is_last", 409],
  ])("keeps %s at %i on delete", async (code, status) => {
    svc.deleteState.mockRejectedValue(reject(code));
    const res = await request(makeApp(OWNER)).delete("/api/pm/states/s1?reassign_to=s2");
    expect(res.status).toBe(status);
  });

  it("reorders with every state id, and refuses a malformed body", async () => {
    const ok = await request(makeApp(OWNER)).post("/api/pm/projects/p1/states/reorder").send({ state_ids: ["a", "b"] });
    expect(ok.status).toBe(200);
    expect(svc.reorderStates).toHaveBeenCalledWith(expect.anything(), "p1", ["a", "b"]);

    for (const body of [{}, { state_ids: [] }, { state_ids: [1] }, { state_ids: "a" }]) {
      const bad = await request(makeApp(OWNER)).post("/api/pm/projects/p1/states/reorder").send(body);
      expect(bad.status).toBe(400);
    }
  });

  it("maps invalid_order to 422", async () => {
    svc.reorderStates.mockRejectedValue(reject("invalid_order"));
    const res = await request(makeApp(OWNER)).post("/api/pm/projects/p1/states/reorder").send({ state_ids: ["a"] });
    expect(res.status).toBe(422);
  });

  it.each([GUEST, MCP, null])("keeps state writes behind the writer roles (%o)", async (user) => {
    expect((await request(makeApp(user)).patch("/api/pm/states/s1").send({ isDefault: true })).status).toBe(403);
    expect((await request(makeApp(user)).delete("/api/pm/states/s1")).status).toBe(403);
    expect(
      (await request(makeApp(user)).post("/api/pm/projects/p1/states/reorder").send({ state_ids: ["a"] })).status,
    ).toBe(403);
  });
});
