/**
 * WARP-3536 — live updates on the Projects page, through the real page, hooks,
 * SWR and board. Only the network is fake.
 *
 * A frame off the socket (here: `publishPmLiveFrame`, which is what
 * NotificationToaster calls) must re-read the board and leave the open drawer on
 * the fresh item, must leave an unrelated project alone, and must wait while a
 * card is in the user's hand.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import React from "react";
import { SWRConfig } from "swr";
import { publishPmLiveFrame } from "@/lib/pm-live-events";

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
vi.mock("@/lib/hooks/useAppCapabilities", () => ({ useAppCapabilities: () => ({ projects: true }) }));

const STATES = [
  { id: "s1", projectId: "p-1", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p-1", name: "In Progress", group: "started", color: "#f59e0b", sortOrder: 2, isDefault: false },
];
const PROJECT = {
  id: "p-1",
  workspaceId: "ws",
  workspaceSlug: "home",
  name: "Roadmap",
  identifier: "RDM",
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
const ITEM = {
  id: "w-1",
  projectId: "p-1",
  sequenceId: 1,
  key: "RDM-1",
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
};

/** What the box currently holds. A test changes it, then sends the frame. */
const server = { items: [ITEM] as Array<typeof ITEM> };
const gets: string[] = [];

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" }, isLoading: false }),
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") gets.push(url);
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
    if (url.startsWith("/api/pm/projects/p-1/work-items?parent=")) return json({ work_items: [] });
    if (url === "/api/pm/projects/p-1/work-items") return json({ work_items: server.items });
    if (url === "/api/pm/projects/p-1/states") return json({ states: STATES });
    if (url === "/api/pm/projects/p-1/labels") return json({ labels: [] });
    if (url.startsWith("/api/pm/projects")) return json({ projects: [PROJECT] });
    if (url === "/api/pm/summary") return json({ summary: { activeProjects: 1, itemsOpen: 1, doneThisWeek: 0, overdue: 0 } });
    if (url.endsWith("/comments")) return json({ comments: [] });
    if (url.endsWith("/activity")) return json({ activity: [] });
    if (url.endsWith("/presence")) return json({ viewers: [] });
    if (url === "/api/departments") return json({ departments: [] });
    if (url === "/api/auth/users") return json({ users: [] });
    return json({});
  }),
}));

import ProjectsPage from "./page";

const boardReads = () => gets.filter((u) => u === "/api/pm/projects/p-1/work-items").length;

const FRAME = { type: "pm.changed", projectId: "p-1", workItemId: "w-1", verb: "updated" };
const frame = (over: Partial<typeof FRAME> = {}) =>
  act(() => publishPmLiveFrame("droplet/pm/ada", { ...FRAME, ...over }));

async function openBoard() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ProjectsPage />
    </SWRConfig>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Roadmap, RDM" }));
  await screen.findByRole("button", { name: /^RDM-1,/ });
}

beforeEach(() => {
  cleanup();
  gets.length = 0;
  server.items = [ITEM];
});

describe("Projects page — live updates (WARP-3536)", () => {
  it("a change made elsewhere shows on the board and in the open drawer", async () => {
    await openBoard();
    fireEvent.click(screen.getByRole("button", { name: /^RDM-1,/ }));
    expect(await screen.findByRole("heading", { name: "First task" })).toBeTruthy(); // the drawer

    server.items = [{ ...ITEM, name: "First task, renamed", updatedAt: "2026-06-02T00:00:00.000Z" }];
    frame();

    // Both the card on the board and the drawer's own heading are the new item.
    await waitFor(() => expect(screen.getAllByText("First task, renamed").length).toBeGreaterThanOrEqual(2));
    expect(screen.getByRole("heading", { name: "First task, renamed" })).toBeTruthy();
  });

  it("a card moved by someone else lands in its new column", async () => {
    await openBoard();
    const columnOf = () =>
      screen.getByRole("button", { name: /^RDM-1,/ }).closest(".pm-col")?.querySelector(".pm-sect")?.textContent ?? "";
    expect(columnOf()).toContain("Todo");

    server.items = [{ ...ITEM, stateId: "s2", state: STATES[1] as typeof ITEM.state, updatedAt: "2026-06-02T00:00:00.000Z" }];
    frame();

    await waitFor(() => expect(columnOf()).toContain("In Progress"));
  });

  it("leaves the board alone for a change in another project", async () => {
    await openBoard();
    const before = boardReads();

    frame({ projectId: "p-9", workItemId: "w-9" });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    expect(boardReads()).toBe(before);
  });

  it("waits while a card is in the user's hand, then catches up once it is let go", async () => {
    await openBoard();
    const before = boardReads();
    const card = screen.getByRole("button", { name: /^RDM-1,/ });

    fireEvent.dragStart(card);
    server.items = [{ ...ITEM, name: "Renamed mid-drag", updatedAt: "2026-06-02T00:00:00.000Z" }];
    frame();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(boardReads()).toBe(before); // nothing was re-read under the pointer
    expect(screen.queryByText("Renamed mid-drag")).toBeNull();

    fireEvent.dragEnd(card);
    expect(await screen.findByText("Renamed mid-drag")).toBeTruthy();
  });
});
