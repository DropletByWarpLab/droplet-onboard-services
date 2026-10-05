import { describe, it, expect } from "vitest";
import { emptyProgress, summarizeProgress } from "./pm-progress.js";

const row = (group: string | null, estimate: number | null = null) => ({
  estimate,
  state: group === null ? null : { group: group as never },
});

describe("emptyProgress", () => {
  it("is all zeros", () => {
    expect(emptyProgress()).toEqual({
      total: 0,
      completed: 0,
      cancelled: 0,
      totalEstimate: 0,
      completedEstimate: 0,
      cancelledEstimate: 0,
    });
  });
});

describe("summarizeProgress", () => {
  it("counts every item in total, and splits completed from cancelled by state GROUP", () => {
    const p = summarizeProgress([
      row("backlog"),
      row("unstarted"),
      row("started"),
      row("completed"),
      row("completed"),
      row("cancelled"),
    ]);
    expect(p.total).toBe(6);
    expect(p.completed).toBe(2);
    expect(p.cancelled).toBe(1);
  });

  it("an item with no state is open (the board files it under unstarted)", () => {
    const p = summarizeProgress([row(null), row("completed")]);
    expect(p.total).toBe(2);
    expect(p.completed).toBe(1);
    expect(p.cancelled).toBe(0);
  });

  it("sums estimates the same way, treating an unset estimate as zero", () => {
    const p = summarizeProgress([
      row("completed", 5),
      row("cancelled", 2),
      row("started", 3),
      row("started", null),
    ]);
    expect(p.totalEstimate).toBe(10);
    expect(p.completedEstimate).toBe(5);
    expect(p.cancelledEstimate).toBe(2);
  });

  it("rounds estimate sums to two decimals", () => {
    const p = summarizeProgress([row("completed", 0.1), row("completed", 0.2)]);
    expect(p.completedEstimate).toBe(0.3);
    expect(p.totalEstimate).toBe(0.3);
  });

  it("an empty set is the empty progress", () => {
    expect(summarizeProgress([])).toEqual(emptyProgress());
  });
});
