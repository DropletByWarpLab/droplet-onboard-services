import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { MonthView, monthGridDays, monthGridRange, eventsByDay } from "./MonthView";

describe("monthGridDays", () => {
  it("returns 42 days starting on the Sunday on/before the 1st", () => {
    const days = monthGridDays(new Date(2026, 4, 15)); // May 2026
    expect(days).toHaveLength(42);
    expect(days[0].getDay()).toBe(0); // grid always starts on a Sunday

    const first = new Date(2026, 4, 1);
    expect(days[0].getTime()).toBeLessThanOrEqual(first.getTime());
    expect(first.getTime() - days[0].getTime()).toBeLessThan(7 * 86_400_000);
  });

  it("includes every day of the cursor's month", () => {
    const days = monthGridDays(new Date(2026, 4, 15));
    const keys = new Set(days.map((d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`));
    expect(keys.has("2026-4-1")).toBe(true); // May 1
    expect(keys.has("2026-4-31")).toBe(true); // May 31
  });

  it("is contiguous (each day is +1 of the previous)", () => {
    const days = monthGridDays(new Date(2026, 1, 10)); // Feb 2026
    for (let i = 1; i < days.length; i++) {
      const diff = (days[i].getTime() - days[i - 1].getTime()) / 86_400_000;
      expect(Math.round(diff)).toBe(1);
    }
  });
});

describe("monthGridRange", () => {
  it("covers the full visible grid and starts on a Sunday", () => {
    const { from, to } = monthGridRange(new Date(2026, 4, 15));
    expect(from.getDay()).toBe(0);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBeGreaterThan(40);
    expect(from.getHours()).toBe(0);
  });
});

describe("eventsByDay", () => {
  // Build event times from LOCAL Date objects so the day-bucketing (which is
  // local-time) is asserted independent of the test runner's timezone.
  const ev = (
    id: string,
    start: Date,
    end: Date,
    source: "local" | "external" = "local",
  ): CalendarEvent =>
    ({
      id,
      title: id,
      startsAt: start.toISOString(),
      endsAt: end.toISOString(),
      allDay: false,
      source,
    }) as CalendarEvent;

  it("places a multi-day event on every day it spans", () => {
    // May 30 10:00 → Jun 1 10:00 local — three distinct local days.
    const m = eventsByDay([ev("trip", new Date(2026, 4, 30, 10), new Date(2026, 5, 1, 10))]);
    expect(m.get("2026-05-30")).toHaveLength(1);
    expect(m.get("2026-05-31")).toHaveLength(1);
    expect(m.get("2026-06-01")).toHaveLength(1);
    expect(m.has("2026-06-02")).toBe(false);
  });

  it("treats an end exactly at local midnight as exclusive", () => {
    // May 31 00:00 → Jun 1 00:00 local is one all-day span, not two.
    const m = eventsByDay([ev("holiday", new Date(2026, 4, 31, 0, 0), new Date(2026, 5, 1, 0, 0))]);
    expect(m.get("2026-05-31")).toHaveLength(1);
    expect(m.has("2026-06-01")).toBe(false);
  });

  it("buckets a single-day event exactly once", () => {
    const m = eventsByDay([ev("lunch", new Date(2026, 4, 15, 12), new Date(2026, 4, 15, 13))]);
    expect([...m.keys()]).toEqual(["2026-05-15"]);
    expect(m.get("2026-05-15")).toHaveLength(1);
  });
});

/* ══ WARP-1786 — the month grid's own gap ══════════════════════════════════
   Sam reported the month grid "runs nearly edge-to-edge", its outer columns
   flush against the screen edges with cell borders clipped, while the
   "August 2026" mini-month directly below it sits on the normal page gutter.

   The cause is the specificity collision in
   `04-coding-standards/mobile-web-layout.md` §4: `.droplet-shell .grid`
   is (0,2,0) and declares `gap: 16px`, so it silently beats every (0,1,0)
   `gap-*` utility inside the shell. Measured in Chrome at a 375px viewport
   against the production CSS bundle: the 7 day columns rendered **35px**
   each with **16px of dead space between them** (7×35 + 6×16 = 341).

   The cost is the cells, not the card's edges: the card is `padding: 0`, so
   the outer columns are flush against the card walls with the gap or without
   it — `gap` only redistributes the same 341px track BETWEEN the columns
   (7×48.7 + 6×0 = 341 as well). What it takes is 39% of every cell's width,
   and it leaves each cell's `border-r` floating 16px away from the cell it is
   supposed to divide — a bordered lattice blown apart.

   MiniMonth already pins its gap inline for exactly this reason (WARP-1848);
   this is the same call-site fix for the big grid. jsdom has no layout engine
   (mobile-web-layout §5), so what is asserted here is the declaration, not
   the geometry. */
describe("MonthView — phone gutter (WARP-1786)", () => {
  it("pins its own gap so the shell's `.grid { gap: 16px }` cannot blow the columns apart", () => {
    const { container } = render(<MonthView events={[]} cursor={new Date(2026, 7, 15)} />);
    const grids = container.querySelectorAll<HTMLElement>(".grid.grid-cols-7");
    // Weekday header row + the 42-cell day grid.
    expect(grids).toHaveLength(2);
    for (const g of grids) {
      // Inline is the only thing that outranks the (0,2,0) primitive without
      // restyling the 58 other files that ask for a grid gap this way.
      expect(g.style.gap).toBe("0px");
    }
  });

  it("keeps the day cells contiguous so their borders form one lattice", () => {
    const { container } = render(<MonthView events={[]} cursor={new Date(2026, 7, 15)} />);
    const cells = container.querySelectorAll<HTMLElement>(".grid.grid-cols-7 button");
    expect(cells).toHaveLength(42);
    // Every cell except the last column draws the vertical divider, and every
    // row except the last draws the horizontal one. With a gap those borders
    // are decorative lines in empty space; with gap 0 they are the grid.
    expect(cells[0].className).toContain("border-r");
    expect(cells[6].className).not.toContain("border-r");
    expect(cells[0].className).toContain("border-b");
    expect(cells[41].className).not.toContain("border-b");
  });
});

/* ══ …and the same lattice at desktop width (≥1024px) ══════════════════════
   WARP-1786 was filed from a 375px screenshot and fixed with an inline,
   UNCONDITIONED `gap: 0`. That reaches every viewport, desktop included, so
   the wide layout changed too and no 375px-shaped test covers it. This block
   exists so that is a decision on the record rather than a side effect.

   It IS the intended end state, and the evidence is in the markup's own
   history: the original month grid (#341) asked for a bare
   `<div className="grid grid-cols-7">` with NO gap utility at all, and drew
   the `isLastCol`/`isLastRow` border lattice underneath it. A lattice is only
   a lattice when the cells touch. `.droplet-shell .grid { gap: 16px }` had
   been injecting 16px at EVERY width since — so the desktop grid was just as
   wrong as the phone one, only with enough room that nobody filed it.
   Pinning 0 restores the original contract; it does not invent a new one.

   Anything that would put the gap back — a `lg:gap-2`, a breakpoint-prefixed
   border variant, a switch back to a plain utility the shell can outrank —
   fails here. jsdom has no layout engine and no media queries, but an inline
   style cannot BE media-queried, which is exactly why asserting it is an
   assertion about ≥1024px. */
describe("MonthView — desktop width (≥1024px)", () => {
  it("pins gap 0 with no breakpoint escape hatch, so wide viewports get the lattice too", () => {
    const { container } = render(<MonthView events={[]} cursor={new Date(2026, 7, 15)} />);
    const grids = container.querySelectorAll<HTMLElement>(".grid.grid-cols-7");
    expect(grids).toHaveLength(2);
    for (const g of grids) {
      // An inline declaration applies at 375px, 1024px and 2560px alike.
      expect(g.style.gap).toBe("0px");
      // A responsive utility next to it would be dead at every width anyway
      // (the shell's (0,2,0) primitive outranks all of them) while reading as
      // though desktop were exempt. Neither the honest nor the dishonest
      // spelling is allowed.
      expect(g.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):gap-/);
      expect(g.className).not.toMatch(/(^|\s)gap-/);
    }
  });

  it("draws the cell borders at every width, unconditioned", () => {
    // The borders ARE the desktop grid lines now that the gap is gone. A
    // `lg:border-0` or an `md:border-r` would leave a wide viewport with
    // neither gap nor rule between the days.
    const { container } = render(<MonthView events={[]} cursor={new Date(2026, 7, 15)} />);
    const cells = container.querySelectorAll<HTMLElement>(".grid.grid-cols-7 button");
    expect(cells).toHaveLength(42);
    for (const c of cells) {
      expect(c.className).not.toMatch(/(^|\s)(sm|md|lg|xl|2xl):border/);
    }
    // Spot-check the interior of the last row and the last column: with gap 0
    // these are the joins a wide layout makes most visible.
    expect(cells[35].className).toContain("border-r");
    expect(cells[35].className).not.toContain("border-b");
    expect(cells[34].className).toContain("border-b");
  });

  it("still gives desktop the taller cell the wide layout was designed around", () => {
    // `sm:min-h-[104px]` is the only width-conditioned thing left on a cell;
    // dropping the gap must not have quietly taken the desktop row height
    // with it.
    const { container } = render(<MonthView events={[]} cursor={new Date(2026, 7, 15)} />);
    const cell = container.querySelector<HTMLElement>(".grid.grid-cols-7 button")!;
    expect(cell.className).toContain("min-h-[88px]");
    expect(cell.className).toContain("sm:min-h-[104px]");
  });
});
