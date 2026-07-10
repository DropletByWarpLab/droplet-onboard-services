/**
 * `/api/modules` + `/api/business-types` — runtime module toggles per business
 * type. Design: docs/superpowers/specs/2026-07-07-module-toggles-design.md.
 *
 *   GET  /api/modules                  any authed user (drives nav + settings page)
 *   PATCH /api/admin/modules/:id       owner/admin — body { enabled: boolean }
 *   GET  /api/business-types           any authed user (preset catalog)
 *   POST /api/admin/business-type      owner/admin — body { type: BusinessType }
 *
 * RBAC per ADR-004: reads open to any authenticated principal; writes restricted
 * to owner/admin via the same inline check the other settings routes use.
 */
import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createLogger } from "../lib/logger.js";
import {
  getModulesView,
  setModuleEnabled,
  applyBusinessType,
  ModuleToggleError,
} from "../services/modules.service.js";
import {
  BUSINESS_TYPES,
  isBusinessType,
  isModuleId,
  type AvailabilityConfig,
} from "../modules/module-registry.js";
import type { ModuleGate } from "../middleware/module-gate.js";
import { recordAccessDenied } from "../middleware/auth.js";

const logger = createLogger("modules-route");

interface AuthedUser { id?: string; username?: string; role?: string }
function getUser(req: Request): AuthedUser | null {
  return (req as Request & { user?: AuthedUser }).user ?? null;
}
function userId(req: Request): string | null {
  const u = getUser(req);
  return u?.username ?? u?.id ?? null;
}
function isAdmin(req: Request): boolean {
  const r = getUser(req)?.role;
  return r === "owner" || r === "admin";
}

const patchBody = z.object({ enabled: z.boolean() });
const businessTypeBody = z.object({ type: z.string() });

export function createModulesRouter(
  prisma: PrismaClient,
  cfg: AvailabilityConfig,
  gate: ModuleGate
): Router {
  const router = Router();

  // ── GET /api/modules ───────────────────────────────────────────────────────
  router.get("/modules", async (req, res, next) => {
    try {
      if (!userId(req)) { res.status(401).json({ error: "auth_required" }); return; }
      const view = await getModulesView(prisma, cfg);
      res.setHeader("Cache-Control", "private, max-age=30");
      res.json(view);
    } catch (e) { next(e); }
  });

  // ── PATCH /api/admin/modules/:id ───────────────────────────────────────────
  router.patch("/admin/modules/:id", async (req, res, next) => {
    try {
      if (!userId(req)) { res.status(401).json({ error: "auth_required" }); return; }
      if (!isAdmin(req)) {
        // WARP-1062 (audit item B): emit the WARP-237 policy-violation row —
        // local isAdmin() denials must not be silent (requireRole parity).
        recordAccessDenied(req, "role-not-permitted");
        res.status(403).json({ error: "admin_required", message: "Only an owner or admin can toggle modules." });
        return;
      }
      const id = req.params.id;
      if (!isModuleId(id)) { res.status(400).json({ error: "unknown_module", module: id }); return; }
      const parsed = patchBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body", message: parsed.error.issues.map((i) => i.message).join("; ") });
        return;
      }
      const state = await setModuleEnabled(prisma, cfg, id, parsed.data.enabled, userId(req));
      gate.invalidate();
      logger.info({ user: userId(req), module: id, enabled: parsed.data.enabled }, "module_toggled");
      res.json(state);
    } catch (e) {
      if (e instanceof ModuleToggleError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      next(e);
    }
  });

  // ── GET /api/business-types ────────────────────────────────────────────────
  router.get("/business-types", async (req, res, next) => {
    try {
      if (!userId(req)) { res.status(401).json({ error: "auth_required" }); return; }
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json({ businessTypes: BUSINESS_TYPES });
    } catch (e) { next(e); }
  });

  // ── POST /api/admin/business-type ──────────────────────────────────────────
  router.post("/admin/business-type", async (req, res, next) => {
    try {
      if (!userId(req)) { res.status(401).json({ error: "auth_required" }); return; }
      if (!isAdmin(req)) {
        // WARP-1062 (audit item B): requireRole-parity policy-violation row.
        recordAccessDenied(req, "role-not-permitted");
        res.status(403).json({ error: "admin_required", message: "Only an owner or admin can apply a business type." });
        return;
      }
      const parsed = businessTypeBody.safeParse(req.body);
      if (!parsed.success || !isBusinessType(parsed.data.type)) {
        res.status(400).json({ error: "invalid_business_type" });
        return;
      }
      const view = await applyBusinessType(prisma, cfg, parsed.data.type, userId(req));
      gate.invalidate();
      logger.info({ user: userId(req), businessType: parsed.data.type }, "business_type_applied");
      res.json(view);
    } catch (e) {
      if (e instanceof ModuleToggleError) {
        res.status(e.status).json({ error: e.code, message: e.message });
        return;
      }
      next(e);
    }
  });

  return router;
}
