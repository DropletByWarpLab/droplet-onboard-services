/**
 * /projects — the board shows EVERY work item, not the first page (WARP-3371).
 *
 * The board used to read one page of 100 and stop, silently: a project with 250
 * items rendered 100 and said nothing. This drives the REAL page and the REAL
 * data hooks against a tiny in-memory server that pages 250 items by cursor, and
 * asserts what a person would see: every card, a "how many of how many" line
 * while the rest is still arriving, counts that never pretend a partial list is
 * the whole one, and quiet once it is whole.
 *
 * ShellPage is a passthrough (same rationale as page.gating.test.tsx); only the
 * network (`authFetch`) is faked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import React from "react";
import { buildPmPath, parsePmUrl, type PmUrlState } from "@droplet/shared-types";

// Model navigation landing through the canonical parser/builder; the real hook
// is covered separately. These tests exercise the actual merged page and SWR.
const navigation = { search: "", entries: [] as string[] };
vi.mock("@/components/projects/useProjectsUrl", () => ({
  useProjectsUrl: () => {
    const [, rerender] = React.useState(0);
    const state = parsePmUrl(new URLSearchParams(navigation.search));
    const go = (patch: Partial<Required<PmUrlState>>, _mode: string) => {
      const href = buildPmPath({ ...state, ...patch });
      navigation.entries.push(href);
      navigation.search = href.split("?")[1] ?? "";
      rerender((n) => n + 1);
    };
    return { state, go, openItem: (key: string) => go({ item: key }, "push"), closeItem: () => go({ item: null }, "replace") };
  },
}));


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

const TOTAL = 250;

const STATES = [
  { id: "s-todo", projectId: "p1", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  { id: "s-doing", projectId: "p1", name: "In Progress", group: "started", color: "#f59e0b", sortOrder: 2, isDefault: false },
  { id: "s-done", projectId: "p1", name: "Done", group: "completed", color: "#22c55e", sortOrder: 3, isDefault: false },
];

const PROJECT = {
  id: "p1",
  workspaceId: "w",
  workspaceSlug: "home",
  name: "Onboarding",
  identifier: "INBOX",
  description: null,
  icon: "board",
  color: "#6366f1",
  leadId: null,
  department: null,
  archived: false,
  openCount: TOTAL,
  doneCount: 0,
  groups: { backlog: 0, unstarted: TOTAL, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

/** Item `n`: spread over the three states so every column has cards. */
function wireItem(n: number) {
  const state = STATES[n % 3];
  return {
    id: `wi-${n}`,
    projectId: "p1",
    sequenceId: n,
    key: `INBOX-${n}`,
    name: `Item ${n}`,
    descriptionHtml: null,
    stateId: state.id,
    state,
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

/** When set, every page AFTER the first waits on this before it answers — a
 *  deterministic "the rest is still on its way" (a timer would race the slow
 *  jsdom render of 200 cards). */
let hold: Promise<void> | null = null;
let failCursorPages = false;
let failFilteredFirstPage = false;
const itemRequests: Array<{ projectId: string | null; limit: number; cursor: string | null }> = [];

function serveItems(body: { projectId: string | null; limit: number; cursor: string | null }) {
  itemRequests.push({ projectId: body.projectId, limit: body.limit, cursor: body.cursor });
  const { limit, cursor } = body;
  const after = cursor ? Number(cursor.replace("after-", "")) : 0;
  const rows = Array.from({ length: Math.min(limit, TOTAL - after) }, (_, i) => wireItem(after + i + 1));
  const last = after + rows.length;
  return { work_items: rows, nextCursor: last < TOTAL ? `after-${last}` : null, total: TOTAL, counts: cursor ? undefined : { all: TOTAL, mine: 0, overdue: 0, recent: 0 } };
}

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "ada", displayName: "Ada", role: "owner" },
    isLoading: false,
  }),
  authFetch: vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) }) as Response;
    if (url === "/api/pm/work-items/query") {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.projectId).toBe("p1");
      if (failFilteredFirstPage && body.cursor === null && body.filter.field === "text") {
        return { ok: false, status: 503, json: () => Promise.resolve({ error: "boom" }) } as Response;
      }
      if (body.cursor) {
        if (hold) await hold;
        if (failCursorPages) return { ok: false, status: 503, json: () => Promise.resolve({ error: "boom" }) } as Response;
      }
      return json(serveItems(body));
    }
    if (url === "/api/pm/people") return json({ people: [] });
    if (url === "/api/pm/projects/p1/cycles") return json({ cycles: [] });
    if (url === "/api/pm/projects/p1/states") return json({ states: STATES });
    if (url.startsWith("/api/pm/projects")) return json({ projects: [PROJECT] });
    if (url.startsWith("/api/pm/summary")) {
      return json({ summary: { activeProjects: 1, itemsOpen: TOTAL, doneThisWeek: 0, overdue: 0 } });
    }
    if (url === "/api/departments") return json({ departments: [] });
    return json({});
  }),
}));

import ProjectsPage from "./page";

function renderPage() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ProjectsPage />
    </SWRConfig>,
  );
}

const cards = () => screen.queryAllByRole("button", { name: /^INBOX-\d+, Item \d+$/ });

async function openBoard() {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Onboarding, INBOX" }));
}

beforeEach(() => {
  navigation.search = "";
  navigation.entries = [];
  hold = null;
  failCursorPages = false;
  failFilteredFirstPage = false;
  itemRequests.length = 0;
});

describe("/projects board — every page, progressively (WARP-3371)", () => {
  it("250 items: all 250 cards render, and the page says nothing once the list is whole", async () => {
    await openBoard();

    await waitFor(() => expect(cards()).toHaveLength(TOTAL));
    // No "x of y" noise on a list that is complete.
    expect(screen.queryByRole("status")).toBeNull();
    // The tail request preserves the project scope and does not refetch the first page.
    expect(itemRequests).toEqual([
      { projectId: "p1", limit: 200, cursor: null },
      { projectId: "p1", limit: 200, cursor: "after-200" },
    ]);
    // The "All" chip is the exact total, and nothing is marked as a floor.
    const all = screen.getByRole("button", { name: /^All\s*250$/ });
    expect(all).toBeInTheDocument();
    expect(screen.queryByText(/\d\+$/)).toBeNull();
  });

  it("while the rest is still on its way it says how many of how many are shown, and marks every count as a floor", async () => {
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await openBoard();

    await waitFor(() => expect(cards()).toHaveLength(200));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Showing 200 of 250 work items — loading the rest…");
    // `All` is the server's exact total, never the length of what has arrived…
    expect(screen.getByRole("button", { name: /^All\s*250$/ })).toBeInTheDocument();
    // Named-filter counts come from the server for the whole query, while
    // board columns only know the loaded rows and remain marked as floors.
    expect(screen.getByRole("button", { name: /^My items\s*0$/ })).toBeInTheDocument();
    expect(screen.getAllByText(/^\d+\+$/).length).toBeGreaterThan(2); // column counts too

    release();
    await waitFor(() => expect(cards()).toHaveLength(TOTAL));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(screen.queryByText(/^\d+\+$/)).toBeNull();
  });

  it("a failed later page keeps the cards in hand and says the rest could not be loaded, with a Retry", async () => {
    failCursorPages = true;
    await openBoard();

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't load the rest."));
    expect(screen.getByRole("status")).toHaveTextContent("Showing 200 of 250 work items.");
    expect(cards()).toHaveLength(200);

    // The server recovers; Retry re-reads the chain and the board completes.
    failCursorPages = false;
    fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(cards()).toHaveLength(TOTAL));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("the list view shows every item too", async () => {
    await openBoard();
    await waitFor(() => expect(cards()).toHaveLength(TOTAL));

    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    await waitFor(() => expect(cards()).toHaveLength(TOTAL));
  });

  it("a failed new filter's first page is a query error, not a failed tail with stale matching rows", async () => {
    await openBoard();
    await waitFor(() => expect(cards()).toHaveLength(TOTAL));
    failFilteredFirstPage = true;
    fireEvent.change(screen.getByLabelText("Search work items"), { target: { value: "Item" } });
    await screen.findByText("Couldn't load this project.");
    expect(cards()).toHaveLength(0);
    expect(screen.queryByText(/Couldn't load the rest/)).toBeNull();
    expect(screen.queryByText(/250 items match/)).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    failFilteredFirstPage = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(cards()).toHaveLength(TOTAL));
  });
});
