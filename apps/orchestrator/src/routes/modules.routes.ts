/**
 * `/api/modules` + `/api/business-types` — runtime module toggles per business
 * type. Design: docs/superpowers/specs/2026-07-07-module-toggles-design.md.
 *
 *   GET  /api/modules                  any authed user (drives nav + settings page)
 *   GET  /api/modules/tool-verdict     the mcp-server's `_service:mcp` principal, or an owner
 *                                      (WARP-2972 — which tool domains are withheld)
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
import { recordAccessDenied, requireRoleOrMcpService } from "../middleware/auth.js";
import { resolveEffectiveAccessForRequest } from "../middleware/feature-gate.js";
import { isOwnerOrAdmin } from "../middleware/admin-tier.js";
import { serializeModuleVerdict } from "@droplet/tools-core";
import {
  resolveToolModuleVerdict,
  type ModuleVerdictResolver,
} from "../services/tool-module-verdict.service.js";

const logger = createLogger("modules-route");

interface AuthedUser { id?: string; username?: string; role?: string }
function getUser(req: Request): AuthedUser | null {
  return (req as Request & { user?: AuthedUser }).user ?? null;
}
function userId(req: Request): string | null {
  const u = getUser(req);
  return u?.username ?? u?.id ?? null;
}
/** The LOCAL User.id UUID — the only key the resolver (and every FK) accepts.
 *  Never the Nextcloud username: that is the WARP-881 IDOR rule. `userId()`
 *  above is the human-readable `setBy` / log label and is NOT interchangeable. */
function localUserId(req: Request): string | null {
  return getUser(req)?.id ?? null;
}

const patchBody = z.object({ enabled: z.boolean() });
const businessTypeBody = z.object({ type: z.string() });

/**
 * The caller's §9 feature set, or `null` when we can't resolve them.
 *
 * Fails OPEN — deliberately, and only here. This field drives NAV: a resolver
 * hiccup or a principal with no local row (AUTH_ENABLED=false dev session, the
 * OCS fallback) must leave the client on the workspace view rather than blank
 * every surface. The enforcement boundary is the server gate
 * (`requireFeatureAccess`), which fails CLOSED on the same inputs — the two
 * postures are the two halves of "the nav is a convenience, the gate is the
 * wall" and must not be conflated.
 */
async function resolveEffectiveForUser(req: Request) {
  const id = localUserId(req);
  if (!id) return null;
  try {
    // Goes through the feature gate's PER-REQUEST memo, never straight at the
    // resolver: it is ~7 DB round-trips with no cache in v1 (T3's deliberate
    // decision), so a request that hits both a gated prefix and this route
    // must pay for it once, not twice.
    const access = await resolveEffectiveAccessForRequest(req);
    return access?.features ?? null;
  } catch (e) {
    logger.warn({ err: e, user: id }, "effective_for_user_unresolved");
    return null;
  }
}

export function createModulesRouter(
  prisma: PrismaClient,
  cfg: AvailabilityConfig,
  gate: ModuleGate,
  /** WARP-2972 — injectable for tests; production reads the process-wide binding. */
  resolveVerdict: ModuleVerdictResolver = resolveToolModuleVerdict,
): Router {
  const router = Router();

  // ── GET /api/modules ───────────────────────────────────────────────────────
  // WARP-1528 / ADR-032 §5: the workspace view is UNCHANGED (Settings →
  // Features is box-wide by design — "Applies to everyone on this Droplet"),
  // and gains an ADDITIVE `effectiveForUser` = workspace-effective ∩ the
  // caller's §9 grants, straight from the T3 resolver (consumed, never
  // re-derived). The nav reads that when it's there.
  router.get("/modules", async (req, res, next) => {
    try {
      if (!userId(req)) { res.status(401).json({ error: "auth_required" }); return; }
      const view = await getModulesView(prisma, cfg);
      const effectiveForUser = (await resolveEffectiveForUser(req)) ?? null;
      // `?.length`, not a bare truthiness check: `[]` is truthy, so the bare
      // form SENT an empty array while the client's contract says the field is
      // omitted when unresolvable. The resolver's always-on floor now makes a
      // genuinely empty set unreachable, so this is belt-and-braces — but a
      // server and a client that disagree about the wire shape is exactly how
      // the next person gets misled.
      res.json(effectiveForUser?.length ? { ...view, effectiveForUser } : view);
    } catch (e) { next(e); }
  });

  // ── GET /api/modules/tool-verdict ──────────────────────────────────────────
  // WARP-2972. Which tool domains a module toggle (box) and the named person's
  // own grants withhold — the ONE derivation (tool-module-verdict.service.ts),
  // asked by the mcp-server before it lists or dispatches a tool, so the HTTP
  // transport and the stdio child answer the same question the chat pool does.
  //
  // `_service:mcp` and the owner. `requireRoleOrMcpService("owner")` admits that
  // principal id plus the owner tier. Owner and admin can already read any
  // person's effective access (`GET /api/people/:id/effective-access`), so this
  // discloses nothing new; and with AUTH_ENABLED=false every request is the
  // synthetic `dev` OWNER, so a route that admitted `_service:mcp` alone would
  // 403 the mcp-server in a no-auth dev stack and it would fail closed. Admins,
  // family, guests and every other service principal are refused. The person is the mcp-server's usual `X-Nextcloud-User` assertion
  // (a username on stdio, a `User.id` over HTTP), resolved as every other
  // asserted-person surface resolves it. An unnamed caller is the box.
  //
  // A verdict that cannot be established is still a 200: it is the fail-closed
  // verdict, as data. The mcp-server treats a non-200 the same way, so the only
  // thing this distinction buys is an honest access log.
  router.get("/modules/tool-verdict", requireRoleOrMcpService("owner"), async (req, res, next) => {
    try {
      const asserted = (req.header("x-nextcloud-user") ?? "").trim();
      const verdict = await resolveVerdict(asserted === "" ? null : asserted);
      res.setHeader("Cache-Control", "no-store");
      res.json(serializeModuleVerdict(verdict));
    } catch (e) { next(e); }
  });

  // ── PATCH /api/admin/modules/:id ───────────────────────────────────────────
  router.patch("/admin/modules/:id", async (req, res, next) => {
    try {
      if (!userId(req)) { res.status(401).json({ error: "auth_required" }); return; }
      if (!isOwnerOrAdmin(req)) {
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
      // Code-resident catalogue, identical on every box: the one kind of /api
      // read allowed to override the app-wide no-store (WARP-3097).
      res.setHeader("Cache-Control", "private, max-age=300");
      res.json({ businessTypes: BUSINESS_TYPES });
    } catch (e) { next(e); }
  });

  // ── POST /api/admin/business-type ──────────────────────────────────────────
  router.post("/admin/business-type", async (req, res, next) => {
    try {
      if (!userId(req)) { res.status(401).json({ error: "auth_required" }); return; }
      if (!isOwnerOrAdmin(req)) {
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
