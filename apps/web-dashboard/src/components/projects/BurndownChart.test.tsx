import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { BurndownChart, burndownSummary } from "./BurndownChart";
import type { PmBurndown, PmBurndownPoint } from "./types";

const day = (date: string, over: Partial<PmBurndownPoint> = {}): PmBurndownPoint => ({
  date,
  scope: 10,
  remaining: 10,
  completed: 0,
  added: 0,
  removed: 0,
  scopeEstimate: 30,
  remainingEstimate: 30,
  completedEstimate: 0,
  ideal: 10,
  idealEstimate: 30,
  ...over,
});

const FUTURE: Partial<PmBurndownPoint> = {
  scope: null,
  remaining: null,
  completed: null,
  added: null,
  removed: null,
  scopeEstimate: null,
  remainingEstimate: null,
  completedEstimate: null,
};

const BURNDOWN: PmBurndown = {
  cycleId: "c1",
  status: "active",
  startDate: "2026-10-05",
  endDate: "2026-10-08",
  through: "2026-10-07",
  hasEstimates: true,
  days: [
    day("2026-10-05"),
    day("2026-10-06", { scope: 10, remaining: 7, completed: 3, ideal: 6.67, scopeEstimate: 30, remainingEstimate: 21, idealEstimate: 20 }),
    day("2026-10-07", { scope: 12, remaining: 6, completed: 6, added: 2, ideal: 3.33, scopeEstimate: 36, remainingEstimate: 18, idealEstimate: 10 }),
    day("2026-10-08", { ...FUTURE, ideal: 0, idealEstimate: 0 }),
  ],
};

describe("burndownSummary", () => {
  it("says where the cycle stands and what happened to the scope", () => {
    expect(burndownSummary(BURNDOWN, "count")).toBe("6 of 12 items remaining · scope grew by 2");
  });

  it("speaks in points when asked", () => {
    expect(burndownSummary(BURNDOWN, "estimate")).toBe("18 of 36 points remaining · scope grew by 6");
  });

  it("says when the scope shrank, and when it did not move", () => {
    const shrank: PmBurndown = { ...BURNDOWN, days: [day("2026-10-05", { scope: 10 }), day("2026-10-06", { scope: 8, remaining: 8 })], through: "2026-10-06" };
    expect(burndownSummary(shrank, "count")).toBe("8 of 8 items remaining · scope shrank by 2");
    const flat: PmBurndown = { ...BURNDOWN, days: [day("2026-10-05"), day("2026-10-06")], through: "2026-10-06" };
    expect(burndownSummary(flat, "count")).toBe("10 of 10 items remaining · scope is unchanged");
  });

  it("uses the singular for one", () => {
    const one: PmBurndown = { ...BURNDOWN, days: [day("2026-10-05", { scope: 1, remaining: 1 })], through: "2026-10-05" };
    expect(burndownSummary(one, "count")).toBe("1 of 1 item remaining · scope is unchanged");
  });

  it("a cycle that has not started has nothing to report yet", () => {
    const notYet: PmBurndown = { ...BURNDOWN, days: [day("2026-10-05", { ...FUTURE })], through: null };
    expect(burndownSummary(notYet, "count")).toBe("This cycle hasn't started yet.");
    expect(burndownSummary({ ...BURNDOWN, days: [], through: null }, "count")).toBe("This cycle hasn't started yet.");
  });
});

describe("BurndownChart", () => {
  it("is a figure whose accessible equivalent is the summary and a data table", () => {
    render(<BurndownChart burndown={BURNDOWN} mode="count" />);
    const figure = screen.getByRole("figure", { name: "Burndown" });
    expect(within(figure).getByText("6 of 12 items remaining · scope grew by 2")).toBeInTheDocument();
    const table = within(figure).getByRole("table");
    expect(within(table).getByText("Daily burndown")).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Date", "Scope", "Remaining", "Ideal"]);
  });

  it("has one row per day, dates as the owner reads them, and a dash where a day has no actuals", () => {
    render(<BurndownChart burndown={BURNDOWN} mode="count" />);
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const cells = (i: number) => within(rows[i]).getAllByRole("cell").map((c) => c.textContent);
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent("Oct 5");
    expect(cells(1)).toEqual(["10", "7", "6.67"]);
    expect(cells(2)).toEqual(["12", "6", "3.33"]);
    expect(within(rows[3]).getByRole("rowheader")).toHaveTextContent("Oct 8");
    expect(cells(3)).toEqual(["—", "—", "0"]);
  });

  it("the table follows the unit", () => {
    render(<BurndownChart burndown={BURNDOWN} mode="estimate" />);
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(within(rows[2]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["36", "18", "10"]);
  });

  it("the picture is hidden from assistive technology — the table is the path", () => {
    const { container } = render(<BurndownChart burndown={BURNDOWN} mode="count" />);
    const plot = container.querySelector(".pm-burndown-plot");
    expect(plot).toHaveAttribute("aria-hidden", "true");
    expect(within(plot as HTMLElement).queryByRole("table")).toBeNull();
  });

  it("names every line in a legend — nothing is colour only", () => {
    render(<BurndownChart burndown={BURNDOWN} mode="count" />);
    const legend = screen.getByRole("list");
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent?.trim())).toEqual(["Remaining", "Scope", "Ideal"]);
  });

  it("the table is visually hidden, not removed", () => {
    render(<BurndownChart burndown={BURNDOWN} mode="count" />);
    expect(screen.getByRole("table")).toHaveClass("pm-sr-only");
  });

  it("uses no colour literal: strokes are token variables", () => {
    const { container } = render(<BurndownChart burndown={BURNDOWN} mode="count" />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
