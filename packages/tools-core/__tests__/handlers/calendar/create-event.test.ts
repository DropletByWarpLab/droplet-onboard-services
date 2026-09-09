import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import createEvent from "../../../src/handlers/calendar/create-event.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(create: Mock, userId?: string): ToolContext {
  return {
    prisma: { calendarEvent: { create } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: userId === undefined ? "alice" : userId,
    signal: new AbortController().signal,
  };
}

describe("create_event", () => {
  it("requires auth", async () => {
    const r = await createEvent.handler(
      { title: "x", starts_at: "2026-04-01T00:00Z", ends_at: "2026-04-01T01:00Z" },
      ctxWith(vi.fn(), ""),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects bad timestamps", async () => {
    const r = await createEvent.handler(
      { title: "x", starts_at: "garbage", ends_at: "2026-04-01T01:00Z" },
      ctxWith(vi.fn()),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects ends_at <= starts_at", async () => {
    const r = await createEvent.handler(
      { title: "x", starts_at: "2026-04-01T01:00Z", ends_at: "2026-04-01T01:00Z" },
      ctxWith(vi.fn()),
    );
    expect(r.ok).toBe(false);
  });

  it("creates the event on the user's calendar", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "evt1",
      title: "Lunch",
      startsAt: new Date("2026-04-01T12:00:00Z"),
    });
    const r = await createEvent.handler(
      {
        title: "Lunch",
        starts_at: "2026-04-01T12:00:00Z",
        ends_at: "2026-04-01T13:00:00Z",
      },
      ctxWith(create),
    );
    expect(r.ok).toBe(true);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "alice", title: "Lunch", source: "local" }),
      }),
    );
  });
});
