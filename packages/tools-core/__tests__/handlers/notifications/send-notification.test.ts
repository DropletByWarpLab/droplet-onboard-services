import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import sendNotification from "../../../src/handlers/notifications/send-notification.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWith(create: Mock, userId = "alice"): ToolContext {
  return {
    prisma: { notificationLog: { create } } as unknown as ToolContext["prisma"],
    http: {} as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

describe("send_notification", () => {
  it("rejects empty title", async () => {
    const r = await sendNotification.handler({ title: "" }, ctxWith(vi.fn()));
    expect(r.ok).toBe(false);
  });

  it("creates notification with kind=ai", async () => {
    const create = vi.fn().mockResolvedValue({ id: "n1", createdAt: new Date() });
    await sendNotification.handler({ title: "Pop!" }, ctxWith(create));
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "alice", kind: "ai", title: "Pop!" }),
    });
  });
});
