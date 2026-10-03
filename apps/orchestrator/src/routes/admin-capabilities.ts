/**
 * Admin capabilities probe — tells the dashboard which optional admin surfaces
 * are actually wired so it can hide nav entries that would lead to a dead /
 * unconfigured page (issues #14, #15).
 *
 *   claudeActivity — Warp Lab's own engineering dashboard (WARP-3433). True only
 *     when the explicit developer flag DROPLET_DEV_ENGINEERING_DASHBOARD is on
 *     (default OFF: customer boxes never show it) AND at least one backing
 *     integration is configured: a GitHub token OR a fully configured Jira.
 *     See services/claude-activity/enabled.ts.
 *   ragEval — the /admin/rag-eval proxy is wired only when RAG_EVAL_URL is set
 *     (admin-rag-eval.ts ragEvalBaseUrl() reads process.env.RAG_EVAL_URL
 *     DIRECTLY — we mirror that exact read here, NOT a config field).
 *
 * Auth: admin-only, the same `role === "owner" || role === "admin"` check the
 * other admin routes use.
 */

import { Router, Request, Response } from "express";
import { recordAccessDenied } from "../middleware/auth.js";
import { isOwnerOrAdmin } from "../middleware/admin-tier.js";
import { claudeActivityEnabled } from "../services/claude-activity/enabled.js";

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
    if (!isOwnerOrAdmin(req)) {
      // WARP-1062 (audit item B): emit the WARP-237 policy-violation row —
      // local isAdmin() denials must not be silent (requireRole parity).
      recordAccessDenied(req, "role-not-permitted");
      res.status(403).json({ error: "admin required" });
      return;
    }
    const body: AdminCapabilities = {
      claudeActivity: claudeActivityEnabled(),
      ragEval: ragEvalWired(),
    };
    res.json(body);
  });

  return router;
}
