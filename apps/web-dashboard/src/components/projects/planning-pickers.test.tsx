// The drawer's cycle and module pickers, and the cycle chip on cards and rows
// (WARP-3521). authFetch is faked as in detail.test.tsx; the real hooks run.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CycleField, ModulesField } from "./planning-pickers";
import { DetailDrawer } from "./detail";
import { ListView, WorkItemCard } from "./board";
import { PeopleContext } from "./bits";
import { makePerson } from "./config";
import type { PmCycle, PmModule, PmModuleRef, PmPlanningProgress, PmState, PmWorkItem } from "./types";

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
  itemModules: PmModuleRef[];
  allModules: PmModule[];
  failures: Record<string, { status: number; error: string }>;
}
let world: World;

function reply(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);
}

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u-viewer", role: "member" } }),
  authFetch: vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url}`;
    const refused = Object.entries(world.failures).find(([needle]) => key.includes(needle));
    if (refused) return reply({ error: refused[1].error }, refused[1].status);

    if (method === "GET") {
      if (url.endsWith("/projects/p/cycles")) return reply({ cycles: world.cycles });
      if (url.endsWith("/work-items/w1/modules")) return reply({ modules: world.itemModules });
      if (url.endsWith("/projects/p/modules")) return reply({ modules: world.allModules });
      if (url.endsWith("/comments")) return reply({ comments: [] });
      if (url.endsWith("/activity")) return reply({ activity: [] });
      if (url.includes("/work-items?parent=")) return reply({ work_items: [] });
      if (url.endsWith("/labels")) return reply({ labels: [] });
      return reply({});
    }
    if (method === "DELETE" && /\/modules\/([^/]+)\/work-items\/w1$/.test(url)) {
      const id = /\/modules\/([^/]+)\//.exec(url)![1];
      world.itemModules = world.itemModules.filter((m) => m.id !== id);
      return reply({ removed: 1 });
    }
    if (method === "POST" && /\/modules\/([^/]+)\/work-items$/.test(url)) {
      const id = /\/modules\/([^/]+)\//.exec(url)![1];
      const mod = world.allModules.find((m) => m.id === id)!;
      world.itemModules = [...world.itemModules, { id: mod.id, name: mod.name, status: mod.status }];
      return reply({ added: 1 });
    }
    return reply({ work_item: ITEM });
  }),
}));

const STATE: PmState = { id: "s1", projectId: "p", name: "Todo", group: "unstarted", color: "#6366f1", sortOrder: 1, isDefault: true };

const ITEM: PmWorkItem = {
  id: "w1",
  projectId: "p",
  sequenceId: 1,
  key: "INBOX-1",
  name: "First task",
  descriptionHtml: null,
  stateId: "s1",
  state: STATE,
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

const progress: PmPlanningProgress = {
  total: 0,
  completed: 0,
  cancelled: 0,
  totalEstimate: 0,
  completedEstimate: 0,
  cancelledEstimate: 0,
};

const cycle = (id: string, name: string, status: PmCycle["status"]): PmCycle => ({
  id,
  projectId: "p",
  name,
  description: null,
  startDate: "2026-10-05",
  endDate: "2026-10-16",
  status,
  completedAt: null,
  carriedOverCount: 0,
  progress,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const mod = (id: string, name: string, status: PmModule["status"] = "planned"): PmModule => ({
  id,
  projectId: "p",
  name,
  description: null,
  leadId: null,
  status,
  startDate: null,
  targetDate: null,
  progress,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

function wrap(ui: React.ReactNode) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>{ui}</PeopleContext.Provider>
    </SWRConfig>,
  );
}

beforeEach(() => {
  calls.length = 0;
  toast.mockReset();
  world = {
    cycles: [cycle("c1", "Sprint 12", "active"), cycle("c2", "Sprint 13", "draft"), cycle("c0", "Sprint 11", "completed")],
    itemModules: [],
    allModules: [mod("m1", "Spring launch"), mod("m2", "Migration", "in_progress")],
    failures: {},
  };
});

// ── CycleField ────────────────────────────────────────────────────────────────

describe("CycleField", () => {
  it("offers the cycles that can take work, and No cycle — not a finished sprint", async () => {
    wrap(<CycleField item={ITEM} readOnly={false} onChanged={vi.fn()} />);
    const select = (await screen.findByLabelText("Cycle")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(3));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "No cycle",
      "Sprint 12 · Active",
      "Sprint 13 · Upcoming",
    ]);
    expect(select.value).toBe("");
  });

  it("an item already in a completed cycle still shows it (it is a record), but it is not offered to anyone else", async () => {
    wrap(<CycleField item={{ ...ITEM, cycleId: "c0" }} readOnly={false} onChanged={vi.fn()} />);
    const select = (await screen.findByLabelText("Cycle")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(4));
    expect(select.value).toBe("c0");
    expect(within(select).getByRole("option", { name: "Sprint 11 · Completed" })).toBeInTheDocument();
  });

  it("choosing a cycle PATCHes cycle_id and tells the drawer", async () => {
    const onChanged = vi.fn();
    wrap(<CycleField item={ITEM} readOnly={false} onChanged={onChanged} />);
    const select = (await screen.findByLabelText("Cycle")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(3));
    fireEvent.change(select, { target: { value: "c1" } });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/pm/work-items/w1", body: { cycle_id: "c1" } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // optimistic: the choice is what the select shows
    expect(select.value).toBe("c1");
  });

  it("No cycle takes the item out — an explicit null, not an omitted field", async () => {
    wrap(<CycleField item={{ ...ITEM, cycleId: "c1" }} readOnly={false} onChanged={vi.fn()} />);
    const select = (await screen.findByLabelText("Cycle")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(3));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ cycle_id: null });
  });

  it("a refusal rolls the select back and says why in a sentence", async () => {
    world.failures["PATCH /api/pm/work-items/w1"] = { status: 409, error: "cycle_completed" };
    const onChanged = vi.fn();
    wrap(<CycleField item={ITEM} readOnly={false} onChanged={onChanged} />);
    const select = (await screen.findByLabelText("Cycle")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(3));
    fireEvent.change(select, { target: { value: "c1" } });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("That cycle is finished, so it can't take new work. Pick another cycle.", "error");
    await waitFor(() => expect(select.value).toBe(""));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("re-seeds when the drawer pushes an updated item", async () => {
    const { rerender } = wrap(<CycleField item={ITEM} readOnly={false} onChanged={vi.fn()} />);
    const select = (await screen.findByLabelText("Cycle")) as HTMLSelectElement;
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBe(3));
    rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PeopleContext.Provider value={(id) => makePerson(id, "Tester")}>
          <CycleField item={{ ...ITEM, cycleId: "c2" }} readOnly={false} onChanged={vi.fn()} />
        </PeopleContext.Provider>
      </SWRConfig>,
    );
    await waitFor(() => expect((screen.getByLabelText("Cycle") as HTMLSelectElement).value).toBe("c2"));
  });

  it("read-only: the cycle as text, no select", async () => {
    wrap(<CycleField item={{ ...ITEM, cycleId: "c1" }} readOnly onChanged={vi.fn()} />);
    expect(await screen.findByText("Sprint 12")).toBeInTheDocument();
    expect(screen.queryByLabelText("Cycle")).toBeNull();
  });

  it("read-only with no cycle says so", () => {
    wrap(<CycleField item={ITEM} readOnly onChanged={vi.fn()} />);
    expect(screen.getByText("No cycle")).toBeInTheDocument();
  });
});

// ── ModulesField ──────────────────────────────────────────────────────────────

describe("ModulesField", () => {
  it("shows the item's modules as chips and offers only the others to add", async () => {
    world.itemModules = [{ id: "m1", name: "Spring launch", status: "planned" }];
    wrap(<ModulesField item={ITEM} readOnly={false} onChanged={vi.fn()} />);
    expect(await screen.findByText("Spring launch")).toBeInTheDocument();
    const add = (await screen.findByLabelText("Add to a module")) as HTMLSelectElement;
    expect(within(add).getAllByRole("option").map((o) => o.textContent)).toEqual(["Add to a module…", "Migration"]);
  });

  it("adding posts the item to that module and refreshes", async () => {
    const onChanged = vi.fn();
    wrap(<ModulesField item={ITEM} readOnly={false} onChanged={onChanged} />);
    const add = (await screen.findByLabelText("Add to a module")) as HTMLSelectElement;
    await waitFor(() => expect(within(add).getAllByRole("option").length).toBe(3));
    fireEvent.change(add, { target: { value: "m2" } });
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/modules/m2/work-items"))).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ work_item_ids: ["w1"] });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(await screen.findByText("Migration")).toBeInTheDocument();
  });

  it("removing deletes the one link, with a hit area and a name a screen reader can use", async () => {
    world.itemModules = [{ id: "m1", name: "Spring launch", status: "planned" }];
    const onChanged = vi.fn();
    wrap(<ModulesField item={ITEM} readOnly={false} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove from Spring launch" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/modules/m1/work-items/w1"))).toBe(true));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // the chip is gone and the item is in no module; the module is addable again
    expect(await screen.findByText("No modules")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove from Spring launch" })).toBeNull();
    expect(within(screen.getByLabelText("Add to a module")).getByRole("option", { name: "Spring launch" })).toBeInTheDocument();
  });

  it("a refusal is a sentence, not a code", async () => {
    world.failures["POST /api/pm/modules/m2/work-items"] = { status: 422, error: "invalid_work_item" };
    wrap(<ModulesField item={ITEM} readOnly={false} onChanged={vi.fn()} />);
    const add = (await screen.findByLabelText("Add to a module")) as HTMLSelectElement;
    await waitFor(() => expect(within(add).getAllByRole("option").length).toBe(3));
    fireEvent.change(add, { target: { value: "m2" } });
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith("That item belongs to a different project, so it can't go in this module.", "error");
  });

  it("an item in no module says so", async () => {
    wrap(<ModulesField item={ITEM} readOnly={false} onChanged={vi.fn()} />);
    expect(await screen.findByText("No modules")).toBeInTheDocument();
  });

  it("read-only: chips and text only — no select, no remove", async () => {
    world.itemModules = [{ id: "m1", name: "Spring launch", status: "planned" }];
    wrap(<ModulesField item={ITEM} readOnly onChanged={vi.fn()} />);
    expect(await screen.findByText("Spring launch")).toBeInTheDocument();
    expect(screen.queryByLabelText("Add to a module")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("when every module already has the item there is nothing to add, and no empty picker", async () => {
    world.itemModules = world.allModules.map((m) => ({ id: m.id, name: m.name, status: m.status }));
    wrap(<ModulesField item={ITEM} readOnly={false} onChanged={vi.fn()} />);
    await screen.findByText("Migration");
    expect(screen.queryByLabelText("Add to a module")).toBeNull();
  });
});

// ── the drawer ────────────────────────────────────────────────────────────────

describe("DetailDrawer — planning rows", () => {
  it("shows Cycle and Modules in the properties rail", async () => {
    wrap(<DetailDrawer item={{ ...ITEM, cycleId: "c1" }} onClose={() => undefined} onChanged={() => undefined} />);
    expect(await screen.findByText("Cycle")).toBeInTheDocument();
    expect(screen.getByText("Modules")).toBeInTheDocument();
    await waitFor(() => expect((screen.getByLabelText("Cycle") as HTMLSelectElement).value).toBe("c1"));
  });

  it("readOnly reaches the pickers: values as text, no controls", async () => {
    wrap(<DetailDrawer item={{ ...ITEM, cycleId: "c1" }} readOnly onClose={() => undefined} onChanged={() => undefined} />);
    expect(await screen.findByText("Sprint 12")).toBeInTheDocument();
    expect(screen.queryByLabelText("Cycle")).toBeNull();
    expect(screen.queryByLabelText("Add to a module")).toBeNull();
  });
});

// ── the chip on cards and rows ────────────────────────────────────────────────

describe("cycle chip on cards and list rows", () => {
  const cycles = new Map([["c1", cycle("c1", "Sprint 12", "active")]]);

  it("a board card names the cycle the item is planned into", () => {
    wrap(<WorkItemCard item={{ ...ITEM, cycleId: "c1" }} cycles={cycles} />);
    expect(screen.getByTitle("Cycle: Sprint 12")).toBeInTheDocument();
  });

  it("…even with no labels and no department to hang it on", () => {
    const { container } = wrap(<WorkItemCard item={{ ...ITEM, cycleId: "c1", labels: [] }} cycles={cycles} />);
    expect(container.querySelector(".pm-tag")).toBeTruthy();
  });

  it("no cycle, no chip", () => {
    wrap(<WorkItemCard item={ITEM} cycles={cycles} />);
    expect(screen.queryByTitle(/^Cycle:/)).toBeNull();
  });

  it("a cycle the card cannot resolve yet draws nothing (not 'undefined')", () => {
    wrap(<WorkItemCard item={{ ...ITEM, cycleId: "c-unknown" }} cycles={cycles} />);
    expect(screen.queryByTitle(/^Cycle:/)).toBeNull();
    expect(screen.queryByText("undefined")).toBeNull();
  });

  it("without the map at all the card renders exactly as before", () => {
    wrap(<WorkItemCard item={{ ...ITEM, cycleId: "c1" }} />);
    expect(screen.queryByTitle(/^Cycle:/)).toBeNull();
  });

  it("a list row shows it too", () => {
    wrap(<ListView states={[STATE]} items={[{ ...ITEM, cycleId: "c1" }]} domain="populated" onOpen={() => undefined} cycles={cycles} />);
    expect(screen.getByTitle("Cycle: Sprint 12")).toBeInTheDocument();
  });
});
