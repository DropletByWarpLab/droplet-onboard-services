/**
 * GET /api/admin/capabilities (#14, #15) — drives dashboard nav-gating for the
 * optional admin surfaces (Activity, RAG eval).
 *
 * Covers: admin-only (403 for non-admins); claudeActivity true when a GitHub
 * token OR a fully-configured Jira is present; ragEval true when RAG_EVAL_URL is
 * set; all false when nothing is configured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// The Jira check reads `config`; mock it as a mutable object the tests tweak.
vi.mock("../config.js", () => ({
  config: { JIRA_HOST: "", JIRA_EMAIL: "", JIRA_API_TOKEN: "" },
}));

import { config } from "../config.js";
import { createAdminCapabilitiesRouter } from "./admin-capabilities.js";

const ORIGINAL_ENV = { ...process.env };

function appWithRole(role: string | undefined) {
  const app = express();
  app.use((req, _res, next) => {
    if (role) (req as unknown as { user: { role: string } }).user = { role };
    next();
  });
  app.use("/api", createAdminCapabilitiesRouter());
  return app;
}

beforeEach(() => {
  const c = config as unknown as Record<string, string>;
  c.JIRA_HOST = "";
  c.JIRA_EMAIL = "";
  c.JIRA_API_TOKEN = "";
  delete process.env.GITHUB_TOKEN;
  delete process.env.RAG_EVAL_URL;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/admin/capabilities", () => {
  it("403s for a non-admin", async () => {
    const res = await request(appWithRole("family")).get(
      "/api/admin/capabilities",
    );
    expect(res.status).toBe(403);
  });

  it("returns all-false when nothing is configured", async () => {
    const res = await request(appWithRole("owner")).get(
      "/api/admin/capabilities",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ claudeActivity: false, ragEval: false });
  });

  it("claudeActivity true when a GitHub token is set", async () => {
    process.env.GITHUB_TOKEN = "ghp_example";
    const res = await request(appWithRole("admin")).get(
      "/api/admin/capabilities",
    );
    expect(res.body.claudeActivity).toBe(true);
  });

  it("claudeActivity true when Jira is fully configured", async () => {
    const c = config as unknown as Record<string, string>;
    c.JIRA_HOST = "acme.atlassian.net";
    c.JIRA_EMAIL = "ops@acme.co";
    c.JIRA_API_TOKEN = "tok";
    const res = await request(appWithRole("owner")).get(
      "/api/admin/capabilities",
    );
    expect(res.body.claudeActivity).toBe(true);
  });

  it("ragEval true when RAG_EVAL_URL is set", async () => {
    process.env.RAG_EVAL_URL = "http://rag-eval:8090";
    const res = await request(appWithRole("owner")).get(
      "/api/admin/capabilities",
    );
    expect(res.body.ragEval).toBe(true);
  });
});
