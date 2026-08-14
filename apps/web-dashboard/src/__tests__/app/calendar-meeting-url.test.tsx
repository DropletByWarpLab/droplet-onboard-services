/**
 * WARP-1874 — the video-call link on the calendar surface.
 *
 * Two halves, mirroring the Messages surface:
 *   1. EventForm — the same explicit "Add video call link" control beside
 *      the physical Location field, so an event can be in the kitchen AND
 *      on a call.
 *   2. The event detail sheet — a stored link becomes a real Join anchor,
 *      re-parsed at render. That re-parse is the point: a CalendarEvent
 *      can arrive from an external ICS feed, which no orchestrator zod
 *      schema ever inspected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from "@testing-library/react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/calendar",
}));

const { useCalendarEventsMock, useCalendarSourcesMock, createEventMock, updateEventMock } =
  vi.hoisted(() => ({
    useCalendarEventsMock: vi.fn(),
    useCalendarSourcesMock: vi.fn(),
    createEventMock: vi.fn(async () => ({ event: { id: "ev-new" } })),
    updateEventMock: vi.fn(async () => ({ event: { id: "ev-1" } })),
  }));

vi.mock("@/lib/hooks/useCalendar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/useCalendar")>();
  return {
    ...actual,
    useCalendarEvents: useCalendarEventsMock,
    useCalendarSources: useCalendarSourcesMock,
    createEvent: createEventMock,
    updateEvent: updateEventMock,
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
// The location combobox proxies to the orchestrator's Nominatim route;
// this file is about the link field next to it.
vi.mock("@/components/calendar/PlaceCombobox", () => ({
  PlaceCombobox: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <input
      aria-label="Location"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import CalendarPage from "@/app/calendar/page";
import { agendaDayId } from "@/components/calendar/AgendaView";
import { EventForm } from "@/components/calendar/EventForm";

const ZOOM = "https://warplab.zoom.us/j/98765?pwd=abc";
const START = new Date(2026, 8, 1, 9, 0, 0, 0);

function event(over: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "ev-1",
    userId: "u1",
    title: "Design review",
    description: null,
    location: null,
    meetingUrl: null,
    startsAt: START.toISOString(),
    endsAt: new Date(START.getTime() + 3600_000).toISOString(),
    allDay: false,
    source: "local",
    sourceId: null,
    externalUid: null,
    createdAt: START.toISOString(),
    updatedAt: START.toISOString(),
    ...over,
  };
}

beforeEach(() => {
  cleanup();
  createEventMock.mockClear();
  updateEventMock.mockClear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  useCalendarEventsMock.mockReturnValue({
    events: [event()],
    refresh: vi.fn(),
    isLoading: false,
  });
  useCalendarSourcesMock.mockReturnValue({
    sources: [],
    refresh: vi.fn(),
    isLoading: false,
  });
});

describe("EventForm — video call link", () => {
  it("keeps the field behind an explicit control so the default stays a plain place", () => {
    render(<EventForm open onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Add video call link" })).toBeTruthy();
    expect(screen.queryByLabelText("Video call link")).toBeNull();
  });

  it("sends the link alongside the physical location", async () => {
    const onSaved = vi.fn();
    render(<EventForm open onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Design review" },
    });
    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "Living Room" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add video call link" }));
    fireEvent.change(screen.getByLabelText("Video call link"), {
      target: { value: ZOOM },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createEventMock).toHaveBeenCalled());
    expect(createEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ location: "Living Room", meetingUrl: ZOOM }),
    );
  });

  it.each(["javascript:alert(1)", "http://zoom.us/j/1", "the kitchen"])(
    "refuses %s instead of saving",
    async (hostile) => {
      render(<EventForm open onClose={vi.fn()} onSaved={vi.fn()} />);
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Sync" } });
      fireEvent.click(screen.getByRole("button", { name: "Add video call link" }));
      fireEvent.change(screen.getByLabelText("Video call link"), {
        target: { value: hostile },
      });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));

      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toContain(
          "Video call links need to start with https://",
        ),
      );
      expect(createEventMock).not.toHaveBeenCalled();
    },
  );

  it("opens with the field already showing when the event has a link", () => {
    render(
      <EventForm open initial={event({ meetingUrl: ZOOM })} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect((screen.getByLabelText("Video call link") as HTMLInputElement).value).toBe(
      ZOOM,
    );
  });

  it("clears the stored link with an explicit null when the field is removed", async () => {
    // `undefined` would mean "don't touch it" to the PATCH route — only an
    // explicit null actually removes the link.
    render(
      <EventForm open initial={event({ meetingUrl: ZOOM })} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove video call link" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateEventMock).toHaveBeenCalled());
    expect(updateEventMock).toHaveBeenCalledWith(
      "ev-1",
      expect.objectContaining({ meetingUrl: null }),
    );
  });
});

describe("Calendar event detail — Join link", () => {
  // The month grid renders the title too, so the click is scoped to the
  // agenda section for the event's own day.
  function openDetail() {
    const view = render(<CalendarPage />);
    fireEvent.click(screen.getByRole("button", { name: /^agenda$/i }));
    const day = document.getElementById(agendaDayId("2026-09-01"))!;
    fireEvent.click(within(day).getByText("Design review"));
    return view;
  }

  it("renders the link as a safe anchor", () => {
    useCalendarEventsMock.mockReturnValue({
      events: [event({ meetingUrl: ZOOM, location: "Living Room" })],
      refresh: vi.fn(),
      isLoading: false,
    });
    openDetail();

    // Scoped to the sheet: since WARP-1905 the agenda row behind it ALSO
    // renders a Join anchor, so an unscoped query would match two.
    const sheet = screen.getByRole("dialog");
    const join = within(sheet).getByRole("link", { name: /Join Zoom/ });
    expect(join.getAttribute("href")).toBe(ZOOM);
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
    // Physical location survives alongside it, in the SAME sheet — the
    // agenda row behind the sheet also renders the location text.
    expect(within(sheet).getByText("Living Room")).toBeTruthy();
  });

  it.each(["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "Kitchen"])(
    "refuses to render %s as an href",
    (hostile) => {
      // An external ICS feed can put anything in this column; the render
      // is the last gate.
      useCalendarEventsMock.mockReturnValue({
        events: [event({ meetingUrl: hostile })],
        refresh: vi.fn(),
        isLoading: false,
      });
      const { container } = openDetail();

      expect(container.querySelector('a[href^="javascript"]')).toBeNull();
      expect(container.querySelector('a[href^="data:"]')).toBeNull();
      expect(screen.queryByRole("link", { name: /Join/ })).toBeNull();
    },
  );
});
