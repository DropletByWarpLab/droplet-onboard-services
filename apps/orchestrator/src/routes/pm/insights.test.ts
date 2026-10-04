/**
 * WARP-3524 — route tests for GET /api/pm/insights.
 *
 * The service is mocked: its numbers are proved against Postgres in
 * `__tests__/pm-insights.pg.test.ts`. What this file pins is the HTTP contract —
 * what the route validates, what it hands the service, how the service's two
 * refusals map to status codes, and that a guest cannot reach it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import { isGuestShared } from "../../modules/guest-shares.js";

const getInsights = vi.fn();
vi.mock("../../services/pm/pm-insights.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/pm/pm-insights.service.js")>()),
  getInsights: (...args: unknown[]) => getInsights(...args),
}));

import { createPmInsightsRouter } from "./insights.js";

function makeApp(user: { id: string; role: string } | null) {
  const app = express();
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
  app.use("/api", createPmInsightsRouter({} as never));
  return app;
}

const BODY = { meta: { scope: "workspace" }, throughput: { total: 0, buckets: [] } };

beforeEach(() => {
  getInsights.mockReset();
  getInsights.mockResolvedValue(BODY);
});

describe("GET /api/pm/insights", () => {
  it("answers { insights } and passes the query through, renaming workspace", async () => {
    const res = await request(makeApp({ id: "u1", role: "member" }))
      .get("/api/pm/insights")
      .query({ projectId: "p-1", from: "2026-09-07", to: "2026-10-04", groupBy: "week" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ insights: BODY });
    expect(getInsights).toHaveBeenCalledWith(expect.anything(), {
      projectId: "p-1",
      workspaceSlug: undefined,
      from: "2026-09-07",
      to: "2026-10-04",
      groupBy: "week",
    });
  });

  it("needs no parameters: the workspace view over the default range", async () => {
    const res = await request(makeApp({ id: "u1", role: "viewer" })).get("/api/pm/insights");
    expect(res.status).toBe(200);
    expect(getInsights).toHaveBeenCalledWith(expect.anything(), {
      projectId: undefined,
      workspaceSlug: undefined,
      from: undefined,
      to: undefined,
      groupBy: undefined,
    });
  });

  it("takes a workspace slug for the workspace view", async () => {
    await request(makeApp({ id: "u1", role: "owner" })).get("/api/pm/insights").query({ workspace: "home" });
    expect(getInsights.mock.calls[0][1]).toMatchObject({ workspaceSlug: "home" });
  });

  it("is open to every role that reaches /api/pm (reads are household-shared)", async () => {
    for (const role of ["owner", "admin", "family", "member", "viewer"]) {
      const res = await request(makeApp({ id: `u-${role}`, role })).get("/api/pm/insights");
      expect(res.status, role).toBe(200);
    }
  });

  it.each([
    ["an unknown bucket size", { groupBy: "year" }],
    ["a malformed date", { from: "07/09/2026" }],
    ["a date that is not on the calendar", { to: "2026-02-30" }],
    ["an empty project id", { projectId: "" }],
    ["a project id over 64 characters", { projectId: "x".repeat(65) }],
  ])("answers 400 for %s, before the service runs", async (_label, query) => {
    const res = await request(makeApp({ id: "u1", role: "owner" })).get("/api/pm/insights").query(query);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(getInsights).not.toHaveBeenCalled();
  });

  it("answers 400 for a parameter given twice rather than guessing which one was meant", async () => {
    const res = await request(makeApp({ id: "u1", role: "owner" })).get("/api/pm/insights?from=2026-09-01&from=2026-09-02");
    expect(res.status).toBe(400);
    expect(getInsights).not.toHaveBeenCalled();
  });

  it("answers 404 project_not_found for an unknown project", async () => {
    getInsights.mockRejectedValue(new Error("project_not_found"));
    const res = await request(makeApp({ id: "u1", role: "owner" })).get("/api/pm/insights").query({ projectId: "nope" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "project_not_found" });
  });

  it("answers 400 invalid_range for a range the service refuses", async () => {
    getInsights.mockRejectedValue(new Error("invalid_range"));
    const res = await request(makeApp({ id: "u1", role: "owner" }))
      .get("/api/pm/insights")
      .query({ from: "2026-10-04", to: "2026-09-07" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_range" });
  });

  it("lets an unexpected failure through to the error handler as a 500", async () => {
    getInsights.mockRejectedValue(new Error("connection terminated"));
    const res = await request(makeApp({ id: "u1", role: "owner" })).get("/api/pm/insights");
    expect(res.status).toBe(500);
  });
});

describe("guests", () => {
  it("are not among the requests an external guest may make inside Projects (WARP-3369)", () => {
    expect(isGuestShared("projects", "GET", "/api/pm/insights")).toBe(false);
    expect(isGuestShared("projects", "GET", "/api/pm/insights/")).toBe(false);
  });
});
