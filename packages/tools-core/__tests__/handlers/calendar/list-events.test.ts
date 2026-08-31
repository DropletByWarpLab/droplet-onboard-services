import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listEvents from "../../../src/handlers/calendar/list-events.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(findMany: Mock, userId?: string): ToolContext {
  return {
    prisma: { calendarEvent: { findMany } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: userId === undefined ? "alice" : userId,
    signal: new AbortController().signal,
  };
}

describe("list_events", () => {
  it("requires auth", async () => {
    const r = await listEvents.handler({}, ctxWith(vi.fn(), ""));
    expect(r.ok).toBe(false);
  });

  it("queries Prisma scoped to userId and returns mapped rows", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "e1",
        title: "Daily standup",
        startsAt: new Date("2026-04-01T10:00:00Z"),
        endsAt: new Date("2026-04-01T10:15:00Z"),
        allDay: false,
        location: null,
        source: "local",
      },
    ]);
    const r = await listEvents.handler({}, ctxWith(findMany));
    expect(r.ok).toBe(true);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "alice" }),
    }));
    if (r.ok) {
      const data = r.data as { count: number };
      expect(data.count).toBe(1);
    }
  });
});
