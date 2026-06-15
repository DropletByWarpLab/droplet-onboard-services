/**
 * RBAC guard for POST /api/pm/onboard.
 *
 * The onboard handler creates Plane workspaces/projects through Plane's
 * privileged admin token and returns the Plane admin credentials, so it
 * must be owner/admin only (WARP-860). This test pins that contract:
 *
 *   - a guest / family session is rejected with 403 by `requireRole`,
 *     BEFORE the handler can touch the bootstrap service;
 *   - an owner session passes the guard and reaches the handler.
 *
 * The router is mounted the way app.ts does (createPmOnboardRouter()),
 * with a tiny upstream middleware that injects `req.user` — the same
 * shape `authMiddleware` produces. `pm-bootstrap.service` is mocked so
 * the owner path never makes a real network call; the assertion is only
 * that the owner gets PAST the guard (not 403).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: {
    DROPLET_PM_WEB_URL: "http://pm.test",
  },
}));

// Mock the bootstrap service so the owner (allowed) path resolves without
// any real Plane I/O. `planeAppApi` is driven so the lookup-or-create flow
// finds nothing, creates a workspace + project, and returns 200.
vi.mock("../services/pm-bootstrap.service.js", () => {
  class PmBootstrapError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "PmBootstrapError";
      this.code = code;
    }
  }
  return {
    PmBootstrapError,
    ensureInstanceSetup: vi.fn().mockResolvedValue(undefined),
    getAppSessionCookie: vi.fn().mockResolvedValue("session-id=abc"),
    planeAdminEmail: vi.fn(() => "admin@pm.test"),
    planeAdminPassword: vi.fn(() => "pw"),
    planeAppApi: vi.fn(async (path: string, _cookie: string, opts?: { method?: string }) => {
      // GET workspace list → empty (force create).
      if (path === "/api/users/me/workspaces/" && !opts?.method) {
        return { status: 200, body: [] };
      }
      // POST create workspace.
      if (path === "/api/workspaces/" && opts?.method === "POST") {
        return { status: 201, body: { id: "ws1", slug: "home", name: "Home" } };
      }
      // GET project list → empty (force create).
      if (path.endsWith("/projects/") && !opts?.method) {
        return { status: 200, body: [] };
      }
      // POST create project.
      if (path.endsWith("/projects/") && opts?.method === "POST") {
        return { status: 201, body: { id: "p1", name: "Inbox", identifier: "INBOX" } };
      }
      // completeAdminOnboarding PATCHes — best-effort, value unused.
      return { status: 200, body: {} };
    }),
  };
});

import { createPmOnboardRouter } from "../routes/pm-onboard.js";

type Role = "owner" | "admin" | "family" | "guest" | "service";

function makeApp(role: Role | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (role) {
      (req as unknown as { user: unknown }).user = {
        id: "u1",
        username: "u1",
        displayName: "U1",
        role,
      };
    }
    next();
  });
  app.use(createPmOnboardRouter());
  return app;
}

describe("POST /api/pm/onboard RBAC", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a guest session with 403", async () => {
    const res = await request(makeApp("guest"))
      .post("/api/pm/onboard")
      .send({ workspace_name: "Home", project_name: "Inbox" });

    expect(res.status).toBe(403);
  });

  it("rejects a family session with 403", async () => {
    const res = await request(makeApp("family"))
      .post("/api/pm/onboard")
      .send({ workspace_name: "Home", project_name: "Inbox" });

    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request with 403", async () => {
    const res = await request(makeApp(null))
      .post("/api/pm/onboard")
      .send({ workspace_name: "Home", project_name: "Inbox" });

    expect(res.status).toBe(403);
  });

  it("lets an owner through the guard (not 403) and onboards", async () => {
    const res = await request(makeApp("owner"))
      .post("/api/pm/onboard")
      .send({ workspace_name: "Home", project_name: "Inbox" });

    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(res.body.workspace).toMatchObject({ slug: "home" });
    expect(res.body.project).toMatchObject({ id: "p1" });
  });

  it("lets an admin through the guard (not 403)", async () => {
    const res = await request(makeApp("admin"))
      .post("/api/pm/onboard")
      .send({ workspace_name: "Home", project_name: "Inbox" });

    expect(res.status).not.toBe(403);
  });
});
