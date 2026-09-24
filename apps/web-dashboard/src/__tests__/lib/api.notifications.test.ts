/**
 * WARP-2804 — the dashboard's client for the notification routes N1–N4.
 *
 * Each helper goes through `authFetch` (an expired access token is refreshed,
 * the session cookie rides along) and throws a typed error carrying the
 * server's `error.code` and the HTTP status, so a caller can tell a 404
 * NOTIFICATION_NOT_FOUND from a network failure.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch;

import {
  getNotifications,
  getUnreadNotificationCount,
  ackNotification,
  ackAllNotifications,
} from "@/lib/api";
import type { NotificationRow } from "@/lib/types";

const ROW: NotificationRow = {
  id: "clx1",
  kind: "reminder",
  title: "Standup",
  body: null,
  url: "/calendar",
  data: null,
  createdAt: "2026-09-24T08:00:00.000Z",
  deliveredAt: "2026-09-24T08:00:00.100Z",
  channels: "toast",
  pushOutcome: "no_subscribers",
  error: null,
  ackState: "unacked",
  ackedAt: null,
  ackMethod: null,
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body), headers: new Headers() };
}

function lastCall(): [string, RequestInit] {
  return mockFetch.mock.calls[mockFetch.mock.calls.length - 1] as [string, RequestInit];
}

beforeEach(() => mockFetch.mockReset());

describe("getNotifications (N1)", () => {
  it("GETs /api/notifications with the session cookie and returns the page", async () => {
    mockFetch.mockResolvedValueOnce(ok({ notifications: [ROW], unread: 1, nextCursor: null }));
    const page = await getNotifications();
    const [url, init] = lastCall();
    expect(url).toBe("/api/notifications");
    expect(init).toMatchObject({ credentials: "same-origin" });
    expect(page).toEqual({ notifications: [ROW], unread: 1, nextCursor: null });
  });

  it("passes limit, cursor and state as query parameters", async () => {
    mockFetch.mockResolvedValueOnce(ok({ notifications: [], unread: 0, nextCursor: null }));
    await getNotifications({ limit: 20, cursor: "1790000000000.clx1", state: "unacked" });
    const [url] = lastCall();
    const q = new URL(url, "https://box.local").searchParams;
    expect(Object.fromEntries(q)).toEqual({ limit: "20", cursor: "1790000000000.clx1", state: "unacked" });
  });
});

describe("getUnreadNotificationCount (N2)", () => {
  it("returns the number", async () => {
    mockFetch.mockResolvedValueOnce(ok({ unread: 3 }));
    await expect(getUnreadNotificationCount()).resolves.toBe(3);
    expect(lastCall()[0]).toBe("/api/notifications/unread-count");
  });
});

describe("ackNotification (N3)", () => {
  it("POSTs {via} as JSON to the row's ack path, id encoded", async () => {
    mockFetch.mockResolvedValueOnce(ok({ notification: { ...ROW, ackState: "acked" }, changed: true }));
    const out = await ackNotification("clx1", { via: "opened" });
    const [url, init] = lastCall();
    expect(url).toBe("/api/notifications/clx1/ack");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ via: "opened" });
    expect(out.changed).toBe(true);
  });

  it("sends an empty body when no `via` is given (the server defaults to inbox)", async () => {
    mockFetch.mockResolvedValueOnce(ok({ notification: ROW, changed: false }));
    await ackNotification("clx1");
    expect(JSON.parse(String(lastCall()[1].body))).toEqual({});
  });

  it("encodes the id into the path", async () => {
    mockFetch.mockResolvedValueOnce(ok({ notification: ROW, changed: false }));
    await ackNotification("a/b");
    expect(lastCall()[0]).toBe("/api/notifications/a%2Fb/ack");
  });

  it("throws the server's code and status on a refusal", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: { code: "NOTIFICATION_NOT_FOUND", message: "No such notification." } }),
      headers: new Headers(),
    });
    await expect(ackNotification("clx9")).rejects.toMatchObject({ code: "NOTIFICATION_NOT_FOUND", status: 404 });
  });
});

describe("ackAllNotifications (N4)", () => {
  it("POSTs the `before` it was given", async () => {
    mockFetch.mockResolvedValueOnce(ok({ acked: 2, unread: 0 }));
    const out = await ackAllNotifications("2026-09-24T08:05:00.000Z");
    const [url, init] = lastCall();
    expect(url).toBe("/api/notifications/ack-all");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ before: "2026-09-24T08:05:00.000Z" });
    expect(out).toEqual({ acked: 2, unread: 0 });
  });
});
