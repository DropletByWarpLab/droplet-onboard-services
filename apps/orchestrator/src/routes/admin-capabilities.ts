/**
 * Admin capabilities probe — tells the dashboard which optional admin surfaces
 * are actually wired so it can hide nav entries that would lead to a dead /
 * unconfigured page (issues #14, #15).
 *
 *   claudeActivity — the /admin/claude-activity surface is useful when at least
 *     one of its backing integrations is configured: a GitHub token
 *     (github-adapter.ts reads process.env.GITHUB_TOKEN) OR a fully configured
 *     Jira (jira-adapter.ts isConfigured(): host + email + token).
 *   ragEval — the /admin/rag-eval proxy is wired only when RAG_EVAL_URL is set
 *     (admin-rag-eval.ts ragEvalBaseUrl() reads process.env.RAG_EVAL_URL
 *     DIRECTLY — we mirror that exact read here, NOT a config field).
 *
 * Auth: admin-only, the same `role === "owner" || role === "admin"` check the
 * other admin routes use.
 */

import { Router, Request, Response } from "express";
import { config } from "../config.js";

function isAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}

/** Mirrors jira-adapter.ts isConfigured(). */
function jiraConfigured(): boolean {
  return !!(config.JIRA_HOST && config.JIRA_EMAIL && config.JIRA_API_TOKEN);
}

/** Mirrors github-adapter.ts: a non-empty GITHUB_TOKEN. */
function githubConfigured(): boolean {
  const t = process.env.GITHUB_TOKEN;
  return !!(t && t.trim().length > 0);
}

/** Mirrors admin-rag-eval.ts ragEvalBaseUrl(): RAG_EVAL_URL set + non-blank. */
function ragEvalWired(): boolean {
  const url = process.env.RAG_EVAL_URL;
  return !!(url && url.trim().length > 0);
}

export interface AdminCapabilities {
  claudeActivity: boolean;
  ragEval: boolean;
}

export function createAdminCapabilitiesRouter(): Router {
  const router = Router();

  router.get("/admin/capabilities", (req: Request, res: Response) => {
    if (!isAdmin(req)) {
      res.status(403).json({ error: "admin required" });
      return;
    }
    const body: AdminCapabilities = {
      claudeActivity: githubConfigured() || jiraConfigured(),
      ragEval: ragEvalWired(),
    };
    // Optional surfaces flip only on a deploy/env change; let the browser cache
    // briefly so the nav doesn't re-probe on every client mount.
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json(body);
  });

  return router;
}
