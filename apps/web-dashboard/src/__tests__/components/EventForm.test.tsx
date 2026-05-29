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
});
