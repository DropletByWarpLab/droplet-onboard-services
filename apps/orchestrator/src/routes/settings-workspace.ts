/**
 * `/api/settings/workspace` — Home vs Business workspace selection.
 *
 * Per ADR-007 + ADR-009, every Droplet has a workspace type that
 * gates which admin surfaces render in the dashboard (Roles matrix,
 * Groups, Sessions, full People, Plan/Billing — Business only).
 * The setting is a singleton row in `Workspace` (id = 1).
 *
 * Endpoints:
 *   GET  /api/settings/workspace
 *     → { workspaceType, displayName?, setBy?, setAt }
 *     Any authenticated user reads it (drives the chrome pill).
 *     If the row doesn't exist yet, returns the HOME default so the
 *     dashboard's WorkspaceProvider can render before the setup
 *     wizard has run.
 *
 *   POST /api/settings/workspace
 *     Body: { workspaceType: "home"|"business", displayName?: string }
 *     → { workspaceType, displayName?, setBy, setAt }
 *     Owner-only. Records who flipped it + when so we have an audit
 *     trail. Idempotent — setting Home when already Home is a no-op
 *     200, not a 400.
 *
 * Phase 4b (separate PR off the wizard branch) adds a wizard step
 * that calls POST once at first-run. This route is the orchestrator
 * half; the dashboard half lives in
 * `apps/web-dashboard/src/lib/workspace.tsx` which hydrates from GET
 * and falls back to localStorage on 404 (so Docker-dev stacks
 * without this route still work).
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

function getUserId(req: Request): string | null {
  const u = getUser(req);
  return u?.username ?? u?.id ?? null;
}

/** Wire-shape WorkspaceType — lowercase string for the dashboard's
 *  `useWorkspace()` hook. Prisma's enum is uppercase. */
function toWireType(t: WorkspaceType): "home" | "business" {
  return t === WorkspaceType.BUSINESS ? "business" : "home";
}

function fromWireType(s: string): WorkspaceType | null {
  if (s === "home") return WorkspaceType.HOME;
  if (s === "business") return WorkspaceType.BUSINESS;
  return null;
}

const postBodySchema = z.object({
  workspaceType: z.enum(["home", "business"]),
  displayName: z.string().min(1).max(120).optional(),
});

export function createSettingsWorkspaceRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/settings/workspace ────────────────────────────────
  router.get("/settings/workspace", async (req, res, next) => {
    try {
      if (!getUserId(req)) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      // Singleton — id = 1. findUnique returns null if the wizard
      // hasn't run yet; the HOME default ships in that case so the
      // dashboard chrome can paint before any user has a chance to
      // pick.
      const row = await prisma.workspace.findUnique({ where: { id: 1 } });
      if (!row) {
        res.json({
          workspaceType: "home",
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
      if (!user || !getUserId(req)) {
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

      const setBy = getUserId(req)!;
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
