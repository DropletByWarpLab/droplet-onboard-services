import { Router } from "express";
import { listDevices } from "../services/device.service.js";

export function createDevicesRouter(): Router {
  const router = Router();

  router.get("/devices", async (_req, res, next) => {
    try {
      const devices = await listDevices();
      res.json(devices);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
