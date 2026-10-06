import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
const disconnectGoogleCalendar = vi.hoisted(() => vi.fn(async () => true));
vi.mock("./google/google-auth.service.js", () => ({ disconnectGoogleCalendar }));
import { deleteSource, findStaleSources, syncSource } from "./calendar.service.js";

function setup(mode: string, owner = "alice") {
  const db = {
    calendarSource: { findUnique: vi.fn(async () => ({ id: "source", userId: owner, authMode: mode })),
      findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 1 })) },
    calendarEvent: { deleteMany: vi.fn(async () => ({ count: 2 })) },
    googleConnection: { findUnique: vi.fn(async () => ({ userId: "user-uuid" })), updateMany: vi.fn(async () => ({ count: 1 })) },
    m365Connection: { findUnique: vi.fn(async () => ({ userId: "user-uuid" })), updateMany: vi.fn(async () => ({ count: 1 })) },
    m365DeltaCursor: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { db, prisma: db as unknown as PrismaClient };
}
describe("cloud calendar source controls", () => {
  it("removes a Google calendar through the consent-cancelling feature lifecycle", async () => {
    disconnectGoogleCalendar.mockClear();
    const { prisma, db } = setup("google_oauth");
    await deleteSource(prisma, "alice", "source");
    expect(disconnectGoogleCalendar).toHaveBeenCalledWith(prisma, "user-uuid", "source");
    expect(db.calendarEvent.deleteMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("removing an Outlook calendar disables sync before purging only the owned copy", async () => {
    const mode = "m365_oauth";
    const { prisma, db } = setup(mode);
    await deleteSource(prisma, "alice", "source");
    const active = db.m365Connection;
    const other = db.googleConnection;
    expect(active.updateMany).toHaveBeenCalledWith({ where: { calendarSourceId: "source" }, data: {
      calendarEnabled: false, calendarSyncState: "DISCONNECTED", calendarSourceId: null,
    } });
    expect(other.updateMany).not.toHaveBeenCalled();
    expect(db.calendarEvent.deleteMany).toHaveBeenCalledWith({ where: { sourceId: "source", userId: "alice" } });
    expect(db.calendarSource.deleteMany).toHaveBeenCalledWith({ where: { id: "source", userId: "alice" } });
    expect(active.updateMany.mock.invocationCallOrder[0]).toBeLessThan(db.calendarEvent.deleteMany.mock.invocationCallOrder[0]);
    expect(db.m365DeltaCursor.deleteMany).toHaveBeenCalledWith({ where: { userId: "user-uuid", workload: "calendar" } });
  });
  it("cleans up an orphaned Google source without affecting another connection", async () => {
    disconnectGoogleCalendar.mockClear();
    const { prisma, db } = setup("google_oauth");
    db.googleConnection.findUnique.mockResolvedValue(null as never);
    await deleteSource(prisma, "alice", "source");
    expect(db.calendarSource.deleteMany).toHaveBeenCalledWith({ where: { id: "source", userId: "alice" } });
    expect(disconnectGoogleCalendar).not.toHaveBeenCalled();
    expect(db.googleConnection.updateMany).not.toHaveBeenCalled();
  });
  it("rejects removal of another person's cloud calendar", async () => {
    const { prisma, db } = setup("google_oauth", "bob");
    await expect(deleteSource(prisma, "alice", "source")).rejects.toThrow("forbidden");
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it("does not send cloud OAuth sources through the CalDAV poller or manual sync", async () => {
    const { prisma, db } = setup("google_oauth");
    expect((await syncSource(prisma, "source")).error).toContain("sync automatically");
    await findStaleSources(prisma);
    expect(db.calendarSource.findMany).toHaveBeenCalledWith({
      where: { authMode: { in: ["none", "basic"] } }, select: { id: true, syncIntervalSec: true, lastSyncAt: true },
    });
    expect(db.calendarEvent.deleteMany).not.toHaveBeenCalled();
  });
});
