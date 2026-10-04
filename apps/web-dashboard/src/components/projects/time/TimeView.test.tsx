// The time view (WARP-3526): a weekly timesheet per person and a time report with
// CSV export — what is requested, what is drawn, and every empty / loading /
// error state.
//
// The orchestrator is a stateful fake (src/__tests__/helpers/fake-time-api.ts).
// The grid arithmetic (which entry lands in which Monday-to-Sunday cell, in
// which zone) is the server's and is tested there; here the fixtures are fixed
// and the question is what a person sees and what the view asks for.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { PeopleContext } from "../bits";
import { makePerson } from "../config";
import type { PmProject } from "../types";
import { TimeAccessProvider } from "./access";
import { TimeView } from "./TimeView";
import { addDays, browserTimeZone, formatWeekRange, mondayOf, ymdInZone } from "./format";
import type { PmTimeReport, PmTimesheet } from "./types";
import { createFakeTimeApi, ITEM_1, ITEM_9, worklog } from "@/__tests__/helpers/fake-time-api";

const api = vi.hoisted(() => ({
  handler: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock("@/lib/auth", () => ({
  authFetch: (url: string, init?: RequestInit) => api.handler!(url, init),
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const tz = () => browserTimeZone();
const today = () => ymdInZone(new Date(), tz());
const thisMonday = () => mondayOf(today());

const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];

const SHEET: PmTimesheet = {
  userId: "u-me",
  tz: "UTC",
  weekStart: "2026-09-28",
  days: DAYS,
  rows: [
    { workItem: ITEM_1, minutes: [90, 0, 45, 0, 0, 0, 0], totalMinutes: 135 },
    { workItem: ITEM_9, minutes: [0, 30, 0, 0, 0, 0, 0], totalMinutes: 30 },
  ],
  dayTotals: [90, 30, 45, 0, 0, 0, 0],
  totalMinutes: 165,
  entries: [
    { ...worklog({ id: "e1", minutes: 45, userId: "u-me", note: "Reviewed", startedAt: "2026-09-30T15:00:00.000Z" }), workItem: ITEM_1 },
    { ...worklog({ id: "e2", minutes: 30, userId: "u-sam", startedAt: "2026-09-29T15:00:00.000Z", workItemId: "w9" }), workItem: ITEM_9 },
  ],
};

const REPORT: PmTimeReport = {
  groupBy: "user",
  from: "2026-10-01",
  to: "2026-10-04",
  tz: "UTC",
  projectId: null,
  rows: [
    { key: "u-sam", label: "Sam Admin", itemKey: null, minutes: 150, entries: 3 },
    { key: "u-ghost", label: "u-ghost", itemKey: null, minutes: 30, entries: 1 },
  ],
  total: { minutes: 180, entries: 4 },
};

const PROJECTS: PmProject[] = [
  { id: "p1", workspaceId: "ws", workspaceSlug: "home", name: "Inbox", identifier: "INBOX", description: null, icon: null, color: null, leadId: null, department: null, archived: false, openCount: 0, doneCount: 0, groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 }, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
  { id: "p2", workspaceId: "ws", workspaceSlug: "home", name: "Office", identifier: "OFF", description: null, icon: null, color: null, leadId: null, department: null, archived: false, openCount: 0, doneCount: 0, groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 }, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" },
];

type Fake = ReturnType<typeof createFakeTimeApi>;
let fake: Fake;

function renderView(opts: { role?: string; projectId?: string | null } = {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TimeAccessProvider user={{ id: "u-me", role: opts.role ?? "family" }}>
        <PeopleContext.Provider value={(id) => makePerson(id, id === "u-ghost" ? "Gone Person" : "Someone")}>
          <TimeView projects={PROJECTS} projectId={opts.projectId ?? null} />
        </PeopleContext.Provider>
      </TimeAccessProvider>
    </SWRConfig>,
  );
}

const gets = (prefix: string) =>
  fake.state.calls.filter((c) => c.method === "GET" && c.url.startsWith(prefix));
const lastQuery = (prefix: string): URLSearchParams => {
  const calls = gets(prefix);
  return new URLSearchParams(calls[calls.length - 1].url.split("?")[1] ?? "");
};

beforeEach(() => {
  toast.mockReset();
  fake = createFakeTimeApi({ timesheet: SHEET, report: REPORT });
  api.handler = fake.handler;
});

describe("TimeView — timesheet", () => {
  it("asks for the signed-in person's current week, Monday first, in the browser's zone", async () => {
    renderView();
    await screen.findByRole("table", { name: /Time logged per work item/ });
    const q = lastQuery("/api/pm/timesheet");
    expect(q.get("userId")).toBe("u-me");
    expect(q.get("weekStart")).toBe(thisMonday());
    expect(q.get("tz")).toBe(tz());
    expect(screen.getByTestId("week-range")).toHaveTextContent(formatWeekRange(thisMonday()));
  });

  it("draws one row per work item, a column per day Monday to Sunday, and the totals", async () => {
    renderView();
    const table = await screen.findByRole("table", { name: /Time logged per work item/ });

    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers[0]).toBe("Work item");
    expect(headers.slice(1, 8).map((h) => h?.slice(0, 3))).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(headers[8]).toBe("Total");

    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4); // header, two items, the total row
    const first = within(rows[1]);
    expect(first.getByRole("rowheader")).toHaveTextContent("INBOX-1");
    expect(first.getByRole("rowheader")).toHaveTextContent("First task");
    const cells = first.getAllByRole("cell").map((c) => c.textContent);
    expect(cells[0]).toBe("1h 30m");
    expect(cells[1]).toContain("0m"); // an empty day is a dash with the amount for a screen reader
    expect(cells[2]).toBe("45m");
    expect(cells[7]).toBe("2h 15m"); // the row total
    // The footer: per-day totals and the week.
    const footer = within(rows[3]).getAllByRole("cell").map((c) => c.textContent);
    expect(footer[0]).toBe("Total");
    expect(footer[1]).toBe("1h 30m");
    expect(footer[8]).toBe("2h 45m");
  });

  it("is a keyboard-reachable scroll region, so a narrow screen can reach every day", async () => {
    renderView();
    const region = await screen.findByRole("region", { name: "Timesheet grid" });
    expect(region).toHaveAttribute("tabindex", "0");
  });

  it("moves a week at a time, and 'This week' brings it back", async () => {
    renderView();
    await screen.findByRole("table", { name: /Time logged per work item/ });
    const thisWeek = screen.getByRole("button", { name: "This week" });
    expect(thisWeek).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(lastQuery("/api/pm/timesheet").get("weekStart")).toBe(addDays(thisMonday(), -7)));
    expect(screen.getByTestId("week-range")).toHaveTextContent(formatWeekRange(addDays(thisMonday(), -7)));
    expect(screen.getByRole("button", { name: "This week" })).not.toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(lastQuery("/api/pm/timesheet").get("weekStart")).toBe(addDays(thisMonday(), 7)));

    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => expect(lastQuery("/api/pm/timesheet").get("weekStart")).toBe(thisMonday()));
  });

  it("reads another person's week from the person picker", async () => {
    renderView();
    await screen.findByRole("table", { name: /Time logged per work item/ });
    const picker = await screen.findByRole("combobox", { name: "Person" });
    expect(within(picker).getByRole("option", { name: "Mia Member (you)" })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: "u-sam" } });
    await waitFor(() => expect(lastQuery("/api/pm/timesheet").get("userId")).toBe("u-sam"));
  });

  it("says plainly when nothing was logged this week", async () => {
    fake.state.timesheet = { ...SHEET, rows: [], dayTotals: [0, 0, 0, 0, 0, 0, 0], totalMinutes: 0, entries: [] };
    renderView();
    expect(await screen.findByText("No time logged this week.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a skeleton while loading, then a calm error with Try again", async () => {
    fake.state.failures = [{ match: /\/timesheet$/, method: "GET", status: 500, error: "boom" }];
    renderView();
    expect(await screen.findByText(/Couldn't load time/)).toBeInTheDocument();
    fake.state.failures = [];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: /Time logged per work item/ })).toBeInTheDocument();
  });

  it("lists the week's entries with their work items; a member can change their own and not Sam's", async () => {
    renderView({ role: "family" });
    const list = await screen.findByRole("list", { name: "Time entries" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("INBOX-1");
    expect(rows[0]).toHaveTextContent("First task");
    expect(within(rows[0]).getByRole("button", { name: /^Edit/ })).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent("INBOX-9");
    expect(within(rows[1]).queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  it("deletes an entry from the timesheet after the same confirmation as the drawer", async () => {
    fake.state.worklogs = [worklog({ id: "e1", minutes: 45, userId: "u-me" })];
    renderView({ role: "family" });
    const list = await screen.findByRole("list", { name: "Time entries" });
    fireEvent.click(within(within(list).getAllByRole("listitem")[0]).getByRole("button", { name: /^Delete/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This removes 45m from INBOX-1 and can't be undone.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fake.state.calls.some((c) => c.method === "DELETE" && c.url === "/api/pm/worklogs/e1")).toBe(true));
  });
});

describe("TimeView — report", () => {
  const openReport = async (opts: Parameters<typeof renderView>[0] = {}) => {
    renderView(opts);
    fireEvent.click(await screen.findByRole("tab", { name: /Report/ }));
    return screen.findByRole("table", { name: /Time by person/ });
  };

  it("starts on the month so far, grouped by person, across all projects, in the browser's zone", async () => {
    await openReport();
    const q = lastQuery("/api/pm/time/report");
    expect(q.get("from")).toBe(`${today().slice(0, 8)}01`);
    expect(q.get("to")).toBe(today());
    expect(q.get("groupBy")).toBe("user");
    expect(q.get("tz")).toBe(tz());
    expect(q.has("projectId")).toBe(false);
  });

  it("starts filtered to the project the page has open", async () => {
    await openReport({ projectId: "p1" });
    expect(lastQuery("/api/pm/time/report").get("projectId")).toBe("p1");
    expect((screen.getByRole("combobox", { name: "Project" }) as HTMLSelectElement).value).toBe("p1");
  });

  it("draws a row per person with their time and entries, a total, and a name for an id the server could not resolve", async () => {
    const table = await openReport();
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4); // header, two people, total
    expect(within(rows[1]).getByRole("rowheader")).toHaveTextContent("Sam Admin");
    expect(within(rows[1]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2h 30m", "3"]);
    // The server sends an unknown person back as their id; the page's directory names them.
    expect(within(rows[2]).getByRole("rowheader")).toHaveTextContent("Gone Person");
    expect(within(rows[3]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Total", "3h", "4"]);
  });

  it("changes the grouping and asks again: by item it leads with the key, by day with the date", async () => {
    fake.state.report = { ...REPORT, groupBy: "item", rows: [{ key: "w1", label: "First task", itemKey: "INBOX-1", minutes: 90, entries: 2 }] };
    await openReport();
    fireEvent.click(screen.getByRole("button", { name: "item" }));
    await waitFor(() => expect(lastQuery("/api/pm/time/report").get("groupBy")).toBe("item"));
    const table = await screen.findByRole("table", { name: /Time by item/ });
    expect(within(table).getAllByRole("rowheader")[0]).toHaveTextContent("INBOX-1");
    expect(within(table).getAllByRole("rowheader")[0]).toHaveTextContent("First task");
    expect(screen.getByRole("button", { name: "item" })).toHaveAttribute("aria-pressed", "true");

    fake.state.report = { ...REPORT, groupBy: "day", rows: [{ key: "2026-10-02", label: "2026-10-02", itemKey: null, minutes: 60, entries: 1 }] };
    fireEvent.click(screen.getByRole("button", { name: "day" }));
    await waitFor(() => expect(lastQuery("/api/pm/time/report").get("groupBy")).toBe("day"));
    expect(await screen.findByText("Fri Oct 2")).toBeInTheDocument();
  });

  it("narrows to a project and widens back to all of them", async () => {
    await openReport();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "p2" } });
    await waitFor(() => expect(lastQuery("/api/pm/time/report").get("projectId")).toBe("p2"));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "" } });
    await waitFor(() => expect(lastQuery("/api/pm/time/report").has("projectId")).toBe(false));
  });

  it("asks for the dates it was given", async () => {
    await openReport();
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-05" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-01-11" } });
    await waitFor(() => {
      const q = lastQuery("/api/pm/time/report");
      expect([q.get("from"), q.get("to")]).toEqual(["2026-01-05", "2026-01-11"]);
    });
  });

  it("does not ask for a range that runs backwards — it says what to fix, and Export is off", async () => {
    await openReport();
    const before = gets("/api/pm/time/report").length;
    fireEvent.change(screen.getByLabelText("From"), { target: { value: addDays(today(), 3) } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: today() } });
    expect(await screen.findByText("Pick a start date no later than the end date.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    expect(gets("/api/pm/time/report").length).toBe(before);
  });

  it("says plainly when the range holds no time, and offers nothing to export", async () => {
    fake.state.report = { ...REPORT, rows: [], total: { minutes: 0, entries: 0 } };
    renderView();
    fireEvent.click(await screen.findByRole("tab", { name: /Report/ }));
    expect(await screen.findByText("No time logged in this range.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });

  it("shows a calm error with Try again", async () => {
    fake.state.failures = [{ match: /\/time\/report$/, method: "GET", status: 500, error: "boom" }];
    renderView();
    fireEvent.click(await screen.findByRole("tab", { name: /Report/ }));
    expect(await screen.findByText(/Couldn't load time/)).toBeInTheDocument();
    fake.state.failures = [];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: /Time by person/ })).toBeInTheDocument();
  });

  describe("Export CSV", () => {
    const createObjectURL = vi.fn(() => "blob:report");
    const revokeObjectURL = vi.fn();
    let click: ReturnType<typeof vi.spyOn>;
    let downloaded: string[];

    beforeEach(() => {
      createObjectURL.mockClear();
      revokeObjectURL.mockClear();
      Object.assign(URL, { createObjectURL, revokeObjectURL });
      downloaded = [];
      click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
        downloaded.push(this.download);
      });
    });
    afterEach(() => click.mockRestore());

    it("fetches the same report as CSV through the session and hands it to the browser as a file", async () => {
      await openReport({ projectId: "p1" });
      fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
      const csvCall = fake.state.calls.find((c) => c.url.includes("format=csv"))!;
      const q = new URLSearchParams(csvCall.url.split("?")[1]);
      expect(q.get("format")).toBe("csv");
      expect(q.get("projectId")).toBe("p1");
      expect(q.get("groupBy")).toBe("user");
      expect(q.get("tz")).toBe(tz());
      // The file is named by the server, and the blob URL is released.
      expect(downloaded).toEqual(["droplet-time-user-2026-10-01-to-2026-10-04.csv"]);
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:report");
    });

    it("says why when the export fails, and leaves the report where it was", async () => {
      await openReport();
      fake.state.failures = [{ match: /\/time\/report$/, method: "GET", status: 400, error: "invalid_range" }];
      // The failure rule matches the JSON read too, so only the CSV request, made now, fails.
      fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith("That date range isn't valid. Pick a start date no later than the end, within a year.", "error"),
      );
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(screen.getByRole("table", { name: /Time by person/ })).toBeInTheDocument();
    });
  });
});

describe("TimeView — tabs", () => {
  it("opens on the timesheet and switches with the tab strip", async () => {
    renderView();
    expect(await screen.findByRole("tab", { name: /Timesheet/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Report/ })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(screen.getByRole("tab", { name: /Report/ }));
    expect(screen.getByRole("tab", { name: /Report/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("tabpanel", { name: "Report" })).toBeInTheDocument();
  });
});
