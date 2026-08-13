/**
 * MiniMonth — display-only day grid (WARP-1904).
 *
 * QA: the compact month card's dates showed hover/click affordances but
 * clicking did nothing on the Calendar page's Month view (the click only
 * moved the cursor inside the already-displayed month — no visible change).
 * Product decision (Option B): don't build date navigation — when no
 * day-click behavior is wired (`onCursor` omitted), the grid is DISPLAY-ONLY:
 * day cells are not buttons, are not focusable, and carry no hover/pointer
 * affordance. The today highlight and event dots stay, and the month
 * prev/next chevrons (real, working navigation) keep working.
 *
 * When `onCursor` IS provided (Agenda view's scroll-to-day pick, WARP-944),
 * the cells stay real buttons — that behavior is genuinely functional and
 * must not regress.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MiniMonth } from "./MiniMonth";
import { dayKey } from "@/lib/calendar";

const today = new Date();
// An in-month day that is NOT today (event dots only render off-today).
const dotDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() === 15 ? 16 : 15);

const fullLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

/** The 42 day cells: every child of the 7-col grid after the 7 DOW headers. */
function dayCells(container: HTMLElement): HTMLElement[] {
  const grid = container.querySelector(".grid.grid-cols-7");
  expect(grid).not.toBeNull();
  return Array.from(grid!.children).slice(7) as HTMLElement[];
}

describe("MiniMonth display-only day grid (WARP-1904)", () => {
  it("renders day cells as non-interactive elements when no onCursor is wired", () => {
    const { container } = render(
      <MiniMonth cursor={today} eventDays={new Set([dayKey(dotDay)])} onMonthNav={vi.fn()} />,
    );

    // The ONLY buttons on the card are the two working month chevrons.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.getAttribute("aria-label")).sort()).toEqual([
      "Next month",
      "Previous month",
    ]);

    const cells = dayCells(container);
    expect(cells).toHaveLength(42);
    for (const cell of cells) {
      expect(cell.tagName).not.toBe("BUTTON");
      expect(cell.getAttribute("role")).toBeNull();
      expect(cell.getAttribute("tabindex")).toBeNull();
      // No pointer/hover affordance left behind on an inert cell.
      expect(cell.className).not.toMatch(/hover:/);
      expect(cell.className).not.toMatch(/cursor-pointer/);
    }
  });

  it("keeps the today highlight and event dots in display-only mode", () => {
    const { container } = render(
      <MiniMonth cursor={today} eventDays={new Set([dayKey(dotDay)])} onMonthNav={vi.fn()} />,
    );

    const todayCell = container.querySelector<HTMLElement>('[aria-current="date"]');
    expect(todayCell).not.toBeNull();
    expect(todayCell!.tagName).not.toBe("BUTTON");
    expect(todayCell!.textContent).toContain(String(today.getDate()));
    expect(todayCell!.className).toMatch(/font-semibold/);

    // The event dot still renders on the day that has events.
    const dotted = dayCells(container).find((c) => c.querySelector("span.rounded-full"));
    expect(dotted).toBeDefined();
    expect(dotted!.textContent).toContain(String(dotDay.getDate()));
  });

  it("month chevrons still navigate in display-only mode", () => {
    const onMonthNav = vi.fn();
    render(<MiniMonth cursor={today} onMonthNav={onMonthNav} />);

    fireEvent.click(screen.getByRole("button", { name: "Next month" }));

    expect(onMonthNav).toHaveBeenCalledTimes(1);
    const target: Date = onMonthNav.mock.calls[0][0];
    expect(target.getMonth()).toBe(new Date(today.getFullYear(), today.getMonth() + 1, 1).getMonth());
    expect(target.getDate()).toBe(1);
  });

  it("keeps day cells as real buttons that fire onCursor when a pick handler is wired (WARP-944)", () => {
    const onCursor = vi.fn();
    render(<MiniMonth cursor={today} onCursor={onCursor} onMonthNav={vi.fn()} />);

    const cell = screen.getByRole("button", { name: fullLabel(dotDay) });
    expect(cell.tagName).toBe("BUTTON");
    fireEvent.click(cell);

    expect(onCursor).toHaveBeenCalledTimes(1);
    expect(dayKey(onCursor.mock.calls[0][0])).toBe(dayKey(dotDay));
  });
});
