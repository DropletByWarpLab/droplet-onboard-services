/**
 * WARP-3193 SEC-AUTH-6 — purge the private rows a person owned BY USERNAME.
 *
 * Several per-person tables key their owner on the username string
 * (`req.user.username` == `User.username`), not on `User.id`: notes, calendar
 * events and subscribed calendar sources (which hold encrypted basic-auth
 * credentials), reminders, persisted AI chats and chat projects, and web-push
 * subscriptions. None of them has a foreign key to `User`, so deleting the
 * row cascades nothing — and because `username` is UNIQUE only among LIVE
 * rows, the next account that derives the same handle (alice@a.com deleted,
 * alice@b.com invited → `alice`) would read all of it as their own.
 *
 * Called inside the transaction that deletes the `User` row, so the identity
 * and its data go together: a username is never free while rows still answer
 * to it. Re-keying these tables onto `User.id` is the long-term fix and is
 * deliberately not done here.
 *
 * ChatSession children (messages, context pins) cascade from the session;
 * a business-profile interview link is SetNull by the schema.
 */
import type { Prisma } from "@prisma/client";

export interface UsernameDataPurgeCounts {
  notes: number;
  calendarEvents: number;
  calendarSources: number;
  reminders: number;
  chatSessions: number;
  chatProjects: number;
  pushSubscriptions: number;
}

export async function purgeUsernameKeyedData(
  tx: Prisma.TransactionClient,
  username: string,
): Promise<UsernameDataPurgeCounts> {
  const byUserId = { where: { userId: username } };
  const notes = await tx.note.deleteMany(byUserId);
  const calendarEvents = await tx.calendarEvent.deleteMany(byUserId);
  const calendarSources = await tx.calendarSource.deleteMany(byUserId);
  const reminders = await tx.reminder.deleteMany(byUserId);
  const chatSessions = await tx.chatSession.deleteMany(byUserId);
  const chatProjects = await tx.chatProject.deleteMany(byUserId);
  const pushSubscriptions = await tx.pushSubscription.deleteMany({
    where: { username },
  });
  return {
    notes: notes.count,
    calendarEvents: calendarEvents.count,
    calendarSources: calendarSources.count,
    reminders: reminders.count,
    chatSessions: chatSessions.count,
    chatProjects: chatProjects.count,
    pushSubscriptions: pushSubscriptions.count,
  };
}
