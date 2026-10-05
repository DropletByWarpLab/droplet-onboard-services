/** WARP-3788: opt-in, read-only copies of the person's primary Outlook calendar. */
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseMeetingLink } from "@droplet/shared-types";
import { isValidIanaZone, zonedWallClockToUtc } from "../../lib/zoned-time.js";
import { upsertExternalCalendarEvents, type ExternalCalendarEvent } from "../cloud-calendar-store.service.js";
import { GRAPH_API_BASE_URL } from "./graph-client.js";
import { CALENDAR_WINDOW, calendarWindowResourceId, grantCovers, GRAPH_RESOURCES } from "./graph-resources.js";
import type { M365GrantGeneration, PageHandler } from "./m365-contracts.js";
import { WINDOWS_TIME_ZONES } from "./windows-timezones.js";

type Db = PrismaClient | Prisma.TransactionClient;
const ACTIVE_USER = { directoryStatus: "ACTIVE" as const, deletionStatus: "NONE" as const };
const SOURCE_URL = `${GRAPH_API_BASE_URL}/me/calendarView`;

export interface MicrosoftCalendarView {
  enabled: boolean;
  state: "DISCONNECTED" | "WAITING" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
  needsConsent: boolean;
  lastSyncAt: Date | null;
  lastError: string | null;
}

export function microsoftCalendarViewOf(row: {
  calendarEnabled?: boolean; calendarSyncState?: MicrosoftCalendarView["state"]; grantedScopes?: string | null;
} | null, source?: { lastSyncAt: Date | null; lastSyncError: string | null } | null): MicrosoftCalendarView {
  const enabled = row?.calendarEnabled === true;
  return { enabled, state: row?.calendarSyncState ?? "DISCONNECTED",
    needsConsent: enabled && !calendarGranted(row?.grantedScopes),
    lastSyncAt: source?.lastSyncAt ?? null, lastError: source?.lastSyncError ?? null };
}

function calendarGranted(scopes: string | null | undefined): boolean {
  return grantCovers((scopes ?? "").split(/\s+/).filter(Boolean), GRAPH_RESOURCES.calendar.leastPrivilegeScope);
}

/** Resolve the calendar owner through the directory. Calendar tables use username, never User.id. */
async function activeUsername(tx: Db, userId: string): Promise<string | null> {
  const person = await tx.user.findFirst({ where: { id: userId, ...ACTIVE_USER }, select: { username: true } });
  return person?.username ?? null;
}

/** Connection write first: it serializes OFF/disconnect with a landing page or discovery. */
async function lockEnabledConnection(tx: Db, userId: string, generation?: M365GrantGeneration) {
  const locked = await tx.m365Connection.updateMany({
    where: { userId, state: "CONNECTED", calendarEnabled: true,
      ...(generation ? { tokenCacheEnc: generation.tokenCacheEnc, cursorLinkHash: generation.cursorLinkHash,
        connectedAt: generation.connectedAt, calendarSourceId: generation.calendarSourceId } : {}) }, data: { calendarEnabled: true },
  });
  if (locked.count !== 1) return null;
  const row = await tx.m365Connection.findUnique({ where: { userId } });
  if (!row?.calendarSourceId || !calendarGranted(row.grantedScopes)) return null;
  const username = await activeUsername(tx, userId);
  if (!username) return null;
  const source = await tx.calendarSource.findFirst({
    where: { id: row.calendarSourceId, userId: username, authMode: "m365_oauth" },
  });
  return source ? { row, source, username } : null;
}

/** Caller holds the connection lock. Source id and provider are checked before any event delete. */
export async function purgeMicrosoftCalendar(tx: Db, userId: string): Promise<void> {
  await tx.m365Connection.updateMany({ where: { userId }, data: {
    calendarEnabled: false, calendarSyncState: "DISCONNECTED",
  } });
  const row = await tx.m365Connection.findUnique({ where: { userId }, select: { calendarSourceId: true } });
  if (row?.calendarSourceId) {
    const user = await tx.user.findFirst({ where: { id: userId }, select: { username: true } });
    const source = user ? await tx.calendarSource.findFirst({ where: { id: row.calendarSourceId, userId: user.username, authMode: "m365_oauth" } }) : null;
    if (source) {
      await tx.calendarEvent.deleteMany({ where: { userId: source.userId, sourceId: source.id, source: "external" } });
      await tx.calendarSource.deleteMany({ where: { id: source.id, userId: source.userId, authMode: "m365_oauth" } });
    }
  }
  await tx.m365Connection.updateMany({ where: { userId }, data: { calendarSourceId: null } });
  await tx.m365DeltaCursor.deleteMany({ where: { userId, workload: "calendar" } });
}

export async function setMicrosoftCalendarEnabled(prisma: PrismaClient, userId: string, enabled: boolean) {
  return prisma.$transaction(async (tx) => {
    if (!enabled) { await purgeMicrosoftCalendar(tx, userId); return true; }
    const locked = await tx.m365Connection.updateMany({ where: { userId, state: "CONNECTED" }, data: { calendarEnabled: true } });
    if (locked.count !== 1) return false;
    const username = await activeUsername(tx, userId);
    if (!username) throw new MicrosoftCalendarUnavailableError();
    const row = await tx.m365Connection.findUnique({ where: { userId } });
    if (!row) throw new MicrosoftCalendarUnavailableError();
    const existing = row.calendarSourceId ? await tx.calendarSource.findFirst({
      where: { id: row.calendarSourceId, userId: username, authMode: "m365_oauth" },
    }) : null;
    const source = existing ?? await tx.calendarSource.create({ data: {
      userId: username, name: "Outlook calendar", url: SOURCE_URL, authMode: "m365_oauth",
      username: null, passwordEnc: null,
    } });
    const granted = calendarGranted(row.grantedScopes);
    await tx.m365Connection.updateMany({ where: { userId, state: "CONNECTED", calendarEnabled: true }, data: {
      calendarSourceId: source.id,
      calendarSyncState: !granted ? "NEEDS_RECONNECT" : existing && row.calendarEnabled
        ? row.calendarSyncState : "WAITING",
    } });
    return true;
  });
}

export class MicrosoftCalendarUnavailableError extends Error {
  constructor() { super("The Outlook calendar is no longer available."); this.name = "MicrosoftCalendarUnavailableError"; }
}

/** Discovery records stable bounds; a delta checkpoint never changes the window mid-run. */
export async function ensureMicrosoftCalendarCursor(prisma: PrismaClient, userId: string, now: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const owner = await lockEnabledConnection(tx, userId);
    if (!owner) return false;
    let start = owner.source.externalWindowStart;
    let end = owner.source.externalWindowEnd;
    // Renew before the future horizon shrinks below six months. Every renewal
    // drops the old token and performs a complete sweep in the new window.
    if (!start || !end || end.getTime() < now.getTime() + CALENDAR_WINDOW.forwardMs / 2) {
      start = new Date(now.getTime() - CALENDAR_WINDOW.backMs);
      end = new Date(now.getTime() + CALENDAR_WINDOW.forwardMs);
      await tx.calendarSource.updateMany({ where: { id: owner.source.id, userId: owner.username, authMode: "m365_oauth" },
        data: { externalWindowStart: start, externalWindowEnd: end, externalSyncRun: null } });
      await tx.m365DeltaCursor.deleteMany({ where: { userId, workload: "calendar" } });
      await tx.m365Connection.updateMany({ where: { userId, calendarEnabled: true }, data: { calendarSyncState: "WAITING" } });
    }
    const resourceId = calendarWindowResourceId(start, end);
    await tx.m365DeltaCursor.upsert({
      where: { userId_workload_resourceId: { userId, workload: "calendar", resourceId } },
      create: { userId, workload: "calendar", resourceId, state: "IDLE" }, update: {},
    });
    return true;
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function zone(value: unknown): string {
  if (typeof value !== "string") throw new MicrosoftCalendarUnavailableError();
  const resolved = WINDOWS_TIME_ZONES[value] ?? value;
  if (!isValidIanaZone(resolved)) throw new MicrosoftCalendarUnavailableError();
  return resolved;
}

function instant(value: unknown): Date {
  const part = record(value);
  const text = part?.dateTime;
  if (typeof text !== "string") throw new MicrosoftCalendarUnavailableError();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/.exec(text);
  if (!match) throw new MicrosoftCalendarUnavailableError();
  const numbers = match.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = numbers;
  const probe = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day ||
      hour! > 23 || minute! > 59 || second! > 59) throw new MicrosoftCalendarUnavailableError();
  const date = match[8] ? new Date(text) : zonedWallClockToUtc(year!, month!, day!, hour!, minute!, second!, zone(part?.timeZone));
  if (!Number.isFinite(date.getTime())) throw new MicrosoftCalendarUnavailableError();
  if (!match[8] && match[7]) date.setTime(date.getTime() + Number(`0.${match[7]}`) * 1000);
  return date;
}

function allDayDate(value: Date, calendarZone: unknown): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone(calendarZone), year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const field = (name: string) => parts.find((p) => p.type === name)!.value;
  // original*TimeZone describes creation. If an event later changes zones,
  // guessing its DATE from that old zone can silently shift an all-day event.
  if (field("hour") !== "00" || field("minute") !== "00" || field("second") !== "00" || value.getUTCMilliseconds() !== 0) throw new MicrosoftCalendarUnavailableError();
  return new Date(`${field("year")}-${field("month")}-${field("day")}T00:00:00.000Z`);
}

function allDayZone(part: unknown, original: unknown): unknown {
  const current = zone(record(part)?.timeZone);
  return ["UTC", "Etc/UTC", "GMT", "Etc/GMT"].includes(current) ? original : current;
}

export type MicrosoftCalendarEntry = { kind: "removed"; externalUid: string } | { kind: "event"; event: ExternalCalendarEvent };

/** UTC is Graph's default; original zones preserve all-day calendar dates after that conversion. */
export function parseMicrosoftCalendarEvent(value: unknown): MicrosoftCalendarEntry {
  const item = record(value);
  if (typeof item?.id !== "string" || !item.id || item.id.length > 1024) throw new MicrosoftCalendarUnavailableError();
  if (item["@removed"] || item.isCancelled === true) return { kind: "removed", externalUid: item.id };
  let startsAt = instant(item.start);
  let endsAt = instant(item.end);
  const allDay = item.isAllDay === true;
  if (allDay) {
    startsAt = allDayDate(startsAt, allDayZone(item.start, item.originalStartTimeZone));
    endsAt = allDayDate(endsAt, allDayZone(item.end, item.originalEndTimeZone ?? item.originalStartTimeZone));
  }
  if (endsAt <= startsAt || typeof item.subject !== "string") throw new MicrosoftCalendarUnavailableError();
  const meeting = record(item.onlineMeeting);
  const location = record(item.location);
  return { kind: "event", event: {
    externalUid: item.id, title: item.subject || "Untitled Outlook event",
    description: typeof item.bodyPreview === "string" ? item.bodyPreview : null,
    location: typeof location?.displayName === "string" ? location.displayName : null,
    meetingUrl: parseMeetingLink(meeting?.joinUrl)?.url ?? null,
    startsAt, endsAt, allDay, recurrence: item.type === "occurrence" || item.type === "exception" ? "occurrence" : "none",
    externalEtag: typeof item["@odata.etag"] === "string" ? item["@odata.etag"] : null,
  } };
}

/** A whole page commits with its sweep markers; retrying a checkpoint cannot lose prior pages. */
export function createMicrosoftCalendarPageHandler(prisma: PrismaClient, now = () => new Date()): PageHandler {
  return async (cursor, page, run) => {
    if (cursor.workload !== "calendar") return;
    // An empty collection is valid; an absent/malformed collection is not a
    // completed snapshot and must never sweep the person's existing archive.
    if (!Array.isArray(page.raw.value)) throw new MicrosoftCalendarUnavailableError();
    const entries = page.items.map(parseMicrosoftCalendarEvent);
    await prisma.$transaction(async (tx) => {
      const owner = await lockEnabledConnection(tx, cursor.userId);
      if (!owner || !await tx.m365DeltaCursor.findFirst({ where: { id: cursor.id, userId: cursor.userId, workload: "calendar", resourceId: cursor.resourceId } })) {
        throw new MicrosoftCalendarUnavailableError();
      }
      const { source, username } = owner;
      if (!source.externalWindowStart || !source.externalWindowEnd ||
          cursor.resourceId !== calendarWindowResourceId(source.externalWindowStart, source.externalWindowEnd)) throw new MicrosoftCalendarUnavailableError();
      const runId = run.fullEnumeration ? run.isFirstPage ? randomUUID() : source.externalSyncRun : null;
      if (run.fullEnumeration && !runId) throw new MicrosoftCalendarUnavailableError();
      if (run.fullEnumeration && run.isFirstPage) await tx.calendarSource.updateMany({ where: { id: source.id, userId: username }, data: { externalSyncRun: runId } });
      await upsertExternalCalendarEvents(tx, { sourceId: source.id, userId: username,
        events: entries.filter((entry): entry is Extract<MicrosoftCalendarEntry, { kind: "event" }> => entry.kind === "event").map((entry) => entry.event),
        ...(runId ? { runId } : {}) });
      for (const entry of entries) {
        if (entry.kind === "removed") {
          // Only this bounded primary-calendar copy is removed. A tombstone for
          // an unrelated event outside the Graph window cannot touch another source.
          await tx.calendarEvent.deleteMany({ where: { userId: username, sourceId: source.id, source: "external", externalUid: entry.externalUid } });
        }
      }
      if (run.fullEnumeration && run.isLastPage) await tx.calendarEvent.deleteMany({ where: {
        userId: username, sourceId: source.id, source: "external", OR: [{ externalSeenRun: null }, { externalSeenRun: { not: runId! } }],
      } });
      if (run.isLastPage) {
        await tx.calendarSource.updateMany({ where: { id: source.id, userId: username, authMode: "m365_oauth" },
          // Retain the completed run marker until the next full first page:
          // cursor advancement happens after this transaction and may need retry.
          data: { lastSyncAt: now(), lastSyncError: null } });
        await tx.m365Connection.updateMany({ where: { userId: cursor.userId, calendarEnabled: true, calendarSourceId: source.id }, data: { calendarSyncState: "CONNECTED" } });
      }
    }, { timeout: 60_000 });
  };
}

export async function recordMicrosoftCalendarFailure(prisma: PrismaClient, userId: string, needsReconnect = false, generation?: M365GrantGeneration): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const owner = await lockEnabledConnection(tx, userId, generation);
    if (!owner) return;
    const error = needsReconnect ? "Reconnect Outlook to continue reading your calendar." : "Outlook calendar could not be read. Droplet will retry.";
    await tx.calendarSource.updateMany({ where: { id: owner.source.id, userId: owner.username, authMode: "m365_oauth" }, data: { lastSyncError: error } });
    await tx.m365Connection.updateMany({ where: { userId, calendarEnabled: true, calendarSourceId: owner.source.id },
      data: { calendarSyncState: needsReconnect ? "NEEDS_RECONNECT" : "ERROR" } });
  });
}
