/**
 * WARP-3528 — the queue rail: six queues in a fixed order with live counts, the
 * active one marked for assistive tech, a desk switcher only when it is needed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";
import { QueueRail } from "./QueueRail";
import { makeDesk } from "./support.test-fixtures";
import type { QueueCounts } from "./types";

const COUNTS: QueueCounts = { unassigned: 3, mine: 1, open: 7, pending: 2, solved_recent: 0, all: 12 };

const rail = (over: Partial<React.ComponentProps<typeof QueueRail>> = {}) => {
  const props = {
    counts: COUNTS,
    queue: "open" as const,
    onQueue: vi.fn(),
    desks: [makeDesk()],
    deskId: null,
    onDesk: vi.fn(),
    ...over,
  };
  render(<QueueRail {...props} />);
  return props;
};

describe("QueueRail", () => {
  it("lists the six queues in order, each with its live count", () => {
    rail();
    const buttons = within(screen.getByRole("navigation", { name: "Ticket queues" })).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Unassigned3",
      "Mine1",
      "Open7",
      "Pending2",
      "Solved recently0",
      "All tickets12",
    ]);
  });

  it("marks the active queue and reports a click", () => {
    const { onQueue } = rail({ queue: "mine" });
    expect(screen.getByRole("button", { name: /^Mine/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /^Open/ })).not.toHaveAttribute("aria-current");
    fireEvent.click(screen.getByRole("button", { name: /^Pending/ }));
    expect(onQueue).toHaveBeenCalledWith("pending");
  });

  it("shows a skeleton, not a zero, until the counts load", () => {
    rail({ counts: undefined });
    expect(screen.queryByText("0")).toBeNull();
    expect(document.querySelectorAll(".pm-skel").length).toBe(6);
  });

  it("moves focus between queues with the arrow keys, wrapping at the ends", () => {
    rail();
    const first = screen.getByRole("button", { name: /^Unassigned/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /^Mine/ })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("button", { name: /^Mine/ }), { key: "ArrowUp" });
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: /^All tickets/ })).toHaveFocus();
  });

  it("offers a desk switcher only when there is more than one desk", () => {
    const { rerender } = render(
      <QueueRail counts={COUNTS} queue="open" onQueue={vi.fn()} desks={[makeDesk()]} deskId={null} onDesk={vi.fn()} />,
    );
    expect(screen.queryByRole("combobox", { name: "Service desk" })).toBeNull();

    const onDesk = vi.fn();
    rerender(
      <QueueRail
        counts={COUNTS}
        queue="open"
        onQueue={vi.fn()}
        desks={[makeDesk(), makeDesk({ id: "desk-2", name: "IT requests", identifier: "IT" })]}
        deskId={null}
        onDesk={onDesk}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Service desk" });
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["All desks", "Support", "IT requests"]);
    fireEvent.change(select, { target: { value: "desk-2" } });
    expect(onDesk).toHaveBeenCalledWith("desk-2");
    fireEvent.change(select, { target: { value: "" } });
    expect(onDesk).toHaveBeenLastCalledWith(null);
  });
});
