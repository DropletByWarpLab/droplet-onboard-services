/**
 * WARP-472 Phase F4 — `/api/hardware` (READ-ONLY, admin+owner).
 *
 * Backs FEATURES.md §9 hardware contract + §2.12 Settings →
 * Hardware. Admin-visible only per the AC.
 */
import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import {
  getHardwarePayload,
  type HardwarePayload,
} from "../services/hardware-summary.service.js";

const HARDWARE_CACHE_KEY = "hardware:summary";
const HARDWARE_CACHE_TTL = 30;

export function createHardwareRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/hardware",
    requireRole("owner", "admin"),
    async (_req, res, next) => {
      try {
        const cached = await cacheGet<HardwarePayload>(HARDWARE_CACHE_KEY);
        if (cached) {
          res.json(cached);
          return;
        }
        const payload = await getHardwarePayload(prisma);
        await cacheSet(HARDWARE_CACHE_KEY, payload, HARDWARE_CACHE_TTL);
        res.json(payload);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
