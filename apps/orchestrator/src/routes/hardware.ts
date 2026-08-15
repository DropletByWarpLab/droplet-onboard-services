/**
 * WARP-472 Phase F4 — `/api/hardware` (READ-ONLY, admin+owner).
 *
 * Backs FEATURES.md §9 hardware contract + §2.12 Settings →
 * Hardware. Admin-visible only per the AC.
 */
import { Router } from "express";
import { fetchGpuTelemetry } from "../lib/gpu-telemetry.js";
import type { PrismaClient } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
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

  /**
   * WARP-1861 — GET /api/hardware/gpu
   *
   * The full GPU snapshot, INCLUDING the processes holding the card. The
   * /hardware payload above carries util and temp, but not attribution — and
   * attribution is the half that answers the question an operator actually
   * asks, which is "why is it busy", not "how busy is it".
   *
   * Deliberately NOT cached alongside /hardware: that payload has a TTL
   * because it is mostly static inventory, whereas this is a live reading
   * whose whole value is being current. A cached "100%" from three minutes
   * ago is worse than no answer.
   *
   * Never 5xx on an absent bridge — it is profile-gated, so not running is an
   * ordinary state (WARP-645). Returns available:false with a reason so the
   * caller can say "unavailable" rather than invent a zero.
   */
  router.get(
    "/hardware/gpu",
    requireRoleOrMcpService("owner", "admin"),
    async (_req, res, next) => {
      try {
        const telemetry = await fetchGpuTelemetry();
        if (!telemetry) {
          res.json({
            available: false,
            reason: "device-bridge unreachable or no auth token configured",
            card: null,
            busyPercent: null,
            vramTotalBytes: null,
            vramUsedBytes: null,
            vramUsedFraction: null,
            powerWatts: null,
            tempC: null,
            processes: [],
          });
          return;
        }
        res.json(telemetry);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
