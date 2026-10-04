/**
 * WARP-3520 — the ROUTE layer of routes/pm/fields.ts: who may define fields and
 * who may set values, strict bodies, and the status/shape of every error.
 *
 * The service is mocked (its real error vocabulary kept), because what is under
 * test is the HTTP contract; the service against a real database is proven in
 * src/__tests__/pm-custom-properties.pg.test.ts. The REAL requireRole guards run
 * behind a stub auth middleware that sets `req.user` per test, and a two-method
 * Prisma stub answers the one question the router itself asks: who leads this
 * project.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";

const svc = vi.hoisted(() => ({
  listProperties: vi.fn(),
  createProperty: vi.fn(),
  updateProperty: vi.fn(),
  deleteProperty: vi.fn(),
  reorderProperties: vi.fn(),
  setPropertyValue: vi.fn(),
  clearPropertyValue: vi.fn(),
}));

vi.mock("../../services/pm/pm-properties.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/pm/pm-properties.service.js")>()),
  ...svc,
}));

import { PropertyValueError } from "../../services/pm/pm-properties.service.js";
import { createPmFieldsRouter } from "./fields.js";

const projectLead = vi.fn();
const propertyLead = vi.fn();
const prisma = {
  pmProject: { findUnique: projectLead },
  pmCustomProperty: { findUnique: propertyLead },
};

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
  app.use("/api", createPmFieldsRouter(prisma as never));
  return app;
}

const OWNER = { id: "u-owner", role: "owner" };
const ADMIN = { id: "u-admin", role: "admin" };
const LEAD = { id: "u-lead", role: "family" };
const FAMILY = { id: "u-family", role: "family" };
const GUEST = { id: "u-guest", role: "guest" };
const MCP = { id: "_service:mcp", role: "service" };

beforeEach(() => {
  for (const fn of [...Object.values(svc), projectLead, propertyLead]) fn.mockReset();
  svc.listProperties.mockResolvedValue([]);
  svc.createProperty.mockResolvedValue({ id: "f1" });
  svc.updateProperty.mockResolvedValue({ id: "f1" });
  svc.deleteProperty.mockResolvedValue(undefined);
  svc.reorderProperties.mockResolvedValue([]);
  svc.setPropertyValue.mockResolvedValue({ id: "w1" });
  svc.clearPropertyValue.mockResolvedValue({ id: "w1" });
  projectLead.mockResolvedValue({ leadId: LEAD.id });
  propertyLead.mockResolvedValue({ project: { leadId: LEAD.id } });
});

const CREATE = { name: "Severity", type: "select", options: [{ label: "Low" }] };

/** The four definition writes, each as a request factory. */
const DEFINITION_WRITES: Array<[string, (app: express.Express) => request.Test, number]> = [
  ["create", (app) => request(app).post("/api/pm/projects/p1/properties").send(CREATE), 201],
  ["patch", (app) => request(app).patch("/api/pm/properties/f1").send({ name: "Renamed" }), 200],
  ["delete", (app) => request(app).delete("/api/pm/properties/f1"), 200],
  [
    "reorder",
    (app) => request(app).post("/api/pm/projects/p1/properties/reorder").send({ property_ids: ["f1"] }),
    200,
  ],
];

describe.each(DEFINITION_WRITES)("defining fields — %s", (_name, call, okStatus) => {
  it.each([OWNER, ADMIN])("admits $role without asking who leads the project", async (user) => {
    expect((await call(makeApp(user))).status).toBe(okStatus);
    expect(projectLead).not.toHaveBeenCalled();
    expect(propertyLead).not.toHaveBeenCalled();
  });

  it("admits a family user ONLY as the project's lead", async () => {
    expect((await call(makeApp(LEAD))).status).toBe(okStatus);
    const refused = await call(makeApp(FAMILY));
    expect(refused.status).toBe(403);
    expect(refused.body).toEqual({ error: "Forbidden: role not permitted" });
  });

  it("refuses a family user when the project has no lead at all", async () => {
    projectLead.mockResolvedValue({ leadId: null });
    propertyLead.mockResolvedValue({ project: { leadId: null } });
    expect((await call(makeApp(FAMILY))).status).toBe(403);
  });

  it.each([GUEST, MCP, null])("refuses %o with 403 before looking anything up", async (user) => {
    expect((await call(makeApp(user))).status).toBe(403);
    expect(projectLead).not.toHaveBeenCalled();
    expect(propertyLead).not.toHaveBeenCalled();
  });

  it("is a 404 — not a 403 — for a family user when the project / field does not exist", async () => {
    projectLead.mockResolvedValue(null);
    propertyLead.mockResolvedValue(null);
    expect((await call(makeApp(FAMILY))).status).toBe(404);
  });
});

describe("reads", () => {
  it("lists a project's fields for any role that reaches the router", async () => {
    svc.listProperties.mockResolvedValue([{ id: "f1" }]);
    for (const user of [OWNER, FAMILY, GUEST]) {
      const res = await request(makeApp(user)).get("/api/pm/projects/p1/properties");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ properties: [{ id: "f1" }] });
    }
  });

  it("maps a missing project to 404", async () => {
    svc.listProperties.mockRejectedValue(new Error("project_not_found"));
    expect((await request(makeApp(OWNER)).get("/api/pm/projects/p1/properties")).status).toBe(404);
  });
});

describe("definition bodies are strict", () => {
  const post = (body: unknown) => request(makeApp(OWNER)).post("/api/pm/projects/p1/properties").send(body as object);
  const patch = (body: unknown) => request(makeApp(OWNER)).patch("/api/pm/properties/f1").send(body as object);

  it("creates with a trimmed name and passes options through", async () => {
    const res = await post({ name: "  Severity ", type: "select", options: [{ label: " Low ", color: "#ef4444" }] });
    expect(res.status).toBe(201);
    expect(svc.createProperty).toHaveBeenCalledWith(prisma, "p1", {
      name: "Severity",
      type: "select",
      options: [{ label: "Low", color: "#ef4444" }],
    });
  });

  it.each([
    ["no name", { type: "text" }],
    ["an empty name", { name: "  ", type: "text" }],
    ["a name over 60 characters", { name: "x".repeat(61), type: "text" }],
    ["an unknown type", { name: "A", type: "rating" }],
    ["an unknown key", { name: "A", type: "text", color: "red" }],
    ["an empty option label", { name: "A", type: "select", options: [{ label: " " }] }],
    ["more than 50 options", { name: "A", type: "select", options: Array.from({ length: 51 }, (_, i) => ({ label: `o${i}` })) }],
    ["an unknown option key", { name: "A", type: "select", options: [{ label: "x", weight: 2 }] }],
  ])("refuses create with %s", async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(svc.createProperty).not.toHaveBeenCalled();
  });

  it("makes the type immutable: a patch that names it is a 400, not a silent no-op", async () => {
    const res = await patch({ type: "number" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(svc.updateProperty).not.toHaveBeenCalled();
  });

  it("passes name, options and sort_order through a patch", async () => {
    await patch({ name: "Priority", options: [{ id: "o1", label: "Low" }], sort_order: 3 });
    expect(svc.updateProperty).toHaveBeenCalledWith(prisma, OWNER.id, "f1", {
      name: "Priority",
      options: [{ id: "o1", label: "Low" }],
      sortOrder: 3,
    });
  });

  it.each([{ sort_order: -1 }, { sort_order: 1.5 }, { sort_order: 10000 }, { nope: 1 }])(
    "refuses the patch %o",
    async (body) => {
      expect((await patch(body)).status).toBe(400);
    },
  );

  it.each([{}, { property_ids: [] }, { property_ids: [3] }, { property_ids: "f1" }])(
    "refuses the reorder body %o",
    async (body) => {
      expect((await request(makeApp(OWNER)).post("/api/pm/projects/p1/properties/reorder").send(body)).status).toBe(400);
    },
  );
});

describe("service errors map to HTTP", () => {
  const create = () => request(makeApp(OWNER)).post("/api/pm/projects/p1/properties").send(CREATE);

  it.each([
    ["property_not_found", 404],
    ["project_not_found", 404],
    ["work_item_not_found", 404],
    ["property_name_taken", 409],
    ["property_limit_reached", 409],
    ["invalid_options", 422],
    ["invalid_order", 422],
  ])("%s -> %i", async (code, status) => {
    svc.createProperty.mockRejectedValue(new Error(code));
    const res = await create();
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  it("leaves an unknown failure to the global handler (500), never a leaked message", async () => {
    svc.createProperty.mockRejectedValue(new Error("connection reset"));
    const res = await create();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("connection reset");
  });
});

describe("values", () => {
  const put = (body: unknown, user = OWNER) =>
    request(makeApp(user)).put("/api/pm/work-items/w1/properties/f1").send(body as object);

  it.each([OWNER, ADMIN, FAMILY])("lets $role set and clear a value (no lead needed)", async (user) => {
    const set = await put({ value: { number: 3 } }, user);
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ work_item: { id: "w1" } });
    expect(svc.setPropertyValue).toHaveBeenLastCalledWith(prisma, user.id, "w1", "f1", { number: 3 });

    const cleared = await request(makeApp(user)).delete("/api/pm/work-items/w1/properties/f1");
    expect(cleared.status).toBe(200);
    expect(svc.clearPropertyValue).toHaveBeenLastCalledWith(prisma, user.id, "w1", "f1");
    expect(projectLead).not.toHaveBeenCalled();
  });

  it.each([GUEST, MCP, null])("refuses %o on both value writes", async (user) => {
    expect((await put({ value: { number: 3 } }, user as never)).status).toBe(403);
    expect((await request(makeApp(user)).delete("/api/pm/work-items/w1/properties/f1")).status).toBe(403);
    expect(svc.setPropertyValue).not.toHaveBeenCalled();
    expect(svc.clearPropertyValue).not.toHaveBeenCalled();
  });

  it.each([{}, { value: "3" }, { value: [1] }, { value: null }, { value: { number: 3 }, extra: true }])(
    "refuses the body %o before the service sees it",
    async (body) => {
      expect((await put(body)).status).toBe(400);
      expect(svc.setPropertyValue).not.toHaveBeenCalled();
    },
  );

  it("answers a rejected value with the sentence under details.fieldErrors.value", async () => {
    svc.setPropertyValue.mockRejectedValue(new PropertyValueError("Pick one of this field's options."));
    const res = await put({ value: { optionIds: ["nope"] } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "invalid_value",
      details: { formErrors: [], fieldErrors: { value: ["Pick one of this field's options."] } },
    });
  });

  it("is a 404 for a missing item or field", async () => {
    for (const code of ["work_item_not_found", "property_not_found"]) {
      svc.setPropertyValue.mockRejectedValue(new Error(code));
      expect((await put({ value: { number: 1 } })).status).toBe(404);
    }
  });
});
