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
 *       [&limit=<n> | &per_page=<n>] [&cursor=<next_cursor>]  (default page 50,
 *       max 100; response adds `next_cursor` + `total` — WARP-3371)
 *   GET /api/mobile/pm/work-items/:id?workspace=<slug>&project_id=<id>
 *
 * Mount: app.use(createPmMobileRouter(prisma)) AFTER authMiddleware (caller's
 * dashboard JWT travels through to req.user).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import {
  listWorkspaces,
  listProjects,
  listWorkItems,
  getWorkItem,
  PM_ERRORS,
  type ApiWorkItem,
} from "../../services/pm/pm.service.js";
import { requireRole } from "../../middleware/auth.js";

/** The mobile page size when a client sends neither `limit` nor `per_page`.
 *  Unchanged since the contract was written: an existing client that has never
 *  heard of the cursor gets exactly the payload it always got. */
const MOBILE_PAGE_DEFAULT = 50;
const MOBILE_PAGE_MAX = 100;

function capPerPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return MOBILE_PAGE_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), MOBILE_PAGE_MAX);
}

/** WARP-3371 — the optional `cursor` of a list. A string or nothing; anything
 *  else (`?cursor=a&cursor=b`) is a 400, like a cursor the list did not mint. */
const cursorQuery = z.string().min(1).max(512).optional();

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
    case PM_ERRORS.WORKSPACE_NOT_FOUND:
      return res.status(404).json({ error: "workspace not found", code: "PM_WORKSPACE_NOT_FOUND" });
    case PM_ERRORS.PROJECT_NOT_FOUND:
      return res.status(404).json({ error: "project not found", code: "PM_PROJECT_NOT_FOUND" });
    case PM_ERRORS.WORK_ITEM_NOT_FOUND:
      return res.status(404).json({ error: "work item not found", code: "PM_WORK_ITEM_NOT_FOUND" });
    case PM_ERRORS.INVALID_CURSOR:
      return res.status(400).json({ error: "invalid cursor", code: "PM_INVALID_CURSOR" });
    default:
      return null;
  }
}

export function createPmMobileRouter(prisma: PrismaClient): Router {
  const router = Router();

  // PM data is private workspace content — human roles explicit, `service`
  // excluded so the mcp-server / voice-io can't enumerate it over the mobile
  // surface (ADR-004 §3). WARP-3369: no `guest` either (an external guest
  // reads nothing of the company's work; the module's tier floor refuses them
  // at the prefix already, this keeps the router honest on its own).
  const HUMAN_GET = requireRole("owner", "admin", "family");

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
        const projects = await listProjects(prisma, { workspaceSlug: workspace, perPage: capPerPage(req.query.per_page) });
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
        const cursor = cursorQuery.safeParse(req.query.cursor);
        if (!cursor.success) {
          return res.status(400).json({ error: "invalid cursor", code: "PM_INVALID_CURSOR" });
        }
        // `limit` is the new name, `per_page` the contract's old one; with
        // neither, the page is MOBILE_PAGE_DEFAULT items exactly as before.
        const page = await listWorkItems(prisma, projectId, {
          limit: capPerPage(req.query.limit ?? req.query.per_page),
          cursor: cursor.data,
          stateId: req.query.state as string | undefined,
          assignee: req.query.assignee as string | undefined,
        });
        // `next_cursor` (null on the last page) and `total` are additive: a
        // client that ignores them is unchanged, one that reads them can tell
        // the first 50 from all of them.
        return res.json({
          work_items: page.items.map(projectWorkItem),
          next_cursor: page.nextCursor,
          total: page.total,
        });
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
        const projectId = req.query.project_id as string | undefined;
        if (!req.query.workspace || !projectId) {
          return res
            .status(400)
            .json({ error: "workspace and project_id query params required" });
        }
        const work_item = await getWorkItem(prisma, req.params.id);
        if (work_item.projectId !== projectId) {
          return res.status(404).json({ error: "work item not found", code: "PM_WORK_ITEM_NOT_FOUND" });
        }
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
