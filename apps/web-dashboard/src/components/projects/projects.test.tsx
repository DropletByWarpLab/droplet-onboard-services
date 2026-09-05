// Unit tests for the native Projects surface — pure helpers + key components.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { canWrite } from "./types";
import { cardAccent, isOverdue, fmtDate, toneOf, makePerson } from "./config";
import { StatePill, PriorityFlag, EmptyBlock, PeopleContext } from "./bits";
import { BoardView } from "./board";
import { IndexView } from "./IndexView";
import type { PmState, PmWorkItem, PmProject } from "./types";

const STATES: PmState[] = [
  { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p", name: "In Progress", group: "started", color: "#f59e0b", sortOrder: 2, isDefault: false },
  { id: "s3", projectId: "p", name: "Done", group: "completed", color: "#22c55e", sortOrder: 3, isDefault: false },
];

function item(over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id: "w1",
    projectId: "p",
    sequenceId: 1,
    key: "INBOX-1",
    name: "First task",
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
    sortOrder: 1,
    completedAt: null,
    createdById: null,
    commentCount: 0,
    subItemCount: 0,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

describe("RBAC — canWrite", () => {
  it("allows owner/admin/family, denies guest/service/undefined", () => {
    expect(canWrite("owner")).toBe(true);
    expect(canWrite("admin")).toBe(true);
    expect(canWrite("family")).toBe(true);
    expect(canWrite("guest")).toBe(false);
    expect(canWrite("service")).toBe(false);
    expect(canWrite(undefined)).toBe(false);
  });
});

describe("config helpers", () => {
  it("cardAccent only rails urgent + high", () => {
    expect(cardAccent("urgent")).toBe("var(--err)");
    expect(cardAccent("high")).toBe("var(--warn)");
    expect(cardAccent("medium")).toBe("transparent");
    expect(cardAccent("none")).toBe("transparent");
  });

  it("isOverdue: past+open true, terminal false, no-due false", () => {
    const past = "2020-01-01T00:00:00.000Z";
    const future = "2999-01-01T00:00:00.000Z";
    expect(isOverdue(item({ dueDate: past, state: STATES[0] }))).toBe(true);
    expect(isOverdue(item({ dueDate: past, state: STATES[2] }))).toBe(false); // completed
    expect(isOverdue(item({ dueDate: future, state: STATES[0] }))).toBe(false);
    expect(isOverdue(item({ dueDate: null }))).toBe(false);
  });

  it("fmtDate formats and is null-safe", () => {
    expect(fmtDate("2026-06-25T00:00:00.000Z")).toMatch(/Jun 2[45]/);
    expect(fmtDate(null)).toBeNull();
  });

  it("toneOf is stable and in 1..6", () => {
    const t = toneOf("user-abc");
    expect(t).toBe(toneOf("user-abc"));
    expect(t).toBeGreaterThanOrEqual(1);
    expect(t).toBeLessThanOrEqual(6);
  });

  it("makePerson derives initials", () => {
    expect(makePerson("u1", "Stefan Cruceru").initials).toBe("SC");
    expect(makePerson("u1", "Madonna").initials).toBe("MA");
  });
});

describe("StatePill / PriorityFlag", () => {
  it("StatePill renders the state name + group class", () => {
    const { container } = render(<StatePill state={STATES[1]} />);
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(container.querySelector(".pm-statechip.started")).toBeTruthy();
  });

  it("PriorityFlag shows the label when asked", () => {
    render(<PriorityFlag p="urgent" withLabel />);
    expect(screen.getByText("Urgent")).toBeInTheDocument();
  });
});

describe("EmptyBlock", () => {
  it("renders heading + body", () => {
    render(<EmptyBlock heading="Nothing here" body="Add one to get started." />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Add one to get started.")).toBeInTheDocument();
  });
});

describe("BoardView", () => {
  const noop = () => undefined;

  it("groups items into a column per state with counts", () => {
    const items = [
      item({ id: "a", key: "INBOX-1", stateId: "s1", state: STATES[0] }),
      item({ id: "b", key: "INBOX-2", stateId: "s2", state: STATES[1] }),
      item({ id: "c", key: "INBOX-3", stateId: "s2", state: STATES[1] }),
    ];
    render(
      <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>
        <BoardView states={STATES} items={items} domain="populated" readOnly onOpen={noop} onTransition={noop} onNewItem={noop} />
      </PeopleContext.Provider>,
    );
    expect(screen.getByText("INBOX-1")).toBeInTheDocument();
    expect(screen.getByText("INBOX-2")).toBeInTheDocument();
    // 3 state column headers
    expect(screen.getByText("Todo")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("read-only hides the per-column new-item button", () => {
    const { container } = render(
      <BoardView states={STATES} items={[item()]} domain="populated" readOnly onOpen={noop} onTransition={noop} onNewItem={noop} />,
    );
    expect(container.querySelectorAll('button[aria-label^="New item in"]').length).toBe(0);
  });

  it("writer sees the per-column new-item button", () => {
    const { container } = render(
      <BoardView states={STATES} items={[item()]} domain="populated" readOnly={false} onOpen={noop} onTransition={noop} onNewItem={noop} />,
    );
    expect(container.querySelectorAll('button[aria-label^="New item in"]').length).toBeGreaterThan(0);
  });

  it("empty domain shows the empty state", () => {
    render(
      <BoardView states={STATES} items={[]} domain="empty" readOnly={false} onOpen={noop} onTransition={noop} onNewItem={noop} />,
    );
    expect(screen.getByText(/No work items in this project yet/)).toBeInTheDocument();
  });

  it("error domain shows the error state", () => {
    render(
      <BoardView states={STATES} items={[]} domain="error" readOnly onOpen={noop} onTransition={noop} onNewItem={noop} />,
    );
    expect(screen.getByText(/Couldn't load this project/)).toBeInTheDocument();
  });
});

describe("IndexView", () => {
  const project: PmProject = {
    id: "p1",
    workspaceId: "w",
    workspaceSlug: "home",
    department: null,
    name: "Onboarding",
    identifier: "INBOX",
    description: null,
    icon: "board",
    color: "#6366f1",
    leadId: null,
    archived: false,
    openCount: 6,
    doneCount: 4,
    groups: { backlog: 1, unstarted: 3, started: 2, completed: 4, cancelled: 0 },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
  const noop = () => undefined;

  it("renders project cards with open/done counts", () => {
    render(
      <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>
        <IndexView
          projects={[project]}
          summary={{ activeProjects: 1, itemsOpen: 6, doneThisWeek: 4, overdue: 1 }}
          loading={false}
          error={false}
          readOnly={false}
          showArchived={false}
          onToggleArchived={noop}
          onOpenProject={noop}
          onNewProject={noop}
        />
      </PeopleContext.Provider>,
    );
    expect(screen.getByText("Onboarding")).toBeInTheDocument();
    expect(screen.getByText("6 open")).toBeInTheDocument();
    expect(screen.getByText("4 done")).toBeInTheDocument();
  });

  it("empty shows the create-first-project CTA", () => {
    render(
      <IndexView
        projects={[]}
        summary={{ activeProjects: 0, itemsOpen: 0, doneThisWeek: 0, overdue: 0 }}
        loading={false}
        error={undefined}
        readOnly={false}
        showArchived={false}
        onToggleArchived={noop}
        onOpenProject={noop}
        onNewProject={noop}
      />,
    );
    expect(screen.getByText("No projects yet.")).toBeInTheDocument();
  });

  function err(status?: number, code?: string): Error & { status?: number; code?: string } {
    const e = new Error(code ?? "boom") as Error & { status?: number; code?: string };
    if (status !== undefined) e.status = status;
    if (code !== undefined) e.code = code;
    return e;
  }

  function renderError(error: Error & { status?: number; code?: string }, onRetry = noop) {
    render(
      <IndexView
        projects={undefined}
        summary={undefined}
        loading={false}
        error={error}
        readOnly={false}
        showArchived={false}
        onToggleArchived={noop}
        onOpenProject={noop}
        onNewProject={noop}
        onRetry={onRetry}
      />,
    );
  }

  it("error state shows a Retry button that invokes onRetry", () => {
    const onRetry = vi.fn();
    renderError(err(503), onRetry);
    const retry = screen.getByRole("button", { name: /retry/i });
    expect(retry).toBeInTheDocument();
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // WARP-1154: the orchestrator's module gate answers 404 module_disabled — a
  // PERMANENT condition. It must read as "not enabled" (honest copy, calm
  // tone, no Retry), never "server error, try again in a moment".
  // WARP-1528: …and REASON-FREE. `module_disabled` now also means "your role
  // wasn't granted this feature", so naming the workspace would be false for a
  // narrowed person (and leak by contradiction to anyone who has seen a
  // colleague using Projects).
  it("module_disabled reads as 'not available' — reason-free — with NO retry affordance", () => {
    const onRetry = vi.fn();
    renderError(err(404, "module_disabled"), onRetry);
    expect(screen.getByText(/projects isn't available/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/isn't enabled on this droplet/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/switched off for this droplet, or it isn't part of your access/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/an owner or admin can turn it on/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByText(/server error/i)).toBeNull();
    // The raw wire code never renders.
    expect(screen.queryByText(/module_disabled/)).toBeNull();
  });

  it("module_disabled uses the calmer (non-error) tone", () => {
    const { container } = render(
      <IndexView
        projects={undefined}
        summary={undefined}
        loading={false}
        error={err(404, "module_disabled")}
        readOnly={false}
        showArchived={false}
        onToggleArchived={noop}
        onOpenProject={noop}
        onNewProject={noop}
        onRetry={noop}
      />,
    );
    const glyph = container.querySelector(".pm-empty .glyph") as HTMLElement;
    expect(glyph.style.color).not.toContain("--err");
  });

  it("auth error (401) shows sign-in-oriented copy", () => {
    renderError(err(401));
    expect(screen.getByText(/sign in again/i)).toBeInTheDocument();
  });

  it("auth error (403) shows sign-in-oriented copy", () => {
    renderError(err(403));
    expect(screen.getByText(/sign in again/i)).toBeInTheDocument();
  });

  it("connection error (no status) shows reach-the-appliance copy", () => {
    renderError(err());
    expect(screen.getByText(/couldn't reach the appliance/i)).toBeInTheDocument();
  });

  it("server error (5xx) keeps the alarming error tone", () => {
    const { container } = render(
      <IndexView
        projects={undefined}
        summary={undefined}
        loading={false}
        error={err(500)}
        readOnly={false}
        showArchived={false}
        onToggleArchived={noop}
        onOpenProject={noop}
        onNewProject={noop}
        onRetry={noop}
      />,
    );
    // error tone uses the err token tint on the glyph
    const glyph = container.querySelector(".pm-empty .glyph") as HTMLElement;
    expect(glyph.style.color).toContain("--err");
  });

  it("connection blip uses the calmer (non-error) tone", () => {
    const { container } = render(
      <IndexView
        projects={undefined}
        summary={undefined}
        loading={false}
        error={err()}
        readOnly={false}
        showArchived={false}
        onToggleArchived={noop}
        onOpenProject={noop}
        onNewProject={noop}
        onRetry={noop}
      />,
    );
    const glyph = container.querySelector(".pm-empty .glyph") as HTMLElement;
    expect(glyph.style.color).not.toContain("--err");
  });
});
