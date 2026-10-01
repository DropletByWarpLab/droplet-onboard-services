import { Router } from "express";
import { requireRole } from "../middleware/auth.js";
import { listDevices } from "../services/device.service.js";
import type { DeviceInfo } from "../types/index.js";

/**
 * What a member may see of the box's own Device row: who it is, not where it is
 * on the network. An allowlist rather than an omit, so a column added to the row
 * later is withheld from a member until someone decides otherwise.
 */
function forMember(d: DeviceInfo): Omit<DeviceInfo, "ip" | "networkMode"> {
  return {
    id: d.id,
    deviceId: d.deviceId,
    hostname: d.hostname,
    hardwareRev: d.hardwareRev,
    lastSeen: d.lastSeen,
  };
}

export function createDevicesRouter(): Router {
  const router = Router();

  // WARP-3378 (Romain, 2026-09-30). The Device row is the box's own hostname,
  // hardware revision, network mode and IP address. Network mode and the IP are
  // infrastructure facts an owner or admin acts on: they go to owner and admin
  // only. A member gets the hostname and hardware revision (the dashboard's
  // header chip and Settings card), and an external guest gets nothing. Pairing,
  // push and the caller's own device list live on the sibling `/devices/*`
  // routers, which this does not touch.
  router.get("/devices", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const devices = await listDevices();
      const operator = req.user?.role === "owner" || req.user?.role === "admin";
      res.json(operator ? devices : devices.map(forMember));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
