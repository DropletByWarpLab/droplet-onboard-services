/**
 * WARP-3522 — the HTTP face of the query API: validation, the `me` principal,
 * status codes. What the endpoint RETURNS is proven against Postgres in
 * `__tests__/pm-filter-query.pg.test.ts`; here the service is a stub, so these
 * tests are about what the route lets through and what it says when the
 * service refuses.
 *
 * The guest refusal is not asserted here. It is the `projects` module's tier
 * floor, and `__tests__/guest-company-data.test.ts` probes this router's routes
 * through the real mount.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import type { AuthUser } from "../../middleware/auth.js";

const svc = vi.hoisted(() => ({ queryWorkItems: vi.fn(), findWorkItemByKey: vi.fn() }));
vi.mock("../../services/pm/filter/query.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/pm/filter/query.js")>();
  return { ...actual, queryWorkItems: svc.queryWorkItems, findWorkItemByKey: svc.findWorkItemByKey };
});

import { createPmQueryRouter } from "./query.js";

const OWNER = { id: "u-owner", role: "owner" };
const FAMILY = { id: "u-fam", role: "family" };
const MCP = { id: "_service:mcp", role: "service" };

function makeApp(user: { id: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = { ...user, username: user.id, displayName: user.id, role: user.role as AuthUser["role"] } as AuthUser;
    next();
  });
  app.use("/api", createPmQueryRouter({} as never));
  return app;
}

const RESULT = { work_items: [], nextCursor: null, total: 0 };

beforeEach(() => {
  svc.queryWorkItems.mockReset().mockResolvedValue(RESULT);
  svc.findWorkItemByKey.mockReset();
});

describe("POST /api/pm/work-items/query", () => {
  it("passes a valid body to the service and returns what it returns", async () => {
    const res = await request(makeApp(FAMILY))
      .post("/api/pm/work-items/query")
      .send({
        projectId: "p1",
        filter: { and: [{ field: "assignee", op: "is", value: "me" }] },
        sort: [{ field: "dueDate", dir: "asc" }],
        groupBy: "state",
        limit: 50,
        tz: "Europe/London",
        counts: { mine: { field: "assignee", op: "is", value: "me" } },
      });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(RESULT);
    expect(svc.queryWorkItems).toHaveBeenCalledTimes(1);
    const [, actor, body] = svc.queryWorkItems.mock.calls[0];
    expect(actor).toEqual({ userId: "u-fam" });
    expect(body).toMatchObject({
      projectId: "p1",
      filter: { and: [{ field: "assignee", op: "is", value: "me" }] },
      sort: [{ field: "dueDate", dir: "asc" }],
      groupBy: "state",
      limit: 50,
      tz: "Europe/London",
      counts: { mine: { field: "assignee", op: "is", value: "me" } },
    });
  });

  it("accepts an empty body: the whole workspace, no filter", async () => {
    const res = await request(makeApp(OWNER)).post("/api/pm/work-items/query").send({});
    expect(res.status).toBe(200);
    expect(svc.queryWorkItems.mock.calls[0][2]).toEqual({});
  });

  it("hands the service the validated COPY of the filter, not the raw body", async () => {
    await request(makeApp(OWNER))
      .post("/api/pm/work-items/query")
      .send({ filter: { and: [{ field: "text", op: "contains", value: "  login  " }] } });
    expect(svc.queryWorkItems.mock.calls[0][2].filter).toEqual({
      and: [{ field: "text", op: "contains", value: "login" }],
    });
  });

  it("gives the assistant's service principal no `me`", async () => {
    await request(makeApp(MCP)).post("/api/pm/work-items/query").send({});
    expect(svc.queryWorkItems.mock.calls[0][1]).toEqual({ userId: null });
  });

  const invalid: Array<[string, unknown]> = [
    ["an unknown key (a typo must not be a silent no-op)", { groupby: "state" }],
    ["a filter with an unknown field", { filter: { field: "color", op: "is", value: "red" } }],
    ["a filter an op does not fit", { filter: { field: "priority", op: "before", value: "today" } }],
    ["an empty `or`", { filter: { or: [] } }],
    ["a sort field that does not exist", { sort: [{ field: "estimate", dir: "asc" }] }],
    ["a repeated sort field", { sort: [{ field: "name", dir: "asc" }, { field: "name", dir: "desc" }] }],
    ["a group-by that does not exist", { groupBy: "estimate" }],
    ["a limit over the cap", { limit: 501 }],
    ["a negative limit", { limit: -1 }],
    ["a fractional limit", { limit: 1.5 }],
    ["a string limit", { limit: "50" }],
    ["a cursor over 512 characters", { cursor: "x".repeat(513) }],
    ["an empty cursor", { cursor: "" }],
    ["a project id that is not a string", { projectId: 7 }],
    ["more counts than the cap", { counts: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, { and: [] }])) }],
    ["a count with a bad filter", { counts: { x: { field: "nope" } } }],
    ["an over-long count name", { counts: { ["x".repeat(41)]: { and: [] } } }],
  ];
  it.each(invalid)("400s %s", async (_name, body) => {
    const res = await request(makeApp(OWNER)).post("/api/pm/work-items/query").send(body as object);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(svc.queryWorkItems).not.toHaveBeenCalled();
  });

  it("names the offending path in the 400", async () => {
    const res = await request(makeApp(OWNER))
      .post("/api/pm/work-items/query")
      .send({ filter: { and: [{ field: "priority", op: "is", value: "critical" }] } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details)).toContain("filter_value_invalid");
  });

  it("400s a deeply nested filter without blowing the stack", async () => {
    // Built as text: superagent's own serializer overflows on a deep OBJECT, and
    // the point is what the SERVER does with a body this shape.
    const depth = 4000;
    const body =
      '{"filter":' +
      '{"and":['.repeat(depth) +
      '{"field":"priority","op":"is","value":"low"}' +
      "]}".repeat(depth) +
      "}";
    const res = await request(makeApp(OWNER))
      .post("/api/pm/work-items/query")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(400);
    expect(svc.queryWorkItems).not.toHaveBeenCalled();
  });

  const mapped: Array<[string, number]> = [
    ["project_not_found", 404],
    ["invalid_filter", 400],
    ["invalid_cursor", 400],
    ["invalid_timezone", 400],
    ["me_unavailable", 422],
  ];
  it.each(mapped)("maps the service's %s to %i", async (code, status) => {
    svc.queryWorkItems.mockRejectedValue(new Error(code));
    const res = await request(makeApp(OWNER)).post("/api/pm/work-items/query").send({});
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: code });
  });

  it("lets an error it does not know about be a 500, not a mapped answer", async () => {
    svc.queryWorkItems.mockRejectedValue(new Error("department_unresolved"));
    const res = await request(makeApp(OWNER)).post("/api/pm/work-items/query").send({});
    expect(res.status).toBe(500);
  });
});

describe("GET /api/pm/work-items/by-key/:key", () => {
  it("returns the work item", async () => {
    svc.findWorkItemByKey.mockResolvedValue({ id: "w1", key: "INBOX-42" });
    const res = await request(makeApp(FAMILY)).get("/api/pm/work-items/by-key/INBOX-42");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ work_item: { id: "w1", key: "INBOX-42" } });
    expect(svc.findWorkItemByKey.mock.calls[0].slice(1)).toEqual(["INBOX-42", undefined]);
  });

  it("passes a workspace through", async () => {
    svc.findWorkItemByKey.mockResolvedValue({ id: "w1" });
    await request(makeApp(FAMILY)).get("/api/pm/work-items/by-key/INBOX-42?workspace=acme");
    expect(svc.findWorkItemByKey.mock.calls[0].slice(1)).toEqual(["INBOX-42", "acme"]);
  });

  it("404s a key nothing answers to", async () => {
    svc.findWorkItemByKey.mockRejectedValue(new Error("work_item_not_found"));
    const res = await request(makeApp(FAMILY)).get("/api/pm/work-items/by-key/NOPE-1");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "work_item_not_found" });
  });
});
