/**
 * Reminder + calendar-source poller.
 *
 * Every REMINDER_POLL_INTERVAL_SEC it does two things, as two separate
 * cron-runtime registrations (WARP-3193 PERF-10 / QUAL-7): a slow or huge
 * calendar feed must never delay a due reminder, and each job gets
 * cron-runtime's own no-overlap guard.
 *
 *  1. Find Reminders where status = 'scheduled' AND dueAt <= now — for each,
 *     move it to 'notified' (stamping notifiedAt) and dispatch a
 *     notification, so we never double-fire even if the dispatch is slow.
 *  2. Find CalendarSources whose syncIntervalSec has elapsed and run their
 *     ingest. Errors are persisted on the source row, not raised.
 *
 * No lockKey, as before: fine for a single-orchestrator deployment. If we
 * ever scale horizontally both jobs take a lockKey; for now the appliance has
 * exactly one orchestrator.
 */

import type { PrismaClient } from "@prisma/client";
import { sendNotification } from "./notifications.service.js";
import { syncSource, findStaleSources } from "./calendar.service.js";
import type { CronRuntime } from "./cron-runtime.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("reminders-poller");

const POLL_INTERVAL_SEC = Number(process.env.REMINDER_POLL_INTERVAL_SEC) || 30;

async function dispatchDueReminders(prisma: PrismaClient): Promise<void> {
  // WARP-3193 QUAL-3 / PERF-14: the explicit status, served by the
  // (status, dueAt) index — no longer `completedAt IS NULL AND
  // notifiedAt IS NULL`.
  const due = await prisma.reminder.findMany({
    where: {
      status: "scheduled",
      dueAt: { lte: new Date() },
    },
    take: 100,
    orderBy: { dueAt: "asc" },
  });
  for (const r of due) {
    try {
      // Stamp notifiedAt FIRST. If sendNotification throws and we didn't
      // stamp first, the next tick would dispatch again. Better to risk a
      // single missed notification (we'll log the error) than spam the user.
      // Conditional on the status still being `scheduled`, so a reminder
      // completed (or re-timed) since the read above is not notified.
      const claim = await prisma.reminder.updateMany({
        where: { id: r.id, status: "scheduled" },
        data: { status: "notified", notifiedAt: new Date() },
      });
      if (claim.count === 0) continue;
      // `Reminder.userId` holds a USERNAME: its one writer, routes/reminders.ts,
      // stores the caller's `req.user.username` or, for the assistant's
      // reminder tools, the username of the person they act for (WARP-3101 —
      // the tools used to write `ctx.userId`, a User.id over the mcp-server's
      // HTTP transport, and the send below threw on it after `notifiedAt` was
      // stamped). notification-recipient.guard.test.ts allow-lists this site
      // and follows that writer, so that stays true.
      await sendNotification(prisma, {
        username: r.userId,
        kind: "reminder",
        title: r.title,
        body: r.body,
      });
    } catch (err) {
      logger.warn({ err, reminderId: r.id }, "reminder notification failed");
    }
  }
}

async function syncStaleSources(prisma: PrismaClient): Promise<void> {
  const ids = await findStaleSources(prisma);
  for (const id of ids) {
    try {
      await syncSource(prisma, id);
    } catch (err) {
      logger.warn({ err, sourceId: id }, "calendar source sync failed");
    }
  }
}

/**
 * Register both jobs on `cron` (index.ts main(); cron.stop() tears them down).
 * Each runs once immediately so newly-added sources sync without waiting a
 * full interval, then settles into the steady cadence. A tick that finds its
 * previous run still in flight (e.g. a slow CalDAV server) is skipped by
 * cron-runtime rather than queued — we'll just sync next tick.
 */
export function startRemindersPoller(
  prisma: PrismaClient,
  cron: Pick<CronRuntime, "scheduleInterval">,
): void {
  cron.scheduleInterval(POLL_INTERVAL_SEC * 1000, () => dispatchDueReminders(prisma), {
    immediate: true,
  });
  cron.scheduleInterval(POLL_INTERVAL_SEC * 1000, () => syncStaleSources(prisma), {
    immediate: true,
  });
  logger.info({ intervalSec: POLL_INTERVAL_SEC }, "reminders poller started");
}
