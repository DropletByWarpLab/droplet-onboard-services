/**
 * GET /api/capabilities — module-capability probe for EVERY authenticated
 * principal (WARP-1154/WARP-1155).
 *
 * Companion to `/api/admin/capabilities` (admin-only, gates optional admin
 * surfaces). This endpoint answers the question the whole household's nav
 * needs: "which user-facing modules is this Droplet actually serving?" The
 * dashboard drives the Projects sidebar entry + `/projects` route off the
 * `projects` flag — an explicit contract, NOT inference from request errors
 * (WARP-1154: a disabled module's `module_disabled` wire code leaked verbatim
 * into a toast and the load-failure state mislabeled the permanent condition
 * as a retryable server error).
 *
 * Why `projects` is `true` here: the native PM surface (ADR-026) lives in the
 * orchestrator's own Postgres, is unconditionally mounted in app.ts, and has
 * no deploy-time dependency — on the shipping single-box product it is ON.
 * There is deliberately no env knob for it on main.
 *
 * Contract note for the runtime module-toggles layer (in progress on
 * `feat/module-toggles`): when module enablement lands, this endpoint is the
 * single place the dashboard learns a module's effective state — wire
 * `projects` (and any new module flags) through the module service's
 * effective-state resolution instead of the constant below. Do NOT add a
 * second probe; the dashboard fails open when this endpoint is absent, and
 * hides the surface only when a flag is explicitly `false`.
 */

import { Router, type Request, type Response } from "express";

export interface AppCapabilities {
  /** The Projects (native PM, ADR-026) surface is enabled on this box. */
  projects: boolean;
}

export function createCapabilitiesRouter(): Router {
  const router = Router();

  router.get("/capabilities", (req: Request, res: Response) => {
    // Mounted after authMiddleware, so an unauthenticated request never gets
    // here in production; the explicit check keeps the router safe standalone
    // (and honest under unit test).
    if (!req.user) {
      res.status(401).json({ error: "auth_required" });
      return;
    }
    const body: AppCapabilities = {
      projects: true,
    };
    // Module state changes only on reconfiguration; let the browser cache
    // briefly so the nav doesn't re-probe on every client mount (same
    // rationale as /admin/capabilities).
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json(body);
  });

  return router;
}
