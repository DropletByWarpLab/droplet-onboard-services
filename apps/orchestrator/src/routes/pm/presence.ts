/**
 * /api/pm/work-items/:id/presence — "Also viewing" (WARP-3536, Work Suite WS-19).
 *
 *   POST  the drawer's heartbeat: "I have this item open." Records the caller for
 *         20 s and answers with everybody ELSE on it. The dashboard sends one every
 *         ~10 s, so one beat is the whole round trip.
 *   GET   the same list without joining. A read.
 *
 * Both answer `{ viewers: string[] }` — `User.id`s, the identifier every other PM
 * payload names people by, resolved to names and avatars by the client from the
 * directory it already holds. Nothing else is stored or returned.
 *
 * Gates, outermost first:
 *   - the `projects` module gate and the guest tier floor, mounted by
 *     `mountModuleGates` off the `/api/pm` prefix: a Droplet without Projects
 *     answers 404, and an external guest is refused because this path is not one
 *     of the requests `modules/guest-shares.ts` lets through the floor;
 *   - a rate limit of its own (240 / minute / address — twenty times what one
 *     open drawer needs). Its own counter, so a drawer left open all day cannot
 *     spend the budget of the board's reads;
 *   - `guestAssignedWorkItem`, the item's own read check (`GET /pm/work-items/:id`
 *     carries the same one), so the day a guest tier may use this route it can
 *     only be on an item assigned to them;
 *   - the item must exist. Without that, a heartbeat on any string would grow the
 *     in-memory store.
 * The service principal has no face to show and is refused.
 *
 * Mount order (P16): the paths here are longer than any `:id` route in the other
 * PM routers, and `/pm/work-items/:id` matches one segment, so neither shadows
 * the other.
 */
import { Router, type RequestHandler } from "express";
import type { PrismaClient } from "@prisma/client";
import { guestAssignedWorkItem } from "../../middleware/guest-share.js";
import { createRateLimit } from "../../middleware/rate-limit.js";
import { actorOf } from "./actor.js";
import { presenceStore, type PresenceStore } from "../../services/pm/pm-presence.js";

/** 240 requests / minute / address, and a counter of its own. */
export const presenceRateLimit: RequestHandler = createRateLimit("pm-presence", {
  windowMs: 60_000,
  limit: 240,
});

export interface PmPresenceRouterOptions {
  /** Defaults to the process-wide store. */
  store?: PresenceStore;
  /** Defaults to `presenceRateLimit`. */
  rateLimit?: RequestHandler;
}

export function createPmPresenceRouter(prisma: PrismaClient, opts: PmPresenceRouterOptions = {}): Router {
  const router = Router();
  const store = opts.store ?? presenceStore;
  const limit = opts.rateLimit ?? presenceRateLimit;
  const sharedItem = guestAssignedWorkItem(prisma);

  const viewers =
    (record: boolean): RequestHandler =>
    async (req, res, next) => {
      try {
        if (!req.user) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        // `actorOf` is null for the MCP principal, which is also `role: "service"`.
        const userId = actorOf(req);
        if (!userId || req.user.role === "service") {
          res.status(403).json({ error: "presence_requires_user" });
          return;
        }
        const id = String(req.params.id);
        const item = await prisma.pmWorkItem.findUnique({ where: { id }, select: { id: true } });
        if (!item) {
          res.status(404).json({ error: "work_item_not_found" });
          return;
        }
        if (record) store.beat(id, userId);
        res.json({ viewers: store.others(id, userId) });
      } catch (err) {
        next(err);
      }
    };

  router.post("/pm/work-items/:id/presence", limit, sharedItem, viewers(true));
  router.get("/pm/work-items/:id/presence", limit, sharedItem, viewers(false));

  return router;
}
