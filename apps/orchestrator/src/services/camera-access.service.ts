/**
 * WARP-1962 — per-camera access.
 *
 * ## Why this exists
 *
 * Role tiers (WARP-1961) answer *"may this person watch recordings at
 * all"*. They cannot answer *"may this person watch **the bedroom**"* —
 * which is the actual household question. A `family` member who should see
 * the front door and the driveway otherwise sees every camera in the house.
 *
 * ## Why it is ONE module
 *
 * The gap WARP-1961 closed happened because enforcement was scattered:
 * 48 of ~76 camera routes had a guard and nobody noticed the other 28.
 * Access resolution lives here, in one place, and every camera route goes
 * through it. A route cannot half-implement this.
 *
 * ## The default
 *
 * A camera with NO grants is visible to `owner`/`admin` and to nobody else.
 * That is deliberate: adding a camera must never silently expose it to the
 * whole household. It is the safe direction to be wrong in — a missing
 * grant is an inconvenience, an unintended one is a person watched without
 * knowing.
 *
 * Owners and admins do not draw access from the grant table at all. They
 * administer the appliance; a table row cannot lock them out of it, and an
 * empty table must not brick the cameras page on a fresh install.
 */

import type { PrismaClient } from "@prisma/client";
import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("camera-access");

/**
 * Roles that see every camera without a grant.
 *
 * Kept separate from WARP-1961's `CAMERA_VIEW_ROLES` on purpose: that list
 * says who may reach the camera surface at all, this one says who bypasses
 * per-camera scoping. `family` is in the first and NOT the second — that
 * difference is the whole feature.
 */
const UNRESTRICTED_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

/**
 * The MCP service principal. Tools dispatch on behalf of a human whose
 * role was already checked at the tool layer, and the principal itself has
 * no camera grants — so it must not be silently reduced to "sees nothing".
 *
 * ⚠ This means per-camera scoping does NOT currently narrow the assistant.
 * Threading the acting user's identity through the tool dispatch is a
 * follow-up on WARP-1962; it is called out in the PR rather than papered
 * over here, because a comment claiming otherwise would be worse than the
 * gap itself.
 */
const MCP_SERVICE_ID = "_service:mcp";

export interface AccessPrincipal {
  id?: string;
  role?: string;
}

/**
 * Which cameras may this principal see?
 *
 * Returns `"all"` for principals that bypass scoping, or a Set of camera
 * NAMES (the key the rest of the API uses, not the row id).
 */
export async function visibleCameraNames(
  prisma: PrismaClient,
  user: AccessPrincipal | undefined,
): Promise<"all" | Set<string>> {
  if (!user?.role) return new Set();
  if (UNRESTRICTED_ROLES.has(user.role)) return "all";
  if (user.id === MCP_SERVICE_ID) return "all";
  if (!user.id) return new Set();

  const grants = await prisma.cameraAccessGrant.findMany({
    where: { userId: user.id },
    select: { camera: { select: { name: true } } },
  });
  return new Set(grants.map((g) => g.camera.name));
}

/** May this principal touch this specific camera? */
export async function canAccessCamera(
  prisma: PrismaClient,
  user: AccessPrincipal | undefined,
  cameraName: string,
): Promise<boolean> {
  const visible = await visibleCameraNames(prisma, user);
  return visible === "all" || visible.has(cameraName);
}

/**
 * Filter a list of camera-shaped rows down to what this principal may see.
 *
 * Used by `GET /cameras` so the grid, the home widget and the group rail
 * agree with what playback will actually allow. A tile you cannot open is
 * worse than no tile.
 */
export async function filterVisibleCameras<T extends { name: string }>(
  prisma: PrismaClient,
  user: AccessPrincipal | undefined,
  cameras: T[],
): Promise<T[]> {
  const visible = await visibleCameraNames(prisma, user);
  if (visible === "all") return cameras;
  return cameras.filter((c) => visible.has(c.name));
}

/**
 * Express guard for any route carrying a camera name in `:name`.
 *
 * 404, not 403, on a denied camera. A 403 confirms the camera EXISTS,
 * which leaks the shape of the household to someone who was not meant to
 * know it — "there is a camera called `bedroom` and you may not see it" is
 * itself information. An absent camera and a forbidden one are reported
 * identically.
 */
export function requireCameraAccess(prisma: PrismaClient) {
  return function cameraAccessGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const name = req.params.name;
    if (typeof name !== "string" || name.length === 0) {
      next();
      return;
    }
    canAccessCamera(prisma, req.user, name)
      .then((ok) => {
        if (ok) {
          next();
          return;
        }
        logger.info(
          { userId: req.user?.id, role: req.user?.role, camera: name },
          "camera access denied by per-camera grant",
        );
        res.status(404).json({ error: "Camera not found" });
      })
      .catch((err) => {
        // Fail CLOSED. A database blip must not become "everyone sees
        // everything" — the whole point of the module is that absence of
        // an answer is not permission.
        logger.error({ err, camera: name }, "camera access check failed; denying");
        res.status(503).json({ error: "access_check_unavailable" });
      });
  };
}

/** List the camera names a given user has been granted, for the admin UI. */
export async function listGrantsForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<string[]> {
  const grants = await prisma.cameraAccessGrant.findMany({
    where: { userId },
    select: { camera: { select: { name: true } } },
  });
  return grants.map((g) => g.camera.name).sort();
}

/**
 * Replace a user's grants wholesale.
 *
 * Set semantics rather than add/remove: the admin UI edits a checklist, and
 * a diff computed client-side would race a second admin editing the same
 * person. Unknown camera names are reported rather than silently dropped —
 * a typo that quietly grants nothing looks identical to success.
 */
export async function setGrantsForUser(
  prisma: PrismaClient,
  userId: string,
  cameraNames: string[],
  grantedBy?: string,
): Promise<{ granted: string[]; unknown: string[] }> {
  const wanted = [...new Set(cameraNames)];
  const cameras = await prisma.camera.findMany({
    where: { name: { in: wanted } },
    select: { id: true, name: true },
  });
  const found = new Map(cameras.map((c) => [c.name, c.id]));
  const unknown = wanted.filter((n) => !found.has(n));

  await prisma.$transaction([
    prisma.cameraAccessGrant.deleteMany({ where: { userId } }),
    ...cameras.map((c) =>
      prisma.cameraAccessGrant.create({
        data: { userId, cameraId: c.id, grantedBy: grantedBy ?? null },
      }),
    ),
  ]);

  return { granted: cameras.map((c) => c.name).sort(), unknown };
}
