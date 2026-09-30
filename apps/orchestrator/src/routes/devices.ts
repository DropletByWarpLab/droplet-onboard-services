import { Router } from "express";
import { requireRole } from "../middleware/auth.js";
import { listDevices } from "../services/device.service.js";

export function createDevicesRouter(): Router {
  const router = Router();

  // WARP-3378 (Romain, 2026-09-30: an external guest gets nothing of the
  // company's data unless it is shared with them). The Device row is the box's
  // own hostname, hardware revision, network mode and IP address; a guest has
  // no use for it. Pairing, push and the caller's own device list live on the
  // sibling `/devices/*` routers, which this does not touch.
  router.get("/devices", requireRole("owner", "admin", "family"), async (_req, res, next) => {
    try {
      const devices = await listDevices();
      res.json(devices);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
