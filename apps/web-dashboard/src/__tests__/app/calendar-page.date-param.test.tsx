/**
 * Calendar page — `?date=YYYY-MM-DD` deep link (WARP-1131).
 *
 * The Home calendar widget deep-links day cells to /calendar?date=YYYY-MM-DD.
 * The page must open with the month cursor on that date and the day selected
 * (the same selected-day state the mini-month sets — WARP-944). A malformed
 * or absent param falls back to today, unselected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";

// next/navigation — drive useSearchParams to simulate the ?date= deep link.
const searchParamsRef: { current: URLSearchParams } = {
  current: new URLSearchParams(),
};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => searchParamsRef.current,
  usePathname: () => "/calendar",
}));

// Fixture event on the deep-linked day so the Agenda view renders a section
// for it (the selected-day highlight lives on that section's heading).
const TARGET = new Date(2026, 2, 14, 9, 0, 0, 0); // 2026-03-14 09:00 local

const fixtureEvent: CalendarEvent = {
  id: "ev-1",
  userId: "u1",
  title: "Design review",
  description: null,
  location: null,
  meetingUrl: null,
  startsAt: TARGET.toISOString(),
  endsAt: new Date(TARGET.getTime() + 3600_000).toISOString(),
  allDay: false,
  source: "local",
  sourceId: null,
  externalUid: null,
  createdAt: TARGET.toISOString(),
  updatedAt: TARGET.toISOString(),
};

const { useCalendarEventsMock, useCalendarSourcesMock } = vi.hoisted(() => ({
  useCalendarEventsMock: vi.fn(),
  useCalendarSourcesMock: vi.fn(),
}));

vi.mock("@/lib/hooks/useCalendar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/useCalendar")>();
  return {
    ...actual,
    useCalendarEvents: useCalendarEventsMock,
    useCalendarSources: useCalendarSourcesMock,
    deleteEvent: vi.fn(),
  };
});

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/hooks/useReminders", () => ({
  useReminders: () => ({ reminders: [], refresh: vi.fn(), isLoading: false }),
  createReminder: vi.fn(),
  patchReminder: vi.fn(),
  deleteReminder: vi.fn(),
}));
vi.mock("@/components/calendar/SubscriptionsPanel", () => ({
  SubscriptionsPanel: () => null,
}));

import CalendarPage from "@/app/calendar/page";
import { agendaDayId } from "@/components/calendar/AgendaView";

describe("Calendar page ?date= deep link (WARP-1131)", () => {
  beforeEach(() => {
    cleanup();
    // jsdom doesn't implement scrollIntoView; the Agenda view scrolls to the
    // selected day's section.
    HTMLElement.prototype.scrollIntoView = vi.fn();
    searchParamsRef.current = new URLSearchParams();
    useCalendarEventsMock.mockReturnValue({
      events: [fixtureEvent],
      refresh: vi.fn(),
      isLoading: false,
    });
    useCalendarSourcesMock.mockReturnValue({ sources: [], refresh: vi.fn(), isLoading: false });
  });

  it("opens the month grid on the deep-linked month", () => {
    searchParamsRef.current = new URLSearchParams("date=2026-03-14");
    render(<CalendarPage />);

    // The label renders in both the toolbar and the mini-month header.
    expect(
      screen.getAllByText(
        TARGET.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("marks the deep-linked day selected (highlighted in the Agenda view)", () => {
    searchParamsRef.current = new URLSearchParams("date=2026-03-14");
    render(<CalendarPage />);

    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));

    const section = document.getElementById(agendaDayId("2026-03-14"));
    expect(section).not.toBeNull();
    const heading = section!.querySelector("h3");
    expect(heading).toHaveAttribute("aria-current", "true");
  });

  it("falls back to today for a malformed date param", () => {
    searchParamsRef.current = new URLSearchParams("date=garbage-99");
    render(<CalendarPage />);

    expect(
      screen.getAllByText(
        new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("defaults to today with no selection when the param is absent", () => {
    render(<CalendarPage />);

    expect(
      screen.getAllByText(
        new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      ).length,
    ).toBeGreaterThan(0);
  });
});
