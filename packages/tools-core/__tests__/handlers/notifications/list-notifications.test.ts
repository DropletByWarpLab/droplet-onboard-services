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

  // WARP-2909 — a row written with a deep link surfaces it so the model can
  // say "open the run" with the path; a row without one carries url: null.
  it("each row includes url (null when the row has none)", async () => {
    const at = new Date("2026-09-19T03:00:00Z");
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "n1",
        kind: "ai",
        title: "Approval needed: delete_file",
        body: "b",
        url: "/admin/audit?run=run-1",
        data: { agentRunId: "run-1", pendingTool: "delete_file", needsDecision: true },
        deliveredAt: at,
        createdAt: at,
      },
      { id: "n2", kind: "reminder", title: "Standup", body: null, url: null, data: null, deliveredAt: null, createdAt: at },
    ]);
    const res = await listNotifications.handler({}, ctxWith(findMany));
    expect(res.ok).toBe(true);
    const rows = (res as { data: { notifications: Array<Record<string, unknown>> } }).data.notifications;
    expect(rows[0]).toEqual({
      id: "n1",
      kind: "ai",
      title: "Approval needed: delete_file",
      body: "b",
      url: "/admin/audit?run=run-1",
      delivered: true,
      at: at.toISOString(),
    });
    expect(rows[1].url).toBeNull();
  });
});
