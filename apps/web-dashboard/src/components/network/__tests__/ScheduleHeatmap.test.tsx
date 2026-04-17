import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScheduleHeatmap } from "../ScheduleHeatmap";

describe("ScheduleHeatmap", () => {
  it("renders 7 rows x 24 columns (168 cells) with role=img + aria-label", () => {
    const { container } = render(<ScheduleHeatmap windows={[]} />);
    const cells = container.querySelectorAll('[data-testid^="heatmap-cell-"]');
    expect(cells).toHaveLength(7 * 24);
    expect(
      screen.getByRole("img", { name: /schedule heatmap/i }),
    ).toBeInTheDocument();
  });

  it("single Mon 9am-5pm window colors 8 cells in Mon row", () => {
    // Mon bitmask = 2. 9:00 = 540, 17:00 = 1020. 8 hour buckets: 9..16.
    const windows = [{ daysOfWeek: 2, startMin: 540, endMin: 1020 }];
    const { container } = render(<ScheduleHeatmap windows={windows} />);
    const monDay = 1; // Sun=0..Sat=6
    const covered: number[] = [];
    for (let h = 0; h < 24; h++) {
      const cell = container.querySelector(
        `[data-testid="heatmap-cell-${monDay}-${h}"]`,
      ) as HTMLElement;
      if (Number.parseInt(cell.dataset.overlap ?? "0", 10) > 0) covered.push(h);
    }
    expect(covered).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("midnight-wrap Sat 11pm-Sun 7am colors Sat[23] and Sun[0..6]", () => {
    // Sat bitmask = 64. startMin 23:00 = 1380. endMin 07:00 = 420.
    const windows = [{ daysOfWeek: 64, startMin: 1380, endMin: 420 }];
    const { container } = render(<ScheduleHeatmap windows={windows} />);
    const sat = 6;
    const sun = 0;
    const satCell = container.querySelector(
      `[data-testid="heatmap-cell-${sat}-23"]`,
    ) as HTMLElement;
    expect(Number.parseInt(satCell.dataset.overlap ?? "0", 10)).toBeGreaterThan(0);
    for (let h = 0; h < 7; h++) {
      const cell = container.querySelector(
        `[data-testid="heatmap-cell-${sun}-${h}"]`,
      ) as HTMLElement;
      expect(Number.parseInt(cell.dataset.overlap ?? "0", 10)).toBeGreaterThan(0);
    }
    // Nothing bled into Sun[7..23]
    for (let h = 7; h < 24; h++) {
      const cell = container.querySelector(
        `[data-testid="heatmap-cell-${sun}-${h}"]`,
      ) as HTMLElement;
      expect(cell.dataset.overlap).toBe("0");
    }
  });

  it("has role='img' and the aria-label required for screen readers", () => {
    render(<ScheduleHeatmap windows={[]} />);
    const el = screen.getByRole("img", {
      name: "Schedule heatmap: hours blocked across the week",
    });
    expect(el).toBeInTheDocument();
  });
});
