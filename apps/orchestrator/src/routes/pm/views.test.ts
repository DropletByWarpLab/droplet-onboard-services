/**
 * WARP-3522 — the HTTP face of saved views: who gets through, what is
 * validated, what each refusal is called. Who may change which view, and
 * everything the database does, is the service's and is proven in
 * `pm-views.service.test.ts` and `__tests__/pm-saved-view.pg.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "../../middleware/auth.js";

const svc = vi.hoisted(() => ({
  listViews: vi.fn(),
  createView: vi.fn(),
  updateView: vi.fn(),
  deleteView: vi.fn(),
}));
vi.mock("../../services/pm/pm-views.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/pm/pm-views.service.js")>();
  return { ...actual, ...svc };
});

import { createPmViewsRouter } from "./views.js";

const OWNER = { id: "u-owner", role: "owner" };
const ADMIN = { id: "u-admin", role: "admin" };
const FAMILY = { id: "u-fam", role: "family" };
const GUEST = { id: "u-guest", role: "guest" };
const MCP = { id: "_service:mcp", role: "service" };

function makeApp(user: { id: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { ...user, username: user.id, displayName: user.id, role: user.role as AuthUser["role"] } as AuthUser;
    next();
  });
  app.use("/api", createPmViewsRouter({} as never));
  return app;
}

const GOOD = {
  projectId: "p1",
  scope: "PERSONAL",
  name: "My bugs",
  layout: "BOARD",
  filter: { and: [{ field: "label", op: "is", value: "l1" }] },
};

beforeEach(() => {
  for (const f of Object.values(svc)) f.mockReset();
  svc.listViews.mockResolvedValue({ builtin: [], views: [] });
  svc.createView.mockResolvedValue({ id: "v1" });
  svc.updateView.mockResolvedValue({ id: "v1" });
  svc.deleteView.mockResolvedValue(undefined);
});

describe("GET /api/pm/views", () => {
  it("returns the built-ins and the caller's views, for any role the module gate admits", async () => {
    for (const user of [OWNER, ADMIN, FAMILY]) {
      const res = await request(makeApp(user)).get("/api/pm/views");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ builtin: [], views: [] });
    }
  });

  it("asks as the person who is asking", async () => {
    await request(makeApp(FAMILY)).get("/api/pm/views?project=p1&workspace=acme");
    const [, person, opts] = svc.listViews.mock.calls[0];
    expect(person).toEqual({ userId: "u-fam", role: "family" });
    expect(opts).toEqual({ project: "p1", workspace: "acme" });
  });

  it("gives the assistant's service principal shared views only (no person)", async () => {
    await request(makeApp(MCP)).get("/api/pm/views");
    expect(svc.listViews.mock.calls[0][1]).toBeNull();
  });

  it("passes `none` through for the cross-project place", async () => {
    await request(makeApp(OWNER)).get("/api/pm/views?project=none");
    expect(svc.listViews.mock.calls[0][2]).toEqual({ project: "none" });
  });

  it("400s a query it does not understand", async () => {
    const res = await request(makeApp(OWNER)).get(`/api/pm/views?project=${"x".repeat(65)}`);
    expect(res.status).toBe(400);
  });
});

describe("writes need a human write role", () => {
  it.each([
    ["POST", "/api/pm/views"],
    ["PATCH", "/api/pm/views/v1"],
    ["DELETE", "/api/pm/views/v1"],
  ] as const)("%s %s: a guest and the service principal get 403", async (method, path) => {
    for (const user of [GUEST, MCP]) {
      const res = await request(makeApp(user))[method.toLowerCase() as "post"](path).send(method === "DELETE" ? undefined : GOOD);
      expect(res.status).toBe(403);
    }
    expect(svc.createView).not.toHaveBeenCalled();
    expect(svc.updateView).not.toHaveBeenCalled();
    expect(svc.deleteView).not.toHaveBeenCalled();
  });

  it.each([OWNER, ADMIN, FAMILY])("owner, admin and family may write", async (user) => {
    expect((await request(makeApp(user)).post("/api/pm/views").send(GOOD)).status).toBe(201);
    expect((await request(makeApp(user)).patch("/api/pm/views/v1").send({ name: "x" })).status).toBe(200);
    expect((await request(makeApp(user)).delete("/api/pm/views/v1")).status).toBe(200);
  });
});

describe("POST /api/pm/views", () => {
  it("returns 201 with the view, and hands the service the person and the validated copy", async () => {
    const res = await request(makeApp(FAMILY)).post("/api/pm/views").send({ ...GOOD, name: "  My bugs  " });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ view: { id: "v1" } });
    const [, actor, input] = svc.createView.mock.calls[0];
    expect(actor).toEqual({ userId: "u-fam", role: "family" });
    expect(input).toMatchObject({ projectId: "p1", scope: "PERSONAL", name: "My bugs", layout: "BOARD" });
  });

  it("accepts a cross-project view (no project), sort, group-by and columns", async () => {
    const res = await request(makeApp(FAMILY))
      .post("/api/pm/views")
      .send({
        ...GOOD,
        projectId: null,
        groupBy: "project",
        sortBy: [{ field: "updatedAt", dir: "desc" }],
        columns: ["key", "state"],
      });
    expect(res.status).toBe(201);
    expect(svc.createView.mock.calls[0][2]).toMatchObject({
      projectId: null,
      groupBy: "project",
      sortBy: [{ field: "updatedAt", dir: "desc" }],
      columns: ["key", "state"],
    });
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["a missing name", { name: undefined }],
    ["a blank name", { name: "   " }],
    ["a name over 60 characters", { name: "x".repeat(61) }],
    ["a missing scope", { scope: undefined }],
    ["a scope that does not exist", { scope: "TEAM" }],
    ["a layout that does not exist", { layout: "GANTT" }],
    ["a missing layout", { layout: undefined }],
    ["a missing filter", { filter: undefined }],
    ["an invalid filter", { filter: { field: "color", op: "is", value: "red" } }],
    ["an unknown key", { owner: "u-other" }],
    ["bad columns", { columns: ["a b"] }],
    ["a bad sort", { sortBy: [{ field: "nope", dir: "asc" }] }],
  ];
  it.each(invalid)("400s %s", async (_name, over) => {
    const res = await request(makeApp(OWNER)).post("/api/pm/views").send({ ...GOOD, ...over });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(svc.createView).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/pm/views/:id", () => {
  it("passes a partial update through, with the view id", async () => {
    const res = await request(makeApp(FAMILY))
      .patch("/api/pm/views/abc")
      .send({ name: "  Renamed ", filter: { and: [] }, groupBy: null });
    expect(res.status).toBe(200);
    const [, , id, patch] = svc.updateView.mock.calls[0];
    expect(id).toBe("abc");
    expect(patch).toEqual({ name: "Renamed", filter: { and: [] }, groupBy: null });
  });

  it("400s an empty patch, a scope change and an unknown key", async () => {
    for (const body of [{}, { scope: "SHARED" }, { projectId: "p2" }, { ownerId: "x" }]) {
      const res = await request(makeApp(OWNER)).patch("/api/pm/views/abc").send(body);
      expect(res.status).toBe(400);
    }
    expect(svc.updateView).not.toHaveBeenCalled();
  });
});

describe("the service's refusals, by name", () => {
  const cases: Array<[string, number]> = [
    ["view_not_found", 404],
    ["project_not_found", 404],
    ["workspace_not_found", 404],
    ["view_forbidden", 403],
    ["view_is_builtin", 409],
    ["view_name_taken", 409],
    ["view_limit_reached", 409],
  ];

  it.each(cases)("%s → %i, on create, update and delete alike", async (code, status) => {
    svc.createView.mockRejectedValue(new Error(code));
    svc.updateView.mockRejectedValue(new Error(code));
    svc.deleteView.mockRejectedValue(new Error(code));
    const app = makeApp(OWNER);
    for (const res of [
      await request(app).post("/api/pm/views").send(GOOD),
      await request(app).patch("/api/pm/views/v1").send({ name: "x" }),
      await request(app).delete("/api/pm/views/v1"),
    ]) {
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: code });
    }
  });

  it("a SERIALIZABLE loser (P2034) is a 409 CONCURRENT_MUTATION, never a 500", async () => {
    svc.createView.mockRejectedValue(Object.assign(new Error("tx"), { code: "P2034" }));
    const res = await request(makeApp(OWNER)).post("/api/pm/views").send(GOOD);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "concurrent_mutation", code: "CONCURRENT_MUTATION" });
  });

  it("an error it does not know is a 500", async () => {
    svc.createView.mockRejectedValue(new Error("boom"));
    expect((await request(makeApp(OWNER)).post("/api/pm/views").send(GOOD)).status).toBe(500);
  });
});

describe("DELETE /api/pm/views/:id", () => {
  it("says what was deleted", async () => {
    const res = await request(makeApp(FAMILY)).delete("/api/pm/views/abc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: "abc" });
    expect(svc.deleteView.mock.calls[0][2]).toBe("abc");
  });
});
