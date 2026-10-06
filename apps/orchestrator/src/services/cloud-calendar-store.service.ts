/** WARP-3788: the existing read-only external calendar store, shared by both providers. */
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { parseMeetingLink } from "@droplet/shared-types";

export interface ExternalCalendarEvent {
  externalUid: string;
  title: string;
  description?: string | null;
  location?: string | null;
  meetingUrl?: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  recurrence?: "none" | "occurrence";
  externalEtag?: string | null;
}

function fields(event: ExternalCalendarEvent) {
  if (!event.externalUid || event.externalUid.length > 1024 ||
      !Number.isFinite(event.startsAt.getTime()) || !Number.isFinite(event.endsAt.getTime()) ||
      event.endsAt <= event.startsAt) throw new Error("Invalid cloud calendar event.");
  // All-day external events carry DATE values as UTC midnight. The existing
  // calendar API exposes these as startDate/endDate, with the end exclusive.
  if (event.allDay && (event.startsAt.toISOString().slice(11) !== "00:00:00.000Z" ||
      event.endsAt.toISOString().slice(11) !== "00:00:00.000Z")) {
    throw new Error("Invalid cloud calendar all-day date.");
  }
  return {
    title: event.title.trim().slice(0, 500) || "Untitled event",
    description: event.description?.slice(0, 10000) ?? null,
    location: event.location?.slice(0, 500) ?? null,
    meetingUrl: event.meetingUrl ? parseMeetingLink(event.meetingUrl)?.url ?? null : null,
    startsAt: event.startsAt, endsAt: event.endsAt, allDay: event.allDay,
    recurrence: event.recurrence ?? "none", externalEtag: event.externalEtag ?? null,
  };
}

/** Caller holds the provider connection lock and checks its active owner/opt-in. */
export async function upsertExternalCalendarEvents(tx: Prisma.TransactionClient, input: {
  sourceId: string; userId: string; events: ExternalCalendarEvent[]; runId?: string;
}): Promise<void> {
  const source = await tx.calendarSource.findUnique({ where: { id: input.sourceId } });
  if (!source || source.userId !== input.userId ||
      !["google_oauth", "m365_oauth"].includes(source.authMode)) {
    throw new Error("Cloud calendar source unavailable.");
  }
  // Validate the whole page before any write; retries are idempotent by vendor ID.
  const incoming = new Map(input.events.map((event) => [event.externalUid, fields(event)]));
  for (const [externalUid, values] of incoming) {
    const data = { ...values, userId: input.userId, source: "external", sourceId: input.sourceId,
      ...(input.runId ? { externalSeenRun: input.runId } : {}) };
    await tx.calendarEvent.upsert({
      where: { sourceId_externalUid: { sourceId: input.sourceId, externalUid } },
      create: { ...data, externalUid }, update: data,
    });
  }
}

/** Replace only a fully fetched snapshot. Failed/truncated fetches never sweep. */
export async function replaceExternalCalendarSnapshot(tx: Prisma.TransactionClient, input: {
  sourceId: string; userId: string; events: ExternalCalendarEvent[]; syncedAt: Date;
}): Promise<void> {
  const runId = randomUUID();
  const source = await tx.calendarSource.findUnique({ where: { id: input.sourceId } });
  if (!source || source.userId !== input.userId || !["google_oauth", "m365_oauth"].includes(source.authMode)) {
    throw new Error("Cloud calendar source unavailable.");
  }
  const incoming = new Map(input.events.map((event) => [event.externalUid, fields(event)]));
  const scope = { sourceId: input.sourceId, userId: input.userId, source: "external" };
  const existing = new Map((await tx.calendarEvent.findMany({ where: scope }))
    .filter((event) => event.externalUid !== null).map((event) => [event.externalUid!, event]));
  const creates: Prisma.CalendarEventCreateManyInput[] = [];
  for (const [externalUid, values] of incoming) {
    const prior = existing.get(externalUid);
    if (!prior) {
      creates.push({ ...scope, ...values, externalUid, externalSeenRun: runId });
    } else if (Object.entries(values).some(([key, value]) => {
      const old = prior[key as keyof typeof prior];
      return value instanceof Date && old instanceof Date ? value.getTime() !== old.getTime() : value !== old;
    })) {
      await tx.calendarEvent.updateMany({ where: { ...scope, id: prior.id }, data: values });
    }
  }
  // Bounded batches avoid thousands of serial inserts or PostgreSQL's query
  // parameter limit. Unchanged event contents are never rewritten.
  const batchSize = 500;
  for (let offset = 0; offset < creates.length; offset += batchSize) {
    await tx.calendarEvent.createMany({ data: creates.slice(offset, offset + batchSize), skipDuplicates: true });
  }
  const ids = [...incoming.keys()];
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    await tx.calendarEvent.updateMany({ where: { ...scope, externalUid: { in: ids.slice(offset, offset + batchSize) } },
      data: { externalSeenRun: runId } });
  }
  await tx.calendarEvent.deleteMany({ where: {
    sourceId: input.sourceId, userId: input.userId, source: "external",
    OR: [{ externalSeenRun: null }, { externalSeenRun: { not: runId } }],
  } });
  await tx.calendarSource.update({ where: { id: input.sourceId },
    data: { lastSyncAt: input.syncedAt, lastSyncError: null } });
}
