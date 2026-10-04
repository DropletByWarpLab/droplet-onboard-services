/**
 * WARP-3523 — route tests for GET /api/pm/projects/:id/timeline and
 * GET /api/pm/my-work.
 *
 * The service is stubbed (its queries are covered by pm-schedule.service.test.ts
 * and, against a real Postgres, by pm-schedule.pg.test.ts); what is under test
 * here is the HTTP contract: validation, status codes, that the caller's id comes
 * from the session and nowhere else, and that a thrown service code maps to a
 * 404 instead of a 500.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Request, Response, NextFunction } from "express";
import type { AuthUser } from "../../middleware/auth.js";

const getProjectTimeline = vi.fn();
const getMyWork = vi.fn();

vi.mock("../../services/pm/pm-schedule.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/pm/pm-schedule.service.js")>()),
  getProjectTimeline: (...args: unknown[]) => getProjectTimeline(...args),
  getMyWork: (...args: unknown[]) => getMyWork(...args),
}));

import { createPmScheduleRouter } from "./schedule.js";
import { isGuestShared } from "../../modules/guest-shares.js";

function makeApp(user: { id: string; role: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) {
      const u: AuthUser = {
        id: user.id,
        username: user.id,
        displayName: user.id,
        role: user.role as AuthUser["role"],
      };
      (req as Request & { user?: AuthUser }).user = u;
    }
    next();
  });
  app.use("/api", createPmScheduleRouter({} as never));
  // Same terminal handler shape the real app ends with, so an unmapped throw is visible as a 500.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const OWNER = { id: "user-owner", role: "owner" };
const MEMBER = { id: "user-member", role: "member" };

beforeEach(() => {
  getProjectTimeline.mockReset();
  getMyWork.mockReset();
});

describe("GET /api/pm/projects/:id/timeline", () => {
  const ok = {
    from: "2026-10-01",
    to: "2026-10-31",
    items: [],
    relations: [],
    milestones: [],
    unscheduledCount: 0,
    truncated: false,
  };

  it("passes the project id and the validated window to the service and returns its body untouched", async () => {
    getProjectTimeline.mockResolvedValueOnce(ok);
    const res = await request(makeApp(OWNER)).get("/api/pm/projects/p-1/timeline?from=2026-10-01&to=2026-10-31");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ok);
    expect(getProjectTimeline).toHaveBeenCalledWith(expect.anything(), "p-1", { from: "2026-10-01", to: "2026-10-31" });
  });

  it("is a read: a plain member may call it", async () => {
    getProjectTimeline.mockResolvedValueOnce(ok);
    const res = await request(makeApp(MEMBER)).get("/api/pm/projects/p-1/timeline?from=2026-10-01&to=2026-10-31");
    expect(res.status).toBe(200);
  });

  it("accepts a single-day window and the maximum span", async () => {
    getProjectTimeline.mockResolvedValue(ok);
    const app = makeApp(OWNER);
    expect((await request(app).get("/api/pm/projects/p/timeline?from=2026-10-01&to=2026-10-01")).status).toBe(200);
    // 2026-01-01 .. 2029-01-04 is exactly 1100 days inclusive.
    expect((await request(app).get("/api/pm/projects/p/timeline?from=2026-01-01&to=2029-01-04")).status).toBe(200);
  });

  it.each([
    ["no window at all", ""],
    ["missing to", "?from=2026-10-01"],
    ["missing from", "?to=2026-10-31"],
    ["a datetime instead of a date", "?from=2026-10-01T00:00:00Z&to=2026-10-31"],
    ["an impossible date", "?from=2026-02-30&to=2026-03-10"],
    ["a malformed date", "?from=10/01/2026&to=10/31/2026"],
    ["from after to", "?from=2026-10-31&to=2026-10-01"],
    ["a window over 1100 days", "?from=2026-01-01&to=2029-01-05"],
    // These used to reach the database: past year 9999 a date cannot even be converted (a 500).
    ["a year past the calendar", "?from=9999-12-01&to=9999-12-31"],
    ["a year before 1900", "?from=0002-10-01&to=0002-10-31"],
    ["the last day of year 9999", "?from=2026-10-01&to=9999-12-31"],
    ["a repeated parameter", "?from=2026-10-01&from=2026-10-02&to=2026-10-31"],
  ])("400 invalid_request for %s", async (_label, qs) => {
    const res = await request(makeApp(OWNER)).get(`/api/pm/projects/p-1/timeline${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.details).toBeTruthy();
    expect(getProjectTimeline).not.toHaveBeenCalled();
  });

  it("404 project_not_found when the service says so", async () => {
    getProjectTimeline.mockRejectedValueOnce(new Error("project_not_found"));
    const res = await request(makeApp(OWNER)).get("/api/pm/projects/ghost/timeline?from=2026-10-01&to=2026-10-31");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "project_not_found" });
  });

  it("lets an unexpected failure through as a 500, not a 404", async () => {
    getProjectTimeline.mockRejectedValueOnce(new Error("connection reset"));
    const res = await request(makeApp(OWNER)).get("/api/pm/projects/p-1/timeline?from=2026-10-01&to=2026-10-31");
    expect(res.status).toBe(500);
  });
});

describe("GET /api/pm/my-work", () => {
  const ok = {
    section: "assigned",
    today: "2026-10-03",
    items: [],
    projects: [],
    total: 0,
    counts: { assigned: 0, created: 0, overdue: 0, dueThisWeek: 0 },
    limit: 200,
    offset: 0,
    nextOffset: null,
  };

  it("lists for the SESSION user and for nobody else", async () => {
    getMyWork.mockResolvedValueOnce(ok);
    const res = await request(makeApp(MEMBER)).get(
      // A caller trying to name someone else: there is no such parameter, and these are ignored.
      "/api/pm/my-work?section=assigned&today=2026-10-03&user=someone-else&assignee=someone-else&userId=someone-else",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual(ok);
    expect(getMyWork).toHaveBeenCalledTimes(1);
    const [, userId, opts] = getMyWork.mock.calls[0];
    expect(userId).toBe("user-member");
    expect(opts).toEqual({ section: "assigned", today: "2026-10-03", limit: undefined, offset: undefined });
  });

  it("passes limit and offset through as numbers", async () => {
    getMyWork.mockResolvedValueOnce(ok);
    await request(makeApp(OWNER)).get("/api/pm/my-work?section=overdue&today=2026-10-03&limit=50&offset=100");
    expect(getMyWork.mock.calls[0][2]).toEqual({ section: "overdue", today: "2026-10-03", limit: 50, offset: 100 });
  });

  it.each(["assigned", "created", "overdue", "due_this_week"])("accepts section=%s", async (section) => {
    getMyWork.mockResolvedValueOnce(ok);
    const res = await request(makeApp(OWNER)).get(`/api/pm/my-work?section=${section}&today=2026-10-03`);
    expect(res.status).toBe(200);
    expect(getMyWork.mock.calls[0][2].section).toBe(section);
  });

  it("falls back to the server's UTC date when the caller sends no today", async () => {
    getMyWork.mockResolvedValueOnce(ok);
    await request(makeApp(OWNER)).get("/api/pm/my-work?section=assigned");
    expect(getMyWork.mock.calls[0][2].today).toBe(new Date().toISOString().slice(0, 10));
  });

  it.each([
    ["no section", ""],
    ["an unknown section", "?section=mentioned"],
    ["watching (not shipped: it depends on WS-2)", "?section=watching"],
    ["a malformed today", "?section=assigned&today=today"],
    ["an impossible today", "?section=assigned&today=2026-02-30"],
    ["a non-numeric limit", "?section=assigned&limit=abc"],
    ["a zero limit", "?section=assigned&limit=0"],
    ["a limit over the cap", "?section=assigned&limit=501"],
    ["a negative offset", "?section=assigned&offset=-1"],
    ["a fractional offset", "?section=assigned&offset=1.5"],
    ["an offset past any list", "?section=assigned&offset=1000001"],
    ["an offset the database cannot hold", "?section=assigned&offset=1e21"],
    ["a today past the calendar", "?section=assigned&today=9999-12-31"],
    ["a today before 1900", "?section=assigned&today=0002-10-20"],
    ["a non-numeric offset", "?section=assigned&offset=abc"],
  ])("400 invalid_request for %s", async (_label, qs) => {
    const res = await request(makeApp(OWNER)).get(`/api/pm/my-work${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(getMyWork).not.toHaveBeenCalled();
  });

  it("accepts the largest page and the deepest offset", async () => {
    getMyWork.mockResolvedValue(ok);
    const app = makeApp(OWNER);
    expect((await request(app).get("/api/pm/my-work?section=assigned&limit=500")).status).toBe(200);
    expect((await request(app).get("/api/pm/my-work?section=assigned&offset=1000000")).status).toBe(200);
    expect((await request(app).get("/api/pm/my-work?section=assigned&today=2200-12-31")).status).toBe(200);
  });

  it("answers the module-gate 404 when there is no session user", async () => {
    const res = await request(makeApp(null)).get("/api/pm/my-work?section=assigned");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "projects" });
    expect(getMyWork).not.toHaveBeenCalled();
  });

  it("surfaces a service failure as a 500", async () => {
    getMyWork.mockRejectedValueOnce(new Error("db down"));
    const res = await request(makeApp(OWNER)).get("/api/pm/my-work?section=assigned");
    expect(res.status).toBe(500);
  });
});

describe("external guests", () => {
  it("neither read is a guest share, so the projects module floor answers a guest 404 before the route runs", () => {
    // modules/guest-shares.ts lists the ONLY requests a guest may make inside
    // Projects (the one item shared with them). A window of a project's schedule
    // and a cross-project list are not that, and must stay closed by default.
    expect(isGuestShared("projects", "GET", "/api/pm/projects/p-1/timeline")).toBe(false);
    expect(isGuestShared("projects", "GET", "/api/pm/my-work")).toBe(false);
    // Control: the one list a guest does get is still recognised, so the check above can fail.
    expect(isGuestShared("projects", "GET", "/api/pm/assigned-to-me")).toBe(true);
  });
});
