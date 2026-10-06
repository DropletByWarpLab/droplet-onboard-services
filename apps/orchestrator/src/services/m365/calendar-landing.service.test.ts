import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
vi.mock("../activity.singleton.js", () => ({ recordActivity: vi.fn(async () => {}) }));
import { disconnect, getConnectionView, purgeM365ForUser, setCalendarEnabled } from "./m365-auth.service.js";
import { calendarWindowResourceId, initialUrlFor } from "./graph-resources.js";
import { createMicrosoftCalendarPageHandler, ensureMicrosoftCalendarCursor, parseMicrosoftCalendarEvent,
  setMicrosoftCalendarEnabled, recordMicrosoftCalendarFailure } from "./calendar-landing.service.js";
import type { DueCursor } from "./delta-cursor.service.js";
import type { GraphPage } from "./graph-client.js";

const USER = "directory-uuid";
const LOGIN = "calendar-owner";
const NOW = new Date("2026-10-05T12:00:00Z");
const event = (id = "event-1", over: Record<string, unknown> = {}) => ({
  id, subject: "Appointment", bodyPreview: "Plain notes", location: { displayName: "Office" },
  start: { dateTime: "2026-10-05T09:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-10-05T10:00:00.0000000", timeZone: "UTC" },
  isAllDay: false, type: "singleInstance", ...over,
});

function fakeCalendarDb() {
  let serial = 0;
  let person: any = { id: USER, username: LOGIN, directoryStatus: "ACTIVE", deletionStatus: "NONE" };
  let connection: any = { id: "connection-1", userId: USER, state: "CONNECTED", calendarEnabled: false,
    calendarSourceId: null, calendarSyncState: "DISCONNECTED", grantedScopes: "Calendars.Read Mail.Read", sharePointEnabled: false };
  let sources: any[] = [];
  let events: any[] = [];
  let cursors: any[] = [];
  const matches = (row: any, where: any): boolean => row != null && Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === "OR") return value.some((clause: any) => matches(row, clause));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("not" in value) return row[key] !== value.not;
      if ("in" in value) return value.in.includes(row[key]);
    }
    return row[key] instanceof Date && value instanceof Date ? row[key].getTime() === value.getTime() : row[key] === value;
  });
  const db: any = {
    user: { findFirst: vi.fn(async ({ where }: any) => matches(person, where) ? { ...person } : null) },
    m365Connection: {
      findUnique: vi.fn(async ({ where }: any) => matches(connection, where) ? { ...connection } : null),
      updateMany: vi.fn(async ({ where, data }: any) => { if (!matches(connection, where)) return { count: 0 }; connection = { ...connection, ...data }; return { count: 1 }; }),
      update: vi.fn(async ({ data }: any) => { connection = { ...connection, ...data }; return { ...connection }; }),
      deleteMany: vi.fn(async ({ where }: any) => { const count = Number(matches(connection, where)); if (count) connection = null; return { count }; }),
    },
    calendarSource: {
      findFirst: vi.fn(async ({ where }: any) => sources.find((s) => matches(s, where)) ?? null),
      findUnique: vi.fn(async ({ where }: any) => sources.find((s) => matches(s, where)) ?? null),
      create: vi.fn(async ({ data }: any) => { const source = { id: `source-${++serial}`, externalSyncRun: null, externalWindowStart: null, externalWindowEnd: null, lastSyncAt: null, lastSyncError: null, ...data }; sources.push(source); return source; }),
      updateMany: vi.fn(async ({ where, data }: any) => { const found = sources.filter((s) => matches(s, where)); for (const s of found) Object.assign(s, data); return { count: found.length }; }),
      deleteMany: vi.fn(async ({ where }: any) => { const found = sources.filter((s) => matches(s, where)); sources = sources.filter((s) => !matches(s, where)); return { count: found.length }; }),
    },
    calendarEvent: {
      upsert: vi.fn(async ({ where, create, update }: any) => { const key = where.sourceId_externalUid; const existing = events.find((e) => matches(e, key)); if (existing) { Object.assign(existing, update); return existing; } const added = { id: `event-${++serial}`, externalSeenRun: null, ...create }; events.push(added); return added; }),
      deleteMany: vi.fn(async ({ where }: any) => { const before = events.length; events = events.filter((e) => !matches(e, where)); return { count: before - events.length }; }),
    },
    m365DeltaCursor: {
      findFirst: vi.fn(async ({ where }: any) => cursors.find((c) => matches(c, where)) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => { const existing = cursors.find((c) => matches(c, where.userId_workload_resourceId)); if (existing) return Object.assign(existing, update); const c = { id: `cursor-${++serial}`, deltaLink: null, resumeLink: null, ...create }; cursors.push(c); return c; }),
      deleteMany: vi.fn(async ({ where }: any) => { const before = cursors.length; cursors = cursors.filter((c) => !matches(c, where)); return { count: before - cursors.length }; }),
    },
    cloudFileItem: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    cloudFileSource: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: async (work: any) => {
      const snapshot = structuredClone({ person, connection, sources, events, cursors });
      try { return await work(db); } catch (error) { ({ person, connection, sources, events, cursors } = snapshot); throw error; }
    },
  };
  return { prisma: db as PrismaClient, person: () => person, connection: () => connection,
    sources: () => sources, events: () => events, cursors: () => cursors,
    addEvent: (e: any) => events.push({ externalSeenRun: null, ...e }),
    addSource: (s: any) => sources.push(s), removeCursor: () => { cursors = []; } };
}

function page(items: unknown[]): GraphPage { return { items, links: { deltaLink: null, nextLink: null }, raw: { value: items } } as GraphPage; }
async function enabled() {
  const db = fakeCalendarDb();
  expect(await setMicrosoftCalendarEnabled(db.prisma, USER, true)).toBe(true);
  expect(await ensureMicrosoftCalendarCursor(db.prisma, USER, NOW)).toBe(true);
  return { db, cursor: db.cursors()[0] as DueCursor, handler: createMicrosoftCalendarPageHandler(db.prisma, () => NOW) };
}

describe("Microsoft calendar dates and vendor fields", () => {
  it("normalizes UTC timed events, meeting links and recurring occurrence ids", () => {
    const parsed = parseMicrosoftCalendarEvent(event("occurrence-1", { type: "exception", onlineMeeting: { joinUrl: " HTTPS://teams.microsoft.com/meet/abc " } }));
    expect(parsed).toMatchObject({ kind: "event", event: { externalUid: "occurrence-1", recurrence: "occurrence", meetingUrl: "https://teams.microsoft.com/meet/abc", description: "Plain notes", location: "Office" } });
    if (parsed.kind === "event") expect(parsed.event.startsAt.toISOString()).toBe("2026-10-05T09:00:00.000Z");
  });
  it.each([
    ["Pacific Standard Time", "2026-03-08T08:00:00", "2026-03-09T07:00:00", "2026-03-08", "2026-03-09"],
    ["Line Islands Standard Time", "2026-10-04T10:00:00", "2026-10-05T10:00:00", "2026-10-05", "2026-10-06"],
    ["India Standard Time", "2026-10-04T18:30:00", "2026-10-05T18:30:00", "2026-10-05", "2026-10-06"],
  ])("keeps all-day dates in %s, including the DST transition", (original, start, end, startDate, endDate) => {
    const parsed = parseMicrosoftCalendarEvent(event("all-day", { isAllDay: true, originalStartTimeZone: original, originalEndTimeZone: original,
      start: { dateTime: start, timeZone: "UTC" }, end: { dateTime: end, timeZone: "UTC" } }));
    expect(parsed).toMatchObject({ kind: "event", event: { allDay: true, startsAt: new Date(`${startDate}T00:00:00Z`), endsAt: new Date(`${endDate}T00:00:00Z`) } });
  });
  it("converts an explicit non-UTC Windows timed value using its zone rather than process time", () => {
    const parsed = parseMicrosoftCalendarEvent(event("india", { start: { dateTime: "2026-10-05T09:00:00", timeZone: "India Standard Time" }, end: { dateTime: "2026-10-05T10:00:00", timeZone: "India Standard Time" } }));
    if (parsed.kind === "event") expect(parsed.event.startsAt.toISOString()).toBe("2026-10-05T03:30:00.000Z");
  });
  it("refuses all-day DATE inference from a stale creation zone rather than shifting its day", () => {
    expect(() => parseMicrosoftCalendarEvent(event("edited-zone", { isAllDay: true,
      originalStartTimeZone: "Pacific Standard Time", originalEndTimeZone: "Pacific Standard Time",
      start: { dateTime: "2026-10-05T04:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-10-06T04:00:00", timeZone: "UTC" } }))).toThrow();
    expect(parseMicrosoftCalendarEvent(event("explicit-zone", { isAllDay: true,
      originalStartTimeZone: "Pacific Standard Time", originalEndTimeZone: "Pacific Standard Time",
      start: { dateTime: "2026-10-05T00:00:00", timeZone: "Eastern Standard Time" },
      end: { dateTime: "2026-10-06T00:00:00", timeZone: "Eastern Standard Time" } }))).toMatchObject({ kind: "event", event: {
        startsAt: new Date("2026-10-05T00:00:00Z"), endsAt: new Date("2026-10-06T00:00:00Z"), allDay: true,
      } });
  });
  it("refuses unknown zones and malformed dates visibly, and discards unsafe meeting links", () => {
    expect(() => parseMicrosoftCalendarEvent(event("bad", { start: { dateTime: "2026-10-05T09:00:00", timeZone: "PRIVATE_UNKNOWN_ZONE" } }))).toThrow("The Outlook calendar is no longer available.");
    expect(() => parseMicrosoftCalendarEvent(event("bad", { end: { dateTime: "2026-02-30T09:00:00", timeZone: "UTC" } }))).toThrow();
    expect(parseMicrosoftCalendarEvent(event("safe", { onlineMeeting: { joinUrl: "javascript:alert(1)" } }))).toMatchObject({ kind: "event", event: { meetingUrl: null } });
    expect(parseMicrosoftCalendarEvent({ id: "removed", "@removed": { reason: "deleted" } })).toEqual({ kind: "removed", externalUid: "removed" });
  });
});

describe("Microsoft calendar preference and guarded delta landing", () => {
  it("defaults off and enabling creates a username-owned OAuth source with no password", async () => {
    const db = fakeCalendarDb();
    expect((await getConnectionView(db.prisma, USER)).calendar).toMatchObject({ enabled: false, state: "DISCONNECTED" });
    expect(await ensureMicrosoftCalendarCursor(db.prisma, USER, NOW)).toBe(false);
    const result = await setCalendarEnabled(db.prisma, USER, true);
    expect(result.ok).toBe(true);
    expect(db.sources()[0]).toMatchObject({ userId: LOGIN, authMode: "m365_oauth", username: null, passwordEnc: null });
    expect(db.connection()).toMatchObject({ calendarEnabled: true, calendarSyncState: "WAITING" });
  });
  it("keeps missing calendar permission as an explicit reconnect state without fetching", async () => {
    const db = fakeCalendarDb(); db.connection().grantedScopes = "Mail.Read";
    await setCalendarEnabled(db.prisma, USER, true);
    expect((await getConnectionView(db.prisma, USER)).calendar).toMatchObject({ enabled: true, state: "NEEDS_RECONNECT", needsConsent: true });
    expect(await ensureMicrosoftCalendarCursor(db.prisma, USER, NOW)).toBe(false);
    expect(db.cursors()).toHaveLength(0);
  });
  it("keeps an explicit error state when ON is repeated, even if a prior sync succeeded", async () => {
    const { db } = await enabled();
    db.sources()[0].lastSyncAt = NOW;
    db.connection().calendarSyncState = "ERROR";
    await setCalendarEnabled(db.prisma, USER, true);
    expect((await getConnectionView(db.prisma, USER)).calendar).toMatchObject({ enabled: true, state: "ERROR", lastSyncAt: NOW });
  });
  it("disconnect also purges an opt-in that committed after its initial read", async () => {
    const db = fakeCalendarDb();
    const transaction = db.prisma.$transaction.bind(db.prisma);
    let first = true;
    Object.assign(db.prisma, { $transaction: async (work: any) => {
      if (first) {
        first = false;
        await setCalendarEnabled(db.prisma, USER, true);
        db.addEvent({ userId: LOGIN, sourceId: db.sources()[0].id, source: "external", externalUid: "copied" });
      }
      return transaction(work);
    } });
    await disconnect(db.prisma, USER);
    expect(db.connection()).toMatchObject({ state: "DISCONNECTED", calendarEnabled: false, calendarSourceId: null, calendarSyncState: "DISCONNECTED" });
    expect(db.events()).toEqual([]);
    expect(db.sources()).toEqual([]);
  });
  it("uses stable delta bounds even when a resync happens on a later date", async () => {
    const { db, cursor } = await enabled();
    const first = initialUrlFor("calendar", cursor.resourceId, NOW);
    expect(initialUrlFor("calendar", cursor.resourceId, new Date("2026-12-01"))).toBe(first);
    await ensureMicrosoftCalendarCursor(db.prisma, USER, new Date("2026-12-01"));
    expect(db.cursors()[0].id).toBe(cursor.id);
    expect(cursor.resourceId).toBe(calendarWindowResourceId(db.sources()[0].externalWindowStart, db.sources()[0].externalWindowEnd));
  });
  it("sweeps only after a completed full enumeration and keeps prior checkpoint pages on retries", async () => {
    const { db, cursor, handler } = await enabled();
    const source = db.sources()[0];
    db.addEvent({ userId: LOGIN, sourceId: source.id, source: "external", externalUid: "stale" });
    db.addEvent({ userId: LOGIN, sourceId: "manual-source", source: "external", externalUid: "manual" });
    await handler(cursor, page([event("a")]), { fullEnumeration: true, isFirstPage: true, isLastPage: false });
    expect(db.events().map((e) => e.externalUid)).toContain("stale");
    await handler(cursor, page([event("b")]), { fullEnumeration: true, isFirstPage: false, isLastPage: true });
    await handler(cursor, page([event("b")]), { fullEnumeration: true, isFirstPage: false, isLastPage: true });
    expect(db.events().map((e) => e.externalUid).sort()).toEqual(["a", "b", "manual"]);
    expect((await getConnectionView(db.prisma, USER)).calendar).toMatchObject({ state: "CONNECTED", lastSyncAt: NOW, lastError: null });
  });
  it.each([{}, { value: null }, { value: {} }])("never sweeps a malformed collection envelope %j", async (raw) => {
    const { db, cursor, handler } = await enabled();
    db.addEvent({ userId: LOGIN, sourceId: db.sources()[0].id, source: "external", externalUid: "kept" });
    await expect(handler(cursor, { ...page([]), raw }, { fullEnumeration: true, isFirstPage: true, isLastPage: true })).rejects.toThrow();
    expect(db.events().map((e) => e.externalUid)).toEqual(["kept"]);
  });
  it("lands a large page with one source validation rather than one lookup per event", async () => {
    const { db, cursor, handler } = await enabled();
    const lookup = db.prisma.calendarSource.findUnique as ReturnType<typeof vi.fn>;
    lookup.mockClear();
    await handler(cursor, page(Array.from({ length: 500 }, (_, index) => event(`event-${index}`))), { fullEnumeration: true, isFirstPage: true, isLastPage: true });
    expect(db.events()).toHaveLength(500);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it("neither shows nor deletes a foreign calendar accidentally referenced by the connection", async () => {
    const db = fakeCalendarDb();
    db.addSource({ id: "foreign", userId: "someone-else", authMode: "m365_oauth", lastSyncAt: NOW, lastSyncError: "Private calendar error" });
    db.connection().calendarSourceId = "foreign";
    db.connection().calendarEnabled = true;
    db.addEvent({ userId: "someone-else", sourceId: "foreign", source: "external", externalUid: "private" });
    expect((await getConnectionView(db.prisma, USER)).calendar).toMatchObject({ lastSyncAt: null, lastError: null });
    await setCalendarEnabled(db.prisma, USER, false);
    expect(db.sources()).toHaveLength(1);
    expect(db.events()).toHaveLength(1);
  });
  it("a malformed later page never sweeps good events and reports a fixed error", async () => {
    const { db, cursor, handler } = await enabled();
    await handler(cursor, page([event("a")]), { fullEnumeration: true, isFirstPage: true, isLastPage: false });
    await expect(handler(cursor, page([event("b", { start: null })]), { fullEnumeration: true, isFirstPage: false, isLastPage: true })).rejects.toThrow();
    await recordMicrosoftCalendarFailure(db.prisma, USER);
    expect(db.events().map((e) => e.externalUid)).toEqual(["a"]);
    expect((await getConnectionView(db.prisma, USER)).calendar).toMatchObject({ state: "ERROR", lastSyncAt: null, lastError: "Outlook calendar could not be read. Droplet will retry." });
  });
  it("an old calendar request cannot change a replacement grant's calendar status", async () => {
    const { db } = await enabled();
    db.connection().tokenCacheEnc = "new-cache";
    db.connection().cursorLinkHash = "new-link";
    await recordMicrosoftCalendarFailure(db.prisma, USER, true, { tokenCacheEnc: "old-cache", cursorLinkHash: "old-link", calendarSourceId: db.sources()[0].id });
    expect(db.connection().calendarSyncState).toBe("WAITING");
    expect(db.sources()[0].lastSyncError).toBeNull();
  });
  it("removed and cancelled events affect only the owning source and incremental runs never sweep", async () => {
    const { db, cursor, handler } = await enabled();
    await handler(cursor, page([event("a"), event("b")]), { fullEnumeration: true, isFirstPage: true, isLastPage: true });
    db.addEvent({ userId: "someone-else", sourceId: "other-source", source: "external", externalUid: "a" });
    await handler(cursor, page([{ id: "a", "@removed": { reason: "deleted" } }]), { fullEnumeration: false, isFirstPage: true, isLastPage: true });
    expect(db.events().map((e) => `${e.userId}/${e.externalUid}`).sort()).toEqual([`${LOGIN}/b`, "someone-else/a"]);
    await handler(cursor, page([event("b", { isCancelled: true })]), { fullEnumeration: false, isFirstPage: true, isLastPage: true });
    expect(db.events()).toHaveLength(1);
  });
  it.each(["off", "disconnect", "leaver", "inactive", "stale-cursor"])("a late page cannot recreate data after %s", async (action) => {
    const { db, cursor, handler } = await enabled();
    if (action === "off") await setCalendarEnabled(db.prisma, USER, false);
    if (action === "disconnect") await disconnect(db.prisma, USER);
    if (action === "leaver") await purgeM365ForUser(db.prisma, USER);
    if (action === "inactive") db.person().directoryStatus = "DEACTIVATED";
    if (action === "stale-cursor") db.removeCursor();
    await expect(handler(cursor, page([event("late")]), { fullEnumeration: true, isFirstPage: true, isLastPage: true })).rejects.toThrow();
    expect(db.events()).toHaveLength(0);
    if (["off", "disconnect", "leaver"].includes(action)) { expect(db.sources()).toHaveLength(0); expect(db.cursors()).toHaveLength(0); }
  });
});
