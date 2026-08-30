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
 * WARP-1306 — `projects` now mirrors the module-toggles EFFECTIVE state
 * (available && enabled, resolved by modules.service), exactly as the
 * original contract note here prescribed. The module-toggles layer landed
 * with the projects module `defaultEnabled: false` and its `/api/pm/projects`
 * routes behind the module gate, but this probe kept answering a hardcoded
 * `true` — so the dashboard rendered the full Projects workspace and let the
 * customer fill the New-project dialog only for the POST to die on the
 * gate's `module_disabled`. One source of truth now: whatever the gate
 * enforces, this probe reports.
 *
 * Error posture: fail CLOSED (`projects: false`) when the enablement read
 * errors — the same posture as the module gate, which would 404 the PM
 * routes anyway. Failing open here while the gate fails closed would
 * recreate the exact dead-end this ticket removes.
 */

import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

import { getEffectiveModuleIds } from "../services/modules.service.js";
import type { AvailabilityConfig } from "../modules/module-registry.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("capabilities-route");

export interface AppCapabilities {
  /** The Projects (native PM, ADR-026) surface is effective (available &&
   *  enabled per the module-toggles layer) on this box. */
  projects: boolean;
  /**
   * WARP-2545 — the CRM sub-tabs on the Projects page. Reported through the
   * SAME effective-set read as `projects`, which means the registry's
   * `requires: "projects"` edge is already applied: `getEffectiveModuleIds`
   * runs `satisfiedModuleIds`, so a box with CRM enabled and Projects off
   * answers `crm: false` here without this route knowing the dependency
   * exists. Re-deriving it (`crm && projects`) would be a second copy of the
   * edge, free to drift from the one the gate enforces.
   */
  crm: boolean;
  /** WARP-2038 — the /contacts surface. Off until that ticket builds it; the
   *  flag ships now so the CRM's people picker has one contract to read. */
  contacts: boolean;
}

export function createCapabilitiesRouter(
  prisma: PrismaClient,
  cfg: AvailabilityConfig,
): Router {
  const router = Router();

  router.get("/capabilities", async (req: Request, res: Response) => {
    // Mounted after authMiddleware, so an unauthenticated request never gets
    // here in production; the explicit check keeps the router safe standalone
    // (and honest under unit test).
    if (!req.user) {
      res.status(401).json({ error: "auth_required" });
      return;
    }
    let projects = false;
    let crm = false;
    let contacts = false;
    try {
      const effective = await getEffectiveModuleIds(prisma, cfg);
      projects = effective.has("projects");
      // Already dependency-resolved by `satisfiedModuleIds` inside
      // getEffectiveModuleIds — see the note on AppCapabilities.crm.
      crm = effective.has("crm");
      contacts = effective.has("contacts");
    } catch (e) {
      // Fail closed — module-gate parity (see the posture note above). The
      // dashboard treats an explicit `false` as "module off", which is what
      // the gate would enforce for every PM request right now anyway.
      logger.error({ err: e }, "capabilities_enablement_read_failed");
    }
    const body: AppCapabilities = { projects, crm, contacts };
    // Module state changes only on reconfiguration; let the browser cache
    // briefly so the nav doesn't re-probe on every client mount (same
    // rationale as /admin/capabilities).
    res.setHeader("Cache-Control", "private, max-age=30");
    res.json(body);
  });

  return router;
}
