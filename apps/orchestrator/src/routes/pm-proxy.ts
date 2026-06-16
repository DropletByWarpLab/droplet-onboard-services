/**
 * PM service-token + app-API proxy routes (WARP-867).
 *
 * Plane CE v0.24.1's `/api/v1/` token API has no workspace list and no
 * search, and the only credential it accepts is a server-generated
 * service token — `DROPLET_PM_ADMIN_TOKEN` was never registered in Plane,
 * so every consumer presenting it has been silently 401ing. These routes
 * close that gap:
 *
 *   GET /api/pm/service-token — the runtime-minted Plane service token.
 *     Consumed by the tools-core pm handlers (via the mcp service
 *     principal) so their `/api/v1/` calls authenticate. Owner/admin
 *     only among humans — it IS a credential.
 *
 *   GET /api/pm/workspaces — workspace list via the session app API
 *     (`/api/users/me/workspaces/`); replaces the nonexistent
 *     `GET /api/v1/workspaces/`.
 *
 *   GET /api/pm/search?workspace_slug=&query= — work-item search via the
 *     app API's global search; the v1 surface has no search at all.
 *
 * Mount: app.use(createPmProxyRouter()) AFTER authMiddleware.
 */

import { Router, type Request, type Response } from "express";
import pino from "pino";

import { requireRoleOrMcpService } from "../middleware/auth.js";
import {
  getPlaneServiceToken,
  listPlaneWorkspaces,
  searchPlaneWorkItems,
  PmBootstrapError,
} from "../services/pm-bootstrap.service.js";

const logger = pino({ name: "pm-proxy-route" });

function handlePmError(err: unknown, res: Response): Response {
  if (err instanceof PmBootstrapError) {
    logger.warn({ err: err.message, code: err.code }, "PM proxy call failed");
    // NO_WORKSPACE is a not-yet-onboarded state, not an outage.
    const status = err.code === "NO_WORKSPACE" ? 409 : 503;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  logger.warn({ err: (err as Error).message }, "PM proxy call failed");
  return res
    .status(502)
    .json({ error: "Plane unreachable", code: "PM_UPSTREAM_ERROR" });
}

export function createPmProxyRouter(): Router {
  const router = Router();

  router.get(
    "/api/pm/service-token",
    requireRoleOrMcpService("owner", "admin"),
    async (_req: Request, res: Response) => {
      try {
        const token = await getPlaneServiceToken();
        return res.json({ token });
      } catch (err) {
        return handlePmError(err, res);
      }
    },
  );

  // Same human-role set as the mobile PM surface (owner/admin/family/guest
  // read PM data) plus the mcp service principal for the pm_* tools.
  router.get(
    "/api/pm/workspaces",
    requireRoleOrMcpService("owner", "admin", "family", "guest"),
    async (_req: Request, res: Response) => {
      try {
        const workspaces = await listPlaneWorkspaces();
        return res.json({ workspaces });
      } catch (err) {
        return handlePmError(err, res);
      }
    },
  );

  router.get(
    "/api/pm/search",
    requireRoleOrMcpService("owner", "admin", "family", "guest"),
    async (req: Request, res: Response) => {
      const workspaceSlug = req.query.workspace_slug;
      const query = req.query.query;
      if (typeof workspaceSlug !== "string" || workspaceSlug.length === 0) {
        return res.status(400).json({ error: "Missing 'workspace_slug'" });
      }
      if (typeof query !== "string" || query.length === 0) {
        return res.status(400).json({ error: "Missing 'query'" });
      }
      try {
        const work_items = await searchPlaneWorkItems(workspaceSlug, query);
        return res.json({ work_items });
      } catch (err) {
        return handlePmError(err, res);
      }
    },
  );

  return router;
}
