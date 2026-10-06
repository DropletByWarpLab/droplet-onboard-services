/**
 * Calendar UX clarity (Samantha QA #bugs) — External-calendars explainer.
 *
 * The only plain-language framing ("Google / iCloud / Outlook") was buried
 * inside the hidden add-form. A one-line intro now sits directly under the
 * "External calendars" header so the user understands the section without
 * expanding the form, and the empty state is enriched to match.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const {
  toastMock,
  useCalendarSourcesMock,
  refreshMock,
} = vi.hoisted(() => ({
  toastMock: vi.fn(),
  useCalendarSourcesMock: vi.fn(),
  refreshMock: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/lib/hooks/useCalendar", () => ({
  useCalendarSources: useCalendarSourcesMock,
  createSource: vi.fn(),
  syncSource: vi.fn(),
  deleteSource: vi.fn(),
  usePublishLinkStatus: () => ({ status: undefined, refresh: vi.fn() }),
  rotatePublishLink: vi.fn(),
  revokePublishLink: vi.fn(),
}));

import { SubscriptionsPanel } from "@/components/calendar/SubscriptionsPanel";

beforeEach(() => {
  toastMock.mockReset();
  useCalendarSourcesMock.mockReturnValue({
    sources: [],
    refresh: refreshMock,
    isLoading: false,
  });
});

describe("SubscriptionsPanel — explainer (Samantha QA #bugs)", () => {
  it("shows a plain-language intro naming Google / iCloud / Outlook WITHOUT expanding the add-form", () => {
    render(<SubscriptionsPanel />);
    // No form opened. The intro must already be visible right under the header.
    const intro = screen.getByText(
      /connect your google or outlook account in settings/i,
    );
    expect(intro).toBeInTheDocument();
    expect(intro).toHaveTextContent(/icloud.*share link/i);
    expect(screen.getByRole("link", { name: "Connect Google or Outlook" })).toHaveAttribute("href", "/settings#connected-accounts");
    // The add-form's auth-mode hint stays hidden until the form is opened —
    // proving the intro is not the buried form copy.
    expect(screen.queryByText(/Requires a username and password/i)).toBeNull();
  });

  it("the empty state still indicates no subscriptions yet", () => {
    render(<SubscriptionsPanel />);
    expect(
      screen.getByText(/no external calendars subscribed yet/i),
    ).toBeInTheDocument();
  });

  it.each(["google_oauth", "m365_oauth"])("routes managed %s calendars to account settings while retaining local-copy removal", (authMode) => {
    useCalendarSourcesMock.mockReturnValue({ sources: [{ id: "account-cal", name: "Account calendar", url: "provider-managed", authMode, username: null, syncIntervalSec: 300, lastSyncAt: null, lastSyncError: null, createdAt: "2026-10-05T00:00:00Z" }], refresh: refreshMock, isLoading: false });
    render(<SubscriptionsPanel />);
    expect(screen.getByRole("link", { name: "Manage connection" })).toHaveAttribute("href", "/settings#connected-accounts");
    expect(screen.getByText(/account · read-only/i)).toBeInTheDocument();
    expect(screen.queryByTitle("Sync now")).not.toBeInTheDocument();
    expect(screen.queryByText("provider-managed")).not.toBeInTheDocument();
  });
});
