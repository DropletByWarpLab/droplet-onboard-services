// WARP-3523 — My Work: sections with server counts, grouped by project with the
// List view's own row, paging, drawer, and every state.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import type { PmState, PmWorkItem } from "../types";
import type { PmMyWorkCounts, PmMyWorkProject, PmMyWorkSection } from "./types";

const todayRef = { current: "2026-10-03" };
vi.mock("../calendar/useToday", () => ({ useToday: () => todayRef.current }));

const state = {
  items: [] as PmWorkItem[],
  projects: [] as PmMyWorkProject[],
  counts: undefined as PmMyWorkCounts | undefined,
  total: 0,
  hasMore: false,
  error: undefined as unknown,
  isLoading: false,
  isValidating: false,
  isLoadingMore: false,
  loadMore: vi.fn(),
  mutate: vi.fn(),
  calls: [] as Array<[PmMyWorkSection, string]>,
};
vi.mock("./useMyWork", () => ({
  useMyWork: (section: PmMyWorkSection, today: string) => {
    state.calls.push([section, today]);
    return { ...state };
  },
}));

// The drawer has its own suite; here it only has to open, close and report a change.
vi.mock("../detail", () => ({
  DetailDrawer: ({ item, onClose, onChanged }: { item: PmWorkItem; onClose: () => void; onChanged: () => Promise<void> }) => (
    <div role="dialog" aria-label={`Drawer for ${item.key}`}>
      <span>{item.name}</span>
      <button onClick={onClose}>Close drawer</button>
      <button onClick={() => void onChanged()}>Changed</button>
    </div>
  ),
}));

import { MyWorkView } from "./MyWorkView";

const TODO: PmState = { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true };
const A: PmMyWorkProject = { id: "p1", name: "Onboarding", identifier: "INBOX", icon: null, color: "#6366f1" };
const B: PmMyWorkProject = { id: "p2", name: "Website", identifier: "WEB", icon: null, color: null };
const COUNTS: PmMyWorkCounts = { assigned: 12, created: 4, overdue: 3, dueThisWeek: 5 };

let seq = 0;
function item(projectId: string, over: Partial<PmWorkItem> = {}): PmWorkItem {
  seq += 1;
  return {
    id: `w${seq}`,
    projectId,
    sequenceId: seq,
    key: `${projectId === "p1" ? "INBOX" : "WEB"}-${seq}`,
    name: `Task ${seq}`,
    descriptionHtml: null,
    stateId: TODO.id,
    state: TODO,
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: null,
    sortOrder: seq,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function load(items: PmWorkItem[], projects: PmMyWorkProject[], over: Partial<typeof state> = {}) {
  Object.assign(
    state,
    { items, projects, counts: COUNTS, total: items.length, hasMore: false, error: undefined, isLoading: false, isValidating: false, isLoadingMore: false },
    over,
  );
}

beforeEach(() => {
  seq = 0;
  todayRef.current = "2026-10-03";
  state.items = [];
  state.projects = [];
  state.counts = undefined;
  state.total = 0;
  state.hasMore = false;
  state.error = undefined;
  state.isLoading = false;
  state.isValidating = false;
  state.isLoadingMore = false;
  state.loadMore = vi.fn();
  state.mutate = vi.fn();
  state.calls = [];
});

describe("sections", () => {
  it("offers Assigned, Created, Overdue and Due this week with the server's counts — and nothing else", () => {
    load([item("p1")], [A]);
    render(<MyWorkView />);
    const group = screen.getByRole("group", { name: "My work sections" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Assigned12", "Created4", "Overdue3", "Due this week5"]);
    expect(screen.queryByRole("button", { name: /Mentioned|Watching/ })).toBeNull();
  });

  it("starts on Assigned and asks the server for the section the user picks, with the viewer's day", () => {
    load([item("p1")], [A]);
    render(<MyWorkView />);
    expect(screen.getByRole("button", { name: /^Assigned/ })).toHaveAttribute("aria-current", "true");
    expect(state.calls[0]).toEqual(["assigned", "2026-10-03"]);
    fireEvent.click(screen.getByRole("button", { name: /^Overdue/ }));
    expect(state.calls[state.calls.length - 1]).toEqual(["overdue", "2026-10-03"]);
    expect(screen.getByRole("button", { name: /^Overdue/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /^Assigned/ })).not.toHaveAttribute("aria-current");
  });

  it("explains the window for 'Due this week' from the viewer's day", () => {
    load([item("p1")], [A]);
    render(<MyWorkView />);
    fireEvent.click(screen.getByRole("button", { name: /^Due this week/ }));
    expect(screen.getByText(/Assigned to you and due Oct 3 – Oct 9\./)).toBeInTheDocument();
  });

  it("keeps the last counts while another section's first page loads, instead of flashing to dashes", () => {
    load([item("p1")], [A]);
    const { rerender } = render(<MyWorkView />);
    fireEvent.click(screen.getByRole("button", { name: /^Overdue/ }));
    // The newly selected section has no data yet: counts are undefined for a moment.
    load([], [], { counts: undefined, isLoading: true });
    rerender(<MyWorkView />);
    const chips = within(screen.getByRole("group", { name: "My work sections" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Assigned12", "Created4", "Overdue3", "Due this week5"]);
  });

  it("shows a dash instead of a number until the counts have loaded", () => {
    load([], [], { counts: undefined, isLoading: true });
    render(<MyWorkView />);
    expect(within(screen.getByRole("group", { name: "My work sections" })).getAllByRole("button")[0].textContent).toBe("Assigned–");
  });
});

describe("refresh", () => {
  it("has its own Refresh, which revalidates this view's lists", () => {
    load([item("p1")], [A]);
    render(<MyWorkView />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });

  it("is there when the list is empty or failed too, and shows a busy state while a request is in flight", () => {
    load([], [], { counts: { assigned: 0, created: 0, overdue: 0, dueThisWeek: 0 } });
    const { rerender } = render(<MyWorkView />);
    expect(screen.getByRole("button", { name: "Refresh" })).not.toHaveAttribute("aria-busy");
    load([], [], { error: new Error("down"), counts: undefined, isValidating: true });
    rerender(<MyWorkView />);
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(refresh).toHaveClass("spinning");
  });
});

describe("grouping and rows", () => {
  it("groups items by project in the server's order, with name, key and count, using the List row", () => {
    const items = [item("p1"), item("p1"), item("p2")];
    load(items, [A, B]);
    render(<MyWorkView />);
    const onboarding = screen.getByRole("region", { name: "Onboarding" });
    expect(within(onboarding).getByText("INBOX")).toBeInTheDocument();
    expect(within(onboarding).getAllByRole("button")).toHaveLength(2);
    expect(within(onboarding).getByRole("button", { name: "INBOX-1, Task 1" })).toBeInTheDocument();
    const website = screen.getByRole("region", { name: "Website" });
    expect(within(website).getByRole("button", { name: "WEB-3, Task 3" })).toBeInTheDocument();
    const order = screen.getAllByRole("heading", { level: 3 }).map((h) => h.querySelector(".name")?.textContent);
    expect(order).toEqual(["Onboarding", "Website"]);
  });

  it("still groups an item whose project the response did not list", () => {
    load([item("p9")], []);
    render(<MyWorkView />);
    expect(screen.getByRole("region", { name: "Project" })).toBeInTheDocument();
  });

  it("says how many of the total are showing and loads more on request", () => {
    load([item("p1"), item("p1")], [A], { total: 5, hasMore: true });
    render(<MyWorkView />);
    expect(screen.getByText("Showing 2 of 5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(state.loadMore).toHaveBeenCalledTimes(1);
  });

  it("disables the button while the next page loads, and hides it at the end", () => {
    load([item("p1")], [A], { total: 5, hasMore: true, isLoadingMore: true });
    const { rerender } = render(<MyWorkView />);
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
    load([item("p1")], [A], { total: 1, hasMore: false });
    rerender(<MyWorkView />);
    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
    expect(screen.getByText("Showing 1 of 1")).toBeInTheDocument();
  });

  it("announces the size of the section for assistive tech", () => {
    load([item("p1"), item("p1")], [A], { total: 2 });
    render(<MyWorkView />);
    expect(screen.getByRole("status")).toHaveTextContent("2 items in Assigned");
  });
});

describe("drawer", () => {
  it("opens the clicked item, closes it, and refreshes it from the revalidated data after a change", async () => {
    const a = item("p1");
    load([a], [A]);
    state.mutate = vi.fn(async () => [{ items: [{ ...a, name: "Renamed elsewhere" }] }]);
    render(<MyWorkView />);
    fireEvent.click(screen.getByRole("button", { name: "INBOX-1, Task 1" }));
    const drawer = screen.getByRole("dialog", { name: "Drawer for INBOX-1" });
    expect(within(drawer).getByText("Task 1")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(drawer).getByRole("button", { name: "Changed" }));
    });
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole("dialog")).getByText("Renamed elsewhere")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("states", () => {
  it("loading is a skeleton, not a spinner", () => {
    load([], [], { isLoading: true, counts: undefined });
    const { container } = render(<MyWorkView />);
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(container.querySelector(".pm-skel")).toBeTruthy();
  });

  it("an error offers Try again, which revalidates", () => {
    load([], [], { error: new Error("down"), counts: undefined });
    render(<MyWorkView />);
    expect(screen.getByText("Couldn't load your work.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(state.mutate).toHaveBeenCalledTimes(1);
  });

  it("keeps showing what it has when a later page fails", () => {
    load([item("p1")], [A], { error: new Error("page 2 failed") });
    render(<MyWorkView />);
    expect(screen.getByRole("button", { name: "INBOX-1, Task 1" })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your work.")).toBeNull();
  });

  it.each([
    ["assigned", "Nothing assigned to you.", "Items assigned to you will show up here."],
    ["created", "Nothing created by you.", "Items you create will show up here."],
    ["overdue", "Nothing overdue.", "Items assigned to you that pass their due date will show up here."],
    ["due_this_week", "Nothing due this week.", "Items assigned to you with a due date in the next 7 days will show up here."],
  ] as const)("an empty %s section has its own calm copy", (id, heading, body) => {
    load([], [], { counts: { assigned: 0, created: 0, overdue: 0, dueThisWeek: 0 } });
    render(<MyWorkView />);
    const chip = { assigned: /^Assigned/, created: /^Created/, overdue: /^Overdue/, due_this_week: /^Due this week/ }[id];
    fireEvent.click(screen.getByRole("button", { name: chip }));
    expect(screen.getByText(heading)).toBeInTheDocument();
    expect(screen.getByText(body)).toBeInTheDocument();
    expect(`${heading} ${body}`).not.toMatch(/!/);
  });
});
