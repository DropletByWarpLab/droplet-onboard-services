/**
 * Calendar business logic.
 *
 * Three responsibilities:
 *  1. CRUD on local CalendarEvent rows (the user's own calendar).
 *  2. CRUD on CalendarSource rows (external feeds the user subscribes to).
 *  3. The sync runner that periodically pulls each source, parses ICS/CalDAV,
 *     and upserts events keyed on (sourceId, externalUid).
 *
 * Routes call into this module; nothing here reads `req`. (LLM tooling
 * lives in `@droplet/tools-core` and uses Prisma directly per spec §6.)
 */

import type { PrismaClient } from "@prisma/client";
import { syncCalendarSource } from "./caldav.client.js";
import { encryptSecret, decryptSecret } from "./encryption.service.js";
// WARP-2022 — the registration-time half of the SSRF guard. The fetch-time
// half lives in caldav.client.ts; both call the same module so there is one
// rule table, not two that can drift.
import { assertOutboundUrlAllowed } from "../lib/outbound-url-guard.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("calendar");

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

export async function listEvents(
  prisma: PrismaClient,
  userId: string,
  range: { from?: Date; to?: Date; limit?: number },
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
  if (patch.startsAt && patch.endsAt && patch.endsAt.getTime() <= patch.startsAt.getTime()) {
    throw new Error("endsAt must be after startsAt");
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
): Promise<{ added: number; updated: number; total: number; error?: string }> {
  const source = await prisma.calendarSource.findUnique({ where: { id: sourceId } });
  if (!source) throw new Error("source_not_found");

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

  // Upsert each event keyed on (sourceId, externalUid). The unique index
  // makes this idempotent — re-sync of the same feed never duplicates.
  let added = 0;
  let updated = 0;
  for (const ev of result.events) {
    if (!ev.uid) continue; // RFC 5545 requires UID; skip malformed
    try {
      const upserted = await prisma.calendarEvent.upsert({
        where: {
          sourceId_externalUid: { sourceId: source.id, externalUid: ev.uid },
        },
        create: {
          userId: source.userId,
          title: ev.summary,
          description: ev.description ?? null,
          location: ev.location ?? null,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          allDay: ev.allDay,
          source: "external",
          sourceId: source.id,
          externalUid: ev.uid,
        },
        update: {
          title: ev.summary,
          description: ev.description ?? null,
          location: ev.location ?? null,
          startsAt: ev.startsAt,
          endsAt: ev.endsAt,
          allDay: ev.allDay,
        },
      });
      // Heuristic: if updatedAt is within 100ms of createdAt, it's a fresh
      // insert. Cheaper than a separate findUnique per event.
      if (upserted.updatedAt.getTime() - upserted.createdAt.getTime() < 100) added++;
      else updated++;
    } catch (err) {
      // Keep going on individual failures — one bad event shouldn't sink
      // the whole sync.
      logger.warn({ err, uid: ev.uid }, "calendar event upsert failed");
    }
  }

  await prisma.calendarSource.update({
    where: { id: source.id },
    data: { lastSyncAt: new Date(), lastSyncError: null },
  });
  return { added, updated, total: result.events.length };
}

/** Find sources whose syncIntervalSec has elapsed since lastSyncAt. Used by
 *  the periodic sync poller. */
export async function findStaleSources(prisma: PrismaClient): Promise<string[]> {
  const all = await prisma.calendarSource.findMany({
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
