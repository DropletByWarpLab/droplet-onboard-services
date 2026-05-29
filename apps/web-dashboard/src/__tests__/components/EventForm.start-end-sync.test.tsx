/**
 * WARP-306 — editing the start time slides the end time by the same delta,
 * preserving the event's duration. Editing the end directly stays under
 * the user's control (no slide).
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

function getStartInput(): HTMLInputElement {
  return screen.getByLabelText(/^Starts$/i) as HTMLInputElement;
}
function getEndInput(): HTMLInputElement {
  return screen.getByLabelText(/^Ends$/i) as HTMLInputElement;
}

describe("EventForm — start/end sync (WARP-306)", () => {
  it("moves end forward by the same delta when start moves forward", () => {
    // 10:00 → 11:00 (1 hour duration)
    const initial = makeInitial("2026-05-12T10:00:00Z", "2026-05-12T11:00:00Z");
    render(<EventForm open initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />);

    const start = getStartInput();
    const end = getEndInput();
    const prevEnd = end.value;
    const prevStart = start.value;

    // Push start forward by 1 hour. Parse "YYYY-MM-DDTHH:mm" reliably via Date.
    const newStart = new Date(new Date(prevStart).getTime() + 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const newStartLocal = `${newStart.getFullYear()}-${pad(newStart.getMonth() + 1)}-${pad(newStart.getDate())}T${pad(newStart.getHours())}:${pad(newStart.getMinutes())}`;
    fireEvent.change(start, { target: { value: newStartLocal } });

    expect(start.value).toBe(newStartLocal);
    // End should have advanced by 1h compared to its previous value.
    const newEndMs = new Date(end.value).getTime();
    const prevEndMs = new Date(prevEnd).getTime();
    expect(newEndMs - prevEndMs).toBe(60 * 60 * 1000);
  });

  it("moves end backward by the same delta when start moves backward", () => {
    const initial = makeInitial("2026-05-12T10:00:00Z", "2026-05-12T11:30:00Z");
    render(<EventForm open initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />);

    const start = getStartInput();
    const end = getEndInput();
    const prevEnd = end.value;
    const prevStart = start.value;

    // Move start back 30 minutes.
    const newStart = new Date(new Date(prevStart).getTime() - 30 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const newStartLocal = `${newStart.getFullYear()}-${pad(newStart.getMonth() + 1)}-${pad(newStart.getDate())}T${pad(newStart.getHours())}:${pad(newStart.getMinutes())}`;
    fireEvent.change(start, { target: { value: newStartLocal } });

    const newEndMs = new Date(end.value).getTime();
    const prevEndMs = new Date(prevEnd).getTime();
    expect(newEndMs - prevEndMs).toBe(-30 * 60 * 1000);
  });

  it("does NOT modify end when the user edits the end field directly", () => {
    const initial = makeInitial("2026-05-12T10:00:00Z", "2026-05-12T11:00:00Z");
    render(<EventForm open initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />);

    const start = getStartInput();
    const end = getEndInput();
    const prevStart = start.value;

    const newEnd = new Date(new Date(end.value).getTime() + 90 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const newEndLocal = `${newEnd.getFullYear()}-${pad(newEnd.getMonth() + 1)}-${pad(newEnd.getDate())}T${pad(newEnd.getHours())}:${pad(newEnd.getMinutes())}`;
    fireEvent.change(end, { target: { value: newEndLocal } });

    expect(end.value).toBe(newEndLocal);
    expect(start.value).toBe(prevStart);
  });

  it("preserves a manually-stretched duration on subsequent start edits", () => {
    // User edits end to make it a 2h meeting, then later pushes start back.
    const initial = makeInitial("2026-05-12T10:00:00Z", "2026-05-12T11:00:00Z");
    render(<EventForm open initial={initial} onClose={vi.fn()} onSaved={vi.fn()} />);

    const start = getStartInput();
    const end = getEndInput();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

    // Step 1: user makes it 2h by editing end alone.
    const newEnd = new Date(new Date(end.value).getTime() + 60 * 60 * 1000);
    fireEvent.change(end, { target: { value: fmt(newEnd) } });

    // Step 2: user pulls start back 15 minutes. End should follow by -15 minutes,
    // preserving the new 2h duration.
    const earlierStart = new Date(new Date(start.value).getTime() - 15 * 60 * 1000);
    fireEvent.change(start, { target: { value: fmt(earlierStart) } });

    const finalDurationMs = new Date(end.value).getTime() - new Date(start.value).getTime();
    expect(finalDurationMs).toBe(2 * 60 * 60 * 1000);
  });
});
