// The work-item drawer's Time section (WARP-3526): entries and total, logging
// time, editing and deleting an entry, and the start/stop timer.
//
// The orchestrator is replaced by a stateful fake (src/__tests__/helpers/
// fake-time-api.ts), so each test asserts the request that went out and what the
// person then sees. Who MAY do what is the server's rule and is tested there;
// here the question is only which controls are drawn.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { PeopleContext } from "../bits";
import { makePerson } from "../config";
import type { PmWorkItem } from "../types";
import { TimeAccessProvider } from "./access";
import { TimeSection } from "./TimeSection";
import { addDays, browserTimeZone, ymdInZone } from "./format";
import { createFakeTimeApi, ITEM_9, worklog } from "@/__tests__/helpers/fake-time-api";

const api = vi.hoisted(() => ({
  handler: null as null | ((url: string, init?: RequestInit) => Promise<Response>),
}));
vi.mock("@/lib/auth", () => ({
  authFetch: (url: string, init?: RequestInit) => api.handler!(url, init),
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

const ITEM: PmWorkItem = {
  id: "w1",
  projectId: "p1",
  sequenceId: 1,
  key: "INBOX-1",
  name: "First task",
  descriptionHtml: null,
  stateId: "s1",
  state: { id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  priority: "none",
  parentId: null,
  cycleId: null,
  department: null,
  assignees: [],
  labels: [],
  startDate: null,
  dueDate: null,
  sortOrder: 1,
  completedAt: null,
  createdById: null,
  commentCount: 0,
  subItemCount: 0,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const NAMES: Record<string, string> = { "u-me": "Mia Member", "u-sam": "Sam Admin", "u-ana": "Ana Other" };

type Fake = ReturnType<typeof createFakeTimeApi>;
let fake: Fake;

function renderSection(who: { id: string; role: string } | null = { id: "u-me", role: "family" }) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <TimeAccessProvider user={who}>
        <PeopleContext.Provider value={(id) => makePerson(id, NAMES[id] ?? "Someone")}>
          <TimeSection item={ITEM} />
        </PeopleContext.Provider>
      </TimeAccessProvider>
    </SWRConfig>,
  );
}

const posts = (suffix: string) => fake.state.calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
const today = () => ymdInZone(new Date(), browserTimeZone());

beforeEach(() => {
  toast.mockReset();
  fake = createFakeTimeApi();
  api.handler = fake.handler;
});

describe("TimeSection — entries and total", () => {
  it("says so when no time has been logged", async () => {
    renderSection();
    expect(await screen.findByText("No time logged yet.")).toBeInTheDocument();
  });

  it("lists the entries newest first with who, how long and the note, and the total over all of them", async () => {
    fake.state.worklogs = [
      worklog({ id: "a", minutes: 90, userId: "u-me", startedAt: "2026-10-01T15:00:00.000Z", note: "Fixed the printer" }),
      worklog({ id: "b", minutes: 45, userId: "u-sam", startedAt: "2026-10-02T15:00:00.000Z" }),
    ];
    renderSection();
    const list = await screen.findByRole("list", { name: "Time entries" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("45m");
    expect(rows[0]).toHaveTextContent("Sam Admin");
    expect(rows[1]).toHaveTextContent("1h 30m");
    expect(rows[1]).toHaveTextContent("Mia Member");
    expect(rows[1]).toHaveTextContent("Fixed the printer");
    // The section header carries the total: 90 + 45 = 135 minutes.
    expect(screen.getByText("Time").parentElement).toHaveTextContent("2h 15m");
  });

  it("says when the list is shorter than the entries there are — the total still covers them all", async () => {
    fake.state.worklogs = [worklog({ id: "a", minutes: 30 }), worklog({ id: "b", minutes: 30, startedAt: "2026-10-01T15:00:00.000Z" })];
    fake.state.totalEntriesOverride = 5;
    renderSection();
    expect(await screen.findByText(/Showing the 2 most recent of 5 entries/)).toBeInTheDocument();
  });

  it("shows a quiet error and retries when the entries cannot be loaded", async () => {
    fake.state.failures = [{ match: /\/worklogs$/, method: "GET", status: 500, error: "boom" }];
    renderSection();
    expect(await screen.findByText(/Couldn't load time/)).toBeInTheDocument();
    fake.state.failures = [];
    fake.state.worklogs = [worklog({ id: "a", minutes: 20 })];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Time entries" })).toBeInTheDocument();
  });
});

describe("TimeSection — who sees which controls", () => {
  const mine = () => worklog({ id: "mine", minutes: 30, userId: "u-me", startedAt: "2026-10-01T15:00:00.000Z" });
  const theirs = () => worklog({ id: "theirs", minutes: 40, userId: "u-ana", startedAt: "2026-10-02T15:00:00.000Z" });

  it("draws nothing to press for a reader — not the timer, not the form, not an edit or delete", async () => {
    fake.state.worklogs = [mine(), theirs()];
    renderSection({ id: "u-me", role: "guest" });
    await screen.findByRole("list", { name: "Time entries" });
    expect(screen.queryByRole("button", { name: /start timer/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Log time" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete/ })).toBeNull();
    // …and it asks the timer endpoint nothing, since there is nothing to show.
    expect(fake.state.calls.some((c) => c.url === "/api/pm/timer")).toBe(false);
  });

  it("draws nothing to press when it is rendered with no one signed in", async () => {
    fake.state.worklogs = [mine()];
    renderSection(null);
    await screen.findByRole("list", { name: "Time entries" });
    expect(screen.queryByRole("button", { name: "Log time" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  it("lets a member change only their own entries", async () => {
    fake.state.worklogs = [mine(), theirs()];
    renderSection({ id: "u-me", role: "family" });
    const list = await screen.findByRole("list", { name: "Time entries" });
    const rows = within(list).getAllByRole("listitem");
    // newest first: theirs (Oct 2), then mine (Oct 1)
    expect(within(rows[0]).queryByRole("button", { name: /^Edit/ })).toBeNull();
    expect(within(rows[0]).queryByRole("button", { name: /^Delete/ })).toBeNull();
    expect(within(rows[1]).getByRole("button", { name: /^Edit/ })).toBeInTheDocument();
    expect(within(rows[1]).getByRole("button", { name: /^Delete/ })).toBeInTheDocument();
  });

  it.each(["owner", "admin"])("lets an %s change anybody's entries", async (role) => {
    fake.state.worklogs = [mine(), theirs()];
    renderSection({ id: "u-sam", role });
    const list = await screen.findByRole("list", { name: "Time entries" });
    for (const row of within(list).getAllByRole("listitem")) {
      expect(within(row).getByRole("button", { name: /^Edit/ })).toBeInTheDocument();
      expect(within(row).getByRole("button", { name: /^Delete/ })).toBeInTheDocument();
    }
  });
});

describe("TimeSection — logging time", () => {
  const fill = async (duration: string, note = "") => {
    await screen.findByText("No time logged yet.");
    fireEvent.change(screen.getByLabelText("Time spent"), { target: { value: duration } });
    if (note) fireEvent.change(screen.getByLabelText("Note (optional)"), { target: { value: note } });
  };

  it("logs what was typed — for today it leaves the start to the box — then shows it and clears the form", async () => {
    renderSection();
    await fill("1h 30m", "Fixed the printer");
    fireEvent.click(screen.getByRole("button", { name: "Log time" }));

    await waitFor(() => expect(posts("/worklogs")).toHaveLength(1));
    expect(posts("/worklogs")[0].body).toEqual({ minutes: 90, note: "Fixed the printer" });
    const list = await screen.findByRole("list", { name: "Time entries" });
    expect(list).toHaveTextContent("1h 30m");
    expect(list).toHaveTextContent("Fixed the printer");
    expect((screen.getByLabelText("Time spent") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Note (optional)") as HTMLInputElement).value).toBe("");
  });

  it("sends local midday as the start when the entry is for an earlier day", async () => {
    renderSection();
    await fill("45m");
    const day = addDays(today(), -2);
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: day } });
    fireEvent.click(screen.getByRole("button", { name: "Log time" }));

    await waitFor(() => expect(posts("/worklogs")).toHaveLength(1));
    const startedAt = new Date(posts("/worklogs")[0].body?.started_at as string);
    expect(startedAt.getHours()).toBe(12);
    expect(ymdInZone(startedAt, browserTimeZone())).toBe(day);
  });

  it.each(["", "abc", "0", "0m", "25h", "1.5", "1h30"])(
    "refuses %j with the duration help, focuses the field and sends nothing",
    async (input) => {
      renderSection();
      await fill(input);
      fireEvent.click(screen.getByRole("button", { name: "Log time" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Enter a time from 1 minute to 24 hours");
      expect(screen.getByLabelText("Time spent")).toHaveFocus();
      expect(screen.getByLabelText("Time spent")).toHaveAttribute("aria-invalid", "true");
      expect(posts("/worklogs")).toHaveLength(0);
    },
  );

  it("asks for a date when the date field is cleared, preserving the form and sending nothing", async () => {
    renderSection();
    await fill("30m", "kept");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Log time" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Pick a date.");
    expect(screen.getByLabelText("Time spent")).toHaveValue("30m");
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("kept");
    expect(posts("/worklogs")).toHaveLength(0);
  });

  it("refuses a date after today without asking the box", async () => {
    renderSection();
    await fill("30m");
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: addDays(today(), 3) } });
    fireEvent.click(screen.getByRole("button", { name: "Log time" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Time can't start in the future.");
    expect(posts("/worklogs")).toHaveLength(0);
  });

  it("shows the box's own refusal, in plain words, and keeps what was typed", async () => {
    fake.state.failures = [{ match: /\/worklogs$/, method: "POST", status: 409, error: "work_item_archived" }];
    renderSection();
    await fill("30m", "kept");
    fireEvent.click(screen.getByRole("button", { name: "Log time" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This item is archived, so time can't be added to it.");
    expect((screen.getByLabelText("Time spent") as HTMLInputElement).value).toBe("30m");
    expect((screen.getByLabelText("Note (optional)") as HTMLInputElement).value).toBe("kept");
  });

  it("carries the Write chip beside the button, as the comment composer does", async () => {
    renderSection();
    await screen.findByText("No time logged yet.");
    expect(screen.getByText("Write · confirm to apply")).toBeInTheDocument();
  });
});

describe("TimeSection — editing and deleting an entry", () => {
  it("edits minutes and note in place; the day is left alone unless it was changed", async () => {
    fake.state.worklogs = [worklog({ id: "mine", minutes: 30, userId: "u-me", note: "old", startedAt: "2026-10-01T15:00:00.000Z" })];
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));

    // The edit form sits in the entry's own row; the "Log time" form below has the same labels.
    const row = within(screen.getByRole("list", { name: "Time entries" })).getByRole("listitem");
    const duration = within(row).getByLabelText("Time spent") as HTMLInputElement;
    expect(duration.value).toBe("30m");
    fireEvent.change(duration, { target: { value: "50m" } });
    fireEvent.change(within(row).getByLabelText("Note (optional)"), { target: { value: "new" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fake.state.calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = fake.state.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe("/api/pm/worklogs/mine");
    expect(patch.body).toEqual({ minutes: 50, note: "new" }); // no started_at: the original start is kept
    const list = await screen.findByRole("list", { name: "Time entries" });
    expect(list).toHaveTextContent("50m");
    expect(list).toHaveTextContent("new");
  });

  it("moving an entry onto TODAY sends a start time — leaving it out would keep the entry on its old day", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3_600_000).toISOString();
    fake.state.worklogs = [worklog({ id: "mine", minutes: 30, userId: "u-me", startedAt: threeDaysAgo })];
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));
    const row = within(screen.getByRole("list", { name: "Time entries" })).getByRole("listitem");
    fireEvent.change(within(row).getByLabelText("Date"), { target: { value: today() } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fake.state.calls.some((c) => c.method === "PATCH")).toBe(true));
    const sent = fake.state.calls.find((c) => c.method === "PATCH")!.body as { started_at?: string; minutes?: number };
    expect(typeof sent.started_at).toBe("string");
    expect(ymdInZone(new Date(sent.started_at as string), browserTimeZone())).toBe(today());
    // …and it is not in the future, so the box will accept it.
    expect(new Date(sent.started_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("cancels an edit without sending anything", async () => {
    fake.state.worklogs = [worklog({ id: "mine", minutes: 30, userId: "u-me", startedAt: "2026-10-01T15:00:00.000Z" })];
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^Edit/ }));
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Back to the read-only row: no Save, the Edit button is back, nothing was sent.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Edit/ })).toBeInTheDocument();
    expect(fake.state.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("asks before deleting, names what goes, and deletes on confirm", async () => {
    fake.state.worklogs = [worklog({ id: "mine", minutes: 90, userId: "u-me", startedAt: "2026-10-01T15:00:00.000Z" })];
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^Delete/ }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete this entry?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("This removes 1h 30m from INBOX-1 and can't be undone.");
    expect(fake.state.calls.some((c) => c.method === "DELETE")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(fake.state.calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(fake.state.calls.find((c) => c.method === "DELETE")!.url).toBe("/api/pm/worklogs/mine");
    expect(await screen.findByText("No time logged yet.")).toBeInTheDocument();
  });

  it("deletes nothing when the dialog is cancelled", async () => {
    fake.state.worklogs = [worklog({ id: "mine", minutes: 90, userId: "u-me", startedAt: "2026-10-01T15:00:00.000Z" })];
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^Delete/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fake.state.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(screen.getByRole("list", { name: "Time entries" })).toHaveTextContent("1h 30m");
  });

  it("keeps the dialog open and says why when the box refuses the delete", async () => {
    fake.state.worklogs = [worklog({ id: "mine", minutes: 30, userId: "u-me", startedAt: "2026-10-01T15:00:00.000Z" })];
    fake.state.failures = [{ match: /\/worklogs\/mine$/, method: "DELETE", status: 403, error: "worklog_forbidden" }];
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: /^Delete/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("You can only change your own entries.", "error"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("TimeSection — the timer", () => {
  it("starts a timer on this item, then shows the running clock and a Stop button", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Start timer" }));

    await waitFor(() => expect(posts("/timer/start")).toHaveLength(1));
    expect(posts("/timer/start")[0].body).toEqual({ work_item_id: "w1" });
    expect(await screen.findByRole("button", { name: "Stop timer" })).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent(/^\d\d:\d\d:\d\d$/);
    expect(screen.getByText("Timer running")).toBeInTheDocument();
  });

  it("stops it and logs the time, in a toast and in the list", async () => {
    fake.state.timer = { userId: "u-me", workItemId: "w1", startedAt: new Date().toISOString(), workItem: { id: "w1", key: "INBOX-1", name: "First task", projectId: "p1", archived: false } };
    fake.state.stopMinutes = 25;
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Stop timer" }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith("Logged 25m on INBOX-1.", "success"));
    expect(await screen.findByRole("button", { name: "Start timer" })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Time entries" })).toHaveTextContent("25m");
  });

  it("says plainly when a forgotten timer was capped at a day", async () => {
    fake.state.timer = { userId: "u-me", workItemId: "w1", startedAt: "2026-09-30T09:00:00.000Z", workItem: { id: "w1", key: "INBOX-1", name: "First task", projectId: "p1", archived: false } };
    fake.state.stopMinutes = 1440;
    fake.state.stopCapped = true;
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Stop timer" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "The timer ran for more than 24 hours, so 24h was logged on INBOX-1. Edit the entry to correct it.",
        "info",
      ),
    );
  });

  it("offers to move a timer that is running on another item, and says what that does", async () => {
    fake.state.timer = { userId: "u-me", workItemId: "w9", startedAt: new Date().toISOString(), workItem: ITEM_9 };
    fake.state.stopMinutes = 25;
    renderSection();
    expect(await screen.findByText(/Timer running on/)).toHaveTextContent("INBOX-9. Starting here stops it and logs its time.");

    fireEvent.click(screen.getByRole("button", { name: "Start timer here" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Logged 25m on INBOX-9.", "info"));
    expect(await screen.findByRole("button", { name: "Stop timer" })).toBeInTheDocument();
  });

  it("says why a start was refused, in plain words", async () => {
    fake.state.failures = [{ match: /\/timer\/start$/, method: "POST", status: 409, error: "work_item_archived" }];
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Start timer" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("This item is archived, so time can't be added to it.", "error"));
    expect(screen.getByRole("button", { name: "Start timer" })).not.toBeDisabled();
  });
});
