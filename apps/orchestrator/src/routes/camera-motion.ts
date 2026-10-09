import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRoleOrMcpService } from "../middleware/auth.js";
import { CAMERA_VIEW_ROLES, cameraScopeOf, narrowCameraFilter, requireCameraAccess } from "../services/camera-access.service.js";
import { getCameras } from "../services/camera.service.js";
import { getMotionActivity } from "../services/camera-motion.service.js";

/** Motion queries cover one day (including a 25-hour DST day), rather than an
 * unbounded archive scan. Camera scope is resolved before any recording fetch. */
export function createCameraMotionRouter(prisma: PrismaClient): Router {
  const router = Router();
  // WARP-3927: MCP-admitted so get_camera_motion / summarize_camera_activity
  // reach it; requireCameraAccess still scopes to the acting person's cameras.
  router.get("/cameras/motion", requireRoleOrMcpService(...CAMERA_VIEW_ROLES), requireCameraAccess(prisma), async (req, res, next) => {
    try {
      const q = req.query;
      for (const key of ["cameras", "after", "before", "cursor", "limit", "businessHours"] as const) {
        if (q[key] !== undefined && typeof q[key] !== "string") return res.status(400).json({ error: `Invalid ${key}` });
      }
      const now = Date.now() / 1000;
      const before = q.before === undefined ? now : Number(q.before);
      const after = q.after === undefined ? before - 86400 : Number(q.after);
      if (!Number.isFinite(after) || !Number.isFinite(before) || after <= 0 || before <= after
        || before - after > 26 * 3600 || before > now + 120) {
        return res.status(400).json({ error: "Motion requires a valid time window of at most 26 hours" });
      }
      const cursor = q.cursor === undefined ? undefined : Number(q.cursor);
      if (cursor !== undefined && (!Number.isFinite(cursor) || cursor < after || cursor > before)) {
        return res.status(400).json({ error: "Invalid motion cursor" });
      }
      const limit = q.limit === undefined ? 50 : Number(q.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: "Motion limit must be between 1 and 200" });
      const businessHours = q.businessHours;
      if (businessHours !== undefined && businessHours !== "outside" && businessHours !== "inside") {
        return res.status(400).json({ error: "businessHours must be outside or inside" });
      }
      const requested = q.cameras === undefined ? undefined : String(q.cameras).split(",").filter(Boolean);
      if (requested?.some((camera) => !/^[A-Za-z0-9_-]{1,64}$/.test(camera))) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const narrowed = narrowCameraFilter(cameraScopeOf(res), requested);
      const cameras = narrowed ?? (await getCameras(prisma)).map((camera) => camera.name);
      res.json(await getMotionActivity(prisma, cameras, { after, before, cursor, limit, businessHours }));
    } catch (err) { next(err); }
  });
  return router;
}
