/**
 * /api/reminders/* — CRUD on the user's reminder list.
 *
 * Mark-complete is a PATCH with `{ completed: true }`. Notifications are
 * fired by the background poller when a reminder's dueAt elapses; this
 * route never directly publishes — see services/reminders-poller.ts.
 *
 * WARP-3101 — `Reminder.userId` holds the owner's USERNAME, and the poller
 * notifies it. The list / create / update routes are also the assistant's
 * reminder tools (REMINDER_TOOL_ROUTES): called as `_service:mcp` they act for
 * the person named in `X-Nextcloud-User` and key the row on THAT person's
 * username (services/tool-acting-user.service.ts). The tools used to write
 * Reminder themselves with `ctx.userId`, a User.id on the mcp-server's HTTP
 * transport — the poller then stamped the row notified and the send threw on
 * the UUID, so the reminder was lost.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma, PrismaClient, ReminderStatus } from "@prisma/client";
import {
  sendToolActingUserDenial,
  toolActingUser,
  type RouteTools,
} from "../services/tool-acting-user.service.js";

function getUser(req: Request): string {
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username is
  // an invariant break, not a legitimate "admin" default (ORCH-007 fail-open).
  if (!username) throw new Error("authenticated user required");
  return username;
}

const reminderCreateSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(2000).optional(),
  dueAt: z.string().datetime(),
  calendarEventId: z.string().uuid().optional(),
});

// WARP-3193 QUAL-14 — `due_before` used to reach Prisma as `new Date(garbage)`
// (Invalid Date → 500). Any Date-parseable string is accepted, as before;
// `completed` / `limit` keep their lenient handling below.
const reminderListQuerySchema = z.object({
  completed: z.string().optional(),
  due_before: z
    .string()
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "invalid date")
    .optional(),
  limit: z.string().optional(),
});

const reminderPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(2000).optional(),
  dueAt: z.string().datetime().optional(),
  completed: z.boolean().optional(),
});

/**
 * WARP-3101 — the reminder routes the assistant's tools call (tools-core
 * TOOL_ROUTES), and the tools each one serves. `set_timer` is a reminder due
 * in N minutes, so it shares `create_reminder`'s route.
 */
export const REMINDER_TOOL_ROUTES = {
  "get /api/reminders": ["list_reminders"],
  "post /api/reminders": ["create_reminder", "set_timer"],
  "patch /api/reminders/:id": ["complete_reminder"],
} as const satisfies Record<string, RouteTools>;

/**
 * WARP-3193 QUAL-3 — the status transitions a PATCH makes, as conditional
 * writes tried in order (see enum ReminderStatus):
 *   - completed: true            → completed
 *   - completed: false + dueAt   → scheduled (re-armed)
 *   - completed: false           → notified if it had already fired, else
 *                                  scheduled; an open reminder is unchanged
 *   - dueAt only                 → scheduled, unless completed (stays)
 *   - neither                    → unchanged
 */
function reminderStatusSteps(patch: z.infer<typeof reminderPatchSchema>): Array<{
  where: Prisma.ReminderWhereInput;
  data: { status?: ReminderStatus };
}> {
  if (patch.completed === true) return [{ where: {}, data: { status: "completed" } }];
  if (patch.completed === false) {
    if (patch.dueAt !== undefined) return [{ where: {}, data: { status: "scheduled" } }];
    return [
      { where: { status: "completed", notifiedAt: { not: null } }, data: { status: "notified" } },
      { where: { status: "completed", notifiedAt: null }, data: { status: "scheduled" } },
      { where: { status: { not: "completed" } }, data: {} },
    ];
  }
  if (patch.dueAt !== undefined) {
    return [
      { where: { status: { not: "completed" } }, data: { status: "scheduled" } },
      { where: { status: "completed" }, data: {} },
    ];
  }
  return [{ where: {}, data: {} }];
}

export function createRemindersRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/reminders", async (req, res, next) => {
    try {
      const query = reminderListQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ error: "invalid_request", details: query.error.flatten() });
        return;
      }
      const person = await toolActingUser(prisma, req, REMINDER_TOOL_ROUTES["get /api/reminders"]);
      if (!person.ok) return void sendToolActingUserDenial(res, person);
      const completed = query.data.completed;
      const dueBefore = query.data.due_before;
      const limit = Math.max(1, Math.min(500, Number(query.data.limit) || 100));

      const reminders = await prisma.reminder.findMany({
        where: {
          userId: person.username,
          // WARP-3193 QUAL-3: the explicit status, not completedAt absence.
          ...(completed === "true"
            ? { status: "completed" as const }
            : completed === "false"
            ? { status: { not: "completed" as const } }
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
      const person = await toolActingUser(prisma, req, REMINDER_TOOL_ROUTES["post /api/reminders"]);
      if (!person.ok) return void sendToolActingUserDenial(res, person);
      const reminder = await prisma.reminder.create({
        data: {
          userId: person.username,
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
      const person = await toolActingUser(prisma, req, REMINDER_TOOL_ROUTES["patch /api/reminders/:id"]);
      if (!person.ok) return void sendToolActingUserDenial(res, person);
      // ORCH-008: ownership-scoped conditional write — 404 (not 403) on a
      // foreign/unknown id so an authed user can't enumerate which reminder
      // ids exist, and no findUnique→update TOCTOU.
      const data = {
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
      };
      // WARP-3193 QUAL-3: the status moves in the same write as its
      // timestamp. Where the next status depends on the current one, each
      // starting status gets its own conditional write; the first that
      // matches the (owned) row wins, so it stays one write per request.
      let count = 0;
      for (const step of reminderStatusSteps(parsed.data)) {
        const upd = await prisma.reminder.updateMany({
          where: { id: req.params.id, userId: person.username, ...step.where },
          data: { ...data, ...step.data },
        });
        count = upd.count;
        if (count > 0) break;
      }
      if (count === 0) return void res.status(404).json({ error: "reminder_not_found" });
      const reminder = await prisma.reminder.findUniqueOrThrow({ where: { id: req.params.id } });
      res.json({ reminder });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/reminders/:id", async (req, res, next) => {
    try {
      // ORCH-008: ownership-scoped delete — 404 on a foreign/unknown id, no TOCTOU.
      const del = await prisma.reminder.deleteMany({
        where: { id: req.params.id, userId: getUser(req) },
      });
      if (del.count === 0) return void res.status(404).json({ error: "reminder_not_found" });
      res.json({ deleted: req.params.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
