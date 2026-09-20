import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listReminders from "../../../src/handlers/reminders/list-reminders.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(findMany: Mock, userId = "alice"): ToolContext {
  return {
    prisma: { reminder: { findMany } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("list_reminders", () => {
  it("filters out completed by default", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listReminders.handler({}, ctxWith(findMany));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "alice", completedAt: null }),
    }));
  });

  it("includes completed when flag is set", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listReminders.handler({ include_completed: true }, ctxWith(findMany));
    const call = findMany.mock.calls[0][0];
    expect(call.where).not.toHaveProperty("completedAt");
  });
});
