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
import {
  sendNotification,
  listRecentNotifications,
  type NotificationKind,
} from "../services/notifications.service.js";

function getUser(req: Request): string {
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username is
  // an invariant break, not a legitimate "admin" default (ORCH-007 fail-open).
  if (!username) throw new Error("authenticated user required");
  return username;
}

// WARP-2587 — one vocabulary, checked in BOTH directions at compile time. The
// `satisfies` catches a label here that the enum does not have; `_KindsCover`
// catches a label the enum HAS that is missing here (which `satisfies` alone
// cannot see, and which would silently 400 a legitimate kind).
const NOTIFICATION_KINDS = [
  "reminder",
  "event",
  "system",
  "ai",
] as const satisfies readonly NotificationKind[];
type _KindsCover = NotificationKind extends (typeof NOTIFICATION_KINDS)[number] ? true : never;
const _kindsAreExhaustive: _KindsCover = true;

const sendSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS).default("system"),
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
