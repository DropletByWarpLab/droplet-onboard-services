/**
 * WARP-1906 — premade business locations: named conference rooms grouped by
 * building, offered as Location suggestions when creating a calendar event
 * (routes/calendar.ts merges them into GET /calendar/places) and managed from
 * the dashboard's Settings → Locations card.
 *
 * Endpoints (mounted behind authMiddleware; the box is a single-workspace
 * appliance — Workspace is the id=1 BUSINESS singleton, WARP-1341 — so
 * "members of the workspace" = every authenticated local user):
 *   GET    /api/workspace-locations      — list, any authenticated member
 *   POST   /api/workspace-locations      — create (owner/admin)
 *   PATCH  /api/workspace-locations/:id  — rename building/room (owner/admin)
 *   DELETE /api/workspace-locations/:id  — remove (owner/admin)
 *
 * Writes carry the same requireRole("owner", "admin") gate as the other
 * workspace admin writes (departments, access roles) and emit ActivityRow
 * audit via activity.singleton. Duplicate building+room pairs are rejected
 * 409 case-insensitively at the route layer, with the schema's
 * @@unique([building, room]) as the backstop.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient, WorkspaceLocation } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { workspaceLocationLabel } from "../services/workspace-locations.service.js";

const locationBodySchema = z.object({
  building: z.string().trim().min(1).max(120),
  room: z.string().trim().min(1).max(120),
});

const locationPatchSchema = z
  .object({
    building: z.string().trim().min(1).max(120).optional(),
    room: z.string().trim().min(1).max(120).optional(),
  })
  .refine((b) => b.building !== undefined || b.room !== undefined, {
    message: "building or room is required",
  });

/** Wire shape — includes the composed canonical `label` so every client
 *  stores the identical location string ("HQ - Room Aurora"). */
function formatLocation(row: WorkspaceLocation) {
  return {
    id: row.id,
    building: row.building,
    room: row.room,
    label: workspaceLocationLabel(row.building, row.room),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Case-insensitive duplicate probe. `excludeId` skips the row being renamed
 *  so a no-op PATCH ("HQ" → "HQ") doesn't collide with itself. */
async function findDuplicate(
  prisma: PrismaClient,
  building: string,
  room: string,
  excludeId?: string,
) {
  return prisma.workspaceLocation.findFirst({
    where: {
      building: { equals: building, mode: "insensitive" },
      room: { equals: room, mode: "insensitive" },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
}

export function createWorkspaceLocationsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/workspace-locations ────────────────────────────────
  // Any authenticated member — the settings card AND the suggestion merge in
  // /calendar/places both read this list. Ordered building-then-room so the
  // settings list groups visually by building without client-side sorting.
  router.get(
    "/workspace-locations",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.user) {
          return res.status(401).json({ error: "Authentication required" });
        }
        const rows = await prisma.workspaceLocation.findMany({
          orderBy: [{ building: "asc" }, { room: "asc" }],
        });
        res.json({ locations: rows.map(formatLocation) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/workspace-locations ───────────────────────────────
  router.post(
    "/workspace-locations",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = locationBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
        }
        const { building, room } = parsed.data;

        if (await findDuplicate(prisma, building, room)) {
          return res.status(409).json({
            error: `"${workspaceLocationLabel(building, room)}" already exists`,
            code: "DUPLICATE_LOCATION",
          });
        }

        const created = await prisma.workspaceLocation.create({
          data: {
            building,
            room,
            // Username, not the User.id UUID — Workspace.setBy attribution
            // shape (WARP-1014).
            createdBy: req.user?.username ?? "unknown",
          },
        });

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "map-pin",
          what: "Workspace location added",
          sub: workspaceLocationLabel(created.building, created.room),
          refs: {
            actor: req.user?.username ?? null,
            locationId: created.id,
          },
          actor: actorFromRequest(req),
        });

        res.status(201).json({ location: formatLocation(created) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PATCH /api/workspace-locations/:id ──────────────────────────
  router.patch(
    "/workspace-locations/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = locationPatchSchema.safeParse(req.body);
        if (!parsed.success) {
          return res
            .status(400)
            .json({ error: "Invalid request", details: parsed.error.flatten() });
        }

        const id = req.params.id;
        const existing = await prisma.workspaceLocation.findUnique({
          where: { id },
        });
        if (!existing) {
          return res
            .status(404)
            .json({ error: "Location not found", code: "NOT_FOUND" });
        }

        const building = parsed.data.building ?? existing.building;
        const room = parsed.data.room ?? existing.room;

        if (await findDuplicate(prisma, building, room, id)) {
          return res.status(409).json({
            error: `"${workspaceLocationLabel(building, room)}" already exists`,
            code: "DUPLICATE_LOCATION",
          });
        }

        const updated = await prisma.workspaceLocation.update({
          where: { id },
          data: { building, room },
        });

        await recordActivity({
          kind: "system",
          severity: "ok",
          sourceIcon: "map-pin",
          what: "Workspace location updated",
          sub: `${workspaceLocationLabel(existing.building, existing.room)} → ${workspaceLocationLabel(updated.building, updated.room)}`,
          refs: {
            actor: req.user?.username ?? null,
            locationId: updated.id,
          },
          actor: actorFromRequest(req),
        });

        res.json({ location: formatLocation(updated) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /api/workspace-locations/:id ─────────────────────────
  // Hard delete — a suggestion row is cheap config, not user data; nothing
  // references it (events store the location STRING, which stays intact on
  // rows that already picked this room).
  router.delete(
    "/workspace-locations/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = req.params.id;
        const existing = await prisma.workspaceLocation.findUnique({
          where: { id },
        });
        if (!existing) {
          return res
            .status(404)
            .json({ error: "Location not found", code: "NOT_FOUND" });
        }

        await prisma.workspaceLocation.delete({ where: { id } });

        await recordActivity({
          kind: "system",
          severity: "warn",
          sourceIcon: "map-pin",
          what: "Workspace location removed",
          sub: workspaceLocationLabel(existing.building, existing.room),
          refs: {
            actor: req.user?.username ?? null,
            locationId: existing.id,
          },
          actor: actorFromRequest(req),
        });

        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
