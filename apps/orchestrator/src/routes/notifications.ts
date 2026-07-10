/**
 * /api/notifications/* — recent notification log + manual send.
 *
 * The dashboard uses the GET endpoint to populate the "Recent notifications"
 * panel. The POST endpoint exists for the LLM `send_notification` tool and
 * for system code that wants to push a one-off message; both wind up calling
 * sendNotification() from services/notifications.service.ts.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { sendNotification, listRecentNotifications } from "../services/notifications.service.js";

function getUser(req: Request): string {
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username is
  // an invariant break, not a legitimate "admin" default (ORCH-007 fail-open).
  if (!username) throw new Error("authenticated user required");
  return username;
}

const sendSchema = z.object({
  kind: z.enum(["reminder", "event", "system", "ai"]).default("system"),
  title: z.string().min(1).max(500),
  body: z.string().max(2000).optional(),
});

export function createNotificationsRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/notifications", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const rows = await listRecentNotifications(prisma, getUser(req), limit);
      res.json({ notifications: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post("/notifications/send", async (req, res, next) => {
    try {
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const result = await sendNotification(prisma, {
        userId: getUser(req),
        kind: parsed.data.kind,
        title: parsed.data.title,
        body: parsed.data.body,
      });
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
