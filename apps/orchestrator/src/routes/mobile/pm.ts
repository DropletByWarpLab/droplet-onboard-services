/**
 * Mobile /api/mobile/pm/* routes — read-only PM for iOS / Android / Windows.
 *
 * ADR-026: repointed off the embedded Plane stack onto the NATIVE PM service
 * (Pm* Prisma models). Mobile clients hit these wrappers, which project the
 * orchestrator's rich work-item shape into the stable mobile envelope. No
 * Plane, no upstream token — the orchestrator owns the data.
 *
 * Endpoints (full shapes in docs/mobile-api-contract.md):
 *   GET /api/mobile/pm/workspaces
 *   GET /api/mobile/pm/projects?workspace=<slug>&per_page=<n>
 *   GET /api/mobile/pm/work-items?workspace=<slug>&project_id=<id>...
 *   GET /api/mobile/pm/work-items/:id?workspace=<slug>&project_id=<id>
 *
 * Mount: app.use(createPmMobileRouter(prisma)) AFTER authMiddleware (caller's
 * dashboard JWT travels through to req.user).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

import {
  listWorkspaces,
  listProjects,
  listWorkItems,
  getWorkItem,
  type ApiWorkItem,
} from "../../services/pm/pm.service.js";
import { requireRole } from "../../middleware/auth.js";

function capPerPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

/** Project the native work item into the strict mobile-api-contract shape so
 *  clients see a stable envelope regardless of the orchestrator's internals. */
function projectWorkItem(w: ApiWorkItem): {
  id: string;
  name: string;
  state: string | undefined;
  assignees: string[];
  labels: string[];
  created_at: string;
  updated_at: string;
} {
  return {
    id: w.id,
    name: w.name,
    state: w.state?.name ?? undefined,
    assignees: w.assignees,
    labels: w.labels.map((l) => l.name),
    created_at: w.createdAt,
    updated_at: w.updatedAt,
  };
}

/** Map a native service error code → a 404 with a resource-specific code, or
 *  null to let the global handler deal with it. */
function mapPmError(err: unknown, res: Response): Response | null {
  const msg = err instanceof Error ? err.message : "";
  switch (msg) {
    case "workspace_not_found":
      return res.status(404).json({ error: "workspace not found", code: "PM_WORKSPACE_NOT_FOUND" });
    case "project_not_found":
      return res.status(404).json({ error: "project not found", code: "PM_PROJECT_NOT_FOUND" });
    case "work_item_not_found":
      return res.status(404).json({ error: "work item not found", code: "PM_WORK_ITEM_NOT_FOUND" });
    default:
      return null;
  }
}

export function createPmMobileRouter(prisma: PrismaClient): Router {
  const router = Router();

  // PM data is private workspace content — human roles explicit, `service`
  // excluded so the mcp-server / voice-io can't enumerate it over the mobile
  // surface (ADR-004 §3).
  const HUMAN_GET = requireRole("owner", "admin", "family", "guest");

  router.get(
    "/api/mobile/pm/workspaces",
    HUMAN_GET,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const workspaces = await listWorkspaces(prisma);
        return res.json({
          workspaces: workspaces.map((w) => ({ id: w.id, slug: w.slug, name: w.name })),
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
    HUMAN_GET,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const workspace = req.query.workspace as string | undefined;
        if (!workspace) {
          return res.status(400).json({ error: "workspace query param required" });
        }
        const projects = await listProjects(prisma, { workspaceSlug: workspace });
        return res.json({
          projects: projects.map((p) => ({ id: p.id, name: p.name, identifier: p.identifier })),
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
    HUMAN_GET,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const projectId = req.query.project_id as string | undefined;
        if (!req.query.workspace || !projectId) {
          return res
            .status(400)
            .json({ error: "workspace and project_id query params required" });
        }
        const work_items = await listWorkItems(prisma, projectId, {
          perPage: capPerPage(req.query.per_page),
          stateId: req.query.state as string | undefined,
          assignee: req.query.assignee as string | undefined,
        });
        return res.json({ work_items: work_items.map(projectWorkItem) });
      } catch (err) {
        const handled = mapPmError(err, res);
        if (handled) return handled;
        next(err);
      }
    },
  );

  router.get(
    "/api/mobile/pm/work-items/:id",
    HUMAN_GET,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.query.workspace || !req.query.project_id) {
          return res
            .status(400)
            .json({ error: "workspace and project_id query params required" });
        }
        const work_item = await getWorkItem(prisma, req.params.id);
        return res.json({ work_item: projectWorkItem(work_item) });
      } catch (err) {
        const handled = mapPmError(err, res);
        if (handled) return handled;
        next(err);
      }
    },
  );

  return router;
}
