/**
 * WARP-3522 — /projects is one route whose state is its URL:
 *
 *   /projects?p=<IDENTIFIER>&view=<tab>&item=<KEY-123>&v=<savedViewId>&f=<filter>
 *
 * The acceptance criterion is a round trip: open a URL → the same project, tab,
 * view, filter and open drawer; change any of them → the URL says so, with
 * PUSH for navigation (a project, a tab, an item) and REPLACE for editing (a
 * filter, a saved view); and Back / Forward — which are just URL changes — walk
 * it. The data layer is stubbed (the queries themselves are proven against
 * Postgres); everything else is the real page, its chips and its views.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import {
  PM_BUILTIN_VIEWS,
  buildPmPath,
  parsePmFilter,
  serializePmFilter,
  type PmFilter,
  type PmSavedViewDto,
} from "@droplet/shared-types";

const h = vi.hoisted(() => ({
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  toast: vi.fn(),
  user: { id: "u-me", username: "me", displayName: "Me", role: "owner" } as { id: string; username: string; displayName: string; role: string },
  projects: [] as unknown[],
  projectsLoaded: true,
  states: [] as unknown[],
  labels: [] as unknown[],
  items: [] as unknown[],
  savedViews: [] as unknown[] | undefined,
  viewsError: undefined as unknown,
  byKey: {} as Record<string, unknown>,
  byKeyError: undefined as unknown,
  stale: undefined as unknown,
  effectiveFilter: undefined as unknown,
  counts: { all: 2 } as Record<string, number> | undefined,
  queryCalls: [] as Array<{ enabled: boolean; projectId: string | null; filter: unknown; counts?: unknown }>,
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children, actions }: { title?: string; sub?: string; children?: React.ReactNode; actions?: React.ReactNode }) => (
    <div className="droplet-shell">
      {title ? <h1>{title}</h1> : null}
      {sub ? <p>{sub}</p> : null}
      {actions}
      {children}
    </div>
  ),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children?: React.ReactNode; href: string }) => React.createElement("a", { href, ...props }, children),
}));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: h.user, isLoading: false }), authFetch: vi.fn() }));
vi.mock("@/lib/hooks/useAppCapabilities", () => ({ useAppCapabilities: () => ({ projects: true }) }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(h.search),
  useRouter: () => ({ push: h.push, replace: h.replace, back: h.back }),
  usePathname: () => "/projects",
}));
vi.mock("@/lib/pin-handoff", () => ({ stageRecordPinHandoff: vi.fn() }));
vi.mock("@/components/projects/detail", () => ({
  DetailDrawer: ({ item, onClose }: { item: { key: string }; onClose: () => void }) => (
    <div role="dialog" aria-label={`Drawer ${item.key}`}>
      <button type="button" onClick={onClose}>
        Close drawer
      </button>
    </div>
  ),
}));
vi.mock("@/components/projects/usePm", () => ({
  useProjects: () => ({ projects: h.projectsLoaded ? h.projects : undefined, error: undefined, isLoading: !h.projectsLoaded, mutate: vi.fn() }),
  useSummary: () => ({ summary: { activeProjects: 1, itemsOpen: 2, doneThisWeek: 0, overdue: 0 }, error: undefined, isLoading: false, mutate: vi.fn() }),
  useProjectStates: (id: string | null) => ({ states: id ? h.states : undefined }),
  useProjectLabels: (id: string | null) => ({ labels: id ? h.labels : undefined }),
  useProjectCycles: () => ({ cycles: [], mutate: vi.fn() }),
  useWorkItemQuery: (args: { enabled: boolean; projectId: string | null; filter: unknown; counts?: unknown }) => {
    h.queryCalls.push(args);
    return {
      items: args.enabled ? h.items : undefined,
      total: args.enabled ? h.items.length : undefined,
      counts: args.enabled ? h.counts : undefined,
      stale: h.stale,
      effectiveFilter: h.effectiveFilter,
      loadingMore: false,
      truncated: false,
      error: undefined,
      isLoading: false,
      refresh: vi.fn(),
    };
  },
  useWorkItemByKey: (key: string | null, enabled: boolean) => ({
    item: key && enabled ? h.byKey[key] : undefined,
    error: key && enabled ? h.byKeyError : undefined,
    mutate: vi.fn(),
  }),
  useSavedViews: (scope: unknown) => ({
    views: scope ? h.savedViews : undefined,
    error: scope ? h.viewsError : undefined,
    isLoading: false,
    mutate: vi.fn(),
  }),
  useDepartments: () => ({ departments: undefined }),
  usePeople: () => ({
    person: (id: string) => ({ id, name: "Tester", initials: "T", tone: 1 }),
    people: [{ id: "u1", displayName: "Ana", avatarUrl: null }],
  }),
  pmActions: () => ({ transitionItem: vi.fn() }),
  viewActions: () => ({ create: h.create, update: h.update, remove: h.remove }),
  PmRequestError: class extends Error {},
}));

import ProjectsPage from "./page";

const STATES = [
  { id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p1", name: "Doing", group: "started", color: "#f59e0b", sortOrder: 2, isDefault: false },
];
const PROJECT = {
  id: "p1",
  workspaceId: "w",
  workspaceSlug: "home",
  name: "Onboarding",
  identifier: "INBOX",
  description: null,
  icon: null,
  color: null,
  leadId: null,
  department: null,
  archived: false,
  openCount: 2,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 2, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
function item(n: number, name: string) {
  return {
    id: `w${n}`,
    projectId: "p1",
    sequenceId: n,
    key: `INBOX-${n}`,
    name,
    descriptionHtml: null,
    stateId: "s1",
    state: STATES[0],
    priority: "none",
    parentId: null,
    cycleId: null,
    department: null,
    assignees: [],
    labels: [],
    startDate: null,
    dueDate: null,
    sortOrder: n,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}
function savedView(over: Partial<PmSavedViewDto>): PmSavedViewDto {
  return {
    id: "v-1",
    projectId: "p1",
    ownerId: "u-me",
    scope: "PERSONAL",
    name: "Urgent only",
    layout: "LIST",
    filter: { field: "priority", op: "is", value: "urgent" },
    groupBy: null,
    sortBy: null,
    columns: null,
    sortOrder: 0,
    canEdit: true,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

const lastQuery = () => h.queryCalls[h.queryCalls.length - 1];
/** A chip in the saved-view row ("All" alone would also match the "All projects" back button). */
const chip = (name: RegExp | string) => within(screen.getByRole("group", { name: "Views" })).getByRole("button", { name });
const HIGH: PmFilter = { field: "priority", op: "is", value: "high" };
const ME: PmFilter = { field: "assignee", op: "is", value: "me" };
const MINE = PM_BUILTIN_VIEWS.find((v) => v.id === "mine")!.filter;

/** Move the browser to `path` and re-render, the way Back / Forward / a link would. */
function visit(path: string, rerender?: (ui: React.ReactElement) => void) {
  h.search = path.includes("?") ? path.slice(path.indexOf("?") + 1) : "";
  rerender?.(<ProjectsPage />);
}

beforeEach(() => {
  h.search = "";
  for (const f of [h.push, h.replace, h.back, h.toast, h.create, h.update, h.remove]) f.mockReset();
  h.user = { id: "u-me", username: "me", displayName: "Me", role: "owner" };
  h.projects = [PROJECT];
  h.projectsLoaded = true;
  h.states = STATES;
  h.labels = [{ id: "l1", projectId: "p1", name: "Bug", color: null }];
  h.items = [item(1, "First task"), item(2, "Second task")];
  h.savedViews = [];
  h.viewsError = undefined;
  h.byKey = {};
  h.byKeyError = undefined;
  h.stale = undefined;
  h.effectiveFilter = undefined;
  h.counts = { all: 2 };
  h.queryCalls.length = 0;
});

describe("opening a URL restores the screen", () => {
  it("project, tab, built-in view and drawer", () => {
    visit("/projects?p=INBOX&view=list&v=mine&item=INBOX-2");
    render(<ProjectsPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Onboarding");
    expect(screen.getByRole("tab", { name: /List/ })).toHaveAttribute("aria-selected", "true");
    expect(chip(/^My items/)).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "INBOX-1, First task" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Drawer INBOX-2" })).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ enabled: true, projectId: "p1", filter: MINE });
  });

  it("a bare ?p= is the board, with no view and no filter", () => {
    visit("/projects?p=INBOX");
    render(<ProjectsPage />);
    expect(screen.getByRole("tab", { name: /Board/ })).toHaveAttribute("aria-selected", "true");
    expect(chip(/^All/)).toHaveAttribute("aria-current", "true");
    expect(lastQuery()).toMatchObject({ projectId: "p1", filter: { and: [] } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("finds the project by identifier, whatever the case of the link", () => {
    visit("/projects?p=inbox");
    render(<ProjectsPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Onboarding");
  });

  it("an explicit filter wins over the view's own, and shows as chips", () => {
    visit("/projects?p=INBOX&v=mine&f=assignee.is:me,priority.is:high");
    render(<ProjectsPage />);
    expect(lastQuery().filter).toEqual({ and: [ME, HIGH] });
    expect(screen.getByRole("button", { name: "Edit filter: Priority is High" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit filter: Assignee is me" })).toBeInTheDocument();
    // The active view has been changed: say so.
    expect(screen.getByText(/You've changed “My items”/)).toBeInTheDocument();
  });

  it("`f=` (empty) is the view with its filter cleared — not the view's filter", () => {
    visit("/projects?p=INBOX&v=mine&f=");
    render(<ProjectsPage />);
    expect(lastQuery().filter).toEqual({ and: [] });
    expect(screen.getByText(/You've changed “My items”/)).toBeInTheDocument();
  });

  it("a saved view's filter is applied, and opens in its layout", () => {
    h.savedViews = [savedView({})];
    visit("/projects?p=INBOX&view=list&v=v-1");
    render(<ProjectsPage />);
    expect(lastQuery().filter).toEqual({ field: "priority", op: "is", value: "urgent" });
    expect(chip(/^Urgent only/)).toHaveAttribute("aria-current", "true");
  });

  it("does not query until a saved view's filter is known (no flash of the wrong rows)", () => {
    h.savedViews = undefined;
    visit("/projects?p=INBOX&v=v-1");
    render(<ProjectsPage />);
    expect(lastQuery().enabled).toBe(false);
  });

  it("opens an item that is not in the loaded list, by its key", () => {
    h.byKey = { "INBOX-9": item(9, "Far away") };
    visit("/projects?p=INBOX&item=INBOX-9");
    render(<ProjectsPage />);
    expect(screen.getByRole("dialog", { name: "Drawer INBOX-9" })).toBeInTheDocument();
  });

  it("a link to an item that does not exist says so and removes the item from the URL", async () => {
    h.byKeyError = Object.assign(new Error("not found"), { status: 404, code: "work_item_not_found" });
    visit("/projects?p=INBOX&item=INBOX-99");
    render(<ProjectsPage />);
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX", { scroll: false }));
    expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/couldn't find that item/i), "error");
  });
});

describe("a link that cannot be honoured degrades, and never errors", () => {
  it("an unreadable filter is ignored, and says so", () => {
    visit("/projects?p=INBOX&v=mine&f=this-is(not,a-filter");
    render(<ProjectsPage />);
    expect(lastQuery().filter).toEqual(MINE);
    expect(screen.getByText("That link's filter couldn't be read, so it was ignored.")).toBeInTheDocument();
  });

  it("an unknown project is a calm message with a way back", () => {
    visit("/projects?p=NOPE");
    render(<ProjectsPage />);
    expect(screen.getByText("We couldn't find that project anymore.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: /All projects/ })[0]);
    expect(h.push).toHaveBeenCalledWith("/projects", { scroll: false });
  });

  it("a saved view that has been deleted says so and shows everything", () => {
    h.savedViews = [];
    visit("/projects?p=INBOX&v=3f2b8c1e-9a44-4d3b-8f10-2a6c1b7d9e01");
    render(<ProjectsPage />);
    expect(screen.getByText("That view isn't available anymore.")).toBeInTheDocument();
    expect(lastQuery().filter).toEqual({ and: [] });
  });

  it("does not say a view is gone while the projects that would hold it are still loading", () => {
    h.projectsLoaded = false;
    visit("/projects?p=INBOX&v=3f2b8c1e-9a44-4d3b-8f10-2a6c1b7d9e01");
    render(<ProjectsPage />);
    expect(screen.queryByText("That view isn't available anymore.")).toBeNull();
    expect(lastQuery().enabled).toBe(false);
  });

  it("a view list that cannot be loaded says so, and shows everything rather than nothing", () => {
    h.savedViews = undefined;
    h.viewsError = new Error("offline");
    visit("/projects?p=INBOX&v=3f2b8c1e-9a44-4d3b-8f10-2a6c1b7d9e01");
    render(<ProjectsPage />);
    expect(screen.getByText("Couldn't load that view, so everything is shown.")).toBeInTheDocument();
    expect(lastQuery()).toMatchObject({ enabled: true, filter: { and: [] } });
  });

  it("tells the user once that an item link is dead, however often the page re-renders", () => {
    h.byKeyError = Object.assign(new Error("not found"), { status: 404, code: "work_item_not_found" });
    visit("/projects?p=INBOX&item=INBOX-99");
    const { rerender } = render(<ProjectsPage />);
    rerender(<ProjectsPage />);
    rerender(<ProjectsPage />);
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.replace).toHaveBeenCalledTimes(1);
  });

  it("values the contract rejects are dropped, not acted on", () => {
    visit("/projects?p=not%20valid&item=nope&view=BOARD");
    render(<ProjectsPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Projects");
    expect(screen.getByText(/No projects yet|Onboarding/)).toBeInTheDocument();
  });
});

describe("changing the screen changes the URL — push for navigation, replace for editing", () => {
  it("opening a project from the index pushes it", () => {
    visit("/projects");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Onboarding/ }));
    expect(h.push).toHaveBeenCalledWith("/projects?p=INBOX", { scroll: false });
  });

  it("the Views button on the index pushes the views index", () => {
    visit("/projects");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Views/ }));
    expect(h.push).toHaveBeenCalledWith("/projects?view=views", { scroll: false });
  });

  it("switching tab pushes, and the board is the unmarked default", () => {
    visit("/projects?p=INBOX&v=mine");
    const { rerender } = render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("tab", { name: /List/ }));
    expect(h.push).toHaveBeenLastCalledWith("/projects?p=INBOX&view=list&v=mine", { scroll: false });
    visit("/projects?p=INBOX&view=list&v=mine", rerender);
    fireEvent.click(screen.getByRole("tab", { name: /Board/ }));
    expect(h.push).toHaveBeenLastCalledWith("/projects?p=INBOX&v=mine", { scroll: false });
  });

  it("picking a built-in view REPLACES, and clears any edited filter", () => {
    visit("/projects?p=INBOX&f=priority.is:high");
    render(<ProjectsPage />);
    fireEvent.click(chip(/^My items/));
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX&v=mine", { scroll: false });
    expect(h.push).not.toHaveBeenCalled();
  });

  it("picking All removes the view from the URL", () => {
    visit("/projects?p=INBOX&v=mine");
    render(<ProjectsPage />);
    fireEvent.click(chip(/^All/));
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX", { scroll: false });
  });

  it("picking a saved view opens it in its own layout", () => {
    h.savedViews = [savedView({ layout: "LIST" })];
    visit("/projects?p=INBOX");
    render(<ProjectsPage />);
    fireEvent.click(chip(/^Urgent only/));
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX&view=list&v=v-1", { scroll: false });
  });

  it("adding a filter replaces, writing the compact filter", () => {
    visit("/projects?p=INBOX");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Filter$/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add a filter" })).getByRole("button", { name: "Priority" }));
    fireEvent.click(screen.getByLabelText("High"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX&f=priority.is:high", { scroll: false });
  });

  it("editing a view's filter keeps the view and adds `f`; undoing the edit drops `f` again", () => {
    visit("/projects?p=INBOX&v=mine");
    const { rerender } = render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Filter$/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add a filter" })).getByRole("button", { name: "Priority" }));
    fireEvent.click(screen.getByLabelText("High"));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(h.replace).toHaveBeenLastCalledWith("/projects?p=INBOX&v=mine&f=assignee.is:me,priority.is:high", { scroll: false });

    visit("/projects?p=INBOX&v=mine&f=assignee.is:me,priority.is:high", rerender);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Priority is High" }));
    expect(h.replace).toHaveBeenLastCalledWith("/projects?p=INBOX&v=mine", { scroll: false });
  });

  it("removing every filter of a view writes `f=`, so a reload does not bring them back", () => {
    visit("/projects?p=INBOX&v=mine");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Remove filter: Assignee is me" }));
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX&v=mine&f=", { scroll: false });
  });

  it("Reset goes back to the view's own filter", () => {
    visit("/projects?p=INBOX&v=mine&f=priority.is:high");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX&v=mine", { scroll: false });
  });

  it("clearing filters from an empty board does not leave the board empty by accident", () => {
    h.items = [];
    h.counts = { all: 5 };
    visit("/projects?p=INBOX&f=priority.is:high");
    render(<ProjectsPage />);
    expect(screen.getByText("No work items match these filters.")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filters" })[0]);
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX", { scroll: false });
  });

  it("an empty project says so (and is not 'filtered')", () => {
    h.items = [];
    h.counts = { all: 0 };
    visit("/projects?p=INBOX");
    render(<ProjectsPage />);
    expect(screen.getByText(/No work items in this project yet/)).toBeInTheDocument();
  });

  it("opening an item pushes it; closing a drawer this page opened goes Back", () => {
    visit("/projects?p=INBOX");
    const { rerender } = render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: "INBOX-1, First task" }));
    expect(h.push).toHaveBeenCalledWith("/projects?p=INBOX&item=INBOX-1", { scroll: false });
    visit("/projects?p=INBOX&item=INBOX-1", rerender);
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(h.back).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("closing a drawer that arrived in the link replaces", () => {
    visit("/projects?p=INBOX&item=INBOX-1");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(h.back).not.toHaveBeenCalled();
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX", { scroll: false });
  });
});

describe("Back and Forward are just URL changes the page re-derives from", () => {
  it("walks index → project → list → item → and back out", () => {
    visit("/projects");
    const { rerender } = render(<ProjectsPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Projects");

    visit("/projects?p=INBOX", rerender);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Onboarding");
    expect(screen.getByRole("tab", { name: /Board/ })).toHaveAttribute("aria-selected", "true");

    visit("/projects?p=INBOX&view=list&v=mine", rerender);
    expect(screen.getByRole("tab", { name: /List/ })).toHaveAttribute("aria-selected", "true");
    expect(chip(/^My items/)).toHaveAttribute("aria-current", "true");

    visit("/projects?p=INBOX&view=list&v=mine&item=INBOX-1", rerender);
    expect(screen.getByRole("dialog", { name: "Drawer INBOX-1" })).toBeInTheDocument();

    visit("/projects?p=INBOX&view=list&v=mine", rerender);
    expect(screen.queryByRole("dialog")).toBeNull();

    visit("/projects?p=INBOX", rerender);
    expect(screen.getByRole("tab", { name: /Board/ })).toHaveAttribute("aria-selected", "true");
    expect(chip(/^All/)).toHaveAttribute("aria-current", "true");

    visit("/projects", rerender);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Projects");
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

describe("a deep link round-trips", () => {
  const cases: Array<[string, { p: string; view?: string; v?: string; f?: PmFilter; item?: string }]> = [
    ["project only", { p: "INBOX" }],
    ["list tab", { p: "INBOX", view: "list" }],
    ["a built-in view", { p: "INBOX", v: "overdue" }],
    ["an edited view", { p: "INBOX", view: "list", v: "mine", f: { and: [ME, HIGH] } }],
    ["a filter and an open item", { p: "INBOX", f: { and: [HIGH, { field: "label", op: "is", value: "l1" }] }, item: "INBOX-2" }],
    ["text with awkward characters", { p: "INBOX", f: { field: "text", op: "contains", value: "a,b (c); d~e%f" } }],
  ];

  it.each(cases)("%s: URL → page → the same URL", (_name, s) => {
    const path = buildPmPath({ ...s, f: s.f ? serializePmFilter(s.f) : null });
    visit(path);
    render(<ProjectsPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Onboarding");
    if (s.view) expect(screen.getByRole("tab", { name: new RegExp(s.view, "i") })).toHaveAttribute("aria-selected", "true");
    if (s.item) expect(screen.getByRole("dialog", { name: `Drawer ${s.item}` })).toBeInTheDocument();
    if (s.f) {
      // The page applies exactly the filter the link carried…
      expect(lastQuery().filter).toEqual(parsePmFilter(serializePmFilter(s.f)));
      // …and re-writing it (a no-op edit) reproduces the very same URL.
      expect(buildPmPath({ ...s, f: serializePmFilter(parsePmFilter(serializePmFilter(s.f))!) })).toBe(path);
    }
  });
});

describe("saved views, end to end", () => {
  it("Save view creates it for this project, in this layout, with this filter — then selects it", async () => {
    h.create.mockResolvedValue({ view: savedView({ id: "v-new", name: "Mine and high", layout: "LIST" }) });
    visit("/projects?p=INBOX&view=list&f=priority.is:high");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    const dialog = screen.getByRole("dialog", { name: "Save view" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Mine and high" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save view" }));
    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith({
        projectId: "p1",
        scope: "PERSONAL",
        name: "Mine and high",
        layout: "LIST",
        filter: HIGH,
      }),
    );
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX&view=list&v=v-new", { scroll: false }));
    expect(h.toast).toHaveBeenCalledWith("View saved", "success");
  });

  it("Update view writes the filter and layout back, then drops `f`", async () => {
    h.savedViews = [savedView({ layout: "BOARD" })];
    h.update.mockResolvedValue({ view: savedView({}) });
    visit("/projects?p=INBOX&v=v-1&f=priority.is:high");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Update view" }));
    await waitFor(() => expect(h.update).toHaveBeenCalledWith("v-1", { filter: HIGH, layout: "BOARD" }));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX&v=v-1", { scroll: false }));
  });

  it("a shared view the person cannot change only offers Save as new", () => {
    h.user = { id: "u-fam", username: "fam", displayName: "Fam", role: "family" };
    h.savedViews = [savedView({ scope: "SHARED", ownerId: "u-admin", canEdit: false, name: "Team" })];
    visit("/projects?p=INBOX&v=v-1&f=priority.is:high");
    render(<ProjectsPage />);
    expect(screen.queryByRole("button", { name: "Update view" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save as new" })).toBeInTheDocument();
  });

  it("deleting the active view returns to All", async () => {
    h.savedViews = [savedView({})];
    h.remove.mockResolvedValue({ deleted: "v-1" });
    visit("/projects?p=INBOX&v=v-1");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Urgent only" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith("v-1"));
    await waitFor(() => expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX", { scroll: false }));
  });

  it("a failed delete says so and leaves the view alone", async () => {
    h.savedViews = [savedView({})];
    h.remove.mockRejectedValue(Object.assign(new Error("x"), { code: "view_forbidden", status: 403 }));
    visit("/projects?p=INBOX&v=v-1");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Urgent only" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.stringMatching(/can't change this view/i), "error"));
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("counts a project's saved views along with the built-ins, in one request", () => {
    h.savedViews = [savedView({})];
    visit("/projects?p=INBOX");
    render(<ProjectsPage />);
    const counts = lastQuery().counts as Record<string, unknown>;
    expect(Object.keys(counts)).toEqual(["all", "mine", "active", "overdue", "noassignee", "v-1"]);
  });
});

describe("a filter that named something that no longer exists", () => {
  it("says so once (brief §3.9) and puts the filter that was applied in the URL", () => {
    h.stale = [{ field: "label", value: "gone" }];
    h.effectiveFilter = HIGH;
    visit("/projects?p=INBOX&f=priority.is:high,label.is:gone");
    render(<ProjectsPage />);
    expect(screen.getByText("One filter was removed because it no longer exists.")).toBeInTheDocument();
    expect(h.replace).toHaveBeenCalledWith("/projects?p=INBOX&f=priority.is:high", { scroll: false });
  });

  it("counts several", () => {
    h.stale = [
      { field: "label", value: "a" },
      { field: "state", value: "b" },
    ];
    h.effectiveFilter = { and: [] };
    visit("/projects?p=INBOX&f=label.is:a,state.is:b");
    render(<ProjectsPage />);
    expect(screen.getByText("2 filters were removed because they no longer exist.")).toBeInTheDocument();
  });
});

describe("workspace-wide lists and the Views index", () => {
  const CROSS = savedView({ id: "v-x", projectId: null, name: "Everything urgent", layout: "LIST" });

  it("a cross-project view with no project IS the workspace list: the whole workspace is queried, grouped by project", () => {
    h.savedViews = [CROSS];
    visit("/projects?v=v-x");
    render(<ProjectsPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("All projects");
    expect(lastQuery()).toMatchObject({ enabled: true, projectId: null, filter: CROSS.filter });
    expect(chip(/^Everything urgent/)).toHaveAttribute("aria-current", "true");
    // Grouped by the project the rows belong to.
    expect(screen.getByText("INBOX")).toBeInTheDocument();
  });

  it("?view=workspace is the unfiltered list across projects, and saving there makes a cross-project view", async () => {
    h.savedViews = [];
    h.create.mockResolvedValue({ view: savedView({ id: "v-new", projectId: null }) });
    visit("/projects?view=workspace&f=priority.is:high");
    render(<ProjectsPage />);
    expect(lastQuery()).toMatchObject({ projectId: null, filter: HIGH });
    fireEvent.click(screen.getByRole("button", { name: /Save view/ }));
    fireEvent.change(within(screen.getByRole("dialog", { name: "Save view" })).getByLabelText("Name"), { target: { value: "High anywhere" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save view" })).getByRole("button", { name: "Save view" }));
    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith({ projectId: null, scope: "PERSONAL", name: "High anywhere", layout: "LIST", filter: HIGH }),
    );
  });

  it("the Views index lists every view, and a row opens its project with the view", () => {
    h.savedViews = [savedView({}), CROSS];
    visit("/projects?view=views");
    render(<ProjectsPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Views");
    fireEvent.click(screen.getByRole("button", { name: /Urgent only/ }));
    expect(h.push).toHaveBeenCalledWith("/projects?p=INBOX&view=list&v=v-1", { scroll: false });
    fireEvent.click(screen.getByRole("button", { name: /Everything urgent/ }));
    expect(h.push).toHaveBeenLastCalledWith("/projects?view=workspace&v=v-x", { scroll: false });
  });

  it("the index door opens the workspace-wide list", () => {
    h.savedViews = [];
    visit("/projects?view=views");
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /All work across projects/ }));
    expect(h.push).toHaveBeenCalledWith("/projects?view=workspace", { scroll: false });
  });

  it("a view of a project that is not in the list (archived) is not offered", () => {
    h.savedViews = [savedView({ projectId: "gone-project", name: "Orphan" })];
    visit("/projects?view=views");
    render(<ProjectsPage />);
    expect(screen.queryByRole("button", { name: /Orphan/ })).toBeNull();
  });
});

describe("what a role that cannot write sees", () => {
  it("has no Save view", () => {
    h.user = { id: "u-g", username: "g", displayName: "G", role: "guest" };
    visit("/projects?p=INBOX");
    render(<ProjectsPage />);
    expect(screen.queryByRole("button", { name: /Save view/ })).toBeNull();
    // …but reads, filters and sees the saved views like anyone.
    expect(screen.getByRole("button", { name: /^Filter$/ })).toBeInTheDocument();
  });
});
