/**
 * /projects wiring for the scheduling views (WARP-3523): Calendar and Timeline are
 * project views behind the same switcher and the same filters as Board and List;
 * My work is a cross-project view reached from the index, not a nav row. The
 * views themselves have their own suites — here they are stubs that record the
 * props the page hands them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import React from "react";

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

const mutateItems = vi.fn(async () => undefined);
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

vi.mock("@/components/projects/usePm", () => ({
  useProjects: () => ({ projects: [PROJECT], error: undefined, isLoading: false, mutate: vi.fn() }),
  useSummary: () => ({ summary: undefined, mutate: vi.fn() }),
  useProjectStates: () => ({ states: [] }),
  useProjectItems: () => ({ items: ITEMS, error: undefined, isLoading: false, mutate: mutateItems, key: "k" }),
  usePeople: () => ({ person: (id: string) => ({ id, name: "Tester", initials: "T", tone: 1 }), users: [] }),
  useDepartments: () => ({ departments: undefined }),
  useProjectCycles: () => ({ cycles: [], mutate: vi.fn() }),
  pmActions: () => ({}),
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
  render(<ProjectsPage />);
  fireEvent.click(screen.getByRole("button", { name: "open Onboarding" }));
}

beforeEach(() => {
  role.current = "owner";
  calendarProps.current = null;
  timelineProps.current = null;
  mutateItems.mockClear();
});

describe("view switcher", () => {
  it("offers Calendar and Timeline between List and Cycles", () => {
    openProject();
    const tabs = within(screen.getByRole("tablist", { name: "View" })).getAllByRole("tab");
    expect(tabs.slice(0, 6).map((t) => t.textContent)).toEqual(["Board", "List", "Calendar", "Timeline", "Cycles", "Modules"]);
  });

  it("Calendar gets the page's filtered items, role and a revalidation that refreshes the board", async () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
    expect(screen.getByTestId("calendar")).toBeInTheDocument();
    expect(calendarProps.current.items.map((i: any) => i.key)).toEqual(["INBOX-1", "INBOX-2", "INBOX-3"]);
    expect(calendarProps.current.readOnly).toBe(false);
    expect(calendarProps.current.domain).toBe("populated");
    await calendarProps.current.onChanged();
    expect(mutateItems).toHaveBeenCalledTimes(1);
  });

  it("the search box narrows what the calendar shows, exactly as it does the board", () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "alpha" } });
    expect(calendarProps.current.items.map((i: any) => i.key)).toEqual(["INBOX-1"]);
  });

  it("Timeline gets the project and, with no filter, no id filter at all", () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(screen.getByTestId("timeline")).toBeInTheDocument();
    expect(timelineProps.current.projectId).toBe("p1");
    expect(timelineProps.current.visibleIds).toBeNull();
    expect(typeof timelineProps.current.revision).toBe("string");
  });

  it("Timeline gets the ids the filters admit once one is active, and a new revision when the data changes", () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "alpha" } });
    expect([...timelineProps.current.visibleIds]).toEqual(["w1"]);
    expect(timelineProps.current.revision).toBe("3:2026-10-03T00:00:00.000Z");
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
  });

  it("a way back to all projects", () => {
    render(<ProjectsPage />);
    fireEvent.click(screen.getByRole("button", { name: /My work/ }));
    fireEvent.click(screen.getByRole("button", { name: /All projects/ }));
    expect(screen.queryByTestId("my-work")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
  });
});
