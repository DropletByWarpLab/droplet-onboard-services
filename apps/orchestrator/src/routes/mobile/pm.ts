/**
 * Mobile /api/mobile/pm/* routes — read-only Plane integration for
 * iOS / Android / Windows clients.
 *
 * WARP-513 — per spec WARP-498 OQ4 (resolved 2026-05-28 to A): the
 * orchestrator transforms Plane's `work-item` shape into the existing
 * mobile envelope. Mobile clients NEVER call Plane directly; they hit
 * these wrappers, which authenticate upstream with the runtime-minted
 * Plane service token (WARP-867 — DROPLET_PM_ADMIN_TOKEN was never a
 * valid Plane credential). Workspace listing goes through the session
 * app API since Plane CE's /api/v1/ has no workspace list.
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
  PlaneApiError,
  type PlaneWorkItem,
} from "../../services/pm.client.js";
import {
  getPlaneServiceToken,
  listPlaneWorkspaces,
  PmBootstrapError,
} from "../../services/pm-bootstrap.service.js";
import { requireRole } from "../../middleware/auth.js";

const logger = pino({ name: "pm-mobile-route" });

function capPerPage(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

/**
 * Romain PR #321 review §4: the /work-items list handler was forwarding
 * raw Plane objects (description_html etc.) rather than projecting to
 * the strict mobile-api-contract shape. Mirror the per-item projection
 * the contract specifies so mobile clients see a stable shape across
 * Plane upstream bumps.
 */
function projectWorkItem(w: PlaneWorkItem): {
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
    state: w.state,
    assignees: w.assignees ?? [],
    labels: w.labels ?? [],
    created_at: w.created_at,
    updated_at: w.updated_at,
  };
}

/**
 * Romain PR #321 review §5: mapPmError hardcoded "work item not found"
 * for every upstream 404. A bad workspace slug on /projects would
 * incorrectly return PM_WORK_ITEM_NOT_FOUND, confusing mobile clients.
 * Caller passes the resource family ("workspace" | "project" |
 * "work_item") so the 404 message names the actual missing thing.
 */
function mapPmError(
  err: unknown,
  res: Response,
  resource: "workspace" | "project" | "work_item",
): Response | null {
  // WARP-867: the service token / session is minted at runtime through
  // pm-bootstrap; until the PM stack is up (or a workspace exists) those
  // throw PmBootstrapError — surface as "not ready", not a route crash.
  if (err instanceof PmBootstrapError) {
    logger.warn({ err: err.message, code: err.code }, "PM not ready");
    return res
      .status(503)
      .json({ error: "Plane is not ready yet", code: err.code });
  }
  if (!(err instanceof PlaneApiError)) return null;
  if (err.status === 404) {
    const code =
      resource === "workspace"
        ? "PM_WORKSPACE_NOT_FOUND"
        : resource === "project"
          ? "PM_PROJECT_NOT_FOUND"
          : "PM_WORK_ITEM_NOT_FOUND";
    const message =
      resource === "workspace"
        ? "workspace not found"
        : resource === "project"
          ? "project not found"
          : "work item not found";
    return res.status(404).json({ error: message, code });
  }
  logger.warn({ status: err.status, detail: err.detail }, "Plane upstream error");
  return res
    .status(502)
    .json({ error: "Plane API unreachable", code: "PM_UPSTREAM_ERROR" });
}

export function createPmMobileRouter(): Router {
  const router = Router();

  // Romain PR #321 review §3: per ADR-004 §3, all GETs accept the
  // `service` role by default — but PM data is private workspace
  // content, so the human-facing roles (owner / admin / family /
  // guest) are explicit. `service` excluded so mcp-server / voice-io
  // / sampler can't enumerate Plane workspaces over the mobile
  // surface.
  const HUMAN_GET = requireRole("owner", "admin", "family", "guest");

  router.get(
    "/api/mobile/pm/workspaces",
    HUMAN_GET,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        // WARP-867: `GET /api/v1/workspaces/` does not exist on Plane CE —
        // the list comes from the session app API via pm-bootstrap.
        const workspaces = await listPlaneWorkspaces();
        return res.json({
          workspaces: workspaces.map((w) => ({
            id: w.id,
            slug: w.slug,
            name: w.name,
          })),
        });
      } catch (err) {
        const handled = mapPmError(err, res, "workspace");
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
          return res
            .status(400)
            .json({ error: "workspace query param required" });
        }
        const projects = await listProjects(
          await getPlaneServiceToken(),
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
        const handled = mapPmError(err, res, "project");
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
        const workspace = req.query.workspace as string | undefined;
        const projectId = req.query.project_id as string | undefined;
        if (!workspace || !projectId) {
          return res
            .status(400)
            .json({ error: "workspace and project_id query params required" });
        }
        const work_items = await listWorkItems(
          await getPlaneServiceToken(),
          workspace,
          projectId,
          {
            perPage: capPerPage(req.query.per_page),
            state: req.query.state as string | undefined,
            assignee: req.query.assignee as string | undefined,
          },
        );
        // Romain PR #321 review §4: project each Plane work-item into
        // the mobile-api-contract shape rather than forwarding raw
        // Plane internals.
        return res.json({ work_items: work_items.map(projectWorkItem) });
      } catch (err) {
        const handled = mapPmError(err, res, "work_item");
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
        const workspace = req.query.workspace as string | undefined;
        const projectId = req.query.project_id as string | undefined;
        const workItemId = req.params.id;
        if (!workspace || !projectId) {
          return res
            .status(400)
            .json({ error: "workspace and project_id query params required" });
        }
        const work_item = await getWorkItem(
          await getPlaneServiceToken(),
          workspace,
          projectId,
          workItemId,
        );
        return res.json({ work_item: projectWorkItem(work_item) });
      } catch (err) {
        const handled = mapPmError(err, res, "work_item");
        if (handled) return handled;
        next(err);
      }
    },
  );

  return router;
}
