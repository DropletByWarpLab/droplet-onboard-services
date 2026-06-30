import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";

// WARP-944: Agenda view was broken — clicking a mini-month date did nothing and
// events didn't populate the list. These mocks feed the page a fixed event set
// so we can assert both behaviours deterministically.

const evDate = new Date();
evDate.setDate(15); // a stable in-month day
evDate.setHours(9, 0, 0, 0);

const fixtureEvent: CalendarEvent = {
  id: "ev-1",
  userId: "u1",
  title: "Team standup",
  description: null,
  location: null,
  startsAt: evDate.toISOString(),
  endsAt: new Date(evDate.getTime() + 3600_000).toISOString(),
  allDay: false,
  source: "local",
  sourceId: null,
  externalUid: null,
  createdAt: evDate.toISOString(),
  updatedAt: evDate.toISOString(),
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
import { dayKey } from "@/lib/calendar";

describe("Calendar Agenda view (WARP-944)", () => {
  beforeEach(() => {
    useCalendarEventsMock.mockReturnValue({
      events: [fixtureEvent],
      refresh: vi.fn(),
      isLoading: false,
    });
    useCalendarSourcesMock.mockReturnValue({ sources: [], refresh: vi.fn(), isLoading: false });
  });

  it("populates the agenda list with calendar events when switched to Agenda", () => {
    render(<CalendarPage />);
    // Switch to Agenda view via the toggle next to "Month".
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));

    // The event must appear in the agenda list — not "No events in this range".
    const section = document.getElementById(agendaDayId(dayKey(evDate)));
    expect(section).not.toBeNull();
    expect(within(section as HTMLElement).getByText("Team standup")).toBeInTheDocument();
    expect(screen.queryByText(/No events in this range/i)).not.toBeInTheDocument();
  });

  it("scrolls the agenda to the day clicked in the mini-month", () => {
    // jsdom doesn't implement scrollIntoView — install a stub so we can spy.
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    render(<CalendarPage />);
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));

    // The mini-month renders one button per day labelled with the long date.
    // Click the day our fixture event lives on.
    const label = evDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    // There can be a mini-month cell + (in month view) a grid cell, but in
    // agenda view only the mini-month is a button with this exact aria-label.
    const dayButtons = screen.getAllByRole("button", { name: label });
    fireEvent.click(dayButtons[0]);

    expect(scrollSpy).toHaveBeenCalled();
    scrollSpy.mockRestore();
  });

  // WARP-944 (UX review): the global reduced-motion CSS block does NOT override a
  // programmatic scrollIntoView({behavior:"smooth"}) — it has to be gated in JS.
  // Mirror schedule-anchor-scroll.ts: reduced-motion users get an instant jump.
  it("uses non-smooth scroll behavior when prefers-reduced-motion is set", () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    const matchMediaMock = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal("matchMedia", matchMediaMock);

    render(<CalendarPage />);
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));

    const label = evDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const dayButtons = screen.getAllByRole("button", { name: label });
    fireEvent.click(dayButtons[0]);

    expect(matchMediaMock).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
    expect(scrollSpy).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "auto" }),
    );
    scrollSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
