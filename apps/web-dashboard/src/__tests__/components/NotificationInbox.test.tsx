/**
 * WARP-3307 — the web notification inbox: the bell's unread count and the
 * /notifications page (order, open, mark read, mark all read, empty, error).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import type { NotificationRow } from "@/lib/types";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
  usePathname: () => "/notifications",
}));

const api = {
  getNotifications: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
  ackNotification: vi.fn((_id: string, _o?: unknown) => Promise.resolve({ changed: true })),
  ackAllNotifications: vi.fn((_ids: readonly string[]) => Promise.resolve({ acked: 1, unread: 0 })),
  fetchSystemHealth: vi.fn(() => Promise.resolve({ status: "healthy" })),
};
vi.mock("@/lib/api", () => ({
  getNotifications: (...a: unknown[]) => api.getNotifications(...a),
  getUnreadNotificationCount: () => api.getUnreadNotificationCount(),
  ackNotification: (id: string, o?: unknown) => api.ackNotification(id, o),
  ackAllNotifications: (ids: readonly string[]) => api.ackAllNotifications(ids),
  fetchSystemHealth: () => api.fetchSystemHealth(),
}));
vi.mock("@/lib/hooks/useBoxAddress", () => ({ useBoxAddress: () => "droplet.local" }));
vi.mock("@/components/home/AmbientLayer", () => ({ AmbientLayer: () => null }));

import NotificationsPage from "@/app/notifications/page";
import { InboxBell } from "@/components/notifications/InboxBell";
import { sortInbox } from "@/lib/hooks/useNotificationInbox";

function row(p: Partial<NotificationRow> & { id: string }): NotificationRow {
  return {
    kind: "ai",
    title: `Title ${p.id}`,
    body: null,
    url: null,
    data: null,
    createdAt: "2026-09-28T10:00:00.000Z",
    deliveredAt: null,
    channels: "ws",
    pushOutcome: null,
    error: null,
    ackState: "unacked",
    ackedAt: null,
    ackMethod: null,
    ...p,
  };
}

// A fresh SWR cache per test, so one test's data never leaks into the next.
const wrap = (ui: ReactNode) =>
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sortInbox", () => {
  it("pins unread decisions first and keeps the box's order otherwise", () => {
    const rows = [
      row({ id: "a" }),
      row({ id: "b", data: { needsDecision: true } }),
      row({ id: "c", data: { needsDecision: true }, ackState: "acked" }),
      row({ id: "d" }),
    ];
    expect(sortInbox(rows).map((r) => r.id)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("InboxBell", () => {
  it("shows the unread count and names it for screen readers", async () => {
    api.getUnreadNotificationCount.mockResolvedValue(3);
    wrap(<InboxBell />);
    const link = await screen.findByRole("link", { name: "Notifications, 3 unread" });
    expect(link.getAttribute("href")).toBe("/notifications");
    expect(link.textContent).toContain("3");
  });

  it("shows no count at zero", async () => {
    api.getUnreadNotificationCount.mockResolvedValue(0);
    wrap(<InboxBell />);
    await waitFor(() => expect(api.getUnreadNotificationCount).toHaveBeenCalled());
    expect(screen.getByRole("link", { name: "Notifications" }).textContent).toBe("");
  });
});

describe("/notifications", () => {
  it("lists notifications with the parked run first, and opens an in-app link with an ack", async () => {
    api.getUnreadNotificationCount.mockResolvedValue(2);
    api.getNotifications.mockResolvedValue({
      notifications: [
        row({ id: "n1", title: "Shared a file", ackState: "acked" }),
        row({ id: "n2", title: "Approval needed: send_email", url: "/workshop?run=r1", data: { needsDecision: true } }),
      ],
      unread: 1,
      nextCursor: null,
    });
    wrap(<NotificationsPage />);
    const rows = await screen.findAllByTestId("inbox-row");
    expect(rows[0].textContent).toContain("Approval needed: send_email");
    expect(within(rows[0]).getByText("Needs your OK")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open: Approval needed: send_email" }));
    expect(api.ackNotification).toHaveBeenCalledWith("n2", { via: "opened" });
    expect(routerPush).toHaveBeenCalledWith("/workshop?run=r1");
  });

  it("never offers Open for a link that is not an in-app path", async () => {
    api.getNotifications.mockResolvedValue({
      notifications: [row({ id: "x", title: "Odd", url: "//evil.example/x" })],
      unread: 1,
      nextCursor: null,
    });
    wrap(<NotificationsPage />);
    await screen.findByText("Odd");
    expect(screen.queryByRole("button", { name: "Open: Odd" })).toBeNull();
  });

  it("marks one read, and marks all read with exactly the unread ids shown", async () => {
    api.getNotifications.mockResolvedValue({
      notifications: [row({ id: "u1" }), row({ id: "u2" }), row({ id: "r1", ackState: "acked" })],
      unread: 2,
      nextCursor: null,
    });
    wrap(<NotificationsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Mark read: Title u1" }));
    await waitFor(() => expect(api.ackNotification).toHaveBeenCalledWith("u1", undefined));

    await waitFor(() => expect((screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(api.ackAllNotifications).toHaveBeenCalledWith(["u1", "u2"]));
  });

  it("says so when there is nothing yet", async () => {
    api.getNotifications.mockResolvedValue({ notifications: [], unread: 0, nextCursor: null });
    wrap(<NotificationsPage />);
    expect(await screen.findByText(/No notifications yet/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Mark all read" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an error with a retry when the list cannot load", async () => {
    api.getNotifications.mockRejectedValue(new Error("down"));
    wrap(<NotificationsPage />);
    expect(await screen.findByText("Notifications could not be loaded.")).toBeTruthy();
    api.getNotifications.mockResolvedValue({ notifications: [row({ id: "z", title: "Back" })], unread: 1, nextCursor: null });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Back")).toBeTruthy();
  });
});
