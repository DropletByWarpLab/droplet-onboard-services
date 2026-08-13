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
  meetingUrl: null,
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

  // pr-reviewer #1: `groups` (a useMemo over `events`) is in the scroll effect's
  // dep array. Every SWR revalidation hands the page a fresh `events` array →
  // new `groups` ref → effect re-fires → the user is yanked back to the picked
  // day on every poll cycle, even after they manually scrolled away. The effect
  // must only scroll on a GENUINELY new selection, not on a poll re-render.
  it("does not re-scroll on a background poll re-render when the selection is unchanged", () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    const { rerender } = render(<CalendarPage />);
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));

    const label = evDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    fireEvent.click(screen.getAllByRole("button", { name: label })[0]);
    expect(scrollSpy).toHaveBeenCalledTimes(1); // initial selection scrolls once

    // Simulate an SWR poll: same logical events, fresh array reference (which is
    // exactly what a revalidation produces) → groups ref changes.
    useCalendarEventsMock.mockReturnValue({
      events: [{ ...fixtureEvent }],
      refresh: vi.fn(),
      isLoading: false,
    });
    rerender(<CalendarPage />);

    // The selection didn't change, so the poll must NOT re-trigger a scroll.
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    scrollSpy.mockRestore();
  });

  // WARP-1904 (supersedes pr-reviewer #2's "month-view pick" case): in MONTH
  // view a mini-month day click did nothing visible — it only moved the cursor
  // inside the already-displayed month. Product decision (Option B): the
  // mini-month day grid is DISPLAY-ONLY in Month view — the cells are not
  // buttons at all, so no month-view click exists to seed a stale agenda
  // selection. The cells become real buttons only in Agenda view, where
  // picking a day scrolls to it (WARP-944).
  it("renders the mini-month day cells display-only in Month view, interactive in Agenda view", () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    render(<CalendarPage />); // starts in Month view

    const label = evDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    // Month view: no day button with the mini-month's bare date label exists —
    // the grid is inert. (The big month grid's cells are labelled
    // "<date>, N events", which the exact-match query does not match.)
    expect(screen.queryAllByRole("button", { name: label })).toHaveLength(0);

    // Switching to Agenda re-arms the day cells (real buttons again) and no
    // stale selection from Month view auto-scrolls the list.
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));
    expect(scrollSpy).not.toHaveBeenCalled();
    expect(screen.getAllByRole("button", { name: label }).length).toBeGreaterThan(0);
    scrollSpy.mockRestore();
  });

  // pr-reviewer #2 (follow-up): the mini-month prev/next month chevrons use the
  // dedicated `onMonthNav` prop, which must clear `selectedKey`. Navigating the
  // mini-month header is "browse a different month", NOT "pick a day", so it must
  // not leave a stale scroll target that yanks the agenda to / highlights day 1
  // of the newly-shown month.
  it("clears the agenda selection (no scroll, no highlight) when the mini-month month chevron is used", () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    const { rerender } = render(<CalendarPage />);
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));

    const label = evDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    fireEvent.click(screen.getAllByRole("button", { name: label })[0]);
    expect(scrollSpy).toHaveBeenCalledTimes(1); // the day pick scrolls once

    // Picking the day highlighted its section header (selected styling).
    expect(document.querySelector('h3[aria-current="true"]')).not.toBeNull();

    // In Agenda view the toolbar nav is hidden, so the ONLY "Next month" button
    // is the mini-month chevron — which routes through `onMonthNav`.
    fireEvent.click(screen.getByRole("button", { name: /next month/i }));

    // Navigating the month must NOT count as a new day selection: no extra
    // scroll, and the day-1 / picked-day highlight is gone.
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('h3[aria-current="true"]')).toBeNull();

    // A background poll after the nav must not re-scroll either (selection cleared).
    useCalendarEventsMock.mockReturnValue({
      events: [{ ...fixtureEvent }],
      refresh: vi.fn(),
      isLoading: false,
    });
    rerender(<CalendarPage />);
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    scrollSpy.mockRestore();
  });

  // pr-reviewer #3: toolbar nav (prev/next/Today) must clear `selectedKey` so a
  // stale scroll target doesn't re-trigger the scroll effect after navigation.
  it("clears the agenda selection when the toolbar 'Today' nav is used", () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView");

    const { rerender } = render(<CalendarPage />);
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));

    const label = evDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    fireEvent.click(screen.getAllByRole("button", { name: label })[0]);
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // Toolbar nav lives in Month view — go back to Month, hit Today (which must
    // deselect), then return to Agenda. A poll re-render must not re-scroll,
    // because the selection was cleared by the nav.
    fireEvent.click(screen.getByRole("button", { name: /^month$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^today$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));

    useCalendarEventsMock.mockReturnValue({
      events: [{ ...fixtureEvent }],
      refresh: vi.fn(),
      isLoading: false,
    });
    rerender(<CalendarPage />);

    expect(scrollSpy).toHaveBeenCalledTimes(1);
    scrollSpy.mockRestore();
  });
});
