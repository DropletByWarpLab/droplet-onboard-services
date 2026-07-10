/**
 * WARP-289: assert EventForm exposes full modal ARIA via the shared
 * <Dialog> primitive.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/lib/hooks/useCalendar", async () => {
  const actual = await vi.importActual<any>("@/lib/hooks/useCalendar");
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

describe("EventForm ARIA (WARP-289)", () => {
  it("renders role=dialog + aria-modal + aria-labelledby resolving to the heading when open", () => {
    render(
      <EventForm open onClose={vi.fn()} onSaved={vi.fn()} initial={null} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toMatch(/New event/);
  });

  it("renders nothing when closed", () => {
    render(
      <EventForm
        open={false}
        onClose={vi.fn()}
        onSaved={vi.fn()}
        initial={null}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("relies on the Dialog primitive for body padding + horizontal clipping (WARP-1152/1153)", () => {
    // The New-event dialog used to self-pad with an overflow-y-auto wrapper;
    // a too-wide Starts/Ends row then overflowed past the right padding and
    // grew an internal horizontal scrollbar. The primitive now owns the p-5
    // inset and the overflow-x-hidden policy — assert EventForm gets it (and
    // doesn't double-pad).
    render(
      <EventForm open onClose={vi.fn()} onSaved={vi.fn()} initial={null} />,
    );
    const dialog = screen.getByRole("dialog");
    const body = dialog.firstElementChild as HTMLElement;
    expect(body.className).toContain("p-5");
    expect(body.className).toContain("overflow-x-hidden");
    expect(body.className).toContain("overflow-y-auto");
    // No second p-5 layer inside the primitive's body region.
    const doublePadded = Array.from(
      body.querySelectorAll<HTMLElement>("*"),
    ).filter((el) => el.classList.contains("p-5"));
    expect(doublePadded).toHaveLength(0);
  });

  it("Starts/Ends datetime rows wrap instead of overflowing the dialog width (WARP-1152)", () => {
    // Each DateTimePicker row (date input + time select) has a min-content
    // width of ~250px, wider than one half of the sm:grid-cols-2 split inside
    // the max-w-md dialog. flex-wrap lets the time select drop to its own
    // line instead of pushing past the dialog's content box.
    render(
      <EventForm open onClose={vi.fn()} onSaved={vi.fn()} initial={null} />,
    );
    for (const stem of ["Starts", "Ends"]) {
      const dateInput = screen.getByLabelText(`${stem} date`);
      const row = dateInput.parentElement as HTMLElement;
      expect(row.className).toMatch(/\bflex\b/);
      expect(row.className).toMatch(/\bflex-wrap\b/);
    }
  });

  it("stacks the Starts/Ends grid on narrow viewports and goes 2-col at sm (WARP-943)", () => {
    // The date input carries an 8.5rem floor so the year isn't clipped; on a
    // ~360px phone two such columns overflow the cell, so the grid must stack
    // (grid-cols-1) and only split side-by-side at the sm breakpoint up.
    render(
      <EventForm open onClose={vi.fn()} onSaved={vi.fn()} initial={null} />,
    );
    const startsCaption = screen.getByText("Starts", { selector: "span" });
    const grid = startsCaption.closest("div.grid");
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain("grid-cols-1");
    expect(grid!.className).toContain("sm:grid-cols-2");
  });
});
