/**
 * WARP-279 — `/api/admin/claude-activity` endpoint.
 *
 * Single GET that aggregates everything the meta-observability dashboard needs
 * into one payload: the AI engineer's session-state file, GitHub activity (PRs,
 * commits, CI), Jira (compliance chain + in-flight tickets), and the parsed
 * compliance-progress.md. The dashboard polls every 30s with
 * `If-Modified-Since`; we honor that with a `Last-Modified` reply.
 *
 * Auth: admin-only. We reuse the same `role === "owner" || role === "admin"`
 * check used by other admin routes (see ddns.ts). LAN-only by ops policy
 * — the gateway is the only inbound path; this endpoint adds nothing past
 * the existing session cookie.
 *
 * In this commit the GitHub / Jira / compliance fields are stubbed to `null`;
 * commits 3-5 wire them in. The shape is fixed now so the frontend in commit
 * 6 can be built against a stable contract.
 */

import { Router, Request, Response, NextFunction } from "express";
import pino from "pino";
import { readSessionState } from "../services/claude-activity/session-state.js";
import {
  getGitHubSnapshot,
  type GitHubSnapshot,
} from "../services/claude-activity/github-adapter.js";

const logger = pino({ name: "admin-claude-activity" });

function isAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}

export interface ClaudeActivityResponse {
  now: Awaited<ReturnType<typeof readSessionState>>["now"];
  decisions: Awaited<ReturnType<typeof readSessionState>>["decisions"];
  recent_actions: Awaited<ReturnType<typeof readSessionState>>["recent_actions"];
  github: GitHubSnapshot | null;
  jira: unknown | null;
  compliance: unknown | null;
  // Wall-clock the orchestrator computed this snapshot. The dashboard uses
  // it for the "last refreshed N seconds ago" footer; the HTTP
  // `Last-Modified` header carries the same value to drive the 304 path.
  generated_at: string;
}

export function createAdminClaudeActivityRouter(): Router {
  const router = Router();

  router.get(
    "/admin/claude-activity",
    async (req: Request, res: Response, next: NextFunction) => {
      if (!isAdmin(req)) {
        res.status(403).json({ error: "admin required" });
        return;
      }

      try {
        // Read session-state + GitHub snapshot in parallel. Each call has
        // its own failure handling — if GitHub is down its leaf is empty
        // arrays, not a 500.
        const [session, github] = await Promise.all([
          readSessionState(),
          getGitHubSnapshot().catch((err) => {
            logger.warn({ err }, "github snapshot failed");
            return null;
          }),
        ]);
        const generatedAt = new Date();

        const body: ClaudeActivityResponse = {
          now: session.now,
          decisions: session.decisions,
          recent_actions: session.recent_actions,
          github,
          jira: null,
          compliance: null,
          generated_at: generatedAt.toISOString(),
        };

        // WARP-279: support `If-Modified-Since` so 30s polling can short-
        // circuit when nothing moved. Reduce over every timestamp we
        // surface — session-state, commits, PRs, CI runs.
        const lastModified =
          mostRecentTimestamp(session, github) ?? generatedAt;
        res.setHeader("Last-Modified", lastModified.toUTCString());
        // Strong cache-control: data is per-user-role and we don't want
        // intermediaries serving a stale admin payload to a guest browser.
        res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");

        const ifModifiedSince = req.headers["if-modified-since"];
        if (typeof ifModifiedSince === "string") {
          const since = new Date(ifModifiedSince);
          if (
            !Number.isNaN(since.getTime()) &&
            lastModified.getTime() <= since.getTime()
          ) {
            res.status(304).end();
            return;
          }
        }

        res.json(body);
      } catch (err) {
        logger.error({ err }, "claude-activity endpoint failed");
        next(err);
      }
    },
  );

  return router;
}

function mostRecentTimestamp(
  session: Awaited<ReturnType<typeof readSessionState>>,
  github: GitHubSnapshot | null,
): Date | null {
  let max: number | null = null;
  const consider = (s: string | null | undefined) => {
    if (!s) return;
    const t = Date.parse(s);
    if (!Number.isNaN(t) && (max === null || t > max)) max = t;
  };
  for (const d of session.decisions) consider(d.ts);
  for (const a of session.recent_actions) consider(a.ts);
  consider(session.now.started_at);
  if (github) {
    for (const c of github.commits) consider(c.ts);
    for (const p of github.prs) consider(p.updated_at);
    for (const r of github.ci_runs) consider(r.updated_at);
  }
  return max === null ? null : new Date(max);
}
