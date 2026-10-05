import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CYCLE_STATUS_LABEL,
  CycleStatusBadge,
  CycleTag,
  MODULE_STATUS_LABEL,
  MODULE_STATUS_ORDER,
  ModuleStatusBadge,
  ProgressBar,
  progressFigures,
  progressText,
} from "./planning-bits";
import type { PmPlanningProgress } from "./types";

const P = (over: Partial<PmPlanningProgress> = {}): PmPlanningProgress => ({
  total: 0,
  completed: 0,
  cancelled: 0,
  totalEstimate: 0,
  completedEstimate: 0,
  cancelledEstimate: 0,
  ...over,
});

describe("progressFigures", () => {
  it("is done out of everything planned, cancelled work excluded", () => {
    expect(progressFigures(P({ total: 12, completed: 7, cancelled: 2 }))).toEqual({
      done: 7,
      of: 10,
      cancelled: 2,
      percent: 70,
    });
  });

  it("a dropped item is not work that failed to get done: all-cancelled is 0%, not a divide-by-zero", () => {
    expect(progressFigures(P({ total: 3, cancelled: 3 })).percent).toBe(0);
  });

  it("an empty set is 0%", () => {
    expect(progressFigures(P())).toEqual({ done: 0, of: 0, cancelled: 0, percent: 0 });
  });

  it("rounds to a whole percent and never exceeds 100", () => {
    expect(progressFigures(P({ total: 3, completed: 1 })).percent).toBe(33);
    expect(progressFigures(P({ total: 3, completed: 2 })).percent).toBe(67);
    expect(progressFigures(P({ total: 2, completed: 5 })).percent).toBe(100);
  });

  it("reads the estimate half when asked", () => {
    const p = P({ total: 4, completed: 1, totalEstimate: 20, completedEstimate: 15, cancelledEstimate: 0 });
    expect(progressFigures(p, "estimate")).toEqual({ done: 15, of: 20, cancelled: 0, percent: 75 });
  });
});

describe("progressText", () => {
  it("says it in words", () => {
    expect(progressText(P({ total: 12, completed: 7 }))).toBe("7 of 12 done");
  });
  it("mentions cancelled work when there is some", () => {
    expect(progressText(P({ total: 12, completed: 7, cancelled: 1 }))).toBe("7 of 11 done · 1 cancelled");
  });
  it("an empty cycle says so", () => {
    expect(progressText(P())).toBe("No items yet");
  });
  it("points", () => {
    expect(progressText(P({ total: 3, totalEstimate: 30, completedEstimate: 18 }), "estimate")).toBe("18 of 30 points done");
    expect(progressText(P({ total: 3 }), "estimate")).toBe("No estimates yet");
  });
});

describe("ProgressBar", () => {
  it("is a progressbar with a name, a value and words", () => {
    render(<ProgressBar progress={P({ total: 10, completed: 4 })} label="Sprint 12" />);
    const bar = screen.getByRole("progressbar", { name: "Sprint 12 progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "40% — 4 of 10 done");
  });

  it("fills to the percentage", () => {
    const { container } = render(<ProgressBar progress={P({ total: 4, completed: 1 })} label="x" />);
    expect((container.querySelector(".fill") as HTMLElement).style.width).toBe("25%");
  });

  it("the ok tone is a class, not a colour literal", () => {
    const { container } = render(<ProgressBar progress={P({ total: 1, completed: 1 })} label="x" tone="ok" />);
    expect(container.querySelector(".fill.ok")).toBeTruthy();
  });
});

describe("status badges", () => {
  it("a draft cycle is 'Upcoming' to the owner", () => {
    render(<CycleStatusBadge status="draft" />);
    expect(screen.getByText("Upcoming")).toBeInTheDocument();
    expect(CYCLE_STATUS_LABEL.active).toBe("Active");
    expect(CYCLE_STATUS_LABEL.completed).toBe("Completed");
  });

  it("reuses the state-chip colour classes", () => {
    const { container, rerender } = render(<CycleStatusBadge status="active" />);
    expect(container.querySelector(".pm-statechip.started")).toBeTruthy();
    rerender(<CycleStatusBadge status="completed" />);
    expect(container.querySelector(".pm-statechip.completed")).toBeTruthy();
  });

  it("every module status has a label, and sentence case", () => {
    for (const s of MODULE_STATUS_ORDER) {
      expect(MODULE_STATUS_LABEL[s]).toBeTruthy();
      expect(MODULE_STATUS_LABEL[s][0]).toBe(MODULE_STATUS_LABEL[s][0].toUpperCase());
      expect(MODULE_STATUS_LABEL[s].slice(1)).toBe(MODULE_STATUS_LABEL[s].slice(1).toLowerCase());
    }
    render(<ModuleStatusBadge status="in_progress" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("only cancelled is red", () => {
    const { container, rerender } = render(<ModuleStatusBadge status="cancelled" />);
    expect(container.querySelector(".pm-statechip.cancelled")).toBeTruthy();
    for (const s of MODULE_STATUS_ORDER.filter((x) => x !== "cancelled")) {
      rerender(<ModuleStatusBadge status={s} />);
      expect(container.querySelector(".pm-statechip.cancelled")).toBeNull();
    }
  });
});

describe("CycleTag", () => {
  const cycles = new Map([["c1", { id: "c1", name: "Sprint 12" }]]);

  it("shows the cycle's name with an explanatory title", () => {
    render(<CycleTag cycleId="c1" cycles={cycles} />);
    expect(screen.getByText("Sprint 12")).toBeInTheDocument();
    expect(screen.getByTitle("Cycle: Sprint 12")).toBeInTheDocument();
  });

  it.each([
    ["no cycle", null, cycles],
    ["undefined", undefined, cycles],
    ["a cycle that is not in the map (still loading, or deleted)", "c2", cycles],
    ["no map at all", "c1", undefined],
  ])("renders nothing for %s", (_label, id, map) => {
    const { container } = render(<CycleTag cycleId={id as string | null | undefined} cycles={map} />);
    expect(container.firstChild).toBeNull();
  });
});
