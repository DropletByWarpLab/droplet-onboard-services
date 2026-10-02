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
import { resolveAssertedUser } from "./asserted-user.service.js";

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
 * The MCP service principal.
 *
 * WARP-1962 shipped this returning `"all"` — tools dispatch on behalf of a
 * human, the principal holds no grants of its own, and denying it outright
 * would have killed every camera tool. The cost was that per-camera scoping
 * did not narrow the assistant at all: a `family` member granted only the
 * front door was blocked in the dashboard and could still ask the
 * assistant about the bedroom.
 *
 * WARP-1975 closes that. The principal now resolves the **acting user**
 * from the `X-Nextcloud-User` header the MCP server already asserts, the
 * same mechanism `middleware/space.ts` uses for department access, and
 * scopes to that human's grants. It fails CLOSED when the header is absent,
 * names nobody, names more than one person, or names a deactivated person
 * (WARP-3061) — a tool that cannot say who is asking gets nothing.
 */
const MCP_SERVICE_ID = "_service:mcp";

export interface AccessPrincipal {
  id?: string;
  role?: string;
  /**
   * The acting human the MCP server asserts in `X-Nextcloud-User`. Despite
   * the header's name this is `User.username` (stdio) or `User.id` (HTTP
   * transport), not a Nextcloud username — see asserted-user.service.ts
   * (WARP-3061). Only consulted for `_service:mcp`; ignored for everyone
   * else, so a header cannot be used to impersonate.
   */
  assertedUser?: string | null;
}

/**
 * Lift the principal to scope by out of a request.
 *
 * For a human this is just `req.user`. For `_service:mcp` it carries the
 * asserted user through so `visibleCameraNames` can resolve the human
 * behind the tool call.
 */
export function principalFromRequest(req: {
  user?: { id?: string; role?: string };
  header?: (name: string) => string | undefined;
}): AccessPrincipal {
  return {
    id: req.user?.id,
    role: req.user?.role,
    assertedUser: req.header?.("x-nextcloud-user")?.trim() || null,
  };
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

  // Resolve the human behind a tool call. Same assertion mechanism as
  // middleware/space.ts, and the same posture: no asserted user, or one
  // that resolves to nobody, to more than one person or to a deactivated
  // one, means NOTHING — never everything. A tool that cannot say who is
  // asking has not earned an answer.
  let scopeUserId = user.id;
  if (user.id === MCP_SERVICE_ID) {
    const asserted = user.assertedUser;
    if (!asserted) {
      logger.warn("MCP camera access with no asserted user; denying");
      return new Set();
    }
    const resolved = await resolveAssertedUser(prisma, asserted);
    if (!resolved.ok) {
      logger.warn({ asserted, reason: resolved.reason }, "MCP asserted user did not resolve to one active person; denying");
      return new Set();
    }
    const acting = resolved.user;
    // The acting human's OWN role decides — an owner asking through the
    // assistant still sees everything, a family member does not.
    if (UNRESTRICTED_ROLES.has(acting.role)) return "all";
    scopeUserId = acting.id;
  }

  if (!scopeUserId) return new Set();

  const grants = await prisma.cameraAccessGrant.findMany({
    where: { userId: scopeUserId },
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

/** What `visibleCameraNames` resolves to: every camera, or these names. */
export type CameraScope = "all" | Set<string>;

/** Is this camera inside the scope? */
export function inCameraScope(scope: CameraScope, cameraName: string): boolean {
  return scope === "all" || scope.has(cameraName);
}

/**
 * WARP-3013 — Frigate's face library keeps its recent recognition attempts
 * in a folder named `train`, next to the people someone named. Those are
 * face crops from EVERY camera (`{event_id}-{timestamp}-{sub_label}-{score}.webp`,
 * frigate/data_processing/real_time/face.py @ 0.17.1), not a roster anyone
 * curated, and `/api/faces` lists the folder like a person.
 */
export const FRIGATE_FACE_TRAIN_FOLDER = "train";

/**
 * May this scope see (or remove images in) this face-library folder?
 *
 * `train` is for a caller who sees every camera. A grant on every CURRENT
 * camera is still not "all": a camera added tomorrow would be ungranted,
 * and its crops would land in the same folder. Named people stay
 * household-wide. Exact match: folder names are case-sensitive on the box,
 * so `Train` is someone's name, not Frigate's folder.
 */
export function canSeeFaceFolder(scope: CameraScope, folder: string): boolean {
  return scope === "all" || folder !== FRIGATE_FACE_TRAIN_FOLDER;
}

/**
 * WARP-2982 — narrow a caller-supplied camera filter to the scope, BEFORE
 * it reaches Frigate, so `limit` and cursor pagination count only cameras
 * the caller may see.
 *
 * - `undefined` → no filter needed (scope is "all" and nothing requested).
 * - `[]`        → nothing is visible. The Frigate client answers an empty
 *                 camera list with an empty result without querying; it
 *                 must never be read as "no filter".
 */
export function narrowCameraFilter(
  scope: CameraScope,
  requested?: string[],
): string[] | undefined {
  if (scope === "all") return requested;
  return requested ? requested.filter((c) => scope.has(c)) : [...scope];
}

/**
 * The scope `cameraAccessGuard` resolved for this request.
 *
 * Throws rather than defaulting: a handler reading a scope the guard never
 * set is a wiring bug, and the only safe answer to it is no answer.
 */
export function cameraScopeOf(res: Response): CameraScope {
  const scope = res.locals.cameraScope as CameraScope | undefined;
  if (scope === undefined) {
    throw new Error("cameraScopeOf: route is missing cameraAccessGuard");
  }
  return scope;
}

/**
 * Resolve the camera that owns a Frigate event / review id. `null` means
 * Frigate does not know the id.
 */
export interface CameraOwnerResolvers {
  eventCamera?: (eventId: string) => Promise<string | null>;
  reviewCamera?: (reviewId: string) => Promise<string | null>;
}

/**
 * Express guard for every route that returns or touches camera-derived data.
 *
 * It resolves the caller's scope ONCE and leaves it on `res.locals` for
 * the handler (`cameraScopeOf`). Then it checks the one camera the route
 * names, however it names it:
 *
 *  - `:name` on a `/cameras/:name…` route — the camera itself;
 *  - `:eventId` — the camera that recorded the event (WARP-2982);
 *  - `:reviewId` — the camera the review cluster belongs to (WARP-2982).
 *
 * Cross-camera routes (lists, search, SSE) name no camera; they get the
 * scope and must narrow with it. Before WARP-2982 this guard only knew
 * `:name`, so every one of those routes silently passed.
 *
 * 404, not 403, on a denied camera. A 403 confirms the camera EXISTS,
 * which leaks the shape of the household to someone who was not meant to
 * know it — "there is a camera called `bedroom` and you may not see it" is
 * itself information. An absent camera and a forbidden one are reported
 * identically; the same goes for an event id on a camera you cannot see.
 */
export function requireCameraAccess(
  prisma: PrismaClient,
  resolvers: CameraOwnerResolvers = {},
) {
  return function cameraAccessGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const principal = principalFromRequest(req);

    // A SERVICE that forgot to say who it is asking for is a different
    // failure from a person asking about a camera they may not see.
    //
    // 404 exists to avoid confirming a camera's existence to a HUMAN who
    // is enumerating. A trusted service principal is not enumerating — it
    // has a bug or a missing header, and answering "Camera not found"
    // sends it hunting for a camera-name problem it does not have. Say the
    // real thing; it discloses nothing a service principal cannot already
    // learn from any other route.
    if (principal.id === MCP_SERVICE_ID && !principal.assertedUser) {
      logger.warn({ path: req.path }, "MCP camera request with no asserted user");
      res.status(401).json({
        error: "no_asserted_user",
        message:
          "Camera access is scoped to the acting user; assert one with X-Nextcloud-User.",
      });
      return;
    }

    // `:name` means a CAMERA only on `/cameras/:name…`; `/cameras/faces/:name`
    // names a person.
    const routePath: string = typeof req.route?.path === "string" ? req.route.path : "";
    const cameraParam =
      routePath.startsWith("/cameras/:name") && typeof req.params.name === "string"
        ? req.params.name
        : undefined;
    const eventId = typeof req.params.eventId === "string" ? req.params.eventId : undefined;
    const reviewId = typeof req.params.reviewId === "string" ? req.params.reviewId : undefined;

    (async (): Promise<boolean> => {
      const scope = await visibleCameraNames(prisma, principal);
      res.locals.cameraScope = scope;
      if (scope === "all") return true;

      let target: string | null | undefined = cameraParam;
      if (target === undefined && eventId !== undefined) {
        if (!resolvers.eventCamera) throw new Error("no event→camera resolver");
        target = await resolvers.eventCamera(eventId);
      } else if (target === undefined && reviewId !== undefined) {
        if (!resolvers.reviewCamera) throw new Error("no review→camera resolver");
        target = await resolvers.reviewCamera(reviewId);
      }
      if (target === undefined) return true; // cross-camera route: handler narrows
      return target !== null && scope.has(target);
    })()
      .then((ok) => {
        if (ok) {
          next();
          return;
        }
        logger.info(
          { userId: req.user?.id, role: req.user?.role, camera: cameraParam, eventId, reviewId },
          "camera access denied by per-camera grant",
        );
        res.status(404).json({ error: cameraParam ? "Camera not found" : "Not found" });
      })
      .catch((err) => {
        // Fail CLOSED. A database blip must not become "everyone sees
        // everything" — the whole point of the module is that absence of
        // an answer is not permission.
        logger.error({ err, camera: cameraParam, eventId, reviewId }, "camera access check failed; denying");
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

  // WARP-2982: a revoked camera must also stop PUSHING. Notification prefs
  // outlive grants otherwise, and a person who can no longer open the
  // camera kept getting "Person detected" for it. Owners/admins draw no
  // access from grants, so their prefs are left alone.
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const pruneOrphanedPrefs = !(target && UNRESTRICTED_ROLES.has(target.role));

  await prisma.$transaction([
    prisma.cameraAccessGrant.deleteMany({ where: { userId } }),
    ...cameras.map((c) =>
      prisma.cameraAccessGrant.create({
        data: { userId, cameraId: c.id, grantedBy: grantedBy ?? null },
      }),
    ),
    ...(pruneOrphanedPrefs
      ? [
          prisma.cameraNotificationPref.deleteMany({
            where: { userId, cameraId: { notIn: cameras.map((c) => c.id) } },
          }),
        ]
      : []),
  ]);

  return { granted: cameras.map((c) => c.name).sort(), unknown };
}
