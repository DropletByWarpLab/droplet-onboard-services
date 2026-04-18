/**
 * WARP-82: NetworkDevice registry routes — per-device GET/PATCH/DELETE,
 * group-membership assignment, and the `/network/groups` CRUD surface.
 *
 * All Prisma access goes through `networkDeviceService`; route handlers
 * do thin arg-marshalling and hand `DeviceRegistryError` back through
 * the shared `handleRegistryError` helper.
 */

import type { Router } from "express";
import type { createNetworkDeviceService } from "../services/network-device.service.js";
import { handleRegistryError } from "./network-error-handler.js";

export interface DeviceDeps {
  networkDeviceService: ReturnType<typeof createNetworkDeviceService>;
}

export function registerDeviceRoutes(router: Router, deps: DeviceDeps): void {
  const { networkDeviceService } = deps;

  // --- WARP-82: single device + mutations ---

  router.get("/network/devices/:mac", async (req, res, next) => {
    try {
      const result = await networkDeviceService.getDevice(req.params.mac);
      res.json(result);
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.patch("/network/devices/:mac", async (req, res, next) => {
    try {
      const { displayName, icon, notes } = req.body ?? {};
      const patch: { displayName?: string; icon?: string; notes?: string } = {};
      if (displayName !== undefined) {
        if (typeof displayName !== "string") {
          return res.status(400).json({ error: "displayName must be a string" });
        }
        patch.displayName = displayName;
      }
      if (icon !== undefined) {
        if (typeof icon !== "string") {
          return res.status(400).json({ error: "icon must be a string" });
        }
        patch.icon = icon;
      }
      if (notes !== undefined) {
        if (typeof notes !== "string") {
          return res.status(400).json({ error: "notes must be a string" });
        }
        patch.notes = notes;
      }
      const device = await networkDeviceService.updateDevice(req.params.mac, patch);
      res.json({ device });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/devices/:mac/groups", async (req, res, next) => {
    try {
      const { groupIds } = req.body ?? {};
      if (!Array.isArray(groupIds) || !groupIds.every((x) => typeof x === "string")) {
        return res
          .status(400)
          .json({ error: "Body must be { groupIds: string[] }" });
      }
      const device = await networkDeviceService.assignDeviceGroups(
        req.params.mac,
        groupIds,
      );
      res.json({ device });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/devices/:mac", async (req, res, next) => {
    try {
      await networkDeviceService.forgetDevice(req.params.mac);
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  // --- WARP-82: groups ---

  router.get("/network/groups", async (_req, res, next) => {
    try {
      const groups = await networkDeviceService.listGroups();
      res.json({ groups });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.post("/network/groups", async (req, res, next) => {
    try {
      const { name, color, icon } = req.body ?? {};
      if (typeof name !== "string" || name.trim().length === 0) {
        return res.status(400).json({ error: "name is required" });
      }
      if (color !== undefined && typeof color !== "string") {
        return res.status(400).json({ error: "color must be a string" });
      }
      if (icon !== undefined && typeof icon !== "string") {
        return res.status(400).json({ error: "icon must be a string" });
      }
      const group = await networkDeviceService.createGroup(name, color, icon);
      res.status(201).json({ group });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.patch("/network/groups/:id", async (req, res, next) => {
    try {
      const { name, color, icon } = req.body ?? {};
      const patch: { name?: string; color?: string; icon?: string } = {};
      if (name !== undefined) {
        if (typeof name !== "string") {
          return res.status(400).json({ error: "name must be a string" });
        }
        patch.name = name;
      }
      if (color !== undefined) {
        if (typeof color !== "string") {
          return res.status(400).json({ error: "color must be a string" });
        }
        patch.color = color;
      }
      if (icon !== undefined) {
        if (typeof icon !== "string") {
          return res.status(400).json({ error: "icon must be a string" });
        }
        patch.icon = icon;
      }
      const group = await networkDeviceService.renameGroup(req.params.id, patch);
      res.json({ group });
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });

  router.delete("/network/groups/:id", async (req, res, next) => {
    try {
      await networkDeviceService.deleteGroup(req.params.id);
      res.status(204).end();
    } catch (err) {
      handleRegistryError(err, res, next);
    }
  });
}
