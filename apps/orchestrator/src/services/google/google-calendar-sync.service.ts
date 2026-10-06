import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { replaceExternalCalendarSnapshot } from "../cloud-calendar-store.service.js";
import { getGoogleCalendarAccessToken, googleDependencies, GoogleNotConnectedError, type GoogleDependencies } from "./google-auth.service.js";
import { createGoogleCalendarClient, type GoogleCalendarClient } from "./google-calendar-client.js";
import { GoogleProviderError } from "./google-client.js";

type SyncDependencies = Partial<GoogleDependencies> & { calendarClient?: GoogleCalendarClient };
type SyncResult = { state: "synced" | "skipped" | "failed"; eventCount?: number };
class SyncCancelledError extends Error {}
const ACTIVE_USER = { directoryStatus: "ACTIVE" as const, deletionStatus: "NONE" as const };
const runs = new WeakMap<PrismaClient, Map<string, Promise<SyncResult>>>();

export function googleCalendarWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(now); start.setUTCFullYear(start.getUTCFullYear() - 1);
  const end = new Date(now); end.setUTCFullYear(end.getUTCFullYear() + 1);
  return { start, end };
}

/** Shares overlapping cron work. Scheduling belongs to cron-runtime in the orchestrator. */
export function syncGoogleCalendar(prisma: PrismaClient, userId: string, options: SyncDependencies = {}): Promise<SyncResult> {
  let pending = runs.get(prisma);
  if (!pending) { pending = new Map(); runs.set(prisma, pending); }
  const existing = pending.get(userId);
  if (existing) return existing;
  const run = (async () => {
    try { return await syncOne(prisma, userId, options); }
    finally { pending.delete(userId); }
  })();
  pending.set(userId, run);
  return run;
}

async function syncOne(prisma: PrismaClient, userId: string, options: SyncDependencies): Promise<SyncResult> {
  const deps = googleDependencies(options);
  const client = options.calendarClient ?? createGoogleCalendarClient();
  const row = await prisma.googleConnection.findUnique({ where: { userId } });
  if (!row || row.state !== "CONNECTED" || !row.calendarEnabled || !row.calendarSourceId) return { state: "skipped" };
  const user = await prisma.user.findFirst({ where: { id: userId, ...ACTIVE_USER }, select: { username: true } });
  if (!user) return { state: "skipped" };
  const source = await prisma.calendarSource.findUnique({ where: { id: row.calendarSourceId } });
  if (!source || source.userId !== user.username || source.authMode !== "google_oauth") return { state: "skipped" };
  const runId = randomUUID();
  const where = { id: row.id, state: "CONNECTED" as const, calendarEnabled: true, calendarSourceId: source.id,
    connectedAt: row.connectedAt, accountAddress: row.accountAddress, user: { is: ACTIVE_USER } };
  const sourceWhere = { id: source.id, userId: user.username, authMode: "google_oauth", externalSyncRun: runId };
  try {
    await prisma.$transaction(async (tx) => {
      const connection = await tx.googleConnection.updateMany({ where, data: { calendarSyncState: "WAITING" } });
      if (!connection.count) throw new SyncCancelledError();
      const claim = await tx.calendarSource.updateMany({
        where: { ...sourceWhere, externalSyncRun: source.externalSyncRun }, data: { externalSyncRun: runId },
      });
      if (!claim.count) throw new SyncCancelledError();
    });
    const grant = await getGoogleCalendarAccessToken(prisma, userId, deps);
    if (grant.connectionId !== row.id || grant.calendarSourceId !== source.id || grant.accountAddress !== row.accountAddress) throw new SyncCancelledError();
    const events = await client.readPrimaryCalendar(grant.accessToken, googleCalendarWindow(deps.now()));
    await prisma.$transaction(async (tx) => {
      // Lock the still-authorized link before touching its snapshot. Callback
      // resets externalSyncRun on re-consent, even for the same account/source.
      const connection = await tx.googleConnection.updateMany({ where, data: { calendarSyncState: "CONNECTED" } });
      if (!connection.count) throw new SyncCancelledError();
      const claimed = await tx.calendarSource.updateMany({ where: sourceWhere, data: { externalSyncRun: runId } });
      if (!claimed.count) throw new SyncCancelledError();
      await replaceExternalCalendarSnapshot(tx, { sourceId: source.id, userId: user.username, events, syncedAt: deps.now() });
    }, { timeout: 60_000 });
    return { state: "synced", eventCount: events.length };
  } catch (err) {
    if (err instanceof SyncCancelledError) return { state: "skipped" };
    if (err instanceof GoogleNotConnectedError) return { state: "failed" };
    const reconnect = err instanceof GoogleProviderError && err.needsReconnect;
    try { await prisma.$transaction(async (tx) => {
      const updated = await tx.googleConnection.updateMany({ where, data: {
        calendarSyncState: reconnect ? "NEEDS_RECONNECT" : "ERROR",
        ...(reconnect ? { state: "NEEDS_RECONNECT", tokenEnc: null, lastError: "Sign in to Google again to reconnect." } : {}),
      } });
      if (!updated.count) return;
      const sourceUpdated = await tx.calendarSource.updateMany({ where: sourceWhere,
        data: { lastSyncError: reconnect ? "Sign in to Google again to reconnect Calendar." : "Google Calendar could not be refreshed. Droplet will try again shortly." } });
      if (!sourceUpdated.count) throw new SyncCancelledError();
    }); } catch (failure) { if (failure instanceof SyncCancelledError) return { state: "skipped" }; throw failure; }
    return { state: "failed" };
  }
}

/** Root's five-minute cron calls this only when the calendar module is enabled. */
export async function syncGoogleCalendars(prisma: PrismaClient, deps: SyncDependencies = {}): Promise<void> {
  const rows = await prisma.googleConnection.findMany({ where: { state: "CONNECTED", calendarEnabled: true,
    calendarSourceId: { not: null }, user: { is: ACTIVE_USER } }, select: { userId: true } });
  for (const row of rows) await syncGoogleCalendar(prisma, row.userId, deps);
}
