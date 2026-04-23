import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

// Mocks need to be hoisted before SUT import.
const fetchIcsFeed = vi.fn();
const syncCalendarSourceMock = vi.fn();
vi.mock("../services/caldav.client.js", () => ({
  fetchIcsFeed: (...a: unknown[]) => fetchIcsFeed(...a),
  syncCalendarSource: (...a: unknown[]) => syncCalendarSourceMock(...a),
}));

// Encryption — keep round-trip behavior so the password handling code doesn't
// hit a missing-key error. Stubbed identity: encrypt = `enc:` + plaintext.
vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ""),
}));

import {
  createEvent,
  listEvents,
  updateEvent,
  deleteEvent,
  createSource,
  syncSource,
} from "../services/calendar.service.js";

function makePrismaStub() {
  const events: any[] = [];
  const sources: any[] = [];
  let nextId = 1;
  const stub = {
    calendarEvent: {
      create: vi.fn(async ({ data }: any) => {
        const ev = {
          id: `ev-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        events.push(ev);
        return ev;
      }),
      findMany: vi.fn(async ({ where, take }: any) => {
        let rows = events.filter((e) => !where?.userId || e.userId === where.userId);
        if (where?.endsAt?.gte) rows = rows.filter((e) => e.endsAt >= where.endsAt.gte);
        if (where?.startsAt?.lte) rows = rows.filter((e) => e.startsAt <= where.startsAt.lte);
        return rows.slice(0, take);
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        events.find((e) => e.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const ev = events.find((e) => e.id === where.id);
        if (!ev) throw new Error("not found");
        Object.assign(ev, data);
        ev.updatedAt = new Date();
        return ev;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const idx = events.findIndex((e) => e.id === where.id);
        if (idx >= 0) events.splice(idx, 1);
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i].sourceId === where.sourceId) events.splice(i, 1);
        }
      }),
      upsert: vi.fn(async ({ where, create, update: upd }: any) => {
        const existing = events.find(
          (e) => e.sourceId === where.sourceId_externalUid?.sourceId
            && e.externalUid === where.sourceId_externalUid?.externalUid,
        );
        if (existing) {
          Object.assign(existing, upd);
          existing.updatedAt = new Date(existing.updatedAt.getTime() + 1000);
          return existing;
        }
        const ev = {
          id: `ev-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
        };
        events.push(ev);
        return ev;
      }),
    },
    calendarSource: {
      create: vi.fn(async ({ data }: any) => {
        const src = {
          id: `src-${nextId++}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          lastSyncAt: null,
          lastSyncError: null,
          ...data,
        };
        sources.push(src);
        return src;
      }),
      findUnique: vi.fn(async ({ where }: any) =>
        sources.find((s) => s.id === where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: any) => {
        const src = sources.find((s) => s.id === where.id);
        if (!src) throw new Error("not found");
        Object.assign(src, data);
        return src;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const idx = sources.findIndex((s) => s.id === where.id);
        if (idx >= 0) sources.splice(idx, 1);
      }),
    },
    $transaction: vi.fn(async (ops: any[]) => Promise.all(ops)),
    _events: events,
    _sources: sources,
  };
  return stub as unknown as PrismaClient & { _events: any[]; _sources: any[] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createEvent", () => {
  it("creates a local event with sane defaults", async () => {
    const prisma = makePrismaStub();
    const ev = await createEvent(prisma, "alice", {
      title: "Lunch",
      startsAt: new Date("2026-04-23T12:00:00Z"),
      endsAt: new Date("2026-04-23T13:00:00Z"),
    });
    expect(ev.userId).toBe("alice");
    expect(ev.source).toBe("local");
    expect(ev.allDay).toBe(false);
  });

  it("rejects an event whose end is before its start", async () => {
    const prisma = makePrismaStub();
    await expect(
      createEvent(prisma, "alice", {
        title: "Bad",
        startsAt: new Date("2026-04-23T13:00:00Z"),
        endsAt: new Date("2026-04-23T12:00:00Z"),
      }),
    ).rejects.toThrow(/endsAt must be after startsAt/);
  });
});

describe("listEvents", () => {
  it("filters by userId and overlapping time window", async () => {
    const prisma = makePrismaStub();
    await createEvent(prisma, "alice", {
      title: "A",
      startsAt: new Date("2026-04-23T10:00:00Z"),
      endsAt: new Date("2026-04-23T11:00:00Z"),
    });
    await createEvent(prisma, "alice", {
      title: "B",
      startsAt: new Date("2026-05-01T10:00:00Z"),
      endsAt: new Date("2026-05-01T11:00:00Z"),
    });
    await createEvent(prisma, "bob", {
      title: "Bob's event",
      startsAt: new Date("2026-04-23T10:00:00Z"),
      endsAt: new Date("2026-04-23T11:00:00Z"),
    });

    const aprilOnly = await listEvents(prisma, "alice", {
      from: new Date("2026-04-20T00:00:00Z"),
      to: new Date("2026-04-30T00:00:00Z"),
    });
    expect(aprilOnly).toHaveLength(1);
    expect(aprilOnly[0].title).toBe("A");

    const allAlice = await listEvents(prisma, "alice", {});
    expect(allAlice).toHaveLength(2);
  });
});

describe("updateEvent", () => {
  it("updates a local event owned by the user", async () => {
    const prisma = makePrismaStub();
    const created = await createEvent(prisma, "alice", {
      title: "Old",
      startsAt: new Date("2026-04-23T10:00:00Z"),
      endsAt: new Date("2026-04-23T11:00:00Z"),
    });
    const updated = await updateEvent(prisma, "alice", created.id, { title: "New" });
    expect(updated.title).toBe("New");
  });

  it("forbids updating another user's event", async () => {
    const prisma = makePrismaStub();
    const created = await createEvent(prisma, "alice", {
      title: "X",
      startsAt: new Date("2026-04-23T10:00:00Z"),
      endsAt: new Date("2026-04-23T11:00:00Z"),
    });
    await expect(updateEvent(prisma, "bob", created.id, { title: "hijack" }))
      .rejects.toThrow(/forbidden/);
  });

  it("refuses to modify an externally-synced event", async () => {
    const prisma = makePrismaStub();
    (prisma as any)._events.push({
      id: "ext-1",
      userId: "alice",
      source: "external",
      sourceId: "src-1",
      externalUid: "u@x",
      title: "From iCloud",
      startsAt: new Date(),
      endsAt: new Date(),
      allDay: false,
    });
    await expect(updateEvent(prisma, "alice", "ext-1", { title: "rewrite" }))
      .rejects.toThrow(/cannot modify externally-synced/);
  });
});

describe("deleteEvent", () => {
  it("refuses to delete an externally-synced event", async () => {
    const prisma = makePrismaStub();
    (prisma as any)._events.push({
      id: "ext-1",
      userId: "alice",
      source: "external",
      title: "From iCloud",
      startsAt: new Date(),
      endsAt: new Date(),
      allDay: false,
    });
    await expect(deleteEvent(prisma, "alice", "ext-1"))
      .rejects.toThrow(/cannot delete externally-synced/);
  });
});

describe("createSource", () => {
  it("encrypts the password before persisting", async () => {
    const prisma = makePrismaStub();
    const src = await createSource(prisma, "alice", {
      name: "iCloud",
      url: "https://example.com/cal",
      authMode: "basic",
      username: "alice",
      password: "secret",
    });
    expect(src.passwordEnc).toBe("enc:secret");
    // raw password must never appear on the row
    expect((src as any).password).toBeUndefined();
  });

  it("rejects basic auth missing username or password", async () => {
    const prisma = makePrismaStub();
    await expect(
      createSource(prisma, "alice", {
        name: "x",
        url: "https://x",
        authMode: "basic",
        username: "alice",
        // no password
      }),
    ).rejects.toThrow(/basic auth requires/);
  });
});

describe("syncSource", () => {
  it("upserts events from the feed and clears lastSyncError on success", async () => {
    const prisma = makePrismaStub();
    const src = await createSource(prisma, "alice", {
      name: "Feed",
      url: "https://x.ics",
      authMode: "none",
    });
    syncCalendarSourceMock.mockResolvedValueOnce({
      ok: true,
      events: [
        {
          uid: "u1@x",
          summary: "Coffee",
          startsAt: new Date("2026-04-23T14:00:00Z"),
          endsAt: new Date("2026-04-23T15:00:00Z"),
          allDay: false,
        },
        {
          uid: "u2@x",
          summary: "Lunch",
          startsAt: new Date("2026-04-24T12:00:00Z"),
          endsAt: new Date("2026-04-24T13:00:00Z"),
          allDay: false,
        },
      ],
    });
    const r = await syncSource(prisma, src.id);
    expect(r.total).toBe(2);
    expect(r.added + r.updated).toBe(2);
    const updatedSrc = (prisma as any)._sources.find((s: any) => s.id === src.id);
    expect(updatedSrc.lastSyncError).toBeNull();
    expect(updatedSrc.lastSyncAt).toBeInstanceOf(Date);
  });

  it("re-sync of identical UIDs updates in place (no duplicates)", async () => {
    const prisma = makePrismaStub();
    const src = await createSource(prisma, "alice", {
      name: "Feed",
      url: "https://x.ics",
      authMode: "none",
    });
    const ev = {
      uid: "u1@x",
      summary: "Coffee",
      startsAt: new Date("2026-04-23T14:00:00Z"),
      endsAt: new Date("2026-04-23T15:00:00Z"),
      allDay: false,
    };
    syncCalendarSourceMock.mockResolvedValueOnce({ ok: true, events: [ev] });
    syncCalendarSourceMock.mockResolvedValueOnce({
      ok: true,
      events: [{ ...ev, summary: "Coffee (renamed)" }],
    });
    await syncSource(prisma, src.id);
    await syncSource(prisma, src.id);
    expect((prisma as any)._events).toHaveLength(1);
    expect((prisma as any)._events[0].title).toBe("Coffee (renamed)");
  });

  it("persists lastSyncError on fetch failure", async () => {
    const prisma = makePrismaStub();
    const src = await createSource(prisma, "alice", {
      name: "Feed",
      url: "https://x.ics",
      authMode: "none",
    });
    syncCalendarSourceMock.mockResolvedValueOnce({ ok: false, error: "HTTP 503 Service Unavailable" });
    const r = await syncSource(prisma, src.id);
    expect(r.error).toBe("HTTP 503 Service Unavailable");
    expect((prisma as any)._sources[0].lastSyncError).toBe("HTTP 503 Service Unavailable");
  });
});
