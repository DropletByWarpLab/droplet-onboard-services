/**
 * WARP-279 — `/api/admin/claude-activity` integration tests.
 *
 * Drives the router directly with a per-test express app so the role-gate
 * is exercised without standing up the full JWT auth pipeline. Two paths:
 *   - non-admin (role = "family") gets 403
 *   - admin (role = "owner") gets 200 with the documented shape
 *
 * WARP-3433: the dashboard ships dark, so these cases switch the developer flag
 * on and give it a GitHub token (the capability needs both); the flag-off and
 * no-token behaviour is pinned in claude-activity.dev-flag.test.ts.
 *
 * The session-state file location is overridden via
 * CLAUDE_SESSION_STATE_PATH so tests don't depend on what's sitting in
 * the repo's .claude/ at the moment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { createAdminClaudeActivityRouter } from "../routes/admin-claude-activity.js";
import type { Role } from "../services/jwt.service.js";

// Stub GitHub + Jira adapters so the route tests stay deterministic and
// don't hit api.github.com / atlassian.net from CI. Each test that needs
// custom data overrides via vi.mocked().
vi.mock("../services/claude-activity/github-adapter.js", () => ({
  getGitHubSnapshot: vi.fn().mockResolvedValue({
    commits: [],
    prs: [],
    ci_runs: [],
  }),
}));

vi.mock("../services/claude-activity/jira-adapter.js", () => ({
  getJiraSnapshot: vi.fn().mockResolvedValue({
    configured: false,
    chain: [],
    in_flight: [],
    chain_progress: {
      total: 0,
      done: 0,
      in_progress: 0,
      blocked: 0,
      not_started: 0,
      percent: 0,
    },
  }),
}));

vi.mock("../services/claude-activity/compliance-parser.js", () => ({
  readComplianceProgress: vi.fn().mockResolvedValue({
    source: "/fake/docs/compliance-progress.md",
    source_mtime_ms: null,
    generated_at: "2026-05-10T18:00:00Z",
    workstreams: [],
    queue: [],
    milestones: [],
    parsed: false,
  }),
}));

function appWith(role: Role) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      id: "test-user",
      username: "test",
      displayName: "Test",
      role,
    };
    next();
  });
  app.use("/api", createAdminClaudeActivityRouter());
  return app;
}

describe("GET /api/admin/claude-activity", () => {
  let dir: string;
  let stateFile: string;
  const originalEnv = process.env.CLAUDE_SESSION_STATE_PATH;
  const originalToken = process.env.GITHUB_TOKEN;
  const cfg = config as unknown as { DROPLET_DEV_ENGINEERING_DASHBOARD: boolean };
  const originalFlag = cfg.DROPLET_DEV_ENGINEERING_DASHBOARD;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "warp-279-route-"));
    stateFile = path.join(dir, "session-state.json");
    process.env.CLAUDE_SESSION_STATE_PATH = stateFile;
    cfg.DROPLET_DEV_ENGINEERING_DASHBOARD = true;
    process.env.GITHUB_TOKEN = "ghp_test";
  });

  afterEach(async () => {
    cfg.DROPLET_DEV_ENGINEERING_DASHBOARD = originalFlag;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_SESSION_STATE_PATH;
    } else {
      process.env.CLAUDE_SESSION_STATE_PATH = originalEnv;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("returns 403 for non-admin roles", async () => {
    const res = await request(appWith("family")).get("/api/admin/claude-activity");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("admin required");
  });

  it("returns 403 for guest role", async () => {
    const res = await request(appWith("guest")).get("/api/admin/claude-activity");
    expect(res.status).toBe(403);
  });

  it("returns 200 for owner role with the documented shape", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({
        v: 1,
        now: {
          task: "Building dashboard",
          ticket: "WARP-279",
          branch: "WARP-279",
          started_at: "2026-05-10T18:00:00Z",
          blocked_on: null,
        },
        decisions: [
          {
            ts: "2026-05-10T17:50:00Z",
            summary: "Picked B",
            rationale: "LAN-only auth",
          },
        ],
        recent_actions: [],
      }),
      "utf8",
    );

    const res = await request(appWith("owner")).get("/api/admin/claude-activity");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      now: {
        task: "Building dashboard",
        ticket: "WARP-279",
      },
      decisions: [
        expect.objectContaining({ summary: "Picked B" }),
      ],
      recent_actions: [],
      github: { commits: [], prs: [], ci_runs: [] },
      jira: {
        configured: false,
        chain: [],
        in_flight: [],
      },
      compliance: { parsed: false, workstreams: [], queue: [], milestones: [] },
    });
    expect(typeof res.body.generated_at).toBe("string");
    expect(res.headers["last-modified"]).toBeTruthy();
  });

  it("returns 200 for admin role with the empty default when no state file exists", async () => {
    // No file written — reader returns the empty default.
    const res = await request(appWith("admin")).get("/api/admin/claude-activity");
    expect(res.status).toBe(200);
    expect(res.body.now).toEqual({
      task: "",
      ticket: null,
      branch: null,
      started_at: null,
      blocked_on: null,
    });
    expect(res.body.decisions).toEqual([]);
    expect(res.body.recent_actions).toEqual([]);
  });

  it("returns 304 when If-Modified-Since is at-or-after Last-Modified", async () => {
    await writeFile(
      stateFile,
      JSON.stringify({
        v: 1,
        now: {
          task: "x",
          ticket: null,
          branch: null,
          started_at: "2026-05-10T18:00:00Z",
          blocked_on: null,
        },
        decisions: [],
        recent_actions: [],
      }),
      "utf8",
    );

    // First request — get Last-Modified.
    const first = await request(appWith("owner")).get("/api/admin/claude-activity");
    expect(first.status).toBe(200);
    const lm = first.headers["last-modified"];
    expect(lm).toBeTruthy();

    // Second request — pass it back as If-Modified-Since. Should 304.
    const second = await request(appWith("owner"))
      .get("/api/admin/claude-activity")
      .set("If-Modified-Since", lm);
    expect(second.status).toBe(304);
  });
});
