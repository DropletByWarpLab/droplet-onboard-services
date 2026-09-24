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
      where: { username: "alice" },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
  });

  it("clamps limit to 200", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    await listNotifications.handler({ limit: 5000 }, ctxWith(findMany));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
  });

  it("WARP-2909: each row carries its deep-link url (null when none)", async () => {
    const at = new Date("2026-09-22T10:00:00Z");
    const findMany = vi.fn().mockResolvedValue([
      { id: "n1", kind: "ai", title: "Approval needed", body: null, url: "/workshop?run=r1", deliveredAt: at, createdAt: at },
      { id: "n2", kind: "reminder", title: "Standup", body: null, url: null, deliveredAt: null, createdAt: at },
    ]);
    const res = await listNotifications.handler({}, ctxWith(findMany));
    const rows = (res as { data: { notifications: Array<{ url: string | null }> } }).data.notifications;
    expect(rows.map((r) => r.url)).toEqual(["/workshop?run=r1", null]);
  });
});
