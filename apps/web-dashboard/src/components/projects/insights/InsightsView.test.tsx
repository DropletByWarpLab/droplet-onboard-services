// Insights view (WARP-3524): the cards, their readings and tables, the range
// picker, and the loading / empty / error states.
//
// recharts cannot lay itself out in jsdom (no layout, so ResponsiveContainer
// measures 0), which is why these tests read the readings and the tables — the
// parts of a card a screen reader gets — rather than the SVG. The tables are the
// same numbers the chart draws, so asserting them asserts the data.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (url: string) => authFetchMock(url),
}));

import { InsightsView } from "./InsightsView";
import { PeopleContext } from "../bits";
import { ViewSwitcher } from "../chrome";
import { makePerson } from "../config";
import type { PmInsights } from "./types";

const NAMES: Record<string, string> = { "u-a": "Ana", "u-b": "Ben" };

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <PeopleContext.Provider value={(id) => makePerson(id, NAMES[id])}>{children}</PeopleContext.Provider>
    </SWRConfig>
  );
}

const day = (date: string, over: Record<string, number> = {}) => ({
  date,
  backlog: 0,
  unstarted: 0,
  started: 0,
  completed: 0,
  cancelled: 0,
  unknown: 0,
  ...over,
});

const INSIGHTS: PmInsights = {
  meta: {
    scope: "project",
    projectId: "p1",
    from: "2026-09-07",
    to: "2026-10-04",
    groupBy: "week",
    timezone: "UTC",
    generatedAt: "2026-10-04T12:00:00.000Z",
    itemCount: 11,
  },
  throughput: {
    total: 4,
    buckets: [
      { start: "2026-09-07", completed: 1 },
      { start: "2026-09-14", completed: 2 },
      { start: "2026-09-21", completed: 1 },
      { start: "2026-09-28", completed: 0 },
    ],
  },
  createdVsCompleted: {
    created: 9,
    completed: 4,
    buckets: [
      { start: "2026-09-07", created: 3, completed: 1 },
      { start: "2026-09-14", created: 4, completed: 2 },
      { start: "2026-09-21", created: 1, completed: 1 },
      { start: "2026-09-28", created: 1, completed: 0 },
    ],
  },
  cycleTime: { count: 3, p50: 3, p85: 6.5, p95: 7.5, edgesDays: [1, 2, 4, 7, 14, 30], counts: [0, 0, 2, 0, 1, 0, 0] },
  leadTime: { count: 4, p50: 6, p85: 9, p95: 9, edgesDays: [1, 2, 4, 7, 14, 30], counts: [0, 0, 2, 0, 2, 0, 0] },
  cumulativeFlow: {
    groups: ["backlog", "unstarted", "started", "completed", "cancelled", "unknown"],
    days: [
      day("2026-09-07", { unstarted: 1, completed: 1 }),
      day("2026-09-17", { backlog: 1, unstarted: 1, completed: 5, unknown: 1 }),
      day("2026-10-04", { backlog: 1, unstarted: 1, started: 2, completed: 5, cancelled: 1, unknown: 1 }),
    ],
  },
  workload: {
    estimateAvailable: false,
    assignees: [
      { userId: "u-a", openItems: 2, openEstimate: 0 },
      { userId: "u-b", openItems: 2, openEstimate: 0 },
      { userId: null, openItems: 2, openEstimate: 0 },
    ],
  },
  agingWip: {
    total: 2,
    items: [
      { id: "i7", key: "WSA-7", name: "Reopened thing", stateName: "Doing", since: "2026-09-20T10:00:00.000Z", ageDays: 14.1 },
      { id: "i5", key: "WSA-5", name: "Newer thing", stateName: "Doing", since: "2026-09-30T10:00:00.000Z", ageDays: 4.1 },
    ],
  },
};

const ok = (insights: PmInsights) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ insights }) } as unknown as Response);
const fail = (status: number, error: string) =>
  Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error }) } as unknown as Response);

beforeEach(() => {
  authFetchMock.mockReset();
  // Only Date is faked: SWR and Testing Library keep their real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 4, 12, 0, 0)); // the viewer's 4 October, local time
});
afterEach(() => {
  vi.useRealTimers();
});

async function populated(projectId: string | null = "p1", insights: PmInsights = INSIGHTS) {
  authFetchMock.mockImplementation(() => ok(insights));
  render(<InsightsView projectId={projectId} />, { wrapper });
  await screen.findByRole("heading", { name: "Work finished" });
}

const card = (name: string) => screen.getByRole("region", { name });

describe("Insights cards", () => {
  it("gives every card one plain-language reading", async () => {
    await populated();
    const read = (name: string) => card(name).querySelector(".reading")?.textContent;
    expect(read("Work finished")).toBe("4 items finished — about 1 a week.");
    expect(read("Added and finished")).toBe("More work was added than finished — 9 added, 4 finished.");
    expect(read("Cycle time")).toBe("Most work finishes within 7 days of starting — half within 3 days.");
    expect(read("Lead time")).toBe("Most work finishes within 9 days of being added — half within 6 days.");
    expect(read("Cumulative flow")).toBe("Waiting work went from 1 to 2; finished work went from 1 to 5.");
    expect(read("Workload")).toBe("Ana has the most open work — 2 items. 2 open items have no owner.");
    expect(read("Aging work in progress")).toBe(
      "1 item has been in progress longer than most finished work took (7 days).",
    );
  });

  it("shows the headline numbers, with unassigned work counted", async () => {
    await populated();
    const tiles = [...document.querySelectorAll(".pm-kpi")].map((t) => [
      t.querySelector(".lbl")?.textContent,
      t.querySelector(".val")?.textContent,
    ]);
    expect(tiles).toEqual([
      ["Finished", "4"],
      ["Typical cycle time", "3 days"],
      ["In progress", "2"],
      ["Unassigned", "2"],
    ]);
  });

  it("carries each chart's numbers as a table", async () => {
    await populated();
    const rowsOf = (name: string) =>
      within(screen.getByRole("region", { name: `${name}, as a table`, hidden: true }))
        .getAllByRole("row")
        .map((r) => [...r.querySelectorAll("th,td")].map((c) => c.textContent));

    expect(rowsOf("Work finished")).toEqual([
      ["Period", "Finished"],
      ["Week of Sep 7", "1"],
      ["Week of Sep 14", "2"],
      ["Week of Sep 21", "1"],
      ["Week of Sep 28", "0"],
    ]);
    expect(rowsOf("Added and finished")[2]).toEqual(["Week of Sep 14", "4", "2"]);
    expect(rowsOf("Cycle time").slice(0, 4)).toEqual([
      ["Time taken", "Items"],
      ["Under 1 day", "0"],
      ["1–2 days", "0"],
      ["2–4 days", "2"],
    ]);
    // Top of the stack first, as in the legend; the unplaced band is there because some day has one.
    expect(rowsOf("Cumulative flow")[0]).toEqual([
      "Day",
      "Unplaced",
      "Backlog",
      "To do",
      "In progress",
      "Cancelled",
      "Done",
    ]);
    expect(rowsOf("Cumulative flow")[3]).toEqual(["2026-10-04", "1", "1", "1", "2", "1", "5"]);
  });

  it("names people from the directory and calls the unowned row what it is", async () => {
    await populated();
    const table = within(screen.getByRole("region", { name: "Open items by person" }));
    expect(table.getAllByRole("rowheader").map((c) => c.textContent)).toEqual(["Ana", "Ben", "Unassigned"]);
  });

  it("lists aging items oldest first, with key, state and age", async () => {
    await populated();
    const table = within(screen.getByRole("region", { name: "Items in progress, oldest first" }));
    const rows = table.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("WSA-7");
    expect(rows[0]).toHaveTextContent("Reopened thing");
    expect(rows[0]).toHaveTextContent("Doing");
    expect(rows[0]).toHaveTextContent("14 days");
    expect(rows[1]).toHaveTextContent("WSA-5");
    expect(rows[1]).toHaveTextContent("4 days");
  });

  it("explains unplaced work in words, not just as a band", async () => {
    await populated();
    expect(screen.getByText(/1 item sits in a state that was removed/i)).toBeInTheDocument();
  });

  it("adds an estimate column to the workload once the orchestrator reports estimates", async () => {
    await populated("p1", {
      ...INSIGHTS,
      workload: {
        estimateAvailable: true,
        assignees: [{ userId: "u-a", openItems: 2, openEstimate: 8 }],
      },
    });
    const table = within(screen.getByRole("region", { name: "Open items by person" }));
    expect(table.getByRole("columnheader", { name: "Open estimate" })).toBeInTheDocument();
    expect(table.getByText("8")).toBeInTheDocument();
  });
});

describe("a chart's table alternative", () => {
  it("is in the page for assistive tech by default, and swaps in for the chart on request", async () => {
    await populated();
    const cycle = within(card("Cycle time"));
    const chart = cycle.getByRole("img", { name: "Cycle time, chart", hidden: true });
    const toggle = cycle.getByRole("button", { name: "View as table" });
    const tableRegion = screen.getByRole("region", { name: "Cycle time, as a table", hidden: true });

    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(chart).not.toHaveAttribute("hidden");
    expect(tableRegion).toHaveClass("pm-sr-only");
    // The toggle controls something that exists.
    expect(document.getElementById(toggle.getAttribute("aria-controls") as string)).toContainElement(tableRegion);

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(chart).toHaveAttribute("hidden");
    expect(tableRegion).not.toHaveClass("pm-sr-only");
    // A scrolling region has to be reachable by keyboard.
    expect(tableRegion).toHaveAttribute("tabindex", "0");
  });

  it("describes the chart image by its reading", async () => {
    await populated();
    const chart = within(card("Work finished")).getByRole("img", { name: "Work finished, chart", hidden: true });
    const readingId = chart.getAttribute("aria-describedby") as string;
    expect(document.getElementById(readingId)).toHaveTextContent("4 items finished");
  });
});

describe("range picker", () => {
  it("asks for twelve weeks of one project by default, counted back from the viewer's day", async () => {
    await populated();
    expect(authFetchMock).toHaveBeenCalledWith("/api/pm/insights?projectId=p1&from=2026-07-13&groupBy=week");
    expect(screen.getByRole("button", { name: "12 weeks" })).toHaveAttribute("aria-pressed", "true");
  });

  it("asks about the whole workspace when no project is named", async () => {
    await populated(null);
    expect(authFetchMock).toHaveBeenCalledWith("/api/pm/insights?from=2026-07-13&groupBy=week");
  });

  it("re-asks with the range it is given, switching to months for a year", async () => {
    await populated();
    fireEvent.click(screen.getByRole("button", { name: "4 weeks" }));
    await waitFor(() =>
      expect(authFetchMock).toHaveBeenLastCalledWith("/api/pm/insights?projectId=p1&from=2026-09-07&groupBy=week"),
    );
    fireEvent.click(screen.getByRole("button", { name: "6 months" }));
    await waitFor(() =>
      expect(authFetchMock).toHaveBeenLastCalledWith("/api/pm/insights?projectId=p1&from=2026-04-06&groupBy=week"),
    );
    fireEvent.click(screen.getByRole("button", { name: "12 months" }));
    await waitFor(() =>
      expect(authFetchMock).toHaveBeenLastCalledWith("/api/pm/insights?projectId=p1&from=2025-10-06&groupBy=month"),
    );
    expect(screen.getByRole("button", { name: "12 months" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "12 weeks" })).toHaveAttribute("aria-pressed", "false");
  });

  it("is a labelled group of buttons, reachable and operable from the keyboard", async () => {
    await populated();
    const group = screen.getByRole("group", { name: "Date range" });
    const buttons = within(group).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["4 weeks", "12 weeks", "6 months", "12 months"]);
    for (const b of buttons) expect(b.tagName).toBe("BUTTON"); // focusable, Enter and Space activate
  });

  it("says which days it measured and how fresh the answer is", async () => {
    await populated();
    expect(document.querySelector(".pm-insights-asof")?.textContent).toMatch(
      /^Sep 7 – Oct 4 · as of .+ · numbers refresh every five minutes$/,
    );
  });
});

describe("states", () => {
  it("shows a skeleton, announced as loading, while the first answer is on its way", () => {
    authFetchMock.mockImplementation(() => new Promise(() => {}));
    render(<InsightsView projectId="p1" />, { wrapper });
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading insights");
    expect(screen.queryByRole("heading", { name: "Work finished" })).toBeNull();
  });

  it("is an empty state, not empty charts, for a project with no work", async () => {
    authFetchMock.mockImplementation(() => ok({ ...INSIGHTS, meta: { ...INSIGHTS.meta, itemCount: 0 } }));
    render(<InsightsView projectId="p1" />, { wrapper });
    expect(await screen.findByText("No insights yet.")).toBeInTheDocument();
    expect(screen.getByText("Charts appear once this project has some work in it.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Work finished" })).toBeNull();
  });

  it("words the empty state for the whole workspace differently", async () => {
    authFetchMock.mockImplementation(() => ok({ ...INSIGHTS, meta: { ...INSIGHTS.meta, itemCount: 0 } }));
    render(<InsightsView projectId={null} />, { wrapper });
    expect(await screen.findByText("Charts appear once there is some work in your projects.")).toBeInTheDocument();
  });

  it("says plainly when work exists but nothing has finished, instead of drawing empty charts", async () => {
    await populated("p1", {
      ...INSIGHTS,
      throughput: { total: 0, buckets: INSIGHTS.throughput.buckets.map((b) => ({ ...b, completed: 0 })) },
      createdVsCompleted: { created: 0, completed: 0, buckets: [] },
      cycleTime: { ...INSIGHTS.cycleTime, count: 0, p50: null, p85: null, p95: null },
      leadTime: { ...INSIGHTS.leadTime, count: 0, p50: null, p85: null, p95: null },
      workload: { estimateAvailable: false, assignees: [] },
      agingWip: { total: 0, items: [] },
    });
    expect(card("Work finished")).toHaveTextContent("Nothing was finished in this period.");
    expect(card("Work finished")).toHaveTextContent("No finished work in this period yet.");
    expect(card("Cycle time")).toHaveTextContent("Nothing to measure yet");
    expect(card("Workload")).toHaveTextContent("Nothing is open right now.");
    expect(card("Aging work in progress")).toHaveTextContent("Nothing is in progress right now.");
    // No percentile line with nothing measured.
    expect(within(card("Cycle time")).queryByText(/Half finish within/)).toBeNull();
  });

  it("offers a retry on a server failure, with the surface's one load-error wording", async () => {
    authFetchMock.mockImplementationOnce(() => fail(500, "boom")).mockImplementation(() => ok(INSIGHTS));
    render(<InsightsView projectId="p1" />, { wrapper });
    expect(await screen.findByText("Couldn't load insights.")).toBeInTheDocument();
    expect(screen.getByText("Check the appliance connection and try again.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { name: "Work finished" })).toBeInTheDocument();
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not dangle a retry for a project that is gone", async () => {
    authFetchMock.mockImplementation(() => fail(404, "project_not_found"));
    render(<InsightsView projectId="p1" />, { wrapper });
    expect(await screen.findByText("This project isn't available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("never prints the orchestrator's error code", async () => {
    authFetchMock.mockImplementation(() => fail(404, "project_not_found"));
    render(<InsightsView projectId="p1" />, { wrapper });
    await screen.findByText("This project isn't available.");
    expect(document.body.textContent).not.toMatch(/project_not_found/);
  });
});

describe("the Insights tab", () => {
  it("is one of a project's view tabs", () => {
    const onView = vi.fn();
    render(<ViewSwitcher view="board" onView={onView} />);
    const tab = screen.getByRole("tab", { name: "Insights" });
    expect(tab).toHaveAttribute("aria-selected", "false");
    fireEvent.click(tab);
    expect(onView).toHaveBeenCalledWith("insights");
  });
});
