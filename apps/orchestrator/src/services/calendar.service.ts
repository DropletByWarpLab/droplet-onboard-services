/**
 * Calendar business logic.
 *
 * Three responsibilities:
 *  1. CRUD on local CalendarEvent rows (the user's own calendar).
 *  2. CRUD on CalendarSource rows (external feeds the user subscribes to).
 *  3. The sync runner that periodically pulls each source, parses ICS/CalDAV,
 *     and upserts events keyed on (sourceId, externalUid).
 *
 * Routes call into this module; nothing here reads `req`. The assistant's
 * calendar tools (`@droplet/tools-core`) reach it through the same routes
 * (WARP-3101): they used to write CalendarEvent directly, keyed on a value
 * that is a User.id on one mcp-server transport and a username on the other.
 */

import type { PrismaClient } from "@prisma/client";
import { syncCalendarSource } from "./caldav.client.js";
import {
  expandIcsEvents,
  OCCURRENCE_KEY_SEPARATOR,
  recurrenceWindow,
} from "./ics-recurrence.js";
import { encryptSecret, decryptSecret } from "./encryption.service.js";
// WARP-2022 — the registration-time half of the SSRF guard. The fetch-time
// half lives in caldav.client.ts; both call the same module so there is one
// rule table, not two that can drift.
import { assertOutboundUrlAllowed } from "../lib/outbound-url-guard.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("calendar");

/** WARP-3193 PERF-10 — changed rows per update transaction in a sync. */
const SYNC_WRITE_CHUNK = 100;

// ── Local events ──

export interface EventInput {
  title: string;
  description?: string | null;
  location?: string | null;
  /** WARP-1874 — https-only video-call link. Callers MUST have run it
   *  through `meetingUrlSchema` (or `parseMeetingLink`) first; this layer
   *  persists what it is given. `null` clears an existing link. */
  meetingUrl?: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay?: boolean;
}

export async function createEvent(
  prisma: PrismaClient,
  userId: string,
  input: EventInput,
) {
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new Error("endsAt must be after startsAt");
  }
  return prisma.calendarEvent.create({
    data: {
      userId,
      title: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      meetingUrl: input.meetingUrl ?? null,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      allDay: input.allDay === true,
      source: "local",
    },
  });
}

/** WARP-3265 — date-only view of an all-day event from a subscribed feed.
 *
 *  An ICS DATE value (`DTSTART;VALUE=DATE:20260915`) has no time of day; the
 *  parser stores it as UTC midnight. A client that reads that instant in its
 *  own zone lands a day early west of UTC, so the API also sends the calendar
 *  dates themselves: `startDate`/`endDate`, `YYYY-MM-DD`, end EXCLUSIVE.
 *  Additive: `startsAt`/`endsAt` are unchanged.
 *
 *  Null for everything else. A LOCAL all-day event carries whatever instants
 *  the form sent (the creator's local midnight), so its UTC date is not its
 *  day and deriving one would be a guess. */
export function allDayDates(ev: {
  allDay: boolean;
  source: string;
  startsAt: Date;
  endsAt: Date;
}): { startDate: string | null; endDate: string | null } {
  if (!ev.allDay || ev.source !== "external") return { startDate: null, endDate: null };
  return { startDate: ev.startsAt.toISOString().slice(0, 10), endDate: ev.endsAt.toISOString().slice(0, 10) };
}

export async function listEvents(
  prisma: PrismaClient,
  userId: string,
  range: { from?: Date; to?: Date; limit?: number; query?: string },
) {
  const limit = Math.max(1, Math.min(500, range.limit ?? 200));
  return prisma.calendarEvent.findMany({
    where: {
      userId,
      ...(range.from || range.to
        ? {
            // An event overlaps the window if it ends after `from` AND starts
            // before `to`. Pure equality on startsAt would miss multi-day
            // events whose start sits before the window.
            ...(range.from ? { endsAt: { gte: range.from } } : {}),
            ...(range.to ? { startsAt: { lte: range.to } } : {}),
          }
        : {}),
      // WARP-3101 — the search_calendar_events tool: the text, in any case,
      // in the title, the notes or the place.
      ...(range.query
        ? {
            OR: [
              { title: { contains: range.query, mode: "insensitive" as const } },
              { description: { contains: range.query, mode: "insensitive" as const } },
              { location: { contains: range.query, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { startsAt: "asc" },
    take: limit,
  });
}

export async function updateEvent(
  prisma: PrismaClient,
  userId: string,
  id: string,
  patch: Partial<EventInput>,
) {
  const existing = await prisma.calendarEvent.findUnique({ where: { id } });
  if (!existing) throw new Error("event_not_found");
  if (existing.userId !== userId) throw new Error("forbidden");
  if (existing.source !== "local") {
    throw new Error("cannot modify externally-synced event");
  }
  // WARP-3101 — the range as it will be AFTER the patch. Checking only when
  // both ends arrived let a one-sided patch (a later start alone) put the end
  // before the start. The update_event tool checked this before it moved onto
  // this route, so the route now does it for the dashboard too.
  if (patch.startsAt !== undefined || patch.endsAt !== undefined) {
    const startsAt = patch.startsAt ?? existing.startsAt;
    const endsAt = patch.endsAt ?? existing.endsAt;
    if (endsAt.getTime() <= startsAt.getTime()) throw new Error("endsAt must be after startsAt");
  }
  return prisma.calendarEvent.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.location !== undefined ? { location: patch.location } : {}),
      ...(patch.meetingUrl !== undefined ? { meetingUrl: patch.meetingUrl } : {}),
      ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
      ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
      ...(patch.allDay !== undefined ? { allDay: patch.allDay } : {}),
    },
  });
}

export async function deleteEvent(
  prisma: PrismaClient,
  userId: string,
  id: string,
) {
  const existing = await prisma.calendarEvent.findUnique({ where: { id } });
  if (!existing) throw new Error("event_not_found");
  if (existing.userId !== userId) throw new Error("forbidden");
  if (existing.source !== "local") {
    throw new Error("cannot delete externally-synced event (remove the source instead)");
  }
  await prisma.calendarEvent.delete({ where: { id } });
}

// ── External sources ──

export interface SourceInput {
  name: string;
  url: string;
  authMode: "none" | "basic";
  username?: string | null;
  password?: string | null;
  syncIntervalSec?: number;
  /**
   * WARP-2022 — owner/admin opt-in to a CalDAV server inside the boundary.
   * The ROUTE decides who may set this; the service only records it. Skips
   * the private-address rules only; scheme and userinfo still apply.
   */
  allowPrivateHost?: boolean;
}

export async function createSource(
  prisma: PrismaClient,
  userId: string,
  input: SourceInput,
) {
  if (input.authMode === "basic" && !(input.username && input.password)) {
    throw new Error("basic auth requires both username and password");
  }
  // WARP-2022 — refuse a destination inside the trust boundary at WRITE time,
  // so a bad URL is a 400 when the user saves it rather than a mystery
  // lastSyncError fifteen minutes later. Structural check only (no DNS): the
  // resolving half runs at fetch time, so saving a source while the box is
  // offline still works, and a name that starts resolving somewhere private
  // later is still caught then.
  const allowPrivateHost = input.allowPrivateHost === true;
  assertOutboundUrlAllowed(input.url, { allowPrivateHost });

  return prisma.calendarSource.create({
    data: {
      userId,
      name: input.name,
      url: input.url,
      authMode: input.authMode,
      username: input.username ?? null,
      passwordEnc: input.password ? encryptSecret(input.password) : null,
      syncIntervalSec: Math.max(60, Math.min(86400, input.syncIntervalSec ?? 900)),
      allowPrivateHost,
    },
  });
}

export async function listSources(prisma: PrismaClient, userId: string) {
  const rows = await prisma.calendarSource.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  // Strip secrets before returning.
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    authMode: r.authMode,
    username: r.username,
    syncIntervalSec: r.syncIntervalSec,
    // WARP-2022 — the panel has to be able to say "this one is allowed to
    // reach the LAN", otherwise the exemption is invisible to the owner who
    // granted it.
    allowPrivateHost: r.allowPrivateHost === true,
    lastSyncAt: r.lastSyncAt,
    lastSyncError: r.lastSyncError,
    createdAt: r.createdAt,
  }));
}

export async function deleteSource(
  prisma: PrismaClient,
  userId: string,
  id: string,
) {
  const existing = await prisma.calendarSource.findUnique({ where: { id } });
  if (!existing) throw new Error("source_not_found");
  if (existing.userId !== userId) throw new Error("forbidden");
  if (existing.authMode === "google_oauth") {
    const connection = await prisma.googleConnection.findUnique({ where: { calendarSourceId: id }, select: { userId: true } });
    if (connection) {
      // Cancel consent as well as sync. An exchanging callback must not restore
      // the calendar the person just removed; Gmail can keep its own grant.
      const { disconnectGoogleCalendar } = await import("./google/google-auth.service.js");
      const removed = await disconnectGoogleCalendar(prisma, connection.userId, id);
      if (!removed && await prisma.calendarSource.findUnique({ where: { id } })) throw new Error("source_not_found");
      return;
    }
  }
  if (existing.authMode === "google_oauth" || existing.authMode === "m365_oauth") {
    // Disable the person's preference before deleting the source, in the same
    // transaction, so a late provider sync cannot recreate copied events.
    await prisma.$transaction(async (tx) => {
      const data = { calendarEnabled: false, calendarSyncState: "DISCONNECTED" as const, calendarSourceId: null };
      if (existing.authMode === "m365_oauth") {
        const connection = await tx.m365Connection.findUnique({ where: { calendarSourceId: id }, select: { userId: true } });
        await tx.m365Connection.updateMany({ where: { calendarSourceId: id }, data });
        if (connection) await tx.m365DeltaCursor.deleteMany({ where: { userId: connection.userId, workload: "calendar" } });
      }
      await tx.calendarEvent.deleteMany({ where: { sourceId: id, userId } });
      await tx.calendarSource.deleteMany({ where: { id, userId } });
    });
    return;
  }
  // Cascade by hand — Prisma schema doesn't declare a relation onDelete
  // because CalendarEvent.sourceId is a soft FK (we want to keep the data
  // model simple and avoid migrations every time we add a source kind).
  await prisma.$transaction([
    prisma.calendarEvent.deleteMany({ where: { sourceId: id, userId } }),
    prisma.calendarSource.delete({ where: { id } }),
  ]);
}

/** Pull a single source and upsert events. Marks lastSyncAt + lastSyncError
 *  on the source row regardless of outcome. Returns counts. */
export async function syncSource(
  prisma: PrismaClient,
  sourceId: string,
): Promise<{ added: number; updated: number; removed?: number; total: number; error?: string }> {
  const source = await prisma.calendarSource.findUnique({ where: { id: sourceId } });
  if (!source) throw new Error("source_not_found");
  if (source.authMode === "google_oauth" || source.authMode === "m365_oauth") {
    // Cloud calendars use their provider's OAuth scheduler, never CalDAV/ICS.
    return { added: 0, updated: 0, total: 0, error: "Cloud calendars sync automatically. Manage the connection in Settings." };
  }

  let password: string | null = null;
  if (source.passwordEnc) {
    try {
      password = decryptSecret(source.passwordEnc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.calendarSource.update({
        where: { id: source.id },
        data: { lastSyncAt: new Date(), lastSyncError: `decrypt: ${msg}` },
      });
      return { added: 0, updated: 0, total: 0, error: `decrypt: ${msg}` };
    }
  }

  const result = await syncCalendarSource({
    url: source.url,
    authMode: source.authMode as "none" | "basic",
    username: source.username,
    password,
    // WARP-2022 — `=== true` is the fail-closed comparison. This is the path
    // the background poller drives, so a row whose column is absent (read
    // back before a client regen) or null must be treated as NOT exempt.
    allowPrivateHost: source.allowPrivateHost === true,
  });
  if (!result.ok) {
    await prisma.calendarSource.update({
      where: { id: source.id },
      data: { lastSyncAt: new Date(), lastSyncError: result.error },
    });
    return { added: 0, updated: 0, total: 0, error: result.error };
  }

  // WARP-3193 PERF-10 — diff before writing. This used to be one upsert per
  // event, serially, on feeds up to 50 MB: thousands of round trips per sync,
  // most of them rewriting rows that had not changed. Now: one read of the
  // source's rows, one batched insert of the new UIDs, and chunked
  // transactions for only the rows whose fields actually changed. Still
  // keyed on (sourceId, externalUid), whose unique index keeps a re-sync
  // from ever duplicating (skipDuplicates covers a racing manual sync).
  //
  // WARP-3266 — recurring series are expanded into one row per occurrence
  // inside a bounded window; each row's key is stable across syncs (see
  // ics-recurrence.ts). UID-less events are dropped there (RFC 5545 requires
  // UID); a repeated UID: the last one wins, as before.
  const now = new Date();
  const expanded = await expandIcsEvents(result.events, now);
  const incoming = new Map<string, (typeof expanded)[number]>();
  for (const ev of expanded) incoming.set(ev.key, ev);
  const fields = (ev: (typeof expanded)[number]) => ({
    title: ev.summary,
    description: ev.description ?? null,
    location: ev.location ?? null,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    allDay: ev.allDay,
    recurrence: ev.recurrence,
  });
  const existing = await prisma.calendarEvent.findMany({
    where: { sourceId: source.id },
    select: {
      id: true,
      externalUid: true,
      title: true,
      description: true,
      location: true,
      startsAt: true,
      endsAt: true,
      allDay: true,
      recurrence: true,
    },
  });
  const byUid = new Map(existing.map((row) => [row.externalUid, row]));

  // WARP-3266 upgrade path: the row an older build stored for a series (bare
  // UID, first instance) BECOMES that series' first occurrence, renamed in
  // place, so CrmActivity / Reminder links to it survive.
  const adopted = new Set<string>();
  for (const ev of result.events) {
    if (!ev.uid || !ev.rrule || ev.recurrenceId || incoming.has(ev.uid)) continue;
    const legacy = byUid.get(ev.uid);
    const firstKey = `${ev.uid}${OCCURRENCE_KEY_SEPARATOR}${ev.startsAt.toISOString()}`;
    if (legacy && incoming.has(firstKey) && !byUid.has(firstKey)) {
      byUid.delete(ev.uid);
      byUid.set(firstKey, legacy);
      adopted.add(legacy.id);
    }
  }

  const toCreate: Array<ReturnType<typeof fields> & { uid: string }> = [];
  const toUpdate: Array<{ id: string; uid: string; data: ReturnType<typeof fields> & { externalUid?: string } }> = [];
  for (const [uid, ev] of incoming) {
    const data = fields(ev);
    const row = byUid.get(uid);
    if (!row) {
      toCreate.push({ ...data, uid });
    } else if (row.externalUid !== uid) {
      toUpdate.push({ id: row.id, uid, data: { ...data, externalUid: uid } });
    } else if (
      row.title !== data.title ||
      row.description !== data.description ||
      row.location !== data.location ||
      row.startsAt.getTime() !== data.startsAt.getTime() ||
      row.endsAt.getTime() !== data.endsAt.getTime() ||
      row.allDay !== data.allDay ||
      row.recurrence !== data.recurrence
    ) {
      toUpdate.push({ id: row.id, uid, data });
    }
  }

  // Keep going on a failed batch — one bad chunk shouldn't sink the whole
  // sync (the same posture the per-event upsert had).
  // One createMany: Prisma splits it into statements under Postgres's bind
  // parameter limit itself.
  let added = 0;
  let notSaved = 0;
  if (toCreate.length > 0) {
    try {
      const res = await prisma.calendarEvent.createMany({
        data: toCreate.map(({ uid, ...data }) => ({
          ...data,
          userId: source.userId,
          source: "external",
          sourceId: source.id,
          externalUid: uid,
        })),
        skipDuplicates: true,
      });
      added = res.count;
    } catch (err) {
      notSaved += toCreate.length;
      logger.warn({ err, sourceId: source.id, count: toCreate.length }, "calendar event insert failed");
    }
  }
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += SYNC_WRITE_CHUNK) {
    const chunk = toUpdate.slice(i, i + SYNC_WRITE_CHUNK);
    try {
      await prisma.$transaction(
        chunk.map((u) => prisma.calendarEvent.update({ where: { id: u.id }, data: u.data })),
      );
      updated += chunk.length;
    } catch (err) {
      notSaved += chunk.length;
      logger.warn({ err, sourceId: source.id, count: chunk.length }, "calendar event update batch failed");
    }
  }

  // WARP-3266 — rows an expanded series no longer produces: the pre-expansion
  // single row keyed on the bare UID, and occurrences that an EXDATE or a
  // cancelled override has since removed. Only rows of series still in the
  // feed, and only inside the window: history older than the window, a
  // series whose occurrences all lie outside it, and events that merely left
  // the feed are kept (the same posture as before for one-off events).
  // Every UID in the feed, not only the ones expanded this time: a series
  // that is now stored `unexpanded` must lose the occurrence rows an earlier
  // sync made, or they show beside its bare row as duplicates.
  // Skipped entirely when a write failed: deleting the old rows without their
  // replacements would lose events silently.
  let removed = 0;
  if (notSaved === 0) {
    const feedUids = new Set(result.events.map((e) => e.uid).filter(Boolean));
    const win = recurrenceWindow(now);
    const staleIds = existing
      .filter((row) => {
        const key = row.externalUid;
        if (!key || incoming.has(key) || adopted.has(row.id)) return false;
        if (!(row.endsAt > win.start && row.startsAt < win.end)) return false;
        if (feedUids.has(key)) return true; // bare row a series no longer produces
        const sep = key.lastIndexOf(OCCURRENCE_KEY_SEPARATOR);
        return sep > 0 && feedUids.has(key.slice(0, sep));
      })
      .map((row) => row.id);
    for (let i = 0; i < staleIds.length; i += SYNC_WRITE_CHUNK) {
      const chunk = staleIds.slice(i, i + SYNC_WRITE_CHUNK);
      try {
        const res = await prisma.calendarEvent.deleteMany({
          where: { id: { in: chunk }, sourceId: source.id },
        });
        removed += res.count;
      } catch (err) {
        logger.warn({ err, sourceId: source.id, count: chunk.length }, "calendar stale occurrence delete failed");
      }
    }
  }

  const error = notSaved > 0 ? `write: ${notSaved} event(s) not saved; will retry` : undefined;
  await prisma.calendarSource.update({
    where: { id: source.id },
    data: { lastSyncAt: new Date(), lastSyncError: error ?? null },
  });
  return { added, updated, removed, total: incoming.size, ...(error ? { error } : {}) };
}

/** Find sources whose syncIntervalSec has elapsed since lastSyncAt. Used by
 *  the periodic sync poller. */
export async function findStaleSources(prisma: PrismaClient): Promise<string[]> {
  const all = await prisma.calendarSource.findMany({
    where: { authMode: { in: ["none", "basic"] } },
    select: { id: true, syncIntervalSec: true, lastSyncAt: true },
  });
  const now = Date.now();
  return all
    .filter((s) => {
      if (!s.lastSyncAt) return true;
      return now - s.lastSyncAt.getTime() >= s.syncIntervalSec * 1000;
    })
    .map((s) => s.id);
}
