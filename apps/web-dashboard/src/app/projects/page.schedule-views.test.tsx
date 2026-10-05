/**
 * /projects wiring for the scheduling views (WARP-3523): Calendar and Timeline are
 * project views behind the same switcher and the same filters as Board and List;
 * My work is a cross-project view reached from the index, not a nav row. The
 * views themselves have their own suites — here they are stubs that record the
 * props the page hands them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import React from "react";
import { buildPmPath, parsePmUrl, type PmUrlState } from "@droplet/shared-types";

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children, actions }: any) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => React.createElement("a", { href, ...props }, children),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const role = { current: "owner" };
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "ada", displayName: "Ada", role: role.current }, isLoading: false }),
  authFetch: vi.fn(),
}));
vi.mock("@/lib/hooks/useAppCapabilities", () => ({ useAppCapabilities: () => ({ projects: true }) }));

const refreshQuery = vi.fn<() => Promise<void>>(async () => undefined);
const createView = vi.fn();
const updateView = vi.fn();
const PROJECT = { id: "p1", name: "Onboarding", identifier: "INBOX", archived: false, openCount: 3, doneCount: 0, groups: {}, department: null };
const item = (n: number, over: Record<string, unknown> = {}) => ({
  id: `w${n}`,
  projectId: "p1",
  key: `INBOX-${n}`,
  name: n === 1 ? "Alpha task" : `Task ${n}`,
  stateId: "s1",
  state: { id: "s1", group: "unstarted", name: "Todo", color: null },
  priority: "none",
  assignees: [],
  labels: [],
  department: null,
  startDate: null,
  dueDate: null,
  sortOrder: n,
  updatedAt: `2026-10-0${n}T00:00:00.000Z`,
  ...over,
});
const ITEMS = [item(1), item(2), item(3)];
const queryState = {
  url: "",
  items: ITEMS,
  savedViews: [] as any[],
  calls: [] as Array<{ enabled: boolean; projectId: string | null; filter: unknown }>,
  navigations: [] as Array<{ path: string; mode: string }>,
};

// The real hook's parser/builder contract is covered in useProjectsUrl.test;
// model navigation landing here so this suite exercises the real merged page.
vi.mock("@/components/projects/useProjectsUrl", () => ({
  useProjectsUrl: () => {
    const [, navigate] = React.useState(0);
    const state = parsePmUrl(new URLSearchParams(queryState.url));
    const go = (patch: Partial<Required<PmUrlState>>, mode: string) => {
      const path = buildPmPath({ ...state, ...patch });
      queryState.navigations.push({ path, mode });
      queryState.url = path.split("?")[1] ?? "";
      navigate((n) => n + 1);
    };
    return { state, go, openItem: (key: string) => go({ item: key }, "push"), closeItem: () => go({ item: null }, "replace") };
  },
}));

vi.mock("@/components/projects/usePm", () => ({
  useProjects: () => ({ projects: [PROJECT], error: undefined, isLoading: false, mutate: vi.fn() }),
  useSummary: () => ({ summary: undefined, mutate: vi.fn() }),
  useProjectStates: () => ({ states: [] }),
  useProjectLabels: () => ({ labels: [] }),
  useWorkItemQuery: (args: { enabled: boolean; projectId: string | null; filter: unknown }) => {
    queryState.calls.push(args);
    return {
      items: args.enabled ? queryState.items : undefined,
      total: queryState.items.length,
      counts: { all: ITEMS.length },
      error: undefined,
      refresh: refreshQuery,
    };
  },
  useWorkItemByKey: () => ({ item: undefined, error: undefined, mutate: vi.fn() }),
  useSavedViews: () => ({ views: queryState.savedViews, error: undefined, isLoading: false, mutate: vi.fn() }),
  usePeople: () => ({ person: (id: string) => ({ id, name: "Tester", initials: "T", tone: 1 }), people: [] }),
  useDepartments: () => ({ departments: undefined }),
  pmActions: () => ({}),
  viewActions: () => ({ create: createView, update: updateView, remove: vi.fn() }),
  PmRequestError: class extends Error {},
}));

vi.mock("@/components/projects/IndexView", () => ({
  IndexView: ({ projects, onOpenProject }: any) => (
    <div>
      {projects?.map((p: any) => (
        <button key={p.id} onClick={() => onOpenProject(p)}>
          open {p.name}
        </button>
      ))}
    </div>
  ),
}));

const calendarProps = { current: null as any };
const timelineProps = { current: null as any };
vi.mock("@/components/projects/calendar/CalendarView", () => ({
  CalendarView: (p: any) => {
    calendarProps.current = p;
    return <div data-testid="calendar" />;
  },
}));
vi.mock("@/components/projects/timeline/TimelineView", () => ({
  TimelineView: (p: any) => {
    timelineProps.current = p;
    return <div data-testid="timeline" />;
  },
}));
vi.mock("@/components/projects/mywork/MyWorkView", () => ({ MyWorkView: () => <div data-testid="my-work" /> }));

import ProjectsPage from "./page";

function openProject() {
  const page = render(<ProjectsPage />);
  fireEvent.click(screen.getByRole("button", { name: "open Onboarding" }));
  return page;
}

beforeEach(() => {
  role.current = "owner";
  calendarProps.current = null;
  timelineProps.current = null;
  refreshQuery.mockReset().mockResolvedValue(undefined);
  createView.mockReset();
  updateView.mockReset();
  queryState.url = "";
  queryState.items = ITEMS;
  queryState.savedViews = [];
  queryState.calls = [];
  queryState.navigations = [];
});

describe("view switcher", () => {
  it("offers Calendar and Timeline between List and Cycles", () => {
    openProject();
    const tabs = within(screen.getByRole("tablist", { name: "View" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Board", "List", "Calendar", "Timeline", "Cycles", "Modules"]);
  });

  it("Calendar gets the server query's items, role and an awaited revalidation", async () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
    expect(screen.getByTestId("calendar")).toBeInTheDocument();
    expect(calendarProps.current.items.map((i: any) => i.key)).toEqual(["INBOX-1", "INBOX-2", "INBOX-3"]);
    expect(calendarProps.current.readOnly).toBe(false);
    expect(calendarProps.current.domain).toBe("populated");
    let complete!: () => void;
    refreshQuery.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve; }));
    let refreshed = false;
    const changed = calendarProps.current.onChanged().then(() => { refreshed = true; });
    expect(refreshQuery).toHaveBeenCalledTimes(1);
    expect(refreshed).toBe(false);
    complete();
    await changed;
    expect(refreshed).toBe(true);
    expect(queryState.navigations.at(-1)).toEqual({ path: "/projects?p=INBOX&view=calendar", mode: "push" });
  });

  it("Calendar sends the URL filter to the query and shows its answer without filtering it again", async () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
    // The server answer deliberately differs from a naive name substring
    // match: the page must trust the query, rather than applying local search.
    queryState.items = [ITEMS[1]];
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "alpha" } });
    await waitFor(() => expect(queryState.calls.at(-1)?.filter).toEqual({ field: "text", op: "contains", value: "alpha" }));
    expect(queryState.navigations.at(-1)).toEqual({ path: "/projects?p=INBOX&view=calendar&f=text.contains:alpha", mode: "replace" });
    expect(calendarProps.current.items.map((i: any) => i.key)).toEqual(["INBOX-2"]);
    expect(screen.getByRole("group", { name: "Views" })).toBeInTheDocument();
  });

  it("Timeline gets the project and, with no filter, no id filter at all", () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
    expect(timelineProps.current.projectId).toBe("p1");
    expect(timelineProps.current.visibleIds).toBeNull();
    expect(typeof timelineProps.current.revision).toBe("string");
  });

  it("Timeline gets the ids the filters admit once one is active, and a new revision when the data changes", async () => {
    const { rerender } = openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    queryState.items = [ITEMS[0]];
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "alpha" } });
    await waitFor(() => expect(timelineProps.current.visibleIds).not.toBeNull());
    expect([...timelineProps.current.visibleIds]).toEqual(["w1"]);
    const revision = timelineProps.current.revision;
    // Same result size and timestamp, different admitted item: a max-time-only
    // revision would fail to tell the timeline it needs to refresh.
    queryState.items = [item(2, { updatedAt: ITEMS[0].updatedAt })];
    rerender(<ProjectsPage />);
    expect([...timelineProps.current.visibleIds]).toEqual(["w2"]);
    expect(timelineProps.current.revision).not.toBe(revision);
    expect(screen.getByLabelText("Search work items")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Views" })).toBeInTheDocument();
  });

  it("a read-only role is told so (no drag, no resize, no nudge)", () => {
    role.current = "member";
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
    expect(calendarProps.current.readOnly).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(timelineProps.current.readOnly).toBe(true);
  });
});

describe("My work", () => {
  it("opens from the Projects index as its own titled view, with no project tabs", () => {
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /My work/ }));
    expect(screen.getByTestId("my-work")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "My work" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "View" })).toBeNull();
    // No project is open, so no project-scoped actions and no board refresh.
    expect(screen.queryByRole("button", { name: /New item/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(queryState.navigations.at(-1)).toEqual({ path: "/projects?view=my-work", mode: "push" });
    expect(queryState.calls.at(-1)?.enabled).toBe(false);
  });

  it("a way back to all projects", () => {
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /My work/ }));
    fireEvent.click(screen.getByRole("button", { name: /All projects/ }));
    expect(screen.queryByTestId("my-work")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(queryState.navigations.at(-1)).toEqual({ path: "/projects", mode: "push" });
  });

  it("restores My work from a direct URL and browser Back or Forward", () => {
    queryState.url = "view=my-work";
    const { rerender } = render(<ProjectsPage />);
    expect(screen.getByTestId("my-work")).toBeInTheDocument();
    queryState.url = "p=INBOX&view=calendar";
    rerender(<ProjectsPage />);
    expect(screen.getByTestId("calendar")).toBeInTheDocument();
    expect(screen.queryByTestId("my-work")).toBeNull();
    queryState.url = "view=my-work";
    rerender(<ProjectsPage />);
    expect(screen.getByTestId("my-work")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "View" })).toBeNull();
  });
});

describe("saved scheduling layouts", () => {
  it.each([
    ["Calendar", "calendar", "CALENDAR"],
    ["Timeline", "timeline", "TIMELINE"],
  ])("saves and updates the %s layout with the active server filter", async (label, tab, layout) => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: label }));
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "alpha" } });
    await waitFor(() => expect(queryState.calls.at(-1)?.filter).toEqual({ field: "text", op: "contains", value: "alpha" }));
    const saved = {
      id: "v-schedule", name: "Scheduled work", projectId: "p1", ownerId: "u1",
      scope: "PERSONAL", canEdit: true, layout,
      filter: { field: "text", op: "contains", value: "alpha" },
    };
    createView.mockResolvedValue({ view: saved });
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: saved.name } });
    // The saved-view list revalidates before the URL selects its new chip.
    queryState.savedViews = [saved];
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(createView).toHaveBeenCalledWith({
      projectId: "p1", scope: "PERSONAL", name: saved.name, layout, filter: saved.filter,
    }));
    await waitFor(() => expect(queryState.navigations.at(-1)).toEqual({
      path: `/projects?p=INBOX&view=${tab}&v=v-schedule`, mode: "replace",
    }));
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "updated" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Update view" })).toBeInTheDocument());
    updateView.mockResolvedValue({ view: saved });
    fireEvent.click(screen.getByRole("button", { name: "Update view" }));
    await waitFor(() => expect(updateView).toHaveBeenCalledWith(saved.id, {
      layout, filter: { field: "text", op: "contains", value: "updated" },
    }));
  });

  it.each([
    ["CALENDAR", "Calendar", "calendar"],
    ["TIMELINE", "Timeline", "timeline"],
    ["TABLE", "List", "list"],
  ])("opens a %s saved view in its supported layout", (layout, label, tab) => {
    queryState.savedViews = [{
      id: "v-schedule", name: "Scheduled work", projectId: "p1", ownerId: "u1",
      scope: "PERSONAL", canEdit: true, layout, filter: { and: [] },
    }];
    openProject();
    fireEvent.click(within(screen.getByRole("group", { name: "Views" })).getByRole("button", { name: /^Scheduled work/ }));
    expect(screen.getByRole("tab", { name: label })).toHaveAttribute("aria-selected", "true");
    expect(queryState.navigations.at(-1)).toEqual({ path: `/projects?p=INBOX&view=${tab}&v=v-schedule`, mode: "replace" });
  });
});
