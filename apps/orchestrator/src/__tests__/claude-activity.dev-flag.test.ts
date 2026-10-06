/**
 * WARP-3433 — Warp Lab's engineering dashboard ships dark.
 *
 * `/admin/claude-activity` is the lab's own tooling (the AI engineer's session
 * notes, GitHub PRs and CI, WARP Jira tickets), not a customer feature. Without
 * the explicit developer flag DROPLET_DEV_ENGINEERING_DASHBOARD the box must
 * behave as if it did not exist, and above all must never dial GitHub or Jira.
 *
 * Unlike admin-claude-activity.test.ts these cases do NOT stub the adapters:
 * the real ones run against a spy on global `fetch`, so "zero calls" is a
 * statement about the actual outbound path, not about a mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../config.js";
import { createAdminCapabilitiesRouter } from "../routes/admin-capabilities.js";
import { createAdminClaudeActivityRouter } from "../routes/admin-claude-activity.js";

const cfg = config as unknown as {
  DROPLET_DEV_ENGINEERING_DASHBOARD: boolean;
  JIRA_HOST: string;
  JIRA_EMAIL: string;
  JIRA_API_TOKEN: string;
};
const SAVED = { ...cfg };
const SAVED_TOKEN = process.env.GITHUB_TOKEN;
const SAVED_STATE_PATH = process.env.CLAUDE_SESSION_STATE_PATH;

const fetchSpy = vi.fn();

function app() {
  const a = express();
  a.use((req, _res, next) => {
    req.user = { id: "u1", username: "owner", displayName: "Owner", role: "owner" };
    next();
  });
  // Mounted unconditionally here: the handler's own capability gate is what
  // is under test. The app.ts flag gate is pinned as source, below.
  a.use("/api", createAdminClaudeActivityRouter());
  a.use("/api", createAdminCapabilitiesRouter());
  return a;
}

const urlsFetched = () => fetchSpy.mock.calls.map(([u]) => String(u));

beforeEach(() => {
  fetchSpy.mockReset();
  // Empty-but-valid bodies: a list from GitHub, a search result from Jira.
  fetchSpy.mockImplementation(
    async (u: unknown) =>
      new Response(JSON.stringify(String(u).includes("github") ? [] : { issues: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  process.env.CLAUDE_SESSION_STATE_PATH = "/nonexistent/session-state.json";
  cfg.DROPLET_DEV_ENGINEERING_DASHBOARD = false;
  cfg.JIRA_HOST = "";
  cfg.JIRA_EMAIL = "";
  cfg.JIRA_API_TOKEN = "";
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(cfg, SAVED);
  if (SAVED_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = SAVED_TOKEN;
  if (SAVED_STATE_PATH === undefined) delete process.env.CLAUDE_SESSION_STATE_PATH;
  else process.env.CLAUDE_SESSION_STATE_PATH = SAVED_STATE_PATH;
});

describe("flag OFF (the default, every customer box)", () => {
  beforeEach(() => {
    // Everything else a lab box has is present: only the flag is missing.
    process.env.GITHUB_TOKEN = "ghp_test";
    cfg.JIRA_HOST = "acme.atlassian.net";
    cfg.JIRA_EMAIL = "ops@acme.co";
    cfg.JIRA_API_TOKEN = "tok";
  });

  it("answers 404 and makes no outbound request", async () => {
    const res = await request(app()).get("/api/admin/claude-activity");
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("answers 404 (not 403) to a non-admin too: absent, not forbidden", async () => {
    const a = express();
    a.use((req, _res, next) => {
      req.user = { id: "u2", username: "m", displayName: "M", role: "family" };
      next();
    });
    a.use("/api", createAdminClaudeActivityRouter());
    const res = await request(a).get("/api/admin/claude-activity");
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports the claudeActivity capability false", async () => {
    const res = await request(app()).get("/api/admin/capabilities");
    expect(res.status).toBe(200);
    expect(res.body.claudeActivity).toBe(false);
  });
});

describe("flag ON, nothing configured", () => {
  beforeEach(() => {
    cfg.DROPLET_DEV_ENGINEERING_DASHBOARD = true;
  });

  it("answers 404 and makes no outbound request (the route also needs the capability)", async () => {
    const res = await request(app()).get("/api/admin/claude-activity");
    expect(res.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports the claudeActivity capability false", async () => {
    const res = await request(app()).get("/api/admin/capabilities");
    expect(res.body.claudeActivity).toBe(false);
  });
});

describe("flag ON, Jira configured but no GitHub token", () => {
  beforeEach(() => {
    cfg.DROPLET_DEV_ENGINEERING_DASHBOARD = true;
    cfg.JIRA_HOST = "acme.atlassian.net";
    cfg.JIRA_EMAIL = "ops@acme.co";
    cfg.JIRA_API_TOKEN = "tok";
  });

  it("serves the page data without ever calling GitHub", async () => {
    const res = await request(app()).get("/api/admin/claude-activity");
    expect(res.status).toBe(200);
    expect(res.body.github).toBeNull();
    // Jira was dialled (it is configured); GitHub was not.
    expect(urlsFetched().some((u) => u.startsWith("https://acme.atlassian.net/"))).toBe(true);
    expect(urlsFetched().some((u) => u.includes("github"))).toBe(false);
  });
});

describe("flag ON, GitHub token set", () => {
  it("calls GitHub with the bearer token (lab-box behaviour is unchanged)", async () => {
    cfg.DROPLET_DEV_ENGINEERING_DASHBOARD = true;
    process.env.GITHUB_TOKEN = "ghp_test";
    const res = await request(app()).get("/api/admin/claude-activity");
    expect(res.status).toBe(200);
    const gh = fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("https://api.github.com/"));
    expect(gh.length).toBeGreaterThan(0);
    for (const [, init] of gh) {
      expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer ghp_test");
    }
  });
});

describe("DROPLET_DEV_ENGINEERING_DASHBOARD config", () => {
  const KEY = "DROPLET_DEV_ENGINEERING_DASHBOARD";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  async function load() {
    vi.resetModules();
    return (await import("../config.js")).config.DROPLET_DEV_ENGINEERING_DASHBOARD;
  }

  it("defaults OFF when unset", async () => {
    delete process.env[KEY];
    expect(await load()).toBe(false);
  });

  it.each(["0", "", "false", "yes", "on"])("%j is OFF", async (v) => {
    process.env[KEY] = v;
    expect(await load()).toBe(false);
  });

  it.each(["1", "true", " TRUE "])("%j is ON", async (v) => {
    process.env[KEY] = v;
    expect(await load()).toBe(true);
  });
});

describe("ships dark: the wiring, read as source", () => {
  const REPO = resolve(__dirname, "../../../..");
  const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");
  const FLAG = "DROPLET_DEV_ENGINEERING_DASHBOARD";

  it("app.ts mounts the router only behind the flag", () => {
    const src = read("apps/orchestrator/src/app.ts");
    expect(src).toMatch(
      /if \(config\.DROPLET_DEV_ENGINEERING_DASHBOARD\) \{\s*app\.use\("\/api", createAdminClaudeActivityRouter\(\)\);\s*\}/,
    );
    expect(src.match(/createAdminClaudeActivityRouter\(\)/g)).toHaveLength(1);
  });

  it("setup.sh and the shipped compose file never set the flag", () => {
    expect(read("scripts/setup.sh")).not.toContain(FLAG);
    expect(read("docker/docker-compose.yml")).not.toContain(FLAG);
  });
});
