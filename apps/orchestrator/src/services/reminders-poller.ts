/**
 * Reminder + calendar-source poller.
 *
 * Wakes every REMINDER_POLL_INTERVAL_SEC and does two things:
 *
 *  1. Find Reminders where dueAt <= now AND completedAt IS NULL AND
 *     notifiedAt IS NULL — for each, dispatch a notification and stamp
 *     notifiedAt so we never double-fire even if the dispatch is slow.
 *  2. Find CalendarSources whose syncIntervalSec has elapsed and run their
 *     ingest. Errors are persisted on the source row, not raised.
 *
 * This is a single in-process interval — fine for a single-orchestrator
 * deployment. If we ever scale horizontally we'd move it to a leader-elected
 * cron; for now the appliance has exactly one orchestrator.
 */

import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { sendNotification } from "./notifications.service.js";
import { syncSource, findStaleSources } from "./calendar.service.js";

const logger = pino({ name: "reminders-poller" });

const POLL_INTERVAL_SEC = Number(process.env.REMINDER_POLL_INTERVAL_SEC) || 30;

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick(prisma: PrismaClient): Promise<void> {
  if (running) {
    // Skip overlapping ticks if the previous one is still in flight (e.g.
    // a slow CalDAV server). Better than queueing — we'll just sync next
    // tick.
    return;
  }
  running = true;
  try {
    await dispatchDueReminders(prisma);
    await syncStaleSources(prisma);
  } catch (err) {
    logger.error({ err }, "poller tick failed");
  } finally {
    running = false;
  }
}

async function dispatchDueReminders(prisma: PrismaClient): Promise<void> {
  const due = await prisma.reminder.findMany({
    where: {
      dueAt: { lte: new Date() },
      completedAt: null,
      notifiedAt: null,
    },
    take: 100,
    orderBy: { dueAt: "asc" },
  });
  for (const r of due) {
    try {
      // Stamp notifiedAt FIRST. If sendNotification throws and we didn't
      // stamp first, the next tick would dispatch again. Better to risk a
      // single missed notification (we'll log the error) than spam the user.
      await prisma.reminder.update({
        where: { id: r.id },
        data: { notifiedAt: new Date() },
      });
      await sendNotification(prisma, {
        userId: r.userId,
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

export function startRemindersPoller(prisma: PrismaClient): void {
  if (timer) return;
  // Kick a tick immediately so newly-added sources sync without waiting a
  // full interval, then settle into the steady cadence.
  void tick(prisma);
  timer = setInterval(() => void tick(prisma), POLL_INTERVAL_SEC * 1000);
  logger.info({ intervalSec: POLL_INTERVAL_SEC }, "reminders poller started");
}

export function stopRemindersPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
