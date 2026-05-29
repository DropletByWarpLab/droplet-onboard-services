/**
 * Mobile /api/mobile/pm/* routes — read-only Plane integration for
 * iOS / Android / Windows clients.
 *
 * WARP-513 — per spec WARP-498 OQ4 (resolved 2026-05-28 to A): the
 * orchestrator transforms Plane's `work-item` shape into the existing
 * mobile envelope. Mobile clients NEVER call Plane directly; they hit
 * these wrappers which forward via DROPLET_PM_ADMIN_TOKEN.
 *
 * Endpoints (full shapes in docs/mobile-api-contract.md):
 *   GET /api/mobile/pm/workspaces
 *   GET /api/mobile/pm/projects?workspace=<slug>&per_page=<n>
 *   GET /api/mobile/pm/work-items?workspace=<slug>&project_id=<id>...
 *   GET /api/mobile/pm/work-items/:id?workspace=<slug>&project_id=<id>
 *
 * Mount: under app.use("/api", createPmMobileRouter()) — protected by
 * authMiddleware (caller's dashboard JWT travels through to req.user).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import pino from "pino";

import {
  getWorkItem,
  listProjects,
  listWorkItems,
  listWorkspaces,
  PlaneApiError,
} from "../../services/pm.client.js";
import { config } from "../../config.js";

const logger = pino({ name: "pm-mobile-route" });

function adminKey(): string {
  return config.DROPLET_PM_ADMIN_TOKEN;
}

function capPerPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

function mapPmError(err: unknown, res: Response): Response | null {
  if (!(err instanceof PlaneApiError)) return null;
  if (err.status === 404) {
    return res
      .status(404)
      .json({ error: "work item not found", code: "PM_WORK_ITEM_NOT_FOUND" });
  }
  logger.warn({ status: err.status, detail: err.detail }, "Plane upstream error");
  return res
    .status(502)
    .json({ error: "Plane API unreachable", code: "PM_UPSTREAM_ERROR" });
}

export function createPmMobileRouter(): Router {
  const router = Router();

  router.get(
    "/api/mobile/pm/workspaces",
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const workspaces = await listWorkspaces(adminKey());
        return res.json({
          workspaces: workspaces.map((w) => ({
            id: w.id,
            slug: w.slug,
            name: w.name,
          })),
        });
      } catch (err) {
        const handled = mapPmError(err, res);
        if (handled) return handled;
        next(err);
      }
    },
  );

  router.get(
    "/api/mobile/pm/projects",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const workspace = req.query.workspace as string | undefined;
        if (!workspace) {
          return res
            .status(400)
            .json({ error: "workspace query param required" });
        }
        const projects = await listProjects(
          adminKey(),
          workspace,
          capPerPage(req.query.per_page),
        );
        return res.json({
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            identifier: p.identifier,
          })),
        });
      } catch (err) {
        const handled = mapPmError(err, res);
        if (handled) return handled;
        next(err);
      }
    },
  );

  router.get(
    "/api/mobile/pm/work-items",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const workspace = req.query.workspace as string | undefined;
        const projectId = req.query.project_id as string | undefined;
        if (!workspace || !projectId) {
          return res
            .status(400)
            .json({ error: "workspace and project_id query params required" });
        }
        const work_items = await listWorkItems(
          adminKey(),
          workspace,
          projectId,
          {
            perPage: capPerPage(req.query.per_page),
            state: req.query.state as string | undefined,
            assignee: req.query.assignee as string | undefined,
          },
        );
        return res.json({ work_items });
      } catch (err) {
        const handled = mapPmError(err, res);
        if (handled) return handled;
        next(err);
      }
    },
  );

  router.get(
    "/api/mobile/pm/work-items/:id",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const workspace = req.query.workspace as string | undefined;
        const projectId = req.query.project_id as string | undefined;
        const workItemId = req.params.id;
        if (!workspace || !projectId) {
          return res
            .status(400)
            .json({ error: "workspace and project_id query params required" });
        }
        const work_item = await getWorkItem(
          adminKey(),
          workspace,
          projectId,
          workItemId,
        );
        return res.json({ work_item });
      } catch (err) {
        const handled = mapPmError(err, res);
        if (handled) return handled;
        next(err);
      }
    },
  );

  return router;
}
