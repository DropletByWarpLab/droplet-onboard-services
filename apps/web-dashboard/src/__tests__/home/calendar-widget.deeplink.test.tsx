/**
 * Home CalendarWidget — day cells deep-link to /calendar (WARP-1130/1131).
 *
 * Bug: the widget's day grid rendered inert <div>s — clicking a day did
 * nothing and the cells were invisible to keyboard/AT users. These tests pin
 * the fix: in-month cells are real <button>s (focusable, labelled with the
 * full date) that navigate to /calendar?date=YYYY-MM-DD; out-of-month filler
 * cells stay non-interactive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));

// The widget only needs the viewed month's events; no network.
vi.mock("@/lib/hooks/useCalendar", () => ({
  useCalendarEvents: () => ({
    events: [],
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  }),
}));

import { CalendarWidget } from "@/components/home/widgets";
import { dayKey } from "@/lib/calendar";

// The widget always opens on the real current month.
const today = new Date();
const y = today.getFullYear();
const m = today.getMonth();
const daysInMonth = new Date(y, m + 1, 0).getDate();
const firstDow = new Date(y, m, 1).getDay();

const fullDateLabel = (day: number) =>
  new Date(y, m, day).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

describe("Home CalendarWidget day cells (WARP-1130/1131)", () => {
  beforeEach(() => {
    cleanup();
    pushMock.mockReset();
  });

  it("renders every in-month day as a focusable button labelled with the full date", () => {
    render(<CalendarWidget w={3} h={4} />);

    const dayButtons = document.querySelectorAll("button.w-cal-cell");
    expect(dayButtons.length).toBe(daysInMonth);

    const fifteenth = screen.getByRole("button", { name: fullDateLabel(15) });
    expect(fifteenth.tagName).toBe("BUTTON");
    // Native buttons are keyboard-focusable (Tab) and activate on Enter/Space.
    expect(fifteenth.tabIndex).toBe(0);
  });

  it("keeps out-of-month filler cells non-interactive", () => {
    render(<CalendarWidget w={3} h={4} />);

    const fillers = document.querySelectorAll(".w-cal-cell.out");
    const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;
    expect(fillers.length).toBe(totalCells - daysInMonth);
    fillers.forEach((cell) => {
      expect(cell.tagName).toBe("DIV");
    });
  });

  it("clicking a day navigates to /calendar?date=YYYY-MM-DD", () => {
    render(<CalendarWidget w={3} h={4} />);

    fireEvent.click(screen.getByRole("button", { name: fullDateLabel(15) }));

    expect(pushMock).toHaveBeenCalledWith(
      `/calendar?date=${dayKey(new Date(y, m, 15))}`,
    );
  });

  it("deep-links follow the viewed month after navigating with the chevrons", () => {
    render(<CalendarWidget w={3} h={4} />);

    fireEvent.click(screen.getByRole("button", { name: /next month/i }));

    const next = new Date(y, m + 1, 1);
    const label = new Date(next.getFullYear(), next.getMonth(), 1).toLocaleDateString(
      undefined,
      { weekday: "long", month: "long", day: "numeric", year: "numeric" },
    );
    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(pushMock).toHaveBeenCalledWith(
      `/calendar?date=${dayKey(new Date(next.getFullYear(), next.getMonth(), 1))}`,
    );
  });
});
