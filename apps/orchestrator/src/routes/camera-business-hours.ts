import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { requireRole } from "../middleware/auth.js";
import { requireFeatureAccess } from "../middleware/feature-gate.js";
import { CAMERA_VIEW_ROLES } from "../services/camera-access.service.js";
import { getCameraBusinessHours, saveCameraBusinessHours } from "../services/camera-business-hours.service.js";

/** Mount before cameras' /:name routes. Authentication is supplied by /api. */
export function createCameraBusinessHoursRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get("/cameras/business-hours", requireRole(...CAMERA_VIEW_ROLES), async (_req, res, next) => {
    try { res.json(await getCameraBusinessHours(prisma)); } catch (err) { next(err); }
  });
  router.put("/cameras/business-hours", requireRole("owner", "admin"), requireFeatureAccess("cameras", "manage"), async (req, res, next) => {
    try { res.json(await saveCameraBusinessHours(prisma, req.body)); }
    catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: "Invalid business hours", details: err.issues.map((issue) => ({
          path: issue.path.join("."), message: issue.message,
        })) });
        return;
      }
      next(err);
    }
  });
  return router;
}
