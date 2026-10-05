import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import type { AuthUser } from "../../middleware/auth.js";

vi.mock("../../services/pm/pm-development.service.js", () => ({
  connectDevelopmentRepository: vi.fn(),
  listConfiguredDevelopmentRepositories: vi.fn(),
  listDevelopmentRepositories: vi.fn(),
  listWorkItemDevelopment: vi.fn(),
  mapDevelopmentRepository: vi.fn(),
  removeDevelopmentRepository: vi.fn(),
}));

import { createPmDevelopmentRouter } from "./development.js";
import * as service from "../../services/pm/pm-development.service.js";

const OWNER: AuthUser = { id: "owner-1", username: "olga", displayName: "Olga", role: "owner" };
const ADMIN: AuthUser = { ...OWNER, id: "admin-1", role: "admin" };
const MEMBER: AuthUser = { ...OWNER, id: "member-1", role: "family" };
const GUEST: AuthUser = { ...OWNER, id: "guest-1", role: "guest" };

function app(user: AuthUser, prisma: object = {}) {
  const server = express();
  server.use(express.json());
  server.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  server.use("/api", createPmDevelopmentRouter(prisma as never));
  server.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(err) }));
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(service.listDevelopmentRepositories).mockResolvedValue({ status: "ok", items: [], etag: null, truncated: false, skipped: 0, rateLimit: null });
  vi.mocked(service.listWorkItemDevelopment).mockResolvedValue([]);
  vi.mocked(service.listConfiguredDevelopmentRepositories).mockResolvedValue([]);
});

describe("WARP-3535 development routes", () => {
  it.each([OWNER, ADMIN])("limits repository administration to owner/admin", async (user) => {
    const res = await request(app(user)).get("/api/pm/development/repositories/github/available");
    expect(res.status).toBe(200);
    expect(service.listDevelopmentRepositories).toHaveBeenCalledWith({}, "github");
  });

  it("refuses a member before touching the integration connection", async () => {
    const res = await request(app(MEMBER)).get("/api/pm/development/repositories/github/available");
    expect(res.status).toBe(403);
    expect(service.listDevelopmentRepositories).not.toHaveBeenCalled();
  });

  it("does not let a guest read development links for an unassigned item", async () => {
    const prisma = { pmWorkItemAssignee: { findFirst: vi.fn().mockResolvedValue(null) } };
    const res = await request(app(GUEST, prisma)).get("/api/pm/work-items/item-1/development");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "projects" });
    expect(service.listWorkItemDevelopment).not.toHaveBeenCalled();
  });

  it("returns only the selected work item's links to an assigned guest", async () => {
    const prisma = { pmWorkItemAssignee: { findFirst: vi.fn().mockResolvedValue({ id: "assignment-1" }) } };
    vi.mocked(service.listWorkItemDevelopment).mockResolvedValue([{ id: "link-1" }] as never);
    const res = await request(app(GUEST, prisma)).get("/api/pm/work-items/item-1/development");
    expect(res.status).toBe(200);
    expect(res.body.links).toEqual([{ id: "link-1" }]);
    expect(service.listWorkItemDevelopment).toHaveBeenCalledWith(prisma, "item-1");
  });

  it("rejects malformed provider and mapping bodies", async () => {
    const server = app(OWNER, { pmDevRepository: { findUnique: vi.fn() } });
    expect((await request(server).get("/api/pm/development/repositories/bitbucket/available")).status).toBe(404);
    expect((await request(server).post("/api/pm/development/repositories/github").send({})).status).toBe(400);
    expect(service.connectDevelopmentRepository).not.toHaveBeenCalled();
  });

  it("returns 404 when the selected work item has no development scope", async () => {
    vi.mocked(service.listWorkItemDevelopment).mockRejectedValue(new Error("work_item_not_found"));
    const res = await request(app(MEMBER)).get("/api/pm/work-items/missing-item/development");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "work_item_not_found" });
  });
});
