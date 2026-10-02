/**
 * WARP-2767 — the calendar feed link is a revocable, expiring credential.
 * The panel shows a new URL once (the server keeps only a hash), shows the
 * expiry of an existing link, and offers "Turn off link".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { statusMock, rotateMock, revokeMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  rotateMock: vi.fn(),
  revokeMock: vi.fn(),
}));

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/hooks/useCalendar", () => ({
  useCalendarSources: () => ({ sources: [], refresh: vi.fn(), isLoading: false }),
  createSource: vi.fn(),
  syncSource: vi.fn(),
  deleteSource: vi.fn(),
  usePublishLinkStatus: statusMock,
  rotatePublishLink: rotateMock,
  revokePublishLink: revokeMock,
}));

import { SubscriptionsPanel } from "@/components/calendar/SubscriptionsPanel";

beforeEach(() => {
  rotateMock.mockReset();
  revokeMock.mockReset();
  statusMock.mockReturnValue({ status: { state: "none", createdAt: null, expiresAt: null }, refresh: vi.fn() });
});

describe("SubscriptionsPanel — calendar feed link (WARP-2767)", () => {
  it("creates a link and shows its URL once, with the credential warning", async () => {
    rotateMock.mockResolvedValue({ url: "/api/calendar/publish/alice.ics?token=t.s", expiresAt: "2027-03-21T00:00:00Z" });
    render(<SubscriptionsPanel />);
    expect(screen.getByText(/works like a password/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(screen.getByText(/publish\/alice\.ics\?token=t\.s/)).toBeTruthy());
    expect(rotateMock).toHaveBeenCalledTimes(1);
  });

  it("shows the expiry of an active link and can turn it off", async () => {
    statusMock.mockReturnValue({
      status: { state: "active", createdAt: "2026-09-22T00:00:00Z", expiresAt: "2027-03-21T12:00:00Z" },
      refresh: vi.fn(),
    });
    revokeMock.mockResolvedValue({ revoked: 1 });
    render(<SubscriptionsPanel />);
    expect(screen.getByText(/A link is active until/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create new link" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Turn off link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(revokeMock).toHaveBeenCalledTimes(1));
  });
});
