import { describe, it, expect, vi } from "vitest";
import searchEvents from "../../../src/handlers/calendar/search-events.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(findMany: ReturnType<typeof vi.fn>, userId?: string): ToolContext {
  return {
    prisma: { calendarEvent: { findMany } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: userId === undefined ? "alice" : userId,
    signal: new AbortController().signal,
  };
}

describe("search_calendar_events", () => {
  it("requires auth", async () => {
    const findMany = vi.fn();
    const r = await searchEvents.handler({ query: "standup" }, ctxWith(findMany, ""));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("AUTH_REQUIRED");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("queries Prisma with a case-insensitive OR over title/description/location, range threading, orderBy and take", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "e1",
        title: "Dentist appointment",
        startsAt: new Date("2026-08-01T10:00:00Z"),
        endsAt: new Date("2026-08-01T11:00:00Z"),
        allDay: false,
        location: "Downtown clinic",
        meetingUrl: null,
        source: "local",
      },
    ]);
    const r = await searchEvents.handler(
      {
        query: "dentist",
        from: "2026-08-01T00:00:00Z",
        to: "2026-08-31T00:00:00Z",
        limit: 5,
      },
      ctxWith(findMany),
    );
    expect(r.ok).toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: "alice",
        AND: [
          { startsAt: { gte: new Date("2026-08-01T00:00:00Z") } },
          { startsAt: { lte: new Date("2026-08-31T00:00:00Z") } },
        ],
        OR: [
          { title: { contains: "dentist", mode: "insensitive" } },
          { description: { contains: "dentist", mode: "insensitive" } },
          { location: { contains: "dentist", mode: "insensitive" } },
        ],
      },
      orderBy: { startsAt: "asc" },
      take: 5,
    });
    if (r.ok) {
      const data = r.data as {
        type: string;
        count: number;
        query: string;
        events: Array<Record<string, unknown>>;
      };
      expect(data.type).toBe("search_calendar_events");
      expect(data.count).toBe(1);
      expect(data.query).toBe("dentist");
      // Event shape mirrors list_events so the two tools stay interchangeable.
      expect(data.events[0]).toEqual({
        id: "e1",
        title: "Dentist appointment",
        starts_at: "2026-08-01T10:00:00.000Z",
        ends_at: "2026-08-01T11:00:00.000Z",
        all_day: false,
        location: "Downtown clinic",
        meeting_url: null,
        source: "local",
      });
    }
  });

  it("omits the range clause when no from/to given and defaults limit to 25", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const r = await searchEvents.handler({ query: "standup" }, ctxWith(findMany));
    expect(r.ok).toBe(true);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: "alice",
        OR: [
          { title: { contains: "standup", mode: "insensitive" } },
          { description: { contains: "standup", mode: "insensitive" } },
          { location: { contains: "standup", mode: "insensitive" } },
        ],
      },
      orderBy: { startsAt: "asc" },
      take: 25,
    });
  });

  it("threads a one-sided range (from only)", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const r = await searchEvents.handler(
      { query: "standup", from: "2026-08-01T00:00:00Z" },
      ctxWith(findMany),
    );
    expect(r.ok).toBe(true);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [{ startsAt: { gte: new Date("2026-08-01T00:00:00Z") } }],
        }),
      }),
    );
  });

  it("rejects a range-only call: query is required", async () => {
    const findMany = vi.fn();
    const r = await searchEvents.handler(
      { from: "2026-08-01T00:00:00Z", to: "2026-08-31T00:00:00Z" },
      ctxWith(findMany),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects an over-long query without hitting Prisma", async () => {
    const findMany = vi.fn();
    const r = await searchEvents.handler({ query: "x".repeat(201) }, ctxWith(findMany));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects invalid dates without hitting Prisma", async () => {
    const findMany = vi.fn();
    for (const args of [
      { query: "standup", from: "garbage" },
      { query: "standup", to: "not-a-date" },
    ]) {
      const r = await searchEvents.handler(args, ctxWith(findMany));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range or non-integer limit without hitting Prisma", async () => {
    const findMany = vi.fn();
    for (const limit of [0, 101, 2.5, "ten"]) {
      const r = await searchEvents.handler({ query: "standup", limit }, ctxWith(findMany));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    }
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns an empty result cleanly", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const r = await searchEvents.handler({ query: "nothing-matches" }, ctxWith(findMany));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const data = r.data as { count: number; events: unknown[] };
      expect(data.count).toBe(0);
      expect(data.events).toEqual([]);
    }
  });

  it("metadata: Tier-1 read-only, query required, no extra args", () => {
    expect(searchEvents.name).toBe("search_calendar_events");
    expect(searchEvents.requiresWrite).toBe(false);
    expect(searchEvents.requiresConfirmation).toBe(false);
    const schema = searchEvents.inputSchema as {
      required?: readonly string[];
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    expect(schema.required).toEqual(["query"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "from",
      "limit",
      "query",
      "to",
    ]);
    // The calendar has no attendee data — the description must say so, or
    // the model will try to search by attendee and misread empty results.
    expect(searchEvents.description).toMatch(/attendee/i);
  });
});
