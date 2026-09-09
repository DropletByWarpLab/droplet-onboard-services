import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import createReminder from "../../../src/handlers/reminders/create-reminder.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(create: Mock, userId = "alice"): ToolContext {
  return {
    prisma: { reminder: { create } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("create_reminder", () => {
  it("rejects bad due_at", async () => {
    const r = await createReminder.handler(
      { title: "x", due_at: "garbage" },
      ctxWith(vi.fn()),
    );
    expect(r.ok).toBe(false);
  });

  it("creates the reminder", async () => {
    const create = vi.fn().mockResolvedValue({ id: "r1", dueAt: new Date("2026-04-01T08:00:00Z") });
    const r = await createReminder.handler(
      {
        title: "Take pill",
        due_at: "2026-04-01T08:00:00Z",
        calendar_event_id: "ev1",
      },
      ctxWith(create),
    );
    expect(r.ok).toBe(true);
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "alice",
        title: "Take pill",
        calendarEventId: "ev1",
      }),
    });
  });
});
