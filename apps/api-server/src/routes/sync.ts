import { Router } from "express";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { resolveAndValidatePath, PathTraversalError } from "../services/file.service.js";
import { publish } from "../services/mqtt.service.js";
import type { SyncTargetInfo } from "../types/index.js";

const createTargetSchema = z.object({
  path: z.string().min(1),
  label: z.string().min(1),
  intervalMin: z.number().int().min(1).max(1440).optional().default(30),
  enabled: z.boolean().optional().default(true),
});

const updateTargetSchema = z.object({
  label: z.string().min(1).optional(),
  intervalMin: z.number().int().min(1).max(1440).optional(),
  enabled: z.boolean().optional(),
});

export function createSyncRouter(prisma: PrismaClient): Router {
  const router = Router();

  // List all sync targets
  router.get("/sync/targets", async (_req, res, next) => {
    try {
      const targets = await prisma.syncTarget.findMany({
        include: { _count: { select: { entries: true } } },
        orderBy: { createdAt: "asc" },
      });

      const result: SyncTargetInfo[] = targets.map((t) => ({
        id: t.id,
        path: t.path,
        label: t.label,
        intervalMin: t.intervalMin,
        enabled: t.enabled,
        lastSync: t.lastSync?.toISOString() ?? null,
        fileCount: t._count.entries,
      }));

      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // Create a sync target
  router.post("/sync/targets", async (req, res, next) => {
    try {
      const parsed = createTargetSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
      }

      // Validate the path exists and is within FILES_ROOT
      await resolveAndValidatePath(parsed.data.path);

      const target = await prisma.syncTarget.create({
        data: parsed.data,
      });

      // Notify the file-sync daemon
      publish("droplet/sync/config/changed", { action: "created", targetId: target.id });

      const result: SyncTargetInfo = {
        id: target.id,
        path: target.path,
        label: target.label,
        intervalMin: target.intervalMin,
        enabled: target.enabled,
        lastSync: null,
        fileCount: 0,
      };

      res.status(201).json(result);
    } catch (err) {
      if (err instanceof PathTraversalError) {
        res.status(400).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  // Update a sync target
  router.put("/sync/targets/:id", async (req, res, next) => {
    try {
      const parsed = updateTargetSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
        return;
      }

      const target = await prisma.syncTarget.update({
        where: { id: req.params.id },
        data: parsed.data,
        include: { _count: { select: { entries: true } } },
      });

      publish("droplet/sync/config/changed", { action: "updated", targetId: target.id });

      const result: SyncTargetInfo = {
        id: target.id,
        path: target.path,
        label: target.label,
        intervalMin: target.intervalMin,
        enabled: target.enabled,
        lastSync: target.lastSync?.toISOString() ?? null,
        fileCount: target._count.entries,
      };

      res.json(result);
    } catch (err: any) {
      if (err.code === "P2025") {
        res.status(404).json({ error: "Sync target not found" });
        return;
      }
      next(err);
    }
  });

  // Delete a sync target
  router.delete("/sync/targets/:id", async (req, res, next) => {
    try {
      await prisma.syncTarget.delete({ where: { id: req.params.id } });
      publish("droplet/sync/config/changed", { action: "deleted", targetId: req.params.id });
      res.json({ deleted: req.params.id });
    } catch (err: any) {
      if (err.code === "P2025") {
        res.status(404).json({ error: "Sync target not found" });
        return;
      }
      next(err);
    }
  });

  // Get sync status (all targets with counts)
  router.get("/sync/status", async (_req, res, next) => {
    try {
      const targets = await prisma.syncTarget.findMany({
        include: { _count: { select: { entries: true } } },
        orderBy: { createdAt: "asc" },
      });

      const result: SyncTargetInfo[] = targets.map((t) => ({
        id: t.id,
        path: t.path,
        label: t.label,
        intervalMin: t.intervalMin,
        enabled: t.enabled,
        lastSync: t.lastSync?.toISOString() ?? null,
        fileCount: t._count.entries,
      }));

      res.json({ targets: result });
    } catch (err) {
      next(err);
    }
  });

  // Trigger immediate sync for a target
  router.post("/sync/trigger", async (req, res, next) => {
    try {
      const schema = z.object({ targetId: z.string().uuid() });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "targetId is required" });
        return;
      }

      // Verify target exists
      const target = await prisma.syncTarget.findUnique({
        where: { id: parsed.data.targetId },
      });
      if (!target) {
        res.status(404).json({ error: "Sync target not found" });
        return;
      }

      publish(`droplet/sync/${target.id}/trigger`, {
        targetId: target.id,
        timestamp: new Date().toISOString(),
      });

      res.json({ status: "triggered", targetId: target.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
