import { describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { replaceExternalCalendarSnapshot, upsertExternalCalendarEvents, type ExternalCalendarEvent } from "./cloud-calendar-store.service.js";

const event = (extra: Partial<ExternalCalendarEvent> = {}): ExternalCalendarEvent => ({
  externalUid: "provider-event", title: "Meeting", startsAt: new Date("2026-10-05T10:00:00Z"),
  endsAt: new Date("2026-10-05T11:00:00Z"), allDay: false, ...extra,
});
function setup(owner = "alice", mode = "google_oauth") {
  const db = { calendarSource: { findUnique: vi.fn(async () => ({ id: "source", userId: owner, authMode: mode })), update: vi.fn() },
    calendarEvent: { upsert: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn(async () => [] as unknown[]),
      createMany: vi.fn(async (_args: { data: unknown[]; skipDuplicates?: boolean }) => ({ count: 0 })),
      updateMany: vi.fn(async (_args: { where: unknown; data: Record<string, unknown> }) => ({ count: 0 })) } };
  return { db, tx: db as unknown as Prisma.TransactionClient };
}
describe("cloud calendar landing", () => {
  it("keys repeated pages on provider ID, stores the calendar username, and admits only safe meeting links", async () => {
    const { tx, db } = setup();
    await upsertExternalCalendarEvents(tx, { sourceId: "source", userId: "alice", runId: "run", events: [
      event({ title: "Old" }), event({ title: "Latest", meetingUrl: "javascript:alert(1)", recurrence: "occurrence" }),
    ] });
    expect(db.calendarEvent.upsert).toHaveBeenCalledOnce();
    expect(db.calendarEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { sourceId_externalUid: { sourceId: "source", externalUid: "provider-event" } },
      create: expect.objectContaining({ userId: "alice", source: "external", title: "Latest", meetingUrl: null,
        externalSeenRun: "run", recurrence: "occurrence" }),
    }));
  });
  it.each([["bob", "google_oauth"], ["alice", "none"], ["alice", "basic"]])("refuses foreign or manual source %s/%s", async (owner, mode) => {
    const { tx, db } = setup(owner, mode);
    await expect(upsertExternalCalendarEvents(tx, { sourceId: "source", userId: "alice", events: [event()] })).rejects.toThrow();
    expect(db.calendarEvent.upsert).not.toHaveBeenCalled();
  });
  it("validates every event before writing, including dates and exclusive all-day ends", async () => {
    const { tx, db } = setup();
    for (const invalid of [event({ startsAt: new Date("invalid") }), event({ endsAt: new Date("2026-10-04") }), event({ allDay: true })]) {
      await expect(upsertExternalCalendarEvents(tx, { sourceId: "source", userId: "alice", events: [event(), invalid] })).rejects.toThrow();
    }
    expect(db.calendarEvent.upsert).not.toHaveBeenCalled();
    await upsertExternalCalendarEvents(tx, { sourceId: "source", userId: "alice", events: [event({
      allDay: true, startsAt: new Date("2026-10-05"), endsAt: new Date("2026-10-06"),
    })] });
    expect(db.calendarEvent.upsert).toHaveBeenCalledOnce();
  });
  it("sweeps only this person's completed snapshot, including unmarked old events", async () => {
    const { tx, db } = setup("alice", "m365_oauth");
    const syncedAt = new Date("2026-10-05T12:00:00Z");
    await replaceExternalCalendarSnapshot(tx, { sourceId: "source", userId: "alice", events: [], syncedAt });
    expect(db.calendarEvent.deleteMany).toHaveBeenCalledWith({ where: {
      sourceId: "source", userId: "alice", source: "external", OR: [
        { externalSeenRun: null }, { externalSeenRun: { not: expect.any(String) } },
      ],
    } });
    expect(db.calendarSource.update).toHaveBeenCalledWith({ where: { id: "source" }, data: { lastSyncAt: syncedAt, lastSyncError: null } });
  });
  it("batches snapshot inserts and leaves unchanged event contents alone", async () => {
    const { tx, db } = setup();
    const unchanged = { ...event(), id: "old-event", userId: "alice", source: "external", sourceId: "source",
      description: null, location: null, meetingUrl: null, recurrence: "none", externalEtag: null };
    db.calendarEvent.findMany.mockResolvedValue([unchanged]);
    const events = [event(), ...Array.from({ length: 501 }, (_, n) => event({ externalUid: `new-${n}` }))];
    await replaceExternalCalendarSnapshot(tx, { sourceId: "source", userId: "alice", events, syncedAt: new Date() });
    expect(db.calendarEvent.createMany).toHaveBeenCalledTimes(2);
    expect(db.calendarEvent.createMany.mock.calls[0][0].data).toHaveLength(500);
    expect(db.calendarEvent.updateMany).toHaveBeenCalledTimes(2);
    for (const [call] of db.calendarEvent.updateMany.mock.calls) expect(call.data).toEqual({ externalSeenRun: expect.any(String) });
    expect(db.calendarEvent.upsert).not.toHaveBeenCalled();
  });
});
