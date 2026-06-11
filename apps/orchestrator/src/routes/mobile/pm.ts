/**
 * Mobile /api/mobile/pm/* routes — read-only Plane integration for
 * iOS / Android / Windows clients.
 *
 * WARP-513 — per spec WARP-498 OQ4 (resolved 2026-05-28 to A): the
 * orchestrator transforms Plane's `work-item` shape into the existing
 * mobile envelope. Mobile clients NEVER call Plane directly.
 *
 * WARP-860 — auth rewrite, ground truth from a live Plane CE v0.24.1:
 * `DROPLET_PM_ADMIN_TOKEN` is registered nowhere in Plane (every
 * forwarded call 401'd), and `GET /api/v1/workspaces/` doesn't exist on
 * CE (404). So these routes now:
 *
 *   - authenticate `/api/v1` with the RUNTIME-PROVISIONED service token
 *     (`withPmServiceToken` — invalidate + retry once on a Plane 401);
 *   - serve /workspaces from `listPlaneWorkspaces()` (session app API,
 *     the only workspace list CE has) — same wire shape as before;
 *   - surface provisioning/bootstrap failures as
 *     `503 {error, code: "PM_NOT_READY"}` (the PM stack isn't onboarded
 *     or reachable yet — retry after the wizard PM step).
 *
 * Endpoints (full shapes in docs/mobile-api-contract.md):
 *   GET /api/mobile/pm/workspaces
 *   GET /api/mobile/pm/projects?workspace=<slug>&per_page=<n>
 *   GET /api/mobile/pm/work-items?workspace=<slug>&project_id=<id>...
 *   GET /api/mobile/pm/work-items/:id?workspace=<slug>&project_id=<id>
 *
 * Mount: app.use(createPmMobileRouter()) — protected by authMiddleware
 * (caller's dashboard JWT travels through to req.user).
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
  listPlaneWorkspaces,
  PmServiceTokenError,
  withPmServiceToken,
} from "../../services/pm-service-token.service.js";
import { PmBootstrapError } from "../../services/pm-bootstrap.service.js";
import { requireRole } from "../../middleware/auth.js";

const logger = pino({ name: "pm-mobile-route" });

/** The withPmServiceToken auth-error predicate: a Plane 401 means the
 *  cached service token went stale — invalidate, re-provision, retry. */
function isPlane401(err: unknown): boolean {
  return err instanceof PlaneApiError && err.status === 401;
}

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
  // WARP-860 — the PM stack isn't ready: the service token couldn't be
  // provisioned (no workspace yet / Plane refused) or Plane itself is
  // unreachable / won't sign the bootstrap admin in. 503 tells mobile
  // clients to retry later (after the wizard PM step), distinct from
  // the 502 "Plane answered badly" upstream case below.
  if (err instanceof PmServiceTokenError || err instanceof PmBootstrapError) {
    logger.warn(
      { err: err.message, code: err.code },
      "PM stack not ready for mobile pm route",
    );
    return res.status(503).json({ error: err.message, code: "PM_NOT_READY" });
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
        // WARP-860 — Plane CE has no /api/v1/workspaces/ (404). The
        // session app API is the only workspace list; the wire shape
        // stays byte-identical to the contract doc.
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
        const projects = await withPmServiceToken(
          (token) => listProjects(token, workspace, capPerPage(req.query.per_page)),
          isPlane401,
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
        const work_items = await withPmServiceToken(
          (token) =>
            listWorkItems(token, workspace, projectId, {
              perPage: capPerPage(req.query.per_page),
              state: req.query.state as string | undefined,
              assignee: req.query.assignee as string | undefined,
            }),
          isPlane401,
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
        const work_item = await withPmServiceToken(
          (token) => getWorkItem(token, workspace, projectId, workItemId),
          isPlane401,
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
