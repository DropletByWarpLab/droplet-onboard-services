/**
 * `/api/settings/workspace` — workspace settings (business-only build).
 *
 * Per ADR-007 + ADR-009, the workspace type gates which admin surfaces
 * render in the dashboard (Roles matrix, Groups, Sessions, full People,
 * Plan/Billing). WARP-1341: this build ships business-only, so BUSINESS
 * is the only accepted and only reported type — "home" on the wire is a
 * 400, and the missing-row default is business.
 * The setting is a singleton row in `Workspace` (id = 1).
 *
 * Endpoints:
 *   GET  /api/settings/workspace
 *     → { workspaceType, displayName?, setBy?, setAt }
 *     Any authenticated user reads it (drives the chrome pill).
 *     If the row doesn't exist yet, returns the BUSINESS default so the
 *     dashboard's WorkspaceProvider can render before the setup
 *     wizard has run.
 *
 *   POST /api/settings/workspace
 *     Body: { workspaceType: "business", displayName?: string }
 *     → { workspaceType, displayName?, setBy, setAt }
 *     Owner-only. Records who set it + when so we have an audit
 *     trail. Idempotent — re-posting "business" is a no-op 200,
 *     not a 400.
 *
 * The setup wizard's org step calls POST once at first-run to pin the
 * singleton to BUSINESS. This route is the orchestrator half; the
 * dashboard half in `apps/web-dashboard/src/lib/workspace.tsx` is now a
 * static business-only context (WARP-1341) — it no longer hydrates the
 * type from GET or falls back to localStorage. GET/POST here remain the
 * audit + display-name surface (the chrome pill reads `displayName`).
 */

import { Router, type Request } from "express";
import { WorkspaceType, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("settings-workspace-route");

interface AuthedUser {
  id?: string;
  username?: string;
  role?: string;
}

function getUser(req: Request): AuthedUser | null {
  return ((req as Request & { user?: AuthedUser }).user) ?? null;
}

/**
 * WARP-1014 key-shape audit — `Workspace.setBy` stores the USERNAME.
 *
 * The schema documents the column as "Nextcloud username from the auth
 * middleware", and every existing row was written that way: the
 * pre-audit helper fell back `username ?? id`, but the auth middleware
 * always sets `username`, so the fallback never fired. `setBy` is
 * display/audit attribution, not a `User` FK — keep writing the
 * username explicitly; switching to the `User.id` UUID would fork the
 * shape of existing rows without a backfill.
 */
function getUsername(req: Request): string | null {
  return getUser(req)?.username ?? null;
}

/** Wire-shape WorkspaceType — lowercase string for the dashboard's
 *  `useWorkspace()` hook. Prisma's enum is uppercase. WARP-1341: a
 *  pre-migration HOME row (should not exist after the data migration)
 *  is still reported as "business" — the wire contract has one value. */
function toWireType(_t: WorkspaceType): "business" {
  return "business";
}

function fromWireType(s: string): WorkspaceType | null {
  if (s === "business") return WorkspaceType.BUSINESS;
  return null;
}

const postBodySchema = z.object({
  // WARP-1341: business-only — "home" is rejected as invalid_body.
  workspaceType: z.enum(["business"]),
  displayName: z.string().min(1).max(120).optional(),
});

export function createSettingsWorkspaceRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/settings/workspace ────────────────────────────────
  router.get("/settings/workspace", async (req, res, next) => {
    try {
      if (!getUsername(req)) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      // Singleton — id = 1. findUnique returns null if the wizard
      // hasn't run yet; the BUSINESS default ships in that case so the
      // dashboard chrome can paint before the wizard has written the
      // row (WARP-1341: business is the only mode).
      const row = await prisma.workspace.findUnique({ where: { id: 1 } });
      if (!row) {
        res.json({
          workspaceType: "business",
          displayName: null,
          setBy: null,
          setAt: null,
        });
        return;
      }
      res.json({
        workspaceType: toWireType(row.type),
        displayName: row.displayName,
        setBy: row.setBy,
        setAt: row.setAt.toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });

  // ── POST /api/settings/workspace ───────────────────────────────
  router.post("/settings/workspace", async (req, res, next) => {
    try {
      const user = getUser(req);
      if (!user || !getUsername(req)) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      // ADR-009 + ADR-002: only owner can flip workspace type. Admin
      // can manage other settings but workspace type is a one-time
      // strategic call.
      if (user.role !== "owner") {
        res.status(403).json({
          error: "owner_required",
          message: "Only the owner can change the workspace type.",
        });
        return;
      }

      const parsed = postBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_body",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        });
        return;
      }
      const wantType = fromWireType(parsed.data.workspaceType);
      if (!wantType) {
        res.status(400).json({ error: "invalid_workspace_type" });
        return;
      }

      const setBy = getUsername(req)!;
      const row = await prisma.workspace.upsert({
        where: { id: 1 },
        update: {
          type: wantType,
          // `?? null` (not `?? undefined`) so an owner can clear the
          // display name by POSTing without it. Prisma skips `undefined`
          // fields on update, which would silently preserve the old
          // value. `null` writes through. Mirrors the `create` branch.
          displayName: parsed.data.displayName ?? null,
          setBy,
          setAt: new Date(),
        },
        create: {
          id: 1,
          type: wantType,
          displayName: parsed.data.displayName ?? null,
          setBy,
        },
      });

      logger.info(
        { user: setBy, workspaceType: row.type, displayName: row.displayName },
        "workspace_type_set"
      );

      res.json({
        workspaceType: toWireType(row.type),
        displayName: row.displayName,
        setBy: row.setBy,
        setAt: row.setAt.toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
