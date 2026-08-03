/**
 * WARP-1685 — team-chat meeting reminder sweep.
 *
 * Runs every 60s off cron-runtime (index.ts registers it with the
 * `droplet:team-chat-meeting-reminders` advisory-lock key — never a
 * hand-rolled loop). For every scheduled meeting whose reminder window
 * has opened (startsAt − reminderMinutesBefore ≤ now) and that hasn't
 * slipped past the 5-minute start grace, it posts ONE meeting_reminder
 * card into the meeting's thread.
 *
 * Exactly-once, restart-safe: the pending→sent claim
 * (`updateMany` guarded on reminderStatus=pending AND status=scheduled)
 * commits in the SAME transaction as the message insert + lastMessageAt
 * bump. A crash before commit leaves the row pending (retried next tick);
 * a concurrent instance that loses the claim inserts nothing. Meetings
 * already started past the grace window get the EXPLICIT `not_needed`
 * terminal — a row is never silently skipped into a forever-pending state
 * (CLAUDE.md no-guessing rule).
 *
 * After the transaction, every participant EXCEPT the organizer gets a
 * best-effort dashboard toast via notifications.service (NotificationLog +
 * MQTT — the send_notification delivery path). Notification failures are
 * logged and contained: the in-thread card is the durable artifact.
 */
import type { PrismaClient } from "@prisma/client";
import { sendNotification } from "./notifications.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("team-chat-reminders");

/** Upper bound the route accepts for reminderMinutesBefore (7 days) —
 *  bounds the candidate scan window so the query stays on the
 *  `[reminderStatus, startsAt]` index instead of table-walking. */
const MAX_REMINDER_MINUTES = 10_080;

/** A meeting that started longer ago than this gets `not_needed` — a
 *  reminder for a meeting that is already well underway is noise. Inside
 *  the window we still remind (better late than silent). */
const START_GRACE_MS = 5 * 60_000;

export interface ReminderSweepResult {
  remindersSent: number;
  markedNotNeeded: number;
}

export async function runTeamChatMeetingReminderSweep(
  prisma: PrismaClient,
): Promise<ReminderSweepResult> {
  const now = Date.now();
  // Candidates: every pending, still-scheduled meeting that could possibly
  // be due (startsAt within the largest allowed reminder window). The
  // per-row due check happens below because reminderMinutesBefore varies
  // per meeting and can't fold into one indexed WHERE.
  const candidates = await prisma.teamChatMeeting.findMany({
    where: {
      status: "scheduled",
      reminderStatus: "pending",
      startsAt: { lte: new Date(now + MAX_REMINDER_MINUTES * 60_000) },
    },
  });

  let remindersSent = 0;
  let markedNotNeeded = 0;

  for (const meeting of candidates) {
    const startsAtMs = meeting.startsAt.getTime();

    // Already started past the grace window → explicit terminal.
    if (startsAtMs <= now - START_GRACE_MS) {
      const marked = await prisma.teamChatMeeting.updateMany({
        where: { id: meeting.id, reminderStatus: "pending" },
        data: { reminderStatus: "not_needed" },
      });
      if (marked.count > 0) markedNotNeeded++;
      continue;
    }

    // Not due yet — the window hasn't opened.
    const dueAtMs = startsAtMs - meeting.reminderMinutesBefore * 60_000;
    if (dueAtMs > now) continue;

    // Due: claim + post in one transaction (exactly-once).
    const posted = await prisma.$transaction(async (tx) => {
      const claimed = await tx.teamChatMeeting.updateMany({
        where: {
          id: meeting.id,
          reminderStatus: "pending",
          status: "scheduled",
        },
        data: { reminderStatus: "sent" },
      });
      if (claimed.count === 0) return false;
      await tx.teamChatMessage.create({
        data: {
          threadId: meeting.threadId,
          senderId: meeting.createdById,
          kind: "meeting_reminder",
          meetingId: meeting.id,
        },
      });
      await tx.teamChatThread.update({
        where: { id: meeting.threadId },
        data: { lastMessageAt: new Date() },
      });
      return true;
    });
    if (!posted) continue;
    remindersSent++;

    // Best-effort toasts — participants except the organizer, keyed by
    // USERNAME (NotificationLog.userId / the MQTT topic are
    // username-scoped, exactly like routes/notifications.ts getUser()).
    try {
      const participants = await prisma.teamChatParticipant.findMany({
        where: { threadId: meeting.threadId },
      });
      const inviteeIds = participants
        .map((p) => p.userId)
        .filter((id) => id !== meeting.createdById);
      if (inviteeIds.length === 0) continue;
      const invitees = await prisma.user.findMany({
        where: { id: { in: inviteeIds } },
        select: { id: true, username: true },
      });
      const minutesToStart = Math.max(1, Math.round((startsAtMs - Date.now()) / 60_000));
      for (const invitee of invitees) {
        try {
          await sendNotification(prisma, {
            userId: invitee.username,
            kind: "event",
            title: "Meeting reminder",
            body: `"${meeting.title}" starts in ${minutesToStart} min`,
          });
        } catch (err) {
          logger.warn(
            { err, meetingId: meeting.id, userId: invitee.id },
            "meeting reminder notification failed — card already posted",
          );
        }
      }
    } catch (err) {
      logger.warn(
        { err, meetingId: meeting.id },
        "meeting reminder notification fan-out failed — card already posted",
      );
    }
  }

  return { remindersSent, markedNotNeeded };
}
