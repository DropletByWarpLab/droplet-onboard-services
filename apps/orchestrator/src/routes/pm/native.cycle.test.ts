/**
 * WARP-3521 — `cycle_id` on the work-item create and patch routes.
 *
 * Its own file for the reason native.department-filter.test.ts gives: the
 * shared in-memory Prisma fake in native.test.ts has no cycle model, and four
 * cases are not worth teaching it one. The service is mocked — what the route
 * layer alone can get wrong is the wire shape (`cycle_id` → `cycleId`, with
 * absent / null / id meaning three different things) and the status each of the
 * three cycle codes leaves as.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import * as pm from "../../services/pm/pm.service.js";
import { createPmNativeRouter } from "./native.js";

vi.mock("../../services/pm/pm.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/pm/pm.service.js")>();
  return { ...actual, createWorkItem: vi.fn(), updateWorkItem: vi.fn() };
});

function makeApp(user: { id: string; role: string }) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: AuthUser }).user = {
      id: user.id,
      username: user.id,
      displayName: user.id,
      role: user.role as AuthUser["role"],
    };
    next();
  });
  app.use("/api", createPmNativeRouter({} as never));
  return app;
}

const OWNER = { id: "user-owner", role: "owner" };
const GUEST = { id: "user-guest", role: "guest" };
const created = vi.mocked(pm.createWorkItem);
const updated = vi.mocked(pm.updateWorkItem);

beforeEach(() => {
  vi.clearAllMocks();
  created.mockResolvedValue({ id: "w1" } as never);
  updated.mockResolvedValue({ id: "w1" } as never);
});

describe("POST /api/pm/projects/:id/work-items — cycle_id", () => {
  it("passes a cycle id through as cycleId", async () => {
    const res = await request(makeApp(OWNER))
      .post("/api/pm/projects/p1/work-items")
      .send({ name: "x", cycle_id: "cy-1" });
    expect(res.status).toBe(201);
    expect(created.mock.calls[0][3]).toMatchObject({ cycleId: "cy-1" });
  });

  it("absent means absent", async () => {
    await request(makeApp(OWNER)).post("/api/pm/projects/p1/work-items").send({ name: "x" });
    expect(created.mock.calls[0][3].cycleId).toBeUndefined();
  });

  it("an empty string is a 400, not a falsy skip", async () => {
    const res = await request(makeApp(OWNER))
      .post("/api/pm/projects/p1/work-items")
      .send({ name: "x", cycle_id: "" });
    expect(res.status).toBe(400);
    expect(created).not.toHaveBeenCalled();
  });

  it("null is not a thing on create — there is nothing to take the item out of", async () => {
    const res = await request(makeApp(OWNER))
      .post("/api/pm/projects/p1/work-items")
      .send({ name: "x", cycle_id: null });
    expect(res.status).toBe(400);
  });

  it.each([
    ["cycle_not_found", 404],
    ["invalid_cycle", 422],
    ["cycle_completed", 409],
  ])("%s → %i", async (code, status) => {
    created.mockRejectedValue(new Error(code));
    const res = await request(makeApp(OWNER))
      .post("/api/pm/projects/p1/work-items")
      .send({ name: "x", cycle_id: "cy-1" });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });
});

describe("PATCH /api/pm/work-items/:id — cycle_id", () => {
  it("an id plans the item into that cycle", async () => {
    const res = await request(makeApp(OWNER)).patch("/api/pm/work-items/w1").send({ cycle_id: "cy-1" });
    expect(res.status).toBe(200);
    expect(updated.mock.calls[0][3]).toMatchObject({ cycleId: "cy-1" });
  });

  it("null takes the item out of its cycle", async () => {
    await request(makeApp(OWNER)).patch("/api/pm/work-items/w1").send({ cycle_id: null });
    expect(updated.mock.calls[0][3].cycleId).toBeNull();
  });

  it("absent leaves the cycle alone", async () => {
    await request(makeApp(OWNER)).patch("/api/pm/work-items/w1").send({ name: "renamed" });
    expect(updated.mock.calls[0][3].cycleId).toBeUndefined();
  });

  it("an empty string is a 400", async () => {
    const res = await request(makeApp(OWNER)).patch("/api/pm/work-items/w1").send({ cycle_id: "" });
    expect(res.status).toBe(400);
    expect(updated).not.toHaveBeenCalled();
  });

  it.each([
    ["cycle_not_found", 404],
    ["invalid_cycle", 422],
    ["cycle_completed", 409],
  ])("%s → %i", async (code, status) => {
    updated.mockRejectedValue(new Error(code));
    const res = await request(makeApp(OWNER)).patch("/api/pm/work-items/w1").send({ cycle_id: "cy-1" });
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  it("a guest still cannot patch — planning adds no back door", async () => {
    const res = await request(makeApp(GUEST)).patch("/api/pm/work-items/w1").send({ cycle_id: "cy-1" });
    expect(res.status).toBe(403);
    expect(updated).not.toHaveBeenCalled();
  });
});
