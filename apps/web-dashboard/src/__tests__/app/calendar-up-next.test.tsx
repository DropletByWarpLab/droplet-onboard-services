/**
 * Calendar page — "Up next" rail card collapse + cap (WARP-1902).
 *
 * The Up next digest used to render always-expanded, cluttering the rail on a
 * busy calendar. It is now a disclosure: the header is a real button with
 * aria-expanded that collapses/expands the list, the expanded list is capped
 * at 6 events (with a muted "N more" hint when events overflow the cap), and
 * the collapsed/expanded choice persists across page loads via the same
 * per-browser localStorage idiom the network page's sections use.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/calendar",
}));

/** `count` one-hour events starting 1h, 2h, ... after now — all upcoming. */
function futureEvents(count: number): CalendarEvent[] {
  return Array.from({ length: count }, (_, i) => {
    const startsAt = new Date(Date.now() + (i + 1) * 3600_000);
    return {
      id: `ev-${i + 1}`,
      userId: "u1",
      title: `Upcoming event ${i + 1}`,
      description: null,
      location: null,
      meetingUrl: null,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 3600_000).toISOString(),
      allDay: false,
      source: "local" as const,
      sourceId: null,
      externalUid: null,
      createdAt: startsAt.toISOString(),
      updatedAt: startsAt.toISOString(),
    };
  });
}

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

/** The Up next card, scoped so month-grid renders of the same events don't
 *  leak into assertions. */
function upNextCard(): HTMLElement {
  const toggle = screen.getByRole("button", { name: /up next/i });
  const card = toggle.closest(".card");
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

describe('Calendar "Up next" card — collapse + 6-event cap (WARP-1902)', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    useCalendarEventsMock.mockReturnValue({
      events: futureEvents(10),
      refresh: vi.fn(),
      isLoading: false,
    });
    useCalendarSourcesMock.mockReturnValue({ sources: [], refresh: vi.fn(), isLoading: false });
  });

  it("renders at most 6 events when 10 are upcoming, with a '4 more' hint", () => {
    render(<CalendarPage />);

    const card = upNextCard();
    expect(within(card).getAllByRole("listitem")).toHaveLength(6);
    // Sorted by start: events 1-6 shown, 7-10 folded into the hint.
    expect(within(card).getByText("Upcoming event 6")).toBeInTheDocument();
    expect(within(card).queryByText("Upcoming event 7")).not.toBeInTheDocument();
    expect(within(card).getByText(/4 more/i)).toBeInTheDocument();
  });

  it("omits the overflow hint when the events fit the cap", () => {
    useCalendarEventsMock.mockReturnValue({
      events: futureEvents(6),
      refresh: vi.fn(),
      isLoading: false,
    });
    render(<CalendarPage />);

    const card = upNextCard();
    expect(within(card).getAllByRole("listitem")).toHaveLength(6);
    expect(within(card).queryByText(/more/i)).not.toBeInTheDocument();
  });

  it("collapses on toggle (aria-expanded flips, list unmounts) and expands back", () => {
    render(<CalendarPage />);

    const toggle = screen.getByRole("button", { name: /up next/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(upNextCard()).queryAllByRole("listitem")).toHaveLength(0);

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(upNextCard()).getAllByRole("listitem")).toHaveLength(6);
  });

  it("persists the collapsed state across page loads", () => {
    const first = render(<CalendarPage />);
    fireEvent.click(screen.getByRole("button", { name: /up next/i }));
    first.unmount();

    render(<CalendarPage />);
    const toggle = screen.getByRole("button", { name: /up next/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(upNextCard()).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("defaults to expanded on a first visit (no stored preference)", () => {
    render(<CalendarPage />);
    expect(screen.getByRole("button", { name: /up next/i })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
