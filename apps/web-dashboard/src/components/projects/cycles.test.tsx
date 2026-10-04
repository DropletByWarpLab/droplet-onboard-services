// CyclesView (WARP-3521): list, detail, the new / edit / complete / delete flows
// and backlog planning. The orchestrator is faked at the authFetch seam — the
// same one detail.test.tsx uses — so these tests drive the real usePm hooks and
// assert on the exact requests that leave the browser.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CyclesView, progressForCard, validateCycleForm } from "./cycles";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmBurndown, PmCycle, PmPlanningProgress, PmProject, PmState, PmWorkItem } from "./types";

const toast = vi.fn();
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));

interface Call {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}
const calls: Call[] = [];

interface World {
  cycles: PmCycle[];
  items: PmWorkItem[];
  itemsTotal?: number;
  backlog: PmWorkItem[];
  backlogTotal?: number;
  burndown: PmBurndown | "error";
  /** `"METHOD url-substring"` → the refusal the server gives it. */
  failures: Record<string, { status: number; error: string }>;
}
let world: World;

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
}

vi.mock("@/lib/auth", () => ({
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url}`;
    const refused = Object.entries(world.failures).find(([needle]) => key.includes(needle));
    if (refused) return reply({ error: refused[1].error }, refused[1].status);

    if (method === "GET") {
      if (url.endsWith("/projects/p/cycles")) return reply({ cycles: world.cycles });
      if (/\/cycles\/[^/]+\/work-items$/.test(url)) {
        return reply({ work_items: world.items, total: world.itemsTotal ?? world.items.length });
      }
      if (url.endsWith("/projects/p/backlog")) {
        return reply({ work_items: world.backlog, total: world.backlogTotal ?? world.backlog.length });
      }
      if (/\/cycles\/[^/]+\/burndown$/.test(url)) {
        return world.burndown === "error" ? reply({ error: "boom" }, 500) : reply({ burndown: world.burndown });
      }
      if (url.endsWith("/projects/p/states")) return reply({ states: STATES });
      return reply({});
    }
    if (method === "POST" && url.endsWith("/projects/p/cycles")) {
      const c = cycle({
        id: "cy-new",
        name: String(body?.name),
        startDate: (body?.start_date as string) ?? null,
        endDate: (body?.end_date as string) ?? null,
      });
      world.cycles.push(c);
      return reply({ cycle: c }, 201);
    }
    const start = /\/cycles\/([^/]+)\/start$/.exec(url);
    if (method === "POST" && start) {
      const c = world.cycles.find((x) => x.id === start[1])!;
      c.status = "active";
      return reply({ cycle: c });
    }
    const complete = /\/cycles\/([^/]+)\/complete$/.exec(url);
    if (method === "POST" && complete) {
      const c = world.cycles.find((x) => x.id === complete[1])!;
      const n = c.progress.total - c.progress.completed - c.progress.cancelled;
      c.status = "completed";
      const to = body?.moveIncompleteTo === "backlog" ? null : String(body?.moveIncompleteTo);
      return reply({ cycle: c, moved: { count: n, to } });
    }
    if (method === "PATCH" && /\/cycles\/[^/]+$/.test(url)) {
      const c = world.cycles.find((x) => url.endsWith(x.id))!;
      return reply({ cycle: { ...c, name: String(body?.name ?? c.name) } });
    }
    if (method === "DELETE" && /\/cycles\/[^/]+$/.test(url)) {
      world.cycles = world.cycles.filter((c) => !url.endsWith(c.id));
      return reply({ deleted: "x" });
    }
    if (method === "PATCH" && /\/work-items\/[^/]+$/.test(url)) {
      const moved = world.backlog.find((i) => url.endsWith(i.id));
      if (moved) {
        world.backlog = world.backlog.filter((i) => i.id !== moved.id);
        world.items = [...world.items, { ...moved, cycleId: String(body?.cycle_id) }];
      }
      return reply({ work_item: moved ?? {} });
    }
    return reply({});
  }),
}));

const STATES: PmState[] = [
  { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true },
  { id: "s2", projectId: "p", name: "Done", group: "completed", color: "#22c55e", sortOrder: 2, isDefault: false },
];

const PROJECT: PmProject = {
  id: "p",
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
  openCount: 0,
  doneCount: 0,
  groups: { backlog: 0, unstarted: 0, started: 0, completed: 0, cancelled: 0 },
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const progress = (over: Partial<PmPlanningProgress> = {}): PmPlanningProgress => ({
  total: 0,
  completed: 0,
  cancelled: 0,
  totalEstimate: 0,
  completedEstimate: 0,
  cancelledEstimate: 0,
  ...over,
});

function cycle(over: Partial<PmCycle> = {}): PmCycle {
  return {
    id: "c1",
    projectId: "p",
    name: "Sprint 12",
    description: null,
    startDate: "2026-10-05",
    endDate: "2026-10-16",
    status: "draft",
    completedAt: null,
    carriedOverCount: 0,
    progress: progress(),
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function item(id: string, key: string, over: Partial<PmWorkItem> = {}): PmWorkItem {
  return {
    id,
    projectId: "p",
    sequenceId: 1,
    key,
    name: `Task ${key}`,
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

const BURNDOWN: PmBurndown = {
  cycleId: "c1",
  status: "active",
  startDate: "2026-10-05",
  endDate: "2026-10-07",
  through: "2026-10-06",
  hasEstimates: false,
  days: [
    { date: "2026-10-05", scope: 4, remaining: 4, completed: 0, added: 4, removed: 0, scopeEstimate: 0, remainingEstimate: 0, completedEstimate: 0, ideal: 4, idealEstimate: 0 },
    { date: "2026-10-06", scope: 5, remaining: 3, completed: 2, added: 1, removed: 0, scopeEstimate: 0, remainingEstimate: 0, completedEstimate: 0, ideal: 2, idealEstimate: 0 },
    { date: "2026-10-07", scope: null, remaining: null, completed: null, added: null, removed: null, scopeEstimate: null, remainingEstimate: null, completedEstimate: null, ideal: 0, idealEstimate: 0 },
  ],
};

function renderCycles(opts: { readOnly?: boolean } = {}) {
  const onOpenItem = vi.fn();
  const onChanged = vi.fn();
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>
        <CyclesView
          project={PROJECT}
          states={STATES}
          readOnly={!!opts.readOnly}
          onOpenItem={onOpenItem}
          onChanged={onChanged}
        />
      </PeopleContext.Provider>
    </SWRConfig>,
  );
  return { onOpenItem, onChanged };
}

async function openCycle(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${name},`) }));
  await screen.findByRole("button", { name: /All cycles/ });
}

const ACTIVE = () =>
  cycle({ id: "c1", name: "Sprint 12", status: "active", progress: progress({ total: 5, completed: 2, cancelled: 1 }) });

beforeEach(() => {
  calls.length = 0;
  toast.mockReset();
  world = {
    cycles: [],
    items: [],
    backlog: [],
    burndown: BURNDOWN,
    failures: {},
  };
});

// ── pure helpers ──────────────────────────────────────────────────────────────

describe("validateCycleForm", () => {
  it("accepts a good form", () => {
    expect(validateCycleForm({ name: "Sprint", start: "2026-10-05", end: "2026-10-16" })).toEqual({});
    expect(validateCycleForm({ name: "Sprint", start: "", end: "" })).toEqual({});
  });
  it("names the three rules the server enforces, in the brief's words", () => {
    expect(validateCycleForm({ name: "  ", start: "", end: "" }).name).toBe("Name can't be empty.");
    expect(validateCycleForm({ name: "x", start: "2026-10-16", end: "2026-10-05" }).dates).toBe(
      "End date can't be before the start date.",
    );
    expect(validateCycleForm({ name: "x", start: "2026-01-01", end: "2027-01-02" }).dates).toBe(
      "A cycle can run for at most a year.",
    );
  });
  it("a cycle of exactly 366 days is fine, and a one-day cycle too", () => {
    expect(validateCycleForm({ name: "x", start: "2028-01-01", end: "2028-12-31" }).dates).toBeUndefined();
    expect(validateCycleForm({ name: "x", start: "2026-10-05", end: "2026-10-05" }).dates).toBeUndefined();
  });
});

describe("progressForCard", () => {
  it("a running cycle reads its own progress", () => {
    const c = cycle({ status: "active", progress: progress({ total: 5, completed: 2 }) });
    expect(progressForCard(c)).toBe(c.progress);
  });
  it("a completed cycle counts the work it carried over, so it is not a trivial 100%", () => {
    const c = cycle({ status: "completed", carriedOverCount: 3, progress: progress({ total: 9, completed: 9 }) });
    expect(progressForCard(c).total).toBe(12);
    expect(progressForCard(c).completed).toBe(9);
  });
});

// ── the list ──────────────────────────────────────────────────────────────────

describe("CyclesView — list", () => {
  it("shows a skeleton while the cycles load", () => {
    renderCycles();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("groups cycles under Active, Upcoming and Completed, with dates and progress words", async () => {
    world.cycles = [
      ACTIVE(),
      cycle({ id: "c2", name: "Sprint 13", startDate: "2026-10-19", endDate: "2026-10-30" }),
      cycle({
        id: "c3",
        name: "Sprint 11",
        status: "completed",
        startDate: "2026-09-21",
        endDate: "2026-10-02",
        completedAt: "2026-10-02T17:00:00.000Z",
        carriedOverCount: 3,
        progress: progress({ total: 9, completed: 9 }),
      }),
    ];
    renderCycles();

    const sections = await screen.findAllByRole("region");
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual(["Active", "Upcoming", "Completed"]);

    const active = screen.getByRole("button", { name: "Sprint 12, Active" });
    expect(within(active).getByText("Oct 5 – Oct 16")).toBeInTheDocument();
    expect(within(active).getByText("2 of 4 done · 1 cancelled")).toBeInTheDocument();
    expect(within(active).getByRole("progressbar", { name: "Sprint 12 progress" })).toHaveAttribute("aria-valuenow", "50");

    const upcoming = screen.getByRole("button", { name: "Sprint 13, Upcoming" });
    expect(within(upcoming).getByText("No items yet")).toBeInTheDocument();

    const completed = screen.getByRole("button", { name: "Sprint 11, Completed" });
    // 9 done out of the 12 it set out to do — not 9 of 9
    expect(within(completed).getByText("9 of 12 done")).toBeInTheDocument();
    expect(within(completed).getByText(/3 moved on/)).toBeInTheDocument();
    expect(within(completed).getByText(/^Completed /)).toBeInTheDocument();
  });

  it("a card's dates and progress ride along as its description — a button's children are not read", async () => {
    world.cycles = [ACTIVE()];
    renderCycles();
    const card = await screen.findByRole("button", { name: "Sprint 12, Active" });
    const described = (card.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described.join(" ")).toContain("Oct 5 – Oct 16");
    expect(described.join(" ")).toContain("2 of 4 done · 1 cancelled");
  });

  it("a calendar date is the date shown, in any timezone", async () => {
    const prev = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Pacific/Auckland"]) {
        process.env.TZ = tz;
        world.cycles = [cycle({ startDate: "2026-10-05", endDate: "2026-10-16" })];
        const { unmount } = render(
          <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
            <PeopleContext.Provider value={(id) => makePerson(id, "T")}>
              <CyclesView project={PROJECT} states={STATES} readOnly={false} onOpenItem={vi.fn()} onChanged={vi.fn()} />
            </PeopleContext.Provider>
          </SWRConfig>,
        );
        expect(await screen.findByText("Oct 5 – Oct 16")).toBeInTheDocument();
        unmount();
      }
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  it("shows points beside items when anything carries an estimate", async () => {
    world.cycles = [ACTIVE()];
    world.cycles[0].progress = progress({ total: 4, completed: 1, totalEstimate: 20, completedEstimate: 5 });
    renderCycles();
    expect(await screen.findByText("5 of 20 points done")).toBeInTheDocument();
  });

  it("empty: calm copy, with a New cycle CTA for writers only", async () => {
    renderCycles();
    expect(await screen.findByText("No cycles yet.")).toBeInTheDocument();
    expect(screen.getByText("Create one to plan a sprint.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /New cycle/ }).length).toBeGreaterThan(0);
  });

  it("read-only: the empty state has no CTA and the toolbar no New cycle", async () => {
    renderCycles({ readOnly: true });
    expect(await screen.findByText("No cycles yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /New cycle/ })).toBeNull();
  });

  it("error: names the problem without blaming, and Try again re-fetches", async () => {
    world.failures["GET /api/pm/projects/p/cycles"] = { status: 500, error: "boom" };
    renderCycles();
    expect(await screen.findByText("Couldn't load cycles.")).toBeInTheDocument();
    expect(screen.getByText("Check the appliance connection and try again.")).toBeInTheDocument();
    const before = calls.filter((c) => c.url.endsWith("/projects/p/cycles")).length;
    delete world.failures["GET /api/pm/projects/p/cycles"];
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/projects/p/cycles")).length).toBeGreaterThan(before));
  });

  it("a card opens with Enter and with Space", async () => {
    world.cycles = [ACTIVE()];
    renderCycles();
    const card = await screen.findByRole("button", { name: "Sprint 12, Active" });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(await screen.findByRole("button", { name: /All cycles/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /All cycles/ }));
    fireEvent.keyDown(await screen.findByRole("button", { name: "Sprint 12, Active" }), { key: " " });
    expect(await screen.findByRole("button", { name: /All cycles/ })).toBeInTheDocument();
  });
});

// ── new / edit ────────────────────────────────────────────────────────────────

describe("CyclesView — new cycle", () => {
  async function openNew() {
    fireEvent.click((await screen.findAllByRole("button", { name: /New cycle/ }))[0]);
    return screen.findByLabelText("Name");
  }

  it("an empty name is named once the owner tries, and nothing is sent", async () => {
    renderCycles();
    await openNew();
    expect(screen.queryByText("Name can't be empty.")).toBeNull(); // not before they try
    fireEvent.click(screen.getByRole("button", { name: "Create cycle" }));
    expect(await screen.findByText("Name can't be empty.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("refuses an end before the start and a cycle over a year, as the owner types — with the brief's words", async () => {
    renderCycles();
    const name = await openNew();
    fireEvent.change(name, { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-16" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-05" } });
    expect(await screen.findByText("End date can't be before the start date.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create cycle" }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-01-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2027-01-02" } });
    expect(await screen.findByText("A cycle can run for at most a year.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create cycle" }));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends the name trimmed and the dates exactly as typed — never through a Date", async () => {
    renderCycles();
    const name = await openNew();
    fireEvent.change(name, { target: { value: "  Sprint 14  " } });
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-05" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-16" } });
    fireEvent.click(screen.getByRole("button", { name: "Create cycle" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/projects/p/cycles"))).toBe(true));
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/projects/p/cycles"))!;
    expect(post.body).toEqual({ name: "Sprint 14", start_date: "2026-10-05", end_date: "2026-10-16" });
    expect(toast).toHaveBeenCalledWith("Cycle created", "success");
    // …and the new cycle opens, once the list has it
    expect(await screen.findByRole("heading", { name: "Sprint 14" })).toBeInTheDocument();
  });

  it("dates are optional on a new cycle (and then omitted, not nulled)", async () => {
    renderCycles();
    fireEvent.change(await openNew(), { target: { value: "Someday" } });
    fireEvent.click(screen.getByRole("button", { name: "Create cycle" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ name: "Someday" });
  });

  it("a server refusal keeps the dialog open and says why, in a sentence", async () => {
    world.failures["POST /api/pm/projects/p/cycles"] = { status: 422, error: "invalid_dates" };
    renderCycles();
    fireEvent.change(await openNew(), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Create cycle" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatch(/dates/i);
    expect(toast.mock.calls[0][0]).not.toContain("invalid_dates");
    expect(toast.mock.calls[0][1]).toBe("error");
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });
});

describe("CyclesView — edit cycle", () => {
  it("clearing a date sends null; the name is trimmed", async () => {
    world.cycles = [cycle({ id: "c2", name: "Sprint 13", status: "draft" })];
    renderCycles();
    await openCycle("Sprint 13");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("End date"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " Sprint 13b " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({
      name: "Sprint 13b",
      description: null,
      start_date: "2026-10-05",
      end_date: null,
    });
  });

  it("a completed cycle's dates are fixed — disabled, explained, and never sent", async () => {
    world.cycles = [
      cycle({ id: "c3", name: "Sprint 11", status: "completed", completedAt: "2026-10-02T17:00:00.000Z", progress: progress({ total: 2, completed: 2 }) }),
    ];
    renderCycles();
    await openCycle("Sprint 11");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByLabelText("Start date")).toBeDisabled();
    expect(screen.getByLabelText("End date")).toBeDisabled();
    expect(screen.getByText("A completed cycle's dates are fixed.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ name: "Renamed", description: null });
  });
});

// ── detail ────────────────────────────────────────────────────────────────────

describe("CyclesView — start", () => {
  it("is disabled, with the reason in plain sight, until both dates are set", async () => {
    world.cycles = [cycle({ id: "c2", name: "Sprint 13", startDate: null, endDate: "2026-10-30" })];
    renderCycles();
    await openCycle("Sprint 13");
    const start = screen.getByRole("button", { name: "Start cycle" });
    expect(start).toBeDisabled();
    expect(screen.getByText("Set a start and end date first.")).toBeInTheDocument();
    expect(start).toHaveAttribute("aria-describedby");
  });

  it("starts a cycle that has its dates", async () => {
    world.cycles = [cycle({ id: "c2", name: "Sprint 13" })];
    const { onChanged } = renderCycles();
    await openCycle("Sprint 13");
    fireEvent.click(screen.getByRole("button", { name: "Start cycle" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/cycles/c2/start"))).toBe(true));
    expect(toast).toHaveBeenCalledWith("Cycle started", "success");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Complete cycle" })).toBeInTheDocument();
  });

  it("a second active cycle is refused in words the owner can act on", async () => {
    world.cycles = [cycle({ id: "c2", name: "Sprint 13" })];
    world.failures["POST /api/pm/cycles/c2/start"] = { status: 409, error: "cycle_already_active" };
    renderCycles();
    await openCycle("Sprint 13");
    fireEvent.click(screen.getByRole("button", { name: "Start cycle" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("Another cycle is already running. Complete it before you start this one.", "error");
  });
});

describe("CyclesView — complete", () => {
  beforeEach(() => {
    world.cycles = [ACTIVE(), cycle({ id: "c2", name: "Sprint 13", startDate: "2026-10-19", endDate: "2026-10-30" })];
  });

  it("says how many unfinished items will move, and defaults to the backlog", async () => {
    renderCycles();
    await openCycle("Sprint 12");
    fireEvent.click(screen.getByRole("button", { name: "Complete cycle" }));
    expect(await screen.findByText("2 unfinished items will move out of this cycle. Finished items stay as a record of what it delivered.")).toBeInTheDocument();
    const select = screen.getByLabelText("Move unfinished items to") as HTMLSelectElement;
    expect(select.value).toBe("backlog");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Backlog", "Sprint 13 · Upcoming"]);
  });

  it("completes into the backlog: the destination is sent, never defaulted by the server", async () => {
    const { onChanged } = renderCycles();
    await openCycle("Sprint 12");
    fireEvent.click(screen.getByRole("button", { name: "Complete cycle" }));
    await screen.findByLabelText("Move unfinished items to");
    // two buttons share the name (the trigger and the dialog's confirm): the dialog's is the last
    const confirms = screen.getAllByRole("button", { name: "Complete cycle" });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/cycles/c1/complete"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/cycles/c1/complete"))!.body).toEqual({ moveIncompleteTo: "backlog" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Cycle completed · 2 moved to Backlog", "success"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("can carry the unfinished work into another cycle, and names it", async () => {
    renderCycles();
    await openCycle("Sprint 12");
    fireEvent.click(screen.getByRole("button", { name: "Complete cycle" }));
    fireEvent.change(await screen.findByLabelText("Move unfinished items to"), { target: { value: "c2" } });
    const confirms = screen.getAllByRole("button", { name: "Complete cycle" });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/cycles/c1/complete"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/cycles/c1/complete"))!.body).toEqual({ moveIncompleteTo: "c2" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Cycle completed · 2 moved to Sprint 13", "success"));
  });

  it("with nothing unfinished there is no destination to choose", async () => {
    world.cycles[0].progress = progress({ total: 3, completed: 3 });
    renderCycles();
    await openCycle("Sprint 12");
    fireEvent.click(screen.getByRole("button", { name: "Complete cycle" }));
    expect(await screen.findByText("Everything in this cycle is finished.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Move unfinished items to")).toBeNull();
    const confirms = screen.getAllByRole("button", { name: "Complete cycle" });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/cycles/c1/complete"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/cycles/c1/complete"))!.body).toEqual({ moveIncompleteTo: "backlog" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Cycle completed", "success"));
  });

  it("a refusal keeps the dialog open", async () => {
    world.failures["POST /api/pm/cycles/c1/complete"] = { status: 409, error: "concurrent_mutation" };
    renderCycles();
    await openCycle("Sprint 12");
    fireEvent.click(screen.getByRole("button", { name: "Complete cycle" }));
    await screen.findByLabelText("Move unfinished items to");
    const confirms = screen.getAllByRole("button", { name: "Complete cycle" });
    fireEvent.click(confirms[confirms.length - 1]);
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][1]).toBe("error");
    expect(screen.getByLabelText("Move unfinished items to")).toBeInTheDocument();
  });
});

describe("CyclesView — delete", () => {
  it("asks first, then deletes and returns to the list", async () => {
    world.cycles = [cycle({ id: "c2", name: "Sprint 13" })];
    const { onChanged } = renderCycles();
    await openCycle("Sprint 13");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Delete this cycle?")).toBeInTheDocument();
    expect(screen.getByText("Unfinished work goes back to the backlog. Completed items keep their status and lose the cycle association. This can't be undone.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete cycle" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/cycles/c2"))).toBe(true));
    expect(toast).toHaveBeenCalledWith("Cycle deleted", "success");
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText("No cycles yet.")).toBeInTheDocument();
  });
});

// ── detail: items, backlog, burndown ──────────────────────────────────────────

describe("CyclesView — the cycle's own work", () => {
  it("lists this cycle's items on a board, scoped server-side, with an exact total", async () => {
    world.cycles = [ACTIVE()];
    world.items = [item("w1", "INBOX-1", { cycleId: "c1" }), item("w2", "INBOX-2", { cycleId: "c1", stateId: "s2", state: STATES[1] })];
    world.itemsTotal = 40;
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText("INBOX-1")).toBeInTheDocument();
    expect(screen.getByText("INBOX-2")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 40")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/cycles/c1/work-items"))).toBe(true);
  });

  it("switches to the list layout", async () => {
    world.cycles = [ACTIVE()];
    world.items = [item("w1", "INBOX-1", { cycleId: "c1" })];
    renderCycles();
    await openCycle("Sprint 12");
    await screen.findByText("INBOX-1");
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("INBOX-1")).toBeInTheDocument();
  });

  it("opening an item hands it to the page's drawer", async () => {
    world.cycles = [ACTIVE()];
    world.items = [item("w1", "INBOX-1", { cycleId: "c1" })];
    const { onOpenItem } = renderCycles();
    await openCycle("Sprint 12");
    fireEvent.click(await screen.findByRole("button", { name: /INBOX-1, Task INBOX-1/ }));
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: "w1" }));
  });

  it("an empty cycle says so, and points at the backlog", async () => {
    world.cycles = [ACTIVE()];
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText("No work items in this cycle yet.")).toBeInTheDocument();
    expect(screen.getByText("Add some from the backlog.")).toBeInTheDocument();
  });

  it("a reader is told the cycle is empty but not to add anything", async () => {
    world.cycles = [ACTIVE()];
    renderCycles({ readOnly: true });
    await openCycle("Sprint 12");
    expect(await screen.findByText("No work items in this cycle yet.")).toBeInTheDocument();
    expect(screen.queryByText("Add some from the backlog.")).toBeNull();
  });
});

describe("CyclesView — backlog planning", () => {
  beforeEach(() => {
    world.cycles = [ACTIVE()];
    world.backlog = [item("b1", "INBOX-7"), item("b2", "INBOX-8")];
  });

  it("lists the backlog with the keyboard route to plan an item stated up front", async () => {
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText("INBOX-7")).toBeInTheDocument();
    expect(screen.getByText("Drag items into the cycle, or use Add to cycle.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add INBOX-7 to Sprint 12" })).toBeInTheDocument();
  });

  it("the Add to cycle button plans the item and says so in a live region", async () => {
    const { onChanged } = renderCycles();
    await openCycle("Sprint 12");
    const addFirst = await screen.findByRole("button", { name: "Add INBOX-7 to Sprint 12" });
    addFirst.focus();
    fireEvent.click(addFirst);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/work-items/b1"))).toBe(true));
    expect(calls.find((c) => c.method === "PATCH" && c.url.endsWith("/work-items/b1"))!.body).toEqual({ cycle_id: "c1" });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Added INBOX-7 to Sprint 12."));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // it left the backlog and joined the cycle
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add INBOX-7 to Sprint 12" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Add INBOX-8 to Sprint 12" })).toHaveFocus());
  });

  it("dragging a backlog row into the cycle does the same thing", async () => {
    renderCycles();
    await openCycle("Sprint 12");
    const row = (await screen.findByText("INBOX-8")).closest(".pm-backlog-row") as HTMLElement;
    expect(row).toHaveAttribute("draggable", "true");
    const zone = screen.getByRole("region", { name: "Work in this cycle" });
    const dataTransfer = { setData: vi.fn(), getData: () => "b2", effectAllowed: "" };
    fireEvent.dragStart(row, { dataTransfer });
    fireEvent.dragOver(zone, { dataTransfer });
    expect(zone.className).toContain("pm-dropzone");
    fireEvent.drop(zone, { dataTransfer });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/work-items/b2"))).toBe(true));
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "b2");
  });

  it("a refusal rolls nothing forward: the row stays and the owner is told", async () => {
    world.failures["PATCH /api/pm/work-items/b1"] = { status: 409, error: "cycle_completed" };
    renderCycles();
    await openCycle("Sprint 12");
    fireEvent.click(await screen.findByRole("button", { name: "Add INBOX-7 to Sprint 12" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("That cycle is finished, so it can't take new work. Pick another cycle.", "error");
    expect(screen.getByText("INBOX-7")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't add INBOX-7 — try again.");
  });

  it("an empty backlog says everything is already planned", async () => {
    world.backlog = [];
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText("The backlog is empty.")).toBeInTheDocument();
    expect(screen.getByText("Everything unfinished is already in a cycle.")).toBeInTheDocument();
  });

  it("a failed backlog read says so and can be retried", async () => {
    world.failures["GET /api/pm/projects/p/backlog"] = { status: 500, error: "boom" };
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText("Couldn't load the backlog.")).toBeInTheDocument();
  });

  it("read-only: the backlog is visible, with no handles and no buttons", async () => {
    renderCycles({ readOnly: true });
    await openCycle("Sprint 12");
    const row = (await screen.findByText("INBOX-7")).closest(".pm-backlog-row") as HTMLElement;
    expect(row.getAttribute("draggable")).not.toBe("true");
    expect(screen.queryByRole("button", { name: /^Add INBOX-7/ })).toBeNull();
    expect(screen.queryByText("Drag items into the cycle, or use Add to cycle.")).toBeNull();
  });

  it("a completed cycle has no backlog panel and no planning", async () => {
    world.cycles = [cycle({ id: "c3", name: "Sprint 11", status: "completed", completedAt: "2026-10-02T17:00:00.000Z", progress: progress({ total: 2, completed: 2 }) })];
    renderCycles();
    await openCycle("Sprint 11");
    await screen.findByText("Burndown");
    expect(screen.queryByRole("region", { name: "Backlog" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Complete cycle" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start cycle" })).toBeNull();
  });

  it("read-only roles get no Start / Complete / Edit / Delete", async () => {
    renderCycles({ readOnly: true });
    await openCycle("Sprint 12");
    for (const name of ["Start cycle", "Complete cycle", "Edit", "Delete"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });
});

describe("CyclesView — burndown panel", () => {
  beforeEach(() => {
    world.cycles = [ACTIVE()];
  });

  it("states the chart in a sentence, and carries the numbers in a table", async () => {
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText("3 of 5 items remaining · scope grew by 1")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("offers Items / Points only when something has an estimate", async () => {
    renderCycles();
    await openCycle("Sprint 12");
    await screen.findByText(/items remaining/);
    expect(screen.queryByRole("button", { name: "Points" })).toBeNull();
  });

  it("with estimates the toggle switches the unit", async () => {
    world.burndown = {
      ...BURNDOWN,
      hasEstimates: true,
      days: BURNDOWN.days.map((d, i) => ({ ...d, scopeEstimate: d.scope === null ? null : 10 + i, remainingEstimate: d.remaining === null ? null : 8 - i * 3, idealEstimate: 8 - i * 4 })),
    };
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText(/items remaining/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Points" }));
    expect(screen.getByText("5 of 11 points remaining · scope grew by 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Points" })).toHaveAttribute("aria-pressed", "true");
  });

  it("a cycle with no dates says what is needed, rather than draw nothing", async () => {
    world.burndown = { ...BURNDOWN, startDate: null, endDate: null, through: null, days: [] };
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText("No burndown yet.")).toBeInTheDocument();
    expect(screen.getByText("Set a start and end date to see the burndown.")).toBeInTheDocument();
  });

  it("a failed read says so and offers Try again", async () => {
    world.burndown = "error";
    renderCycles();
    await openCycle("Sprint 12");
    expect(await screen.findByText("Couldn't load the burndown.")).toBeInTheDocument();
  });
});
