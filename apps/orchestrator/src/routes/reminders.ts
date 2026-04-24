/**
 * /api/reminders/* — CRUD on the user's reminder list.
 *
 * Mark-complete is a PATCH with `{ completed: true }`. Notifications are
 * fired by the background poller when a reminder's dueAt elapses; this
 * route never directly publishes — see services/reminders-poller.ts.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

function getUser(req: Request): string {
  return req.user?.username || "admin";
}

const reminderCreateSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(2000).optional(),
  dueAt: z.string().datetime(),
  calendarEventId: z.string().uuid().optional(),
});

const reminderPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(2000).optional(),
  dueAt: z.string().datetime().optional(),
  completed: z.boolean().optional(),
});

export function createRemindersRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/reminders", async (req, res, next) => {
    try {
      const user = getUser(req);
      const completed = req.query.completed as string | undefined;
      const dueBefore = req.query.due_before as string | undefined;
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

      const reminders = await prisma.reminder.findMany({
        where: {
          userId: user,
          ...(completed === "true"
            ? { completedAt: { not: null } }
            : completed === "false"
            ? { completedAt: null }
            : {}),
          ...(dueBefore ? { dueAt: { lte: new Date(dueBefore) } } : {}),
        },
        orderBy: [{ completedAt: "asc" }, { dueAt: "asc" }],
        take: limit,
      });
      res.json({ reminders });
    } catch (err) {
      next(err);
    }
  });

  router.post("/reminders", async (req, res, next) => {
    try {
      const parsed = reminderCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const reminder = await prisma.reminder.create({
        data: {
          userId: getUser(req),
          title: parsed.data.title,
          body: parsed.data.body ?? null,
          dueAt: new Date(parsed.data.dueAt),
          calendarEventId: parsed.data.calendarEventId ?? null,
        },
      });
      res.status(201).json({ reminder });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/reminders/:id", async (req, res, next) => {
    try {
      const parsed = reminderPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const existing = await prisma.reminder.findUnique({ where: { id: req.params.id } });
      if (!existing) return void res.status(404).json({ error: "reminder_not_found" });
      if (existing.userId !== getUser(req)) return void res.status(403).json({ error: "forbidden" });

      const reminder = await prisma.reminder.update({
        where: { id: req.params.id },
        data: {
          ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
          ...(parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
          ...(parsed.data.dueAt !== undefined
            ? {
                dueAt: new Date(parsed.data.dueAt),
                // Re-arming a reminder (changing dueAt to a future time)
                // should re-enable the notification dispatcher.
                notifiedAt: null,
              }
            : {}),
          ...(parsed.data.completed !== undefined
            ? { completedAt: parsed.data.completed ? new Date() : null }
            : {}),
        },
      });
      res.json({ reminder });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/reminders/:id", async (req, res, next) => {
    try {
      const existing = await prisma.reminder.findUnique({ where: { id: req.params.id } });
      if (!existing) return void res.status(404).json({ error: "reminder_not_found" });
      if (existing.userId !== getUser(req)) return void res.status(403).json({ error: "forbidden" });
      await prisma.reminder.delete({ where: { id: req.params.id } });
      res.json({ deleted: req.params.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
