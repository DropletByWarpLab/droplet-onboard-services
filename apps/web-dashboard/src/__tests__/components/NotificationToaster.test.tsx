import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

// Mock the toast hook so we can capture invocations without rendering the
// real provider. Capture the (message, type) args verbatim — that's what
// callers rely on.
const toastSpy = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

// Mock auth so the WebSocket effect runs.
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "alice", displayName: "Alice" },
  }),
}));

// In-test WebSocket double: capture the latest instance so the test can
// drive incoming messages through onmessage.
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    // Synchronously open on construct so the connect effect "sticks".
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

import { NotificationToaster } from "@/components/NotificationToaster";

function deliver(payload: unknown) {
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.onmessage?.({
    data: JSON.stringify({
      topic: `droplet/notifications/alice`,
      payload,
    }),
  });
}

describe("NotificationToaster fallback copy (WARP-297)", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    toastSpy.mockReset();
    // jsdom doesn't ship a WebSocket; install our double.
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket =
      FakeWebSocket;
    // Stable location.protocol/host for URL construction.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost" } as Location,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses kind-derived title (e.g. 'Reminder') when title is missing — no doubled prefix", async () => {
    render(<NotificationToaster />);
    await act(async () => {
      // Let the queueMicrotask in FakeWebSocket settle.
      await Promise.resolve();
      deliver({ kind: "reminder", body: "Stand up and stretch" });
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const [message] = toastSpy.mock.calls[0];
    // Title-cased "Reminder" stands in for the missing title; body should
    // appear verbatim and exactly once — not "Reminder — Reminder — body".
    expect(message).toMatch(/Reminder/);
    expect(message).toMatch(/Stand up and stretch/);
    // Critical regression guard: the body must not be prefixed by the
    // generic word "Notification" anymore.
    expect(message).not.toMatch(/Notification — /);
    // And the "Reminder" label should not be doubled.
    const reminderHits = (message as string).match(/Reminder/g)?.length ?? 0;
    expect(reminderHits).toBe(1);
  });

  it("falls back to 'New notification' when neither title nor kind is present, without doubling the body", async () => {
    render(<NotificationToaster />);
    await act(async () => {
      await Promise.resolve();
      deliver({ body: "Just a body" });
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const [message] = toastSpy.mock.calls[0];
    expect(message).toMatch(/New notification/i);
    expect(message).toMatch(/Just a body/);
    // No more "Notification — Just a body" doubling.
    expect(message).not.toMatch(/Notification — Just a body/);
  });

  it("renders both title and body when both are present (no regression)", async () => {
    render(<NotificationToaster />);
    await act(async () => {
      await Promise.resolve();
      deliver({ title: "Door open", body: "Front door has been open 2m" });
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    const [message] = toastSpy.mock.calls[0];
    expect(message).toMatch(/Door open/);
    expect(message).toMatch(/Front door has been open 2m/);
  });
});
