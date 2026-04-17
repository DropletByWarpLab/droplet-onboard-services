import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WeeklyWindowsEditor } from "../WeeklyWindowsEditor";

describe("WeeklyWindowsEditor", () => {
  it("renders one row per window with role=group", () => {
    const w = [
      { id: "1", daysOfWeek: 2, startMin: 540, endMin: 1020 },
      { id: "2", daysOfWeek: 4, startMin: 600, endMin: 900 },
    ];
    render(<WeeklyWindowsEditor value={w} onChange={vi.fn()} />);
    expect(screen.getAllByRole("group", { name: /window/i })).toHaveLength(2);
  });

  it("day-checkbox toggle updates the bitmask (Mon uncheck of Mon+Wed+Fri 42 → 40)", () => {
    const onChange = vi.fn();
    const w = [{ id: "1", daysOfWeek: 42, startMin: 540, endMin: 1020 }];
    render(<WeeklyWindowsEditor value={w} onChange={onChange} />);
    // Un-check Mon (bit 2). Mask 42 = Mon|Wed|Fri (2+8+32). Result: 40.
    fireEvent.click(screen.getByRole("checkbox", { name: /^mon$/i }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ daysOfWeek: 40 }),
    ]);
  });

  it("Remove button calls onChange with smaller array", () => {
    const onChange = vi.fn();
    const w = [
      { id: "1", daysOfWeek: 2, startMin: 540, endMin: 1020 },
      { id: "2", daysOfWeek: 4, startMin: 600, endMin: 900 },
    ];
    render(<WeeklyWindowsEditor value={w} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /remove window 1/i }));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "2" }),
    ]);
  });

  it("+ Add window button disabled at 7 windows", () => {
    const w = Array.from({ length: 7 }, (_, j) => ({
      id: String(j),
      daysOfWeek: 0,
      startMin: 0,
      endMin: 60,
    }));
    render(<WeeklyWindowsEditor value={w} onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add window/i })).toBeDisabled();
  });

  it("zero-length window shows inline 'cannot be zero-length' error", () => {
    const w = [{ id: "1", daysOfWeek: 2, startMin: 540, endMin: 540 }];
    render(<WeeklyWindowsEditor value={w} onChange={vi.fn()} />);
    expect(screen.getByText(/cannot be zero-length/i)).toBeInTheDocument();
  });

  it("midnight-wrap shows 'Ends next day' indicator", () => {
    const w = [{ id: "1", daysOfWeek: 1, startMin: 21 * 60, endMin: 7 * 60 }];
    render(<WeeklyWindowsEditor value={w} onChange={vi.fn()} />);
    expect(screen.getByText(/ends next day/i)).toBeInTheDocument();
  });
});
