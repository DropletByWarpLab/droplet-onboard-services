import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const { fetchVapidPublicKeyMock, registerPushMock, sendTestMock, unregisterPushMock } =
  vi.hoisted(() => ({
    fetchVapidPublicKeyMock: vi.fn(),
    registerPushMock: vi.fn(),
    sendTestMock: vi.fn(),
    unregisterPushMock: vi.fn(),
  }));

vi.mock("@/lib/api", () => ({
  fetchVapidPublicKey: fetchVapidPublicKeyMock,
  registerPushSubscription: registerPushMock,
  sendTestPush: sendTestMock,
  unregisterPushSubscription: unregisterPushMock,
}));

import { PushSubscriptionCard } from "@/components/notifications/PushSubscriptionCard";

/**
 * WARP-294 — PushSubscriptionCard must never render raw err.message
 * onto the inline status line.
 */

function installNavigatorStubs() {
  Object.defineProperty(window, "Notification", {
    value: Object.assign(
      function Notification() {},
      { permission: "default", requestPermission: vi.fn() },
    ),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "PushManager", {
    value: function PushManager() {},
    writable: true,
    configurable: true,
  });
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      getRegistration: vi.fn(async () => null),
      register: vi.fn(async () => ({ active: true, pushManager: {} })),
      ready: Promise.resolve({ active: true }),
    },
    writable: true,
    configurable: true,
  });
}

describe("PushSubscriptionCard — typed error → friendly copy (WARP-294)", () => {
  beforeEach(() => {
    fetchVapidPublicKeyMock.mockReset();
    registerPushMock.mockReset();
    sendTestMock.mockReset();
    unregisterPushMock.mockReset();
    installNavigatorStubs();
  });

  it("renders a friendly translation when the test-push call fails (no raw error leak)", async () => {
    const SECRET = "ECONNREFUSED 127.0.0.1:5050 — push-handler-down";
    fetchVapidPublicKeyMock.mockResolvedValue("AAAA");
    sendTestMock.mockRejectedValueOnce(new Error(SECRET));

    // Pre-populate the card into "subscribed" status by making
    // getRegistration return a fake subscription.
    (navigator.serviceWorker.getRegistration as any).mockResolvedValueOnce({
      pushManager: {
        getSubscription: async () => ({ endpoint: "https://example/p/abc" }),
      },
    });

    await act(async () => {
      render(<PushSubscriptionCard />);
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /send test/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /send test/i }));
    });

    await waitFor(() => {
      // Friendly push-domain fallback ("We couldn't … try again …").
      expect(screen.queryByText(/couldn't|try again/i)).toBeTruthy();
    });

    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });
});
