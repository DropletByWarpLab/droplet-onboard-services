import { describe, it, expect } from "vitest";
import {
  agingReading,
  bucketLabel,
  bucketTitle,
  cumulativeFlowReading,
  durationBucketLabels,
  durationReading,
  flowReading,
  formatAge,
  formatDays,
  throughputReading,
  withinPhrase,
  workloadReading,
  ymdLabel,
} from "./readings";
import type { InsightsCfdDay, InsightsDuration, PmInsights } from "./types";

const duration = (over: Partial<InsightsDuration> = {}): InsightsDuration => ({
  count: 4,
  p50: 2,
  p85: 3.2,
  p95: 6,
  edgesDays: [1, 2, 4, 7, 14, 30],
  counts: [0, 0, 3, 1, 0, 0, 0],
  ...over,
});

const meta = (over: Partial<PmInsights["meta"]> = {}): PmInsights["meta"] => ({
  scope: "project",
  projectId: "p1",
  from: "2026-07-13",
  to: "2026-10-04", // 84 days: exactly twelve weeks
  groupBy: "week",
  timezone: "UTC",
  generatedAt: "2026-10-04T12:00:00.000Z",
  itemCount: 10,
  ...over,
});

const day = (date: string, over: Partial<InsightsCfdDay> = {}): InsightsCfdDay => ({
  date,
  backlog: 0,
  unstarted: 0,
  started: 0,
  completed: 0,
  cancelled: 0,
  unknown: 0,
  ...over,
});

describe("labels", () => {
  it("builds a date label from the string, never through the viewer's time zone", () => {
    expect(ymdLabel("2026-09-07")).toBe("Sep 7");
    expect(ymdLabel("2026-01-01")).toBe("Jan 1");
  });

  it("labels a bucket by its kind", () => {
    expect(bucketLabel("2026-09-07", "week")).toBe("Sep 7");
    expect(bucketLabel("2026-09-07", "day")).toBe("Sep 7");
    expect(bucketLabel("2026-09-01", "month")).toBe("Sep 2026");
    expect(bucketTitle("2026-09-07", "week")).toBe("Week of Sep 7");
    expect(bucketTitle("2026-09-01", "month")).toBe("Sep 2026");
  });

  it("names the histogram buckets from the edges the API reports", () => {
    expect(durationBucketLabels([1, 2, 4, 7, 14, 30])).toEqual([
      "Under 1 day",
      "1–2 days",
      "2–4 days",
      "4–7 days",
      "7–14 days",
      "14–30 days",
      "30 days or more",
    ]);
  });
});

describe("durations in words", () => {
  it("rounds an upper bound UP", () => {
    expect(withinPhrase(0.4)).toBe("a day");
    expect(withinPhrase(1)).toBe("a day");
    expect(withinPhrase(3.2)).toBe("4 days");
    expect(withinPhrase(14.2)).toBe("15 days");
    expect(withinPhrase(42)).toBe("42 days");
    expect(withinPhrase(43)).toBe("7 weeks");
    expect(withinPhrase(130)).toBe("5 months");
  });

  it("writes a duration as itself", () => {
    expect(formatDays(0.3)).toBe("Under a day");
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(2.5)).toBe("2.5 days");
    expect(formatDays(14.2)).toBe("14.2 days");
    expect(formatDays(60)).toBe("9 weeks");
    expect(formatDays(130)).toBe("4.3 months");
  });

  it("writes an age as whole units", () => {
    expect(formatAge(0.2)).toBe("Under a day");
    expect(formatAge(1.9)).toBe("1 day");
    expect(formatAge(4.1)).toBe("4 days");
    expect(formatAge(14.1)).toBe("14 days");
    expect(formatAge(70)).toBe("10 weeks");
    expect(formatAge(130)).toBe("4 months");
  });
});

describe("throughputReading", () => {
  it("says so when nothing finished", () => {
    expect(throughputReading({ total: 0, buckets: [] }, meta())).toBe("Nothing was finished in this period.");
  });

  it("gives a rate per bucket, counted over the days in the range", () => {
    expect(throughputReading({ total: 36, buckets: [] }, meta())).toBe("36 items finished — about 3 a week.");
    expect(throughputReading({ total: 30, buckets: [] }, meta())).toBe("30 items finished — about 2.5 a week.");
    expect(throughputReading({ total: 1, buckets: [] }, meta())).toBe("1 item finished — less than one a week.");
  });

  it("follows the bucket the chart uses", () => {
    expect(throughputReading({ total: 84, buckets: [] }, meta({ groupBy: "day" }))).toBe(
      "84 items finished — about 1 a day.",
    );
  });
});

describe("flowReading", () => {
  it("compares what arrived with what finished, without judging it", () => {
    expect(flowReading({ created: 0, completed: 0, buckets: [] })).toBe("No work was added or finished in this period.");
    expect(flowReading({ created: 12, completed: 7, buckets: [] })).toBe(
      "More work was added than finished — 12 added, 7 finished.",
    );
    expect(flowReading({ created: 7, completed: 12, buckets: [] })).toBe(
      "More was finished than added — 12 finished, 7 added.",
    );
    expect(flowReading({ created: 5, completed: 5, buckets: [] })).toBe("Added and finished are in step — 5 each.");
  });
});

describe("durationReading", () => {
  it("reads like the spec's example: most work finishes within 4 days", () => {
    expect(durationReading("cycle", duration())).toBe(
      "Most work finishes within 4 days of starting — half within 2 days.",
    );
    expect(durationReading("lead", duration({ p85: 9, p50: 6 }))).toBe(
      "Most work finishes within 9 days of being added — half within 6 days.",
    );
  });

  it("says what is missing rather than printing zeros", () => {
    const none = duration({ count: 0, p50: null, p85: null, p95: null });
    expect(durationReading("cycle", none)).toBe("Nothing to measure yet — no finished work was started in this period.");
    expect(durationReading("lead", none)).toBe("Nothing to measure yet — no work was finished in this period.");
  });
});

describe("cumulativeFlowReading", () => {
  it("compares the first day with the last", () => {
    expect(
      cumulativeFlowReading([
        day("2026-09-07", { backlog: 4, unstarted: 10, started: 3, completed: 30 }),
        day("2026-10-04", { backlog: 6, unstarted: 16, started: 5, completed: 48 }),
      ]),
    ).toBe("Waiting work went from 14 to 22; finished work went from 30 to 48.");
  });

  it("has a line even with no history", () => {
    expect(cumulativeFlowReading([])).toBe("No history yet.");
  });
});

describe("workloadReading", () => {
  const name = (id: string) => ({ a: "Ana", b: "Ben" })[id] ?? "Someone";

  it("names the person with the most open work and counts what has no owner", () => {
    expect(
      workloadReading(
        { estimateAvailable: false, assignees: [{ userId: "a", openItems: 9, openEstimate: 0 }, { userId: "b", openItems: 4, openEstimate: 0 }, { userId: null, openItems: 3, openEstimate: 0 }] },
        name,
      ),
    ).toBe("Ana has the most open work — 9 items. 3 open items have no owner.");
    expect(
      workloadReading(
        { estimateAvailable: false, assignees: [{ userId: "b", openItems: 1, openEstimate: 0 }, { userId: null, openItems: 1, openEstimate: 0 }] },
        name,
      ),
    ).toBe("Ben has the most open work — 1 item. 1 open item has no owner.");
  });

  it("leads with the unowned work when that is the biggest pile", () => {
    expect(
      workloadReading(
        { estimateAvailable: false, assignees: [{ userId: null, openItems: 12, openEstimate: 0 }, { userId: "a", openItems: 2, openEstimate: 0 }] },
        name,
      ),
    ).toBe("Most open work has no owner yet — 12 items.");
  });

  it("is quiet when nothing is open", () => {
    expect(workloadReading({ estimateAvailable: false, assignees: [] }, name)).toBe("Nothing is open right now.");
  });
});

describe("agingReading", () => {
  const item = (ageDays: number) => ({ id: String(ageDays), key: "A-1", name: "n", stateName: "Doing", since: "", ageDays });

  it("counts what has outlasted most finished work", () => {
    expect(agingReading({ total: 3, items: [item(20), item(9), item(2)] }, 7)).toBe(
      "2 items have been in progress longer than most finished work took (7 days).",
    );
  });

  it("does not claim an exact count when the list is only the oldest few", () => {
    expect(agingReading({ total: 25, items: [item(30), item(29)] }, 7)).toBe(
      "At least 2 items have been in progress longer than most finished work took (7 days).",
    );
  });

  it("falls back to the oldest age when there is nothing finished to compare with", () => {
    expect(agingReading({ total: 2, items: [item(14.1), item(4)] }, null)).toBe(
      "2 items are in progress — the oldest for 14 days.",
    );
  });

  it("says when nothing is old, and when nothing is in progress", () => {
    expect(agingReading({ total: 1, items: [item(2)] }, 7)).toBe(
      "Nothing has been in progress longer than most finished work took.",
    );
    expect(agingReading({ total: 0, items: [] }, 7)).toBe("Nothing is in progress right now.");
  });
});
