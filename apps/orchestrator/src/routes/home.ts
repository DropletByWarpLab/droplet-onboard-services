/**
 * WARP-469 Phase F1 — Home aggregation endpoint.
 *
 * Single round-trip `GET /api/home` that backs the Home page in
 * FEATURES.md §2.1. Per-user Redis cache with a 30 s TTL keeps the
 * dashboard snappy without hammering ActivityRow on every reload.
 */
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { getHomePayload, type HomePayload } from "../services/home-aggregation.service.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; displayName?: string; role?: string };
};

const HOME_CACHE_TTL_SECONDS = 30;

function cacheKeyFor(user: AuthedRequest["user"]): string {
  const id = user?.id ?? user?.username ?? "anon";
  return `home:${id}`;
}

export function createHomeRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/home",
    requireRole("owner", "admin", "family", "guest"),
    async (req, res, next) => {
      try {
        const user = (req as AuthedRequest).user ?? {};
        const cacheKey = cacheKeyFor(user);
        const cached = await cacheGet<HomePayload>(cacheKey);
        if (cached) {
          res.json(cached);
          return;
        }
        const payload = await getHomePayload(prisma, user);
        await cacheSet(cacheKey, payload, HOME_CACHE_TTL_SECONDS);
        res.json(payload);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
