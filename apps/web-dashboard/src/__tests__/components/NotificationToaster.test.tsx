import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";

// Mock the toast hook so we can capture invocations without rendering the
// real provider. Capture the (message, type) args verbatim — that's what
// callers rely on.
const toastSpy = vi.fn();
vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn() }),
}));

// WARP-2804 — the ack the "Open" action sends. Resolves by default; a test
// can make it reject to prove a failed ack never blocks the navigation.
const ackSpy = vi.fn((_id: string, _opts?: { via?: string }) => Promise.resolve({ changed: true }));
vi.mock("@/lib/api", () => ({
  ackNotification: (id: string, opts?: { via?: string }) => ackSpy(id, opts),
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

describe("NotificationToaster deep link (WARP-2909)", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    toastSpy.mockReset();
    routerPush.mockReset();
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost" } as Location,
    });
  });

  async function toastFor(payload: unknown) {
    render(<NotificationToaster />);
    await act(async () => {
      await Promise.resolve();
      deliver(payload);
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    return toastSpy.mock.calls[0][2] as { label: string; onClick: () => void } | undefined;
  }

  it("a toast with a url gets an Open action that navigates in-app", async () => {
    const action = await toastFor({ kind: "ai", title: "Approval needed: delete_file", url: "/workshop?run=r1" });
    expect(action?.label).toBe("Open");
    action!.onClick();
    expect(routerPush).toHaveBeenCalledWith("/workshop?run=r1");
  });

  it("a toast without a url has no action", async () => {
    expect(await toastFor({ kind: "ai", title: "Done" })).toBeUndefined();
  });

  it.each(["//evil.example/x", "https://evil.example", "javascript:alert(1)", "/\\evil.example"])(
    "never offers to navigate to %s",
    async (url) => {
      expect(await toastFor({ kind: "ai", title: "x", url })).toBeUndefined();
      expect(routerPush).not.toHaveBeenCalled();
    },
  );
});

describe("NotificationToaster acknowledgement (WARP-2804)", () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    toastSpy.mockReset();
    routerPush.mockReset();
    ackSpy.mockClear();
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { protocol: "http:", host: "localhost" } as Location,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function toastFor(payload: unknown) {
    render(<NotificationToaster />);
    await act(async () => {
      await Promise.resolve();
      deliver(payload);
    });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    return toastSpy.mock.calls[0][2] as { label: string; onClick: () => void } | undefined;
  }

  it("\"Open\" acknowledges the notification as opened, then navigates", async () => {
    const action = await toastFor({ id: "clx1", kind: "reminder", title: "Standup", url: "/calendar" });
    action!.onClick();
    expect(ackSpy).toHaveBeenCalledTimes(1);
    expect(ackSpy).toHaveBeenCalledWith("clx1", { via: "opened" });
    expect(routerPush).toHaveBeenCalledWith("/calendar");
    // The ack is sent first; navigation never waits for it.
    expect(ackSpy.mock.invocationCallOrder[0]!).toBeLessThan(routerPush.mock.invocationCallOrder[0]!);
  });

  it("a failed ack never blocks the navigation, and is swallowed", async () => {
    ackSpy.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const action = await toastFor({ id: "clx1", kind: "ai", title: "Approval needed", url: "/workshop?run=r1" });
      action!.onClick();
      expect(routerPush).toHaveBeenCalledWith("/workshop?run=r1");
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("without an id (an older box), Open navigates and sends no ack", async () => {
    const action = await toastFor({ kind: "reminder", title: "Standup", url: "/calendar" });
    action!.onClick();
    expect(routerPush).toHaveBeenCalledWith("/calendar");
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it.each([42, "", { id: "x" }])("a malformed id (%j) is not acked", async (id) => {
    const action = await toastFor({ id, kind: "reminder", title: "Standup", url: "/calendar" });
    action!.onClick();
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("a toast that is shown and times out is NOT an acknowledgement", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await toastFor({ id: "clx1", kind: "reminder", title: "Standup", url: "/calendar" });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("a toast with an id but no link has no Open, and nothing acks it", async () => {
    expect(await toastFor({ id: "clx1", kind: "system", title: "Backups resumed" })).toBeUndefined();
    expect(ackSpy).not.toHaveBeenCalled();
  });
});
