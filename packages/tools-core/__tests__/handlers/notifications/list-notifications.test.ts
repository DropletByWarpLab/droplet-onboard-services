import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import listNotifications from "../../../src/handlers/notifications/list-notifications.js";
import type { ToolContext } from "../../../src/types.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * WARP-3099 — the handler reads through the orchestrator's N1; its ctx.prisma
 * refuses every NotificationLog read, so a handler that goes back to reading it
 * directly (by `ctx.userId`, a User.id over the HTTP transport) fails here.
 */
function ctxWith(get: Mock, userId = "5b0c7a4e-1f2d-4c3b-9a8e-7d6f5e4c3b2a"): ToolContext {
  const refuse = vi.fn(async () => {
    throw new Error("read NotificationLog through ctx.prisma");
  });
  return {
    prisma: { notificationLog: { findMany: refuse } } as unknown as ToolContext["prisma"],
    http: { orchestrator: { get } } as unknown as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId,
    signal: new AbortController().signal,
  };
}

const ROWS = [
  {
    id: "n1",
    kind: "ai",
    title: "Approval needed",
    body: null,
    url: "/workshop?run=r1",
    deliveredAt: "2026-09-22T10:00:01.000Z",
    createdAt: "2026-09-22T10:00:00.000Z",
    ackState: "unacked",
  },
  {
    id: "n2",
    kind: "reminder",
    title: "Standup",
    body: "10:00",
    url: null,
    deliveredAt: null,
    createdAt: "2026-09-22T09:00:00.000Z",
    ackState: "acked",
  },
];

describe("list_notifications", () => {
  it("reads N1 for every row, read or not, 30 by default", async () => {
    const get = vi.fn().mockResolvedValue(json(200, { notifications: [], unread: 0, nextCursor: null }));
    await listNotifications.handler({}, ctxWith(get));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/notifications?limit=30&state=all", {
      headers: { Accept: "application/json" },
    });
  });

  it.each([
    [5000, 200],
    [0, 30],
    [-4, 1],
    [2.7, 2],
    ["12", 12],
    ["many", 30],
  ])("limit %j → %i (N1 accepts 1-200 digits only)", async (limit, sent) => {
    const get = vi.fn().mockResolvedValue(json(200, { notifications: [], unread: 0, nextCursor: null }));
    await listNotifications.handler({ limit }, ctxWith(get));
    expect(get.mock.calls[0]![0]).toBe(`/api/notifications?limit=${sent}&state=all`);
  });

  it("keeps the tool's row shape; WARP-2909: each row carries its deep-link url (null when none)", async () => {
    const get = vi.fn().mockResolvedValue(json(200, { notifications: ROWS, unread: 1, nextCursor: null }));
    const res = await listNotifications.handler({}, ctxWith(get));
    expect(res).toEqual({
      ok: true,
      data: {
        count: 2,
        notifications: [
          { id: "n1", kind: "ai", title: "Approval needed", body: null, url: "/workshop?run=r1", delivered: true, at: "2026-09-22T10:00:00.000Z" },
          { id: "n2", kind: "reminder", title: "Standup", body: "10:00", url: null, delivered: false, at: "2026-09-22T09:00:00.000Z" },
        ],
      },
    });
  });

  it("no acting user → AUTH_REQUIRED, and nothing is asked", async () => {
    const get = vi.fn();
    const res = await listNotifications.handler({}, ctxWith(get, ""));
    expect(res).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(get).not.toHaveBeenCalled();
  });

  it("403 (nobody resolved, or their access refuses the tool) → FORBIDDEN, never an empty list", async () => {
    const get = vi.fn().mockResolvedValue(json(403, { error: { code: "ACTING_USER_REQUIRED", message: "x" } }));
    const res = await listNotifications.handler({}, ctxWith(get));
    expect(res).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("any other failure is an error, never an empty list", async () => {
    const get = vi.fn().mockResolvedValue(json(500, { error: "boom" }));
    const res = await listNotifications.handler({}, ctxWith(get));
    expect(res).toMatchObject({ ok: false, error: { code: "NOTIFICATIONS_UNAVAILABLE" } });
  });
});
