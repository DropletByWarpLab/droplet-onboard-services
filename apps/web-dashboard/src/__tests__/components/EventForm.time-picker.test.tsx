/**
 * Calendar UX clarity (Samantha QA #bugs) — EventForm Starts / Ends use the
 * 15-minute time dropdown via <DateTimePicker>, and the stored ISO value stays
 * correct end-to-end (picker → localInputToIso → createEvent payload).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const createEventMock = vi.fn();
const updateEventMock = vi.fn();
const deleteEventMock = vi.fn();

vi.mock("@/lib/hooks/useCalendar", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks/useCalendar")>(
    "@/lib/hooks/useCalendar",
  );
  return {
    ...actual,
    createEvent: (...a: any[]) => createEventMock(...a),
    updateEvent: (...a: any[]) => updateEventMock(...a),
    deleteEvent: (...a: any[]) => deleteEventMock(...a),
  };
});

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { EventForm } from "@/components/calendar/EventForm";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";

function makeInitial(startIso: string, endIso: string): CalendarEvent {
  return {
    id: "evt_1",
    userId: "u1",
    title: "Standup",
    description: null,
    location: null,
    meetingUrl: null,
    startsAt: startIso,
    endsAt: endIso,
    allDay: false,
    source: "local",
    sourceId: null,
    externalUid: null,
    createdAt: "2026-05-12T08:00:00Z",
    updatedAt: "2026-05-12T08:00:00Z",
  };
}

beforeEach(() => {
  createEventMock.mockReset();
  updateEventMock.mockReset();
  deleteEventMock.mockReset();
});

describe("EventForm — time dropdown (Samantha QA #bugs)", () => {
  it("renders a 15-minute time dropdown for both Starts and Ends", () => {
    // Pick an ISO that lands on a quarter in local time so the option exists.
    const local = new Date(2026, 4, 12, 10, 0);
    const localEnd = new Date(2026, 4, 12, 11, 0);
    render(
      <EventForm
        open
        initial={makeInitial(local.toISOString(), localEnd.toISOString())}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const startTime = screen.getByLabelText(/Starts time/i) as HTMLSelectElement;
    const endTime = screen.getByLabelText(/Ends time/i) as HTMLSelectElement;
    expect(startTime.tagName).toBe("SELECT");
    expect(endTime.tagName).toBe("SELECT");
    expect(Array.from(startTime.options).map((o) => o.value)).toContain("00:15");
    expect(startTime.options).toHaveLength(96);
  });

  it("keeps the stored ISO correct after picking a new start time", async () => {
    const local = new Date(2026, 4, 12, 10, 0);
    const localEnd = new Date(2026, 4, 12, 11, 0);
    updateEventMock.mockResolvedValueOnce({});
    render(
      <EventForm
        open
        initial={makeInitial(local.toISOString(), localEnd.toISOString())}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    // Move the start to 10:30 local.
    fireEvent.change(screen.getByLabelText(/Starts time/i), {
      target: { value: "10:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(updateEventMock).toHaveBeenCalled());
    const payload = updateEventMock.mock.calls[0][1];
    // The saved ISO must equal 10:30 local converted to UTC ISO.
    const expectedStart = new Date(2026, 4, 12, 10, 30).toISOString();
    expect(payload.startsAt).toBe(expectedStart);
  });

  it("preserves the duration slide: moving start drags end by the same delta", () => {
    const local = new Date(2026, 4, 12, 10, 0); // 10:00 local
    const localEnd = new Date(2026, 4, 12, 11, 0); // 11:00 local (1h)
    render(
      <EventForm
        open
        initial={makeInitial(local.toISOString(), localEnd.toISOString())}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const startTime = screen.getByLabelText(/Starts time/i) as HTMLSelectElement;
    const endTime = screen.getByLabelText(/Ends time/i) as HTMLSelectElement;
    expect(startTime.value).toBe("10:00");
    expect(endTime.value).toBe("11:00");

    // Push start forward 30 min → end should follow to 11:30, preserving 1h.
    fireEvent.change(startTime, { target: { value: "10:30" } });

    expect(startTime.value).toBe("10:30");
    expect(endTime.value).toBe("11:30");
  });
});
