/**
 * /projects — the planning wiring (WARP-3521).
 *
 * The Cycles and Modules tabs used to render a "…aren't ready yet" placeholder.
 * They now render the real views, and the board and list name the cycle an item
 * is planned into. The usePm data layer is stubbed (as page.gating.test.tsx does)
 * so this proves the PAGE's wiring: which view each tab shows, that the project
 * and its states reach them, and that the cycle map reaches the cards.
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
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "ada", displayName: "Ada", role: roleRef.current }, isLoading: false }),
  authFetch: vi.fn(),
}));
vi.mock("@/lib/hooks/useAppCapabilities", () => ({ useAppCapabilities: () => ({ projects: true }) }));

const roleRef = { current: "owner" };

const PROJECT = {
  id: "p1",
  workspaceId: "w",
  workspaceSlug: "home",
  name: "Inbox",
  identifier: "INBOX",
  description: null,
  icon: null,
  color: null,
  leadId: null,
  department: null,
  archived: false,
  openCount: 1,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 1, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
const STATE = { id: "s1", projectId: "p1", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true };
const ITEM = {
  id: "w1",
  projectId: "p1",
  sequenceId: 1,
  key: "INBOX-1",
  name: "First task",
  descriptionHtml: null,
  stateId: "s1",
  state: STATE,
  priority: "none",
  parentId: null,
  cycleId: "c1",
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
const PROGRESS = { total: 1, completed: 0, cancelled: 0, totalEstimate: 0, completedEstimate: 0, cancelledEstimate: 0 };
const CYCLE = {
  id: "c1",
  projectId: "p1",
  name: "Sprint 12",
  description: null,
  startDate: "2026-10-05",
  endDate: "2026-10-16",
  status: "active",
  completedAt: null,
  carriedOverCount: 0,
  progress: PROGRESS,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const idle = { error: undefined, isLoading: false, mutate: vi.fn() };
const cyclesRef = { current: [CYCLE] as unknown[] };

vi.mock("@/components/projects/usePm", () => ({
  useProjects: () => ({ projects: [PROJECT], ...idle }),
  useSummary: () => ({ summary: undefined, ...idle }),
  useProjectStates: () => ({ states: [STATE], error: undefined, isLoading: false }),
  useProjectItems: () => ({ items: [ITEM], ...idle, key: null }),
  usePeople: () => ({ person: (id: string) => ({ id, name: "Tester", initials: "T", tone: 1 }), users: [] }),
  useDepartments: () => ({ departments: undefined }),
  useProjectCycles: () => ({ cycles: cyclesRef.current, ...idle }),
  useCycleItems: () => ({ items: [ITEM], total: 1, ...idle }),
  useBacklog: () => ({ items: [], total: 0, ...idle }),
  useCycleBurndown: () => ({ burndown: undefined, ...idle }),
  useProjectModules: () => ({ modules: [], ...idle }),
  useModuleItems: () => ({ items: [], total: 0, ...idle }),
  useWorkItemModules: () => ({ modules: [], ...idle }),
  useProjectLabels: () => ({ labels: [] }),
  useSubIssues: () => ({ subIssues: [] }),
  useComments: () => ({ comments: [], mutate: vi.fn() }),
  useActivity: () => ({ activity: [], mutate: vi.fn() }),
  useAttachments: () => ({ attachments: [], maxBytes: 26214400, ...idle }),
  pmActions: () => ({}),
  PmRequestError: class extends Error {},
}));

import ProjectsPage from "./page";

function openProject() {
  render(<ProjectsPage />);
  fireEvent.click(screen.getByText("Inbox"));
}

describe("/projects — planning wiring", () => {
  beforeEach(() => {
    roleRef.current = "owner";
    cyclesRef.current = [CYCLE];
  });

  it("the board names the cycle an item is planned into", () => {
    openProject();
    expect(screen.getByText("INBOX-1")).toBeInTheDocument();
    expect(screen.getByTitle("Cycle: Sprint 12")).toBeInTheDocument();
  });

  it("the list does too", () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: /List/ }));
    expect(screen.getByTitle("Cycle: Sprint 12")).toBeInTheDocument();
  });

  it("an item whose cycle is unknown gets no chip rather than a broken one", () => {
    cyclesRef.current = [];
    openProject();
    expect(screen.getByText("INBOX-1")).toBeInTheDocument();
    expect(screen.queryByTitle(/^Cycle:/)).toBeNull();
  });

  it("the Cycles tab is the real view — the placeholder is gone", () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: /Cycles/ }));
    expect(screen.queryByText("Cycles aren't ready yet.")).toBeNull();
    expect(screen.queryByText(/Sprint planning will live here/)).toBeNull();
    const card = screen.getByRole("button", { name: "Sprint 12, Active" });
    expect(within(card).getByText("Oct 5 – Oct 16")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /New cycle/ })).toBeInTheDocument();
  });

  it("the Modules tab is the real view — the placeholder is gone", () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: /Modules/ }));
    expect(screen.queryByText("Modules aren't ready yet.")).toBeNull();
    expect(screen.queryByText(/Grouping work into bigger efforts will live here/)).toBeNull();
    expect(screen.getByText("No modules yet.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /New module/ }).length).toBeGreaterThan(0);
  });

  it("a read-only role sees the planning views without any write affordance", () => {
    roleRef.current = "guest";
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: /Cycles/ }));
    expect(screen.getByRole("button", { name: "Sprint 12, Active" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New cycle/ })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Modules/ }));
    expect(screen.queryByRole("button", { name: /New module/ })).toBeNull();
  });

  it("opening a cycle's item from the planning view opens the same drawer as the board", () => {
    openProject();
    fireEvent.click(screen.getByRole("tab", { name: /Cycles/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sprint 12, Active" }));
    fireEvent.click(screen.getByRole("button", { name: /INBOX-1, First task/ }));
    // the drawer shows the planning rows ("Modules" is also a tab label, so look inside the drawer)
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByText("Cycle")).toBeInTheDocument();
    expect(within(drawer).getByText("Modules")).toBeInTheDocument();
  });
});
