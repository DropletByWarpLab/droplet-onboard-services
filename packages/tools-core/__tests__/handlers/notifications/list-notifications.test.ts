import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listNotifications from "../../../src/handlers/notifications/list-notifications.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(findMany: Mock, userId = "alice"): ToolContext {
  return {
    prisma: { notificationLog: { findMany } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("list_notifications", () => {
  it("scopes to user, orders desc, defaults limit 30", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listNotifications.handler({}, ctxWith(findMany));
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "alice" },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
  });

  it("clamps limit to 200", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listNotifications.handler({ limit: 5000 }, ctxWith(findMany));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
  });
});
