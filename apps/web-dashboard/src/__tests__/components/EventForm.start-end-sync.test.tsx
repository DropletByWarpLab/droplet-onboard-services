/**
 * WARP-306 — editing the start time slides the end time by the same delta,
 * preserving the event's duration. Editing the end directly stays under
 * the user's control (no slide).
 *
 * Updated for the Calendar UX clarity work (Samantha QA #bugs): the Starts /
 * Ends fields are now the date + 15-minute time dropdown (<DateTimePicker>)
 * instead of a single native datetime-local input. The duration-slide
 * *behavior* is unchanged — these tests drive the time <select> and assert the
 * same invariant.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@/lib/hooks/useCalendar", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hooks/useCalendar")>(
    "@/lib/hooks/useCalendar",
  );
  return {
    ...actual,
    createEvent: vi.fn(),
    updateEvent: vi.fn(),
    deleteEvent: vi.fn(),
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

function getStartTime(): HTMLSelectElement {
  return screen.getByLabelText(/Starts time/i) as HTMLSelectElement;
}
function getEndTime(): HTMLSelectElement {
  return screen.getByLabelText(/Ends time/i) as HTMLSelectElement;
}

// Build an ISO that lands on the given local H:M so the dropdown options match.
function localIso(year: number, month0: number, day: number, h: number, m: number): string {
  return new Date(year, month0, day, h, m).toISOString();
}

describe("EventForm — start/end sync (WARP-306)", () => {
  it("moves end forward by the same delta when start moves forward", () => {
    // 10:00 → 11:00 (1 hour duration), local time.
    const initial = makeInitial(
      localIso(2026, 4, 12, 10, 0),
      localIso(2026, 4, 12, 11, 0),
    );
    render(<EventForm open initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />);

    const start = getStartTime();
    const end = getEndTime();
    expect(start.value).toBe("10:00");
    expect(end.value).toBe("11:00");

    // Push start forward by 1 hour.
    fireEvent.change(start, { target: { value: "11:00" } });

    expect(start.value).toBe("11:00");
    // End should have advanced by 1h, preserving the duration.
    expect(end.value).toBe("12:00");
  });

  it("moves end backward by the same delta when start moves backward", () => {
    const initial = makeInitial(
      localIso(2026, 4, 12, 10, 0),
      localIso(2026, 4, 12, 11, 30),
    );
    render(<EventForm open initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />);

    const start = getStartTime();
    const end = getEndTime();
    expect(start.value).toBe("10:00");
    expect(end.value).toBe("11:30");

    // Move start back 30 minutes → end follows to 11:00 (still 1h30 duration).
    fireEvent.change(start, { target: { value: "09:30" } });

    expect(start.value).toBe("09:30");
    expect(end.value).toBe("11:00");
  });

  it("does NOT modify start when the user edits the end field directly", () => {
    const initial = makeInitial(
      localIso(2026, 4, 12, 10, 0),
      localIso(2026, 4, 12, 11, 0),
    );
    render(<EventForm open initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />);

    const start = getStartTime();
    const end = getEndTime();

    fireEvent.change(end, { target: { value: "12:30" } });

    expect(end.value).toBe("12:30");
    expect(start.value).toBe("10:00");
  });

  it("preserves a manually-stretched duration on subsequent start edits", () => {
    // User edits end to make it a 2h meeting, then later pulls start back.
    const initial = makeInitial(
      localIso(2026, 4, 12, 10, 0),
      localIso(2026, 4, 12, 11, 0),
    );
    render(<EventForm open initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />);

    const start = getStartTime();
    const end = getEndTime();

    // Step 1: user makes it 2h (10:00 → 12:00) by editing end alone.
    fireEvent.change(end, { target: { value: "12:00" } });
    expect(end.value).toBe("12:00");
    expect(start.value).toBe("10:00");

    // Step 2: user pulls start back 15 minutes → end follows by -15 minutes,
    // preserving the new 2h duration (09:45 → 11:45).
    fireEvent.change(start, { target: { value: "09:45" } });

    expect(start.value).toBe("09:45");
    expect(end.value).toBe("11:45");
  });
});
