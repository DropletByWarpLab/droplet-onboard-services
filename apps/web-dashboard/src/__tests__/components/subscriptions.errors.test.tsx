import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const {
  toastMock,
  useCalendarSourcesMock,
  createSourceMock,
  syncSourceMock,
  deleteSourceMock,
  getPublishUrlMock,
} = vi.hoisted(() => ({
  toastMock: vi.fn(),
  useCalendarSourcesMock: vi.fn(() => ({
    sources: [],
    refresh: vi.fn(),
    isLoading: false,
  })),
  createSourceMock: vi.fn(),
  syncSourceMock: vi.fn(),
  deleteSourceMock: vi.fn(),
  getPublishUrlMock: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/lib/hooks/useCalendar", () => ({
  useCalendarSources: useCalendarSourcesMock,
  createSource: createSourceMock,
  syncSource: syncSourceMock,
  deleteSource: deleteSourceMock,
  getPublishUrl: getPublishUrlMock,
}));

import { SubscriptionsPanel } from "@/components/calendar/SubscriptionsPanel";

describe("SubscriptionsPanel — typed error → friendly toast (WARP-294)", () => {
  beforeEach(() => {
    toastMock.mockReset();
    createSourceMock.mockReset();
    syncSourceMock.mockReset();
    deleteSourceMock.mockReset();
    getPublishUrlMock.mockReset();
    useCalendarSourcesMock.mockReturnValue({
      sources: [],
      refresh: vi.fn(),
      isLoading: false,
    });
  });

  it("translates add-subscription failures and never echoes err.message", async () => {
    const SECRET = "401 Unauthorized — caldav-server-rejected-creds";
    createSourceMock.mockRejectedValueOnce(new Error(SECRET));

    render(<SubscriptionsPanel />);
    // The "+" button toggles the new-subscription form.
    fireEvent.click(
      screen.getByRole("button", { name: "" }).parentElement!.querySelector(
        "button",
      )!,
    );

    // WARP-308: the form label is now a visible `<span>` ("Display name",
    // "Calendar URL") and the placeholder carries example copy only.
    fireEvent.change(screen.getByPlaceholderText(/Personal iCloud/i), {
      target: { value: "iCloud" },
    });
    fireEvent.change(screen.getByPlaceholderText("https://…"), {
      target: { value: "https://example.com/cal.ics" },
    });

    fireEvent.click(screen.getByRole("button", { name: /add subscription/i }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });

    // First call is "Subscription added — first sync runs within 30s"
    // if it succeeded; on failure the only toast is the error one.
    const errorCall = toastMock.mock.calls.find(([, tone]) => tone === "error");
    expect(errorCall, "expected an error toast").toBeTruthy();
    const [text] = errorCall!;
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("caldav-server-rejected-creds");
    expect(text).not.toContain("401 Unauthorized");
  });
});
