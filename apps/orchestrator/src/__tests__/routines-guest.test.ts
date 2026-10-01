/**
 * WARP-3354 — the guest half (Romain, 2026-09-30: an external guest gets
 * nothing of the company's data unless it is shared with them).
 *
 * A routine's steps and their arguments (file paths, recipients, prompts) and a
 * draft another person asked the assistant to write down are the author's data.
 * The routine sharing model (`ToolSpec.visibility`, the member half) has one
 * share, "with the Workspace" (members), and no per-person share, so nothing
 * is ever "shared" with a guest: they see NO routine, list or detail, and
 * cannot run, share or un-share one, read its runs, or touch its schedules.
 * That is the rule on every `/api/tools*` route (`requireRole("owner","admin",
 * "family")`, and the same set for the person the assistant acts for over
 * MCP), and it is checked BEFORE the visibility filter, so a guest never
 * reaches a routine query. This pins it on all twelve routes (the two share
 * routes included) and on the assistant's path so a widening shows up here
 * first, and pins that the member rule composes with it: a member lists the
 * shared routines plus their own, an owner or admin lists every routine.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { createToolsRouter } from "../routes/tools.js";
import type { StepDispatcher } from "../services/tool-spec-runner.service.js";
import type { AuthUser } from "../middleware/auth.js";
import { userDirectory } from "./helpers/user-directory.js";

const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };

const findMany = vi.fn();
const PEOPLE = [
  { id: "id-guest", username: "gina", nextcloudUsername: "gina", role: "guest" },
  { id: "id-member", username: "marc", nextcloudUsername: "marc", role: "family" },
];

function appAs(user: AuthUser, asserted?: string) {
  const prisma = { user: userDirectory(PEOPLE), toolSpec: { findMany } };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    if (asserted) req.headers["x-nextcloud-user"] = asserted;
    next();
  });
  app.use("/api", createToolsRouter(prisma as never, dispatcher));
  return app;
}

const person = (role: AuthUser["role"]): AuthUser => ({
  id: `u-${role}`,
  username: role,
  displayName: role,
  role,
});
const MCP: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "mcp", role: "service" };

/** Every routine route, as the routers register them. */
const ROUTINE_ROUTES = [
  ["get", "/api/tools"],
  ["get", "/api/tools/some-routine"],
  ["post", "/api/tools"],
  ["patch", "/api/tools/some-routine"],
  ["post", "/api/tools/some-routine/runs"],
  ["get", "/api/tools/some-routine/runs"],
  ["get", "/api/tools/some-routine/schedules"],
  ["post", "/api/tools/some-routine/schedules"],
  ["patch", "/api/tools/some-routine/schedules/s1"],
  ["delete", "/api/tools/some-routine/schedules/s1"],
  // WARP-3354 member half: share and un-share (creator, owner or admin only).
  ["post", "/api/tools/some-routine/share"],
  ["delete", "/api/tools/some-routine/share"],
] as const;

beforeEach(() => {
  findMany.mockReset().mockResolvedValue([]);
});

describe("routines: an external guest sees and touches none of them (WARP-3354)", () => {
  it.each(ROUTINE_ROUTES)("%s %s → 403 for a guest session", async (method, path) => {
    const res = await request(appAs(person("guest")))[method](path).send({});
    expect(res.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("the assistant acting for a guest lists and runs nothing: routine_list and routine_run are 403 for the person behind them", async () => {
    const list = await request(appAs(MCP, "gina")).get("/api/tools");
    expect(list.status).toBe(403);
    const run = await request(appAs(MCP, "gina")).post("/api/tools/some-routine/runs").send({});
    expect(run.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("…and the assistant acting for nobody stays refused", async () => {
    expect((await request(appAs(MCP)).get("/api/tools")).status).toBe(403);
  });

  it("a member (and the assistant acting for one) still lists routines", async () => {
    const own = await request(appAs(person("family"))).get("/api/tools");
    expect(own.status).toBe(200);
    expect(own.body).toEqual({ specs: [] });
    const acting = await request(appAs(MCP, "marc")).get("/api/tools");
    expect(acting.status).toBe(200);
    expect(acting.body).toEqual({ specs: [] });
  });

  it("a member lists the shared routines plus their own; owner and admin list every routine; a guest never reaches the query", async () => {
    await request(appAs(person("family"))).get("/api/tools");
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { visibility: "WORKSPACE" },
      { ownerId: "u-family" },
    ]);

    findMany.mockClear();
    await request(appAs(MCP, "marc")).get("/api/tools");
    expect(findMany.mock.calls[0][0].where.OR).toEqual([
      { visibility: "WORKSPACE" },
      { ownerId: "id-member" },
    ]);

    for (const role of ["owner", "admin"] as const) {
      findMany.mockClear();
      await request(appAs(person(role))).get("/api/tools");
      expect(findMany.mock.calls[0][0].where.OR).toBeUndefined();
    }

    findMany.mockClear();
    await request(appAs(person("guest"))).get("/api/tools");
    await request(appAs(MCP, "gina")).get("/api/tools");
    expect(findMany).not.toHaveBeenCalled();
  });
});
