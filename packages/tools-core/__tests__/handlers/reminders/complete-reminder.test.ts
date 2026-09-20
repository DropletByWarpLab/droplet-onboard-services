import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import completeReminder from "../../../src/handlers/reminders/complete-reminder.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(
  findUnique: Mock,
  update: Mock,
  userId = "alice",
): ToolContext {
  return {
    prisma: {
      reminder: { findUnique, update },
    } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("complete_reminder", () => {
  it("404s when missing", async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const r = await completeReminder.handler({ id: "x" }, ctxWith(findUnique, vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("forbids cross-user access", async () => {
    const findUnique = vi.fn().mockResolvedValue({ userId: "bob" });
    const r = await completeReminder.handler({ id: "x" }, ctxWith(findUnique, vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("sets completedAt to now by default", async () => {
    const findUnique = vi.fn().mockResolvedValue({ userId: "alice" });
    const update = vi.fn().mockResolvedValue({});
    await completeReminder.handler({ id: "x" }, ctxWith(findUnique, update));
    const call = update.mock.calls[0][0];
    expect(call.data.completedAt).toBeInstanceOf(Date);
  });

  it("clears completedAt when completed=false", async () => {
    const findUnique = vi.fn().mockResolvedValue({ userId: "alice" });
    const update = vi.fn().mockResolvedValue({});
    await completeReminder.handler(
      { id: "x", completed: false },
      ctxWith(findUnique, update),
    );
    expect(update).toHaveBeenCalledWith({ where: { id: "x" }, data: { completedAt: null } });
  });
});
